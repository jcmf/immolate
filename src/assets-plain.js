import crypto from 'node:crypto';
import path from 'node:path';
import { VALID_PLACEMENTS } from './asset-rules.js';
import { rewriteCssUrls } from './css-urls.js';
import { createOutputWriter } from './output.js';
import { attachContext, currentStack } from './render-context.js';

const TOKEN_RE = /__XTATIC_ASSET_[a-f0-9]+__/g;
// Any registry token (asset/image/style/font), anchored — used to make asset()
// idempotent when a manual asset() result flows into a whitelisted attribute.
const ANY_XTATIC_TOKEN_RE = /^__XTATIC_(?:ASSET|IMG|STYLE|FONT)_[a-f0-9]+__$/;
const EXT_RE = /\.([a-z0-9]+)$/i;

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
};

function makeToken() {
  return `__XTATIC_ASSET_${crypto.randomBytes(12).toString('hex')}__`;
}

function isPassthroughUrl(s) {
  return (
    s.startsWith('data:') ||
    s.startsWith('http://') ||
    s.startsWith('https://') ||
    s.startsWith('//') ||
    s.startsWith('#') ||
    s.startsWith('mailto:') ||
    s.startsWith('tel:')
  );
}

function mimeFromExt(ext) {
  return MIME[ext] ?? 'application/octet-stream';
}

