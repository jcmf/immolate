import crypto from 'node:crypto';
import path from 'node:path';
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
const MIME = { woff: 'font/woff', woff2: 'font/woff2' };

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
  if (input === true) return { mode: 'css-static', precision: 'face' };
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
  return { mode, precision };
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
}) {
  const subsetConfig = normalizeFontSubset(fontSubset);
  const calls = [];

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

  async function processAll(pages = [], opts) {
    const autoSubsetFor = resolveAutoSubset(pages, opts);

    // Build jobs from calls (deferred from render-time so auto-subset text can
    // be resolved from `pages` first). Explicit `text=` wins over auto-subset.
    const jobs = new Map();
    const callJobKey = new Array(calls.length);
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      let subsetText;
      if (call.text !== undefined) {
        subsetText = canonicalSubsetText(call.text);
      } else if (call.autoSubset) {
        const auto = autoSubsetFor(call);
        if (auto !== undefined) subsetText = auto;
      }
      const jobKey =
        subsetText === undefined ? call.absSrc : `${call.absSrc}\0${subsetText}`;
      if (!jobs.has(jobKey)) {
        jobs.set(jobKey, {
          absSrc: call.absSrc,
          ext: call.ext,
          subsetText,
          importerDisplay: call.importerDisplay,
          context: call.context,
        });
      }
      callJobKey[i] = jobKey;
    }

    const jobResults = new Map();
    await Promise.all(
      [...jobs.entries()].map(async ([key, job]) => {
        jobResults.set(key, await runJob(job));
      }),
    );

    const tokenToHtml = new Map();
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const { url, ext } = jobResults.get(callJobKey[i]);
      const decls = [`font-family:"${escCssString(call.family)}"`];
      if (call.style !== undefined) decls.push(`font-style:${call.style}`);
      if (call.weight !== undefined) decls.push(`font-weight:${call.weight}`);
      if (call.display !== undefined)
        decls.push(`font-display:${call.display}`);
      if (call.unicodeRange !== undefined)
        decls.push(`unicode-range:${call.unicodeRange}`);
      decls.push(`src:url("${url}") format("${ext}")`);
      const fontFace = `<style>@font-face{${decls.join(';')}}</style>`;
      const preloadHtml = call.preload
        ? `<link rel="preload" as="font" type="${MIME[ext]}" href="${url}" crossorigin>`
        : '';
      tokenToHtml.set(call.token, preloadHtml + fontFace);
    }

    return function substitute(html) {
      if (tokenToHtml.size === 0) return html;
      return html.replace(TOKEN_RE, (m) => tokenToHtml.get(m) ?? m);
    };
  }

  return { forImporter, processAll };
}
