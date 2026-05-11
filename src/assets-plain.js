import crypto from 'node:crypto';
import path from 'node:path';
import { rewriteCssUrls } from './css-urls.js';
import { attachContext, currentStack } from './render-context.js';

const TOKEN_RE = /__XTATIC_ASSET_[a-f0-9]+__/g;
const EXT_RE = /\.([a-z0-9]+)$/i;
const VALID_PLACEMENTS = new Set(['inline', 'shared', 'co-located', 'auto']);

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

export function createPlainAssetRegistry({
  fs,
  topDir,
  outputDir,
  assetRegistry,
  defaultInlineThreshold = 4096,
}) {
  const calls = [];
  const colocatedWrites = new Map();

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
      const placement = opts.placement;
      if (placement !== undefined && !VALID_PLACEMENTS.has(placement)) {
        throw new Error(
          `asset("${value}"): invalid placement "${placement}" (use "inline", "shared", "co-located", or "auto"; in "${displayPath(importerAbsPath)}").`,
        );
      }
      const absSrc = resolveSrc(importerAbsPath, value);
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
    for (const page of pages) {
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
        };
        bySrc.set(call.absSrc, entry);
      }
      entry.calls.push({ ...call, pageOutPath });
      entry.pages.add(pageOutPath);
      if (call.placement && call.placement !== 'auto') {
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
      [...bySrc.values()].map(async (entry) => {
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
              tokenToResolver.set(call.token, () => url);
            }
          }
          break;
        }
        case 'shared': {
          const url = assetRegistry.emit(entry.bytes, entry.ext);
          for (const call of entry.calls) {
            tokenToResolver.set(call.token, () => url);
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
              return path.posix.relative(pageOutDir, assetOutAbs);
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
    const dirs = new Set();
    for (const [absPath, bytes] of colocatedWrites) {
      const dir = path.posix.dirname(absPath);
      if (!dirs.has(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
        dirs.add(dir);
      }
      await fs.promises.writeFile(absPath, bytes);
    }
  }

  return { forImporter, processAll, writeAll };
}