function escAttrValue(s) {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

// A page renders to `<dir>/index.html`; a link to it should point at the
// directory (clean URL) rather than the literal index.html file. Override
// pages (outputPath naming a real file like feed.xml) are linked as-is.
function cleanPageUrl(rel) {
  if (rel === 'index.html') return './';
  if (rel.endsWith('/index.html')) {
    return rel.slice(0, -'index.html'.length);
  }
  return rel;
}

export function createPlainAssetRegistry({
  fs,
  topDir,
  outputDir,
  assetRegistry,
  defaultInlineThreshold = 4096,
  writer,
}) {
  // The build's shared output writer (skip-if-unchanged writes + prune
  // bookkeeping); registry-only unit tests get a private one.
  writer = writer ?? createOutputWriter({ fs, outputDir });
  const calls = [];
  const colocatedWrites = new Map();
  // absSrc → rewritten CSS text, populated during processAll for any `.css`
  // entry. Kept around so the font-cascade engine (commit 3) can call
  // cssForPage(html) and learn which stylesheets reach each page.
  const resolvedCss = new Map();

  function displayPath(absPath) {
    const rel = path.posix.relative(topDir, absPath);
    return rel && !rel.startsWith('..') ? rel : absPath;
  }

  function resolveSrc(importerAbsPath, src) {
    if (src.startsWith('/')) return path.posix.join(topDir, src);
    return path.posix.resolve(path.posix.dirname(importerAbsPath), src);
  }

  function forImporter(importerAbsPath) {
    return function asset(value, opts = {}) {
      if (typeof value !== 'string') return value;
      if (value === '') return value;
      if (isPassthroughUrl(value)) return value;
      // Already an xtatic placeholder/token — e.g. a manual `asset()` call whose
      // result lands in a now-whitelisted attribute like <a href={asset(...)}>,
      // which recma-assets would otherwise wrap a second time. Idempotent.
      if (ANY_XTATIC_TOKEN_RE.test(value)) return value;
      // Split off a trailing ?query / #fragment so the path portion resolves
      // and the suffix re-attaches to the rewritten URL (e.g. an <a href> to
      // "./about.md#install" or an "./icon.svg#glyph" sprite reference).
      const suffixMatch = value.match(/[?#].*$/s);
      const suffix = suffixMatch ? suffixMatch[0] : '';
      const pathPart = suffix ? value.slice(0, -suffix.length) : value;
      if (pathPart === '') return value;
      const placement = opts.placement;
      if (placement !== undefined && !VALID_PLACEMENTS.has(placement)) {
        throw new Error(
          `asset("${value}"): invalid placement "${placement}" (use "inline", "shared", "co-located", or "auto"; in "${displayPath(importerAbsPath)}").`,
        );
      }
      const absSrc = resolveSrc(importerAbsPath, pathPart);
      const token = makeToken();
      // recma-assets passes the `<img>`/`<link>`/… call site (tag + file:line:col)
      // for whitelisted attrs; the `__xtatic_asset` call itself isn't wrapped in a
      // withFrame, so synthesize that frame on top of the live stack snapshot.
      const context = currentStack();
      if (opts.locFile) {
        context.push({
          kind: 'component',
          name: opts.tag ?? null,
          atFile: opts.locFile,
          atLine: opts.locLine ?? null,
          atColumn: opts.locColumn ?? null,
        });
      }
      calls.push({
        token,
        importerAbsPath,
        absSrc,
        srcDisplay: value,
        suffix,
        placement,
        kind: opts.kind ?? null,
        context,
      });
      return token;
    };
  }

  function isAssetUnderPage(assetAbsSrc, pageOutPath) {
    const relAssetFromTop = path.posix.relative(topDir, assetAbsSrc);
    if (relAssetFromTop.startsWith('..')) return false;
    const assetOutAbs = path.posix.join(outputDir, relAssetFromTop);
    const assetOutDir = path.posix.dirname(assetOutAbs);
    const pageOutDir = path.posix.dirname(pageOutPath);
    if (assetOutDir === pageOutDir) return true;
    return assetOutDir.startsWith(`${pageOutDir}/`);
  }

  async function processAll(pages) {
    if (calls.length === 0) {
      return function substitute(html) {
        return html;
      };
    }

    const tokenToPage = new Map();
    // Source-file → output-path for every page in the build, so an <a href> /
    // <area href> pointing at another page's source (e.g. "./about.md") can be
    // rewritten to that page's rendered location rather than copied as a file.
    const pageOutBySrc = new Map();
    for (const page of pages) {
      if (page.srcPath) pageOutBySrc.set(page.srcPath, page.outPath);
      const found = page.html.match(TOKEN_RE);
      if (!found) continue;
      for (const t of found) tokenToPage.set(t, page.outPath);
    }

    const bySrc = new Map();
    for (const call of calls) {
      if (!tokenToPage.has(call.token)) continue;
      const pageOutPath = tokenToPage.get(call.token);
      let entry = bySrc.get(call.absSrc);
      if (!entry) {
        entry = {
          absSrc: call.absSrc,
          calls: [],
          pages: new Set(),
          explicitPlacement: undefined,
          ext: (EXT_RE.exec(call.absSrc)?.[1] ?? 'bin').toLowerCase(),
          targetPageOut: pageOutBySrc.get(call.absSrc),
        };
        bySrc.set(call.absSrc, entry);
      }
      entry.calls.push({ ...call, pageOutPath });
      entry.pages.add(pageOutPath);
      // A link to a page resolves to that page's URL, not a copied file —
      // placement is meaningless, so skip the placement bookkeeping.
      if (entry.targetPageOut === undefined && call.placement && call.placement !== 'auto') {
        if (
          entry.explicitPlacement &&
          entry.explicitPlacement !== call.placement
        ) {
          throw attachContext(
            new Error(
              `Conflicting placement for "${call.srcDisplay}": got "${entry.explicitPlacement}" and "${call.placement}" (in "${displayPath(call.importerAbsPath)}").`,
            ),
            call.context,
          );
        }
        entry.explicitPlacement = call.placement;
      }
    }

    await Promise.all(
      [...bySrc.values()]
        .filter((entry) => entry.targetPageOut === undefined)
        .map(async (entry) => {
        try {
          try {
            entry.bytes = await fs.promises.readFile(entry.absSrc);
          } catch (e) {
            if (e.code === 'ENOENT') {
              const importer = displayPath(entry.calls[0].importerAbsPath);
              throw new Error(
                `Asset not found at ${entry.absSrc} (referenced from "${importer}").`,
              );
            }
            throw e;
          }
          if (entry.ext === 'css') {
            const rewritten = await rewriteCssUrls({
              css: entry.bytes.toString('utf8'),
              sourceAbsPath: entry.absSrc,
              fs,
              topDir,
              assetRegistry,
              notFoundMessage: (url, absRef) =>
                `Asset url("${url}") not found at ${absRef} (referenced from "${displayPath(entry.absSrc)}").`,
            });
            entry.bytes = Buffer.from(rewritten, 'utf8');
            resolvedCss.set(entry.absSrc, rewritten);
          }
        } catch (e) {
          throw attachContext(e, entry.calls[0]?.context);
        }
      }),
    );

    function decidePlacement(entry) {
      if (entry.explicitPlacement) {
        if (entry.explicitPlacement === 'co-located') {
          for (const pageOutPath of entry.pages) {
            if (isAssetUnderPage(entry.absSrc, pageOutPath)) return 'co-located';
          }
          throw attachContext(
            new Error(
              `Cannot co-locate "${displayPath(entry.absSrc)}": its source is not at-or-below any consuming page's output directory.`,
            ),
            entry.calls[0]?.context,
          );
        }
        return entry.explicitPlacement;
      }
      if (entry.bytes.length <= defaultInlineThreshold) return 'inline';
      if (entry.pages.size === 1) {
        const [pageOutPath] = entry.pages;
        if (isAssetUnderPage(entry.absSrc, pageOutPath)) return 'co-located';
      }
      return 'shared';
    }

    const tokenToResolver = new Map();
    const stylesheetInlineTokens = new Map();

    for (const entry of bySrc.values()) {
      // Link to another page: resolve to that page's output URL, relative to
      // the linking page's own directory.
      if (entry.targetPageOut !== undefined) {
        const targetOut = entry.targetPageOut;
        for (const call of entry.calls) {
          tokenToResolver.set(call.token, (outPath) => {
            const rel = path.posix.relative(
              path.posix.dirname(outPath),
              targetOut,
            );
            return cleanPageUrl(rel) + call.suffix;
          });
        }
        continue;
      }
      const placement = decidePlacement(entry);
      switch (placement) {
        case 'inline': {
          const url = `data:${mimeFromExt(entry.ext)};base64,${entry.bytes.toString('base64')}`;
          const cssText =
            entry.ext === 'css' ? entry.bytes.toString('utf8') : null;
          for (const call of entry.calls) {
            if (cssText != null && call.kind === 'stylesheet') {
              stylesheetInlineTokens.set(call.token, cssText);
            } else {
              tokenToResolver.set(call.token, () => url + call.suffix);
            }
          }
          break;
        }
        case 'shared': {
          const url = assetRegistry.emit(entry.bytes, entry.ext);
          for (const call of entry.calls) {
            tokenToResolver.set(call.token, () => url + call.suffix);
          }
          break;
        }
        case 'co-located': {
          const relFromTop = path.posix.relative(topDir, entry.absSrc);
          const assetOutAbs = path.posix.join(outputDir, relFromTop);
          const existing = colocatedWrites.get(assetOutAbs);
          if (existing && !existing.equals(entry.bytes)) {
            throw attachContext(
              new Error(
                `Co-located output collision at ${assetOutAbs}: different bytes.`,
              ),
              entry.calls[0]?.context,
            );
          }
          colocatedWrites.set(assetOutAbs, entry.bytes);
          for (const call of entry.calls) {
            tokenToResolver.set(call.token, (outPath) => {
              const pageOutDir = path.posix.dirname(outPath);
              return path.posix.relative(pageOutDir, assetOutAbs) + call.suffix;
            });
          }
          break;
        }
      }
    }

    return function substitute(html, outPath) {
      if (tokenToResolver.size === 0 && stylesheetInlineTokens.size === 0) {
        return html;
      }
      let out = html;
      for (const [token, css] of stylesheetInlineTokens) {
        const re = new RegExp(
          `<link\\b([^>]*\\bhref="${token}"[^>]*)>`,
          'g',
        );
        out = out.replace(re, (_, attrs) => {
          const cleaned = attrs
            .replace(/\s+rel\s*=\s*"[^"]*"/i, '')
            .replace(/\s+href\s*=\s*"[^"]*"/i, '')
            .replace(/\s*\/$/, '')
            .trim();
          const sep = cleaned ? ' ' : '';
          return `<style${sep}${cleaned}>${css}</style>`;
        });
      }
      if (tokenToResolver.size === 0) return out;
      return out.replace(TOKEN_RE, (m) => {
        const resolver = tokenToResolver.get(m);
        if (!resolver) return m;
        return escAttrValue(resolver(outPath));
      });
    };
  }

  async function writeAll() {
    if (colocatedWrites.size === 0) return;
    for (const [absPath, bytes] of colocatedWrites) {
      // A co-located .css can carry emit placeholders for url()-referenced
      // assets that went to _assets/; rewrite them relative to this file's dir.
      const dir = path.posix.dirname(absPath);
      const ext = (EXT_RE.exec(absPath)?.[1] ?? '').toLowerCase();
      const out =
        ext === 'css'
          ? Buffer.from(
              assetRegistry.relativize(bytes.toString('utf8'), dir),
              'utf8',
            )
          : bytes;
      await writer.writeFile(absPath, out);
    }
  }

  // Returns the resolved CSS text of every stylesheet-kind asset token that
  // appears in `html`, deduped by source. Must be called after processAll();
  // counterpart to styleRegistry.cssForPage. Non-stylesheet `.css` refs (e.g.
  // <link rel=preload as=style>) are excluded — they're emitted as data:/asset
  // URLs and the browser only fetches them if the cascade calls for it, but
  // for static analysis of which CSS *rules* reach a page they don't apply.
  function cssForPage(html) {
    const tokens = html.match(TOKEN_RE);
    if (!tokens) return [];
    const tokenSet = new Set(tokens);
    const srcs = new Set();
    for (const call of calls) {
      if (call.kind !== 'stylesheet') continue;
      if (tokenSet.has(call.token)) srcs.add(call.absSrc);
    }
    const out = [];
    for (const src of srcs) {
      const css = resolvedCss.get(src);
      if (css != null) out.push(css);
    }
    return out;
  }

  return { forImporter, processAll, cssForPage, writeAll };
}
