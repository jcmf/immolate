import crypto from 'node:crypto';
import path from 'node:path';
import { create as fontkitCreate } from 'fontkit';
import { transcodeToWoff2 } from './font-transcode.js';
import { subsetToWoff2 } from './font-subset.js';
import { computeCodePointsByFace, faceKey } from './font-cascade.js';
import { attachContext, currentStack } from './render-context.js';

const TOKEN_RE = /__XTATIC_FONT_[a-f0-9]+__/g;
const VALID_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const TRANSCODE_EXTS = new Set(['ttf', 'otf']);
const VALID_DISPLAY = new Set([
  'auto',
  'block',
  'swap',
  'fallback',
  'optional',
]);
const VALID_STYLE = new Set(['normal', 'italic', 'oblique']);
const VALID_SUBSET_MODES = new Set(['all-text', 'css-static']);
const VALID_PRECISIONS = new Set(['family', 'face']);
const VALID_HEDGES = new Set(['none', 'latin1', 'full']);
const VALID_PRELOAD_HEDGES = new Set([false, 'prefetch', 'preload']);
const MIME = { woff: 'font/woff', woff2: 'font/woff2' };

// Run-length encode a sorted array of code points into a CSS `unicode-range`
// descriptor: contiguous runs collapse to `U+lo-hi`, singletons to `U+xx`.
function encodeUnicodeRange(sortedCps) {
  if (!sortedCps || sortedCps.length === 0) return null;
  const parts = [];
  let lo = sortedCps[0];
  let hi = lo;
  for (let i = 1; i < sortedCps.length; i++) {
    const cp = sortedCps[i];
    if (cp === hi + 1) {
      hi = cp;
    } else {
      parts.push(
        lo === hi
          ? `U+${lo.toString(16).toUpperCase()}`
          : `U+${lo.toString(16).toUpperCase()}-${hi.toString(16).toUpperCase()}`,
      );
      lo = cp;
      hi = cp;
    }
  }
  parts.push(
    lo === hi
      ? `U+${lo.toString(16).toUpperCase()}`
      : `U+${lo.toString(16).toUpperCase()}-${hi.toString(16).toUpperCase()}`,
  );
  return parts.join(',');
}

function escCssString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function makeToken() {
  return `__XTATIC_FONT_${crypto.randomBytes(12).toString('hex')}__`;
}

// Canonical glyph-set key for a subset request: unique code points, sorted, so
// text="ab", "ba", and "aab" all map to one job (and one emitted asset).
function canonicalSubsetText(text) {
  return [...new Set(text)].sort().join('');
}

// Strip tags from a page's rendered HTML and return the remaining text.
// Drops <script>/<style>/<template> content (not rendered as glyphs); decodes
// the four entities the JSX runtime produces (&lt; &gt; &quot; &amp;). Regex-
// based and intentionally tolerant — over-including a code point is harmless,
// missing one is silent tofu. mode:'css-static' (commit 3) will swap this for
// a proper parse5 walk; for mode:'all-text' the regex is plenty.
function extractPageText(html) {
  let s = html.replace(
    /<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  );
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  return s;
}

function normalizeFontSubset(input) {
  if (input == null || input === false) return null;
  if (input === true) {
    return { mode: 'css-static', precision: 'face', hedge: 'full', preloadHedge: false };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      `fontSubset must be true, false, or an options object; got ${JSON.stringify(input)}.`,
    );
  }
  const mode = input.mode ?? 'css-static';
  if (!VALID_SUBSET_MODES.has(mode)) {
    throw new Error(
      `fontSubset.mode must be one of ${[...VALID_SUBSET_MODES].join(', ')}; got ${JSON.stringify(mode)}.`,
    );
  }
  const precision = input.precision ?? 'face';
  if (mode === 'css-static' && !VALID_PRECISIONS.has(precision)) {
    throw new Error(
      `fontSubset.precision must be one of ${[...VALID_PRECISIONS].join(', ')}; got ${JSON.stringify(precision)}.`,
    );
  }
  // Default hedge differs from fontSubset:true vs an explicit object: the
  // boolean form is "I want the safe defaults"; the object form is "I'm
  // configuring deliberately." Boolean form gets hedge:'full' (never tofu),
  // object form defaults to 'none' unless the user sets it.
  const hedge = input.hedge ?? 'none';
  if (!VALID_HEDGES.has(hedge)) {
    throw new Error(
      `fontSubset.hedge must be one of ${[...VALID_HEDGES].join(', ')}; got ${JSON.stringify(hedge)}.`,
    );
  }
  const preloadHedge = input.preloadHedge ?? false;
  if (!VALID_PRELOAD_HEDGES.has(preloadHedge)) {
    throw new Error(
      `fontSubset.preloadHedge must be false, 'prefetch', or 'preload'; got ${JSON.stringify(preloadHedge)}.`,
    );
  }
  return { mode, precision, hedge, preloadHedge };
}

function defaultGetCoverage(bytes) {
  const font = fontkitCreate(bytes);
  return new Set(font.characterSet);
}

export function createFontRegistry({
  fs,
  topDir,
  assetRegistry,
  autoInstall = false,
  install,
  fontSubset,
  transcode = (bytes) => transcodeToWoff2(bytes, { autoInstall, topDir, install }),
  subset = (bytes, text) =>
    subsetToWoff2(bytes, text, { autoInstall, topDir, install }),
  getCoverage = defaultGetCoverage,
}) {
  const subsetConfig = normalizeFontSubset(fontSubset);
  const calls = [];
  // Per-build cache: absSrc → Set<codepoint> of the source font's coverage.
  // Populated lazily in processAll only for sources that need hedge work.
  const sourceCoverageCache = new Map();

  function displayPath(absPath) {
    const rel = path.posix.relative(topDir, absPath);
    return rel && !rel.startsWith('..') ? rel : absPath;
  }

  function resolveSrc(importerAbsPath, src) {
    if (src.startsWith('/')) return path.posix.join(topDir, src);
    return path.posix.resolve(path.posix.dirname(importerAbsPath), src);
  }

  function forImporter(importerAbsPath) {
    return function Font(props = {}) {
      const {
        src,
        family,
        weight,
        style,
        display,
        unicodeRange,
        text,
        preload,
        subset: subsetProp,
        children: _children,
        ...rest
      } = props;

      if (typeof src !== 'string' || src.length === 0) {
        throw new Error(
          `<Font> requires a non-empty src (in "${displayPath(importerAbsPath)}").`,
        );
      }
      if (typeof family !== 'string' || family.length === 0) {
        throw new Error(
          `<Font src="${src}"> requires a non-empty family (in "${displayPath(importerAbsPath)}").`,
        );
      }
      if (family.includes('<')) {
        throw new Error(
          `<Font src="${src}">: family must not contain "<" (in "${displayPath(importerAbsPath)}").`,
        );
      }
      const ext = path.posix.extname(src).slice(1).toLowerCase();
      if (!VALID_EXTS.has(ext)) {
        throw new Error(
          `<Font src="${src}">: unsupported extension; expected .ttf, .otf, .woff, or .woff2 (in "${displayPath(importerAbsPath)}").`,
        );
      }
      if (display !== undefined && !VALID_DISPLAY.has(display)) {
        throw new Error(
          `<Font src="${src}">: display must be one of ${[...VALID_DISPLAY].join(', ')}; got "${display}".`,
        );
      }
      if (style !== undefined && !VALID_STYLE.has(style)) {
        throw new Error(
          `<Font src="${src}">: style must be one of ${[...VALID_STYLE].join(', ')}; got "${style}".`,
        );
      }
      if (
        weight !== undefined &&
        typeof weight !== 'number' &&
        typeof weight !== 'string'
      ) {
        throw new Error(
          `<Font src="${src}">: weight must be a number or string; got ${typeof weight}.`,
        );
      }
      if (unicodeRange !== undefined && typeof unicodeRange !== 'string') {
        throw new Error(
          `<Font src="${src}">: unicodeRange must be a string; got ${typeof unicodeRange}.`,
        );
      }
      if (
        text !== undefined &&
        (typeof text !== 'string' || text.length === 0)
      ) {
        throw new Error(
          `<Font src="${src}">: text must be a non-empty string (in "${displayPath(importerAbsPath)}").`,
        );
      }
      if (subsetProp !== undefined && typeof subsetProp !== 'boolean') {
        throw new Error(
          `<Font src="${src}">: subset must be a boolean; got ${typeof subsetProp}.`,
        );
      }
      const extraKeys = Object.keys(rest);
      if (extraKeys.length > 0) {
        throw new Error(
          `<Font src="${src}"> received unknown prop(s): ${extraKeys.join(', ')} (in "${displayPath(importerAbsPath)}").`,
        );
      }

      const absSrc = resolveSrc(importerAbsPath, src);
      // Auto-subset opt-in: per-call `subset` prop overrides the global default.
      // Explicit `text=` ALWAYS wins over auto-subset (resolved in processAll).
      const autoSubset = subsetProp ?? !!subsetConfig;

      const token = makeToken();
      calls.push({
        token,
        absSrc,
        ext,
        family,
        weight,
        style,
        display,
        unicodeRange,
        preload: !!preload,
        text,
        autoSubset,
        importerDisplay: displayPath(importerAbsPath),
        context: currentStack(),
      });
      return { html: token };
    };
  }

  async function runJob(job) {
    try {
      let bytes;
      try {
        bytes = await fs.promises.readFile(job.absSrc);
      } catch (e) {
        if (e.code === 'ENOENT') {
          throw new Error(
            `<Font>: source not found at ${job.absSrc} (requested by "${job.importerDisplay}").`,
          );
        }
        throw e;
      }
      let outExt = job.ext;
      if (job.subsetText !== undefined) {
        bytes = await subset(bytes, job.subsetText);
        outExt = 'woff2';
      } else if (TRANSCODE_EXTS.has(job.ext)) {
        bytes = await transcode(bytes);
        outExt = 'woff2';
      }
      const url = assetRegistry.emit(bytes, outExt);
      return { url, ext: outExt };
    } catch (e) {
      throw attachContext(e, job.context);
    }
  }

  // Convert a Set of code points (numbers) to a canonical sorted string for
  // the subsetter and for job dedup keys.
  function codePointSetToCanonical(set) {
    const sorted = [...set].sort((a, b) => a - b);
    return String.fromCodePoint(...sorted);
  }

  // Resolve each opted-in call's subset text. mode:'all-text' yields one
  // shared union string; mode:'css-static' yields a per-face glyph set via
  // the cascade engine, which we then look up per-call by faceKey. Returns
  // undefined to signal "no auto-subset for this call".
  function resolveAutoSubset(pages, opts) {
    if (!calls.some((c) => c.autoSubset)) {
      return () => undefined;
    }
    const mode = subsetConfig?.mode ?? 'css-static';
    const precision = subsetConfig?.precision ?? 'face';

    if (mode === 'all-text') {
      let acc = '';
      for (const p of pages) acc += extractPageText(p.html);
      const canon = canonicalSubsetText(acc);
      if (canon.length === 0) return () => undefined;
      return () => canon;
    }

    // css-static
    const getCssForPage = opts?.cssForPage ?? (() => []);
    const registeredFaces = calls.map((c) => ({
      family: c.family,
      weight: c.weight ?? 400,
      style: c.style ?? 'normal',
      stretch: 'normal',
      unicodeRange: c.unicodeRange,
    }));
    const byFace = computeCodePointsByFace({
      pages,
      getCssForPage,
      registeredFaces,
      precision,
    });
    return (call) => {
      const key = faceKey(
        {
          family: call.family,
          weight: call.weight ?? 400,
          style: call.style ?? 'normal',
          unicodeRange: call.unicodeRange,
        },
        precision,
      );
      const set = byFace.get(key);
      if (!set || set.size === 0) return undefined;
      return codePointSetToCanonical(set);
    };
  }

  // Lazy-load source font coverage by absSrc, reusing a cache so repeat calls
  // are free. Wraps the injectable `getCoverage` for fontkit-or-stub use.
  async function loadSourceCoverage(call) {
    if (sourceCoverageCache.has(call.absSrc)) {
      return sourceCoverageCache.get(call.absSrc);
    }
    try {
      const bytes = await fs.promises.readFile(call.absSrc);
      const cov = getCoverage(bytes);
      sourceCoverageCache.set(call.absSrc, cov);
      return cov;
    } catch (e) {
      if (e.code === 'ENOENT') {
        // Let runJob surface the canonical "source not found" error; just
        // mark coverage unavailable so hedge silently degrades to no-op.
        sourceCoverageCache.set(call.absSrc, null);
        return null;
      }
      throw attachContext(e, call.context);
    }
  }

  // Compute the complement glyph set for one call's primary subset, capped to
  // the hedge level. Returns null if no complement should be emitted (no
  // primary, hedge:'none', empty result, or user-supplied unicodeRange).
  async function computeComplement(call, primaryCpSet) {
    if (!subsetConfig || subsetConfig.hedge === 'none') return null;
    if (call.unicodeRange !== undefined) return null; // user is being explicit
    if (!primaryCpSet || primaryCpSet.size === 0) return null;
    const coverage = await loadSourceCoverage(call);
    if (!coverage) return null;
    const out = new Set();
    for (const cp of coverage) {
      if (primaryCpSet.has(cp)) continue;
      if (subsetConfig.hedge === 'latin1' && cp > 0xff) continue;
      out.add(cp);
    }
    return out.size === 0 ? null : out;
  }

  async function processAll(pages = [], opts) {
    const autoSubsetFor = resolveAutoSubset(pages, opts);

    // Build jobs from calls. Each call may produce up to two jobs (primary
    // glyph set + complement). Job dedup by `${absSrc}\0${subsetText}` so two
    // calls with the same glyph set share an asset. callJobs[i] records the
    // job keys + unicode-ranges for this call's primary and complement.
    const jobs = new Map();
    const callJobs = new Array(calls.length);

    function ensureJob(absSrc, ext, subsetText, importerDisplay, context) {
      const key =
        subsetText === undefined ? absSrc : `${absSrc}\0${subsetText}`;
      if (!jobs.has(key)) {
        jobs.set(key, { absSrc, ext, subsetText, importerDisplay, context });
      }
      return key;
    }

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];

      let primarySubsetText;
      if (call.text !== undefined) {
        primarySubsetText = canonicalSubsetText(call.text);
      } else if (call.autoSubset) {
        const auto = autoSubsetFor(call);
        if (auto !== undefined) primarySubsetText = auto;
      }

      const primaryCpSet =
        primarySubsetText === undefined
          ? null
          : new Set([...primarySubsetText].map((c) => c.codePointAt(0)));

      // Hedge: compute complement only when primary exists and is a real
      // subset (not the whole transcoded/passthrough font).
      const complementCpSet = await computeComplement(call, primaryCpSet);

      // If hedge applies and the complement is non-empty, both faces get
      // a unicode-range to partition the code-point space. Otherwise the
      // primary keeps the user's optional unicodeRange (or none) verbatim.
      let primaryRange = null;
      let complementRange = null;
      if (complementCpSet) {
        primaryRange = encodeUnicodeRange(
          [...primaryCpSet].sort((a, b) => a - b),
        );
        complementRange = encodeUnicodeRange(
          [...complementCpSet].sort((a, b) => a - b),
        );
      }

      const primaryJobKey = ensureJob(
        call.absSrc,
        call.ext,
        primarySubsetText,
        call.importerDisplay,
        call.context,
      );
      let complementJobKey = null;
      if (complementCpSet) {
        const complementText = String.fromCodePoint(
          ...[...complementCpSet].sort((a, b) => a - b),
        );
        complementJobKey = ensureJob(
          call.absSrc,
          call.ext,
          complementText,
          call.importerDisplay,
          call.context,
        );
      }

      callJobs[i] = {
        primaryJobKey,
        primaryRange,
        complementJobKey,
        complementRange,
      };
    }

    const jobResults = new Map();
    await Promise.all(
      [...jobs.entries()].map(async ([key, job]) => {
        jobResults.set(key, await runJob(job));
      }),
    );

    const preloadHedgeKind = subsetConfig?.preloadHedge ?? false;

    function renderFace(call, url, ext, range) {
      const decls = [`font-family:"${escCssString(call.family)}"`];
      if (call.style !== undefined) decls.push(`font-style:${call.style}`);
      if (call.weight !== undefined) decls.push(`font-weight:${call.weight}`);
      if (call.display !== undefined)
        decls.push(`font-display:${call.display}`);
      // User's explicit unicodeRange wins over a hedge-computed range — that
      // case is gated above (hedge skipped when call.unicodeRange is set).
      const rangeToUse = call.unicodeRange ?? range;
      if (rangeToUse) decls.push(`unicode-range:${rangeToUse}`);
      decls.push(`src:url("${url}") format("${ext}")`);
      return `@font-face{${decls.join(';')}}`;
    }

    const tokenToHtml = new Map();
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const { primaryJobKey, primaryRange, complementJobKey, complementRange } =
        callJobs[i];
      const primary = jobResults.get(primaryJobKey);
      const complement = complementJobKey ? jobResults.get(complementJobKey) : null;

      const faces = [renderFace(call, primary.url, primary.ext, primaryRange)];
      if (complement) {
        faces.push(
          renderFace(call, complement.url, complement.ext, complementRange),
        );
      }
      const styleBlock = `<style>${faces.join('')}</style>`;

      const preloadHtml = [];
      if (call.preload) {
        preloadHtml.push(
          `<link rel="preload" as="font" type="${MIME[primary.ext]}" href="${primary.url}" crossorigin>`,
        );
      }
      if (complement && preloadHedgeKind) {
        preloadHtml.push(
          `<link rel="${preloadHedgeKind}" as="font" type="${MIME[complement.ext]}" href="${complement.url}" crossorigin>`,
        );
      }
      tokenToHtml.set(call.token, preloadHtml.join('') + styleBlock);
    }

    return function substitute(html) {
      if (tokenToHtml.size === 0) return html;
      return html.replace(TOKEN_RE, (m) => tokenToHtml.get(m) ?? m);
    };
  }

  return { forImporter, processAll };
}
