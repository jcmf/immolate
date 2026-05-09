import crypto from 'node:crypto';
import path from 'node:path';
import { transcodeToWoff2 } from './font-transcode.js';

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
const MIME = { woff: 'font/woff', woff2: 'font/woff2' };

function escCssString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function makeToken() {
  return `__XTATIC_FONT_${crypto.randomBytes(12).toString('hex')}__`;
}

export function createFontRegistry({
  fs,
  topDir,
  assetRegistry,
  transcode = transcodeToWoff2,
}) {
  const calls = [];
  const jobs = new Map();

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
        preload,
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
      const extraKeys = Object.keys(rest);
      if (extraKeys.length > 0) {
        throw new Error(
          `<Font src="${src}"> received unknown prop(s): ${extraKeys.join(', ')} (in "${displayPath(importerAbsPath)}").`,
        );
      }

      const absSrc = resolveSrc(importerAbsPath, src);
      if (!jobs.has(absSrc)) {
        jobs.set(absSrc, {
          absSrc,
          ext,
          importerDisplay: displayPath(importerAbsPath),
        });
      }

      const token = makeToken();
      calls.push({
        token,
        absSrc,
        family,
        weight,
        style,
        display,
        unicodeRange,
        preload: !!preload,
      });
      return { html: token };
    };
  }

  async function runJob(job) {
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
    if (TRANSCODE_EXTS.has(job.ext)) {
      bytes = await transcode(bytes);
      outExt = 'woff2';
    }
    const url = assetRegistry.emit(bytes, outExt);
    return { url, ext: outExt };
  }

  async function processAll() {
    const jobResults = new Map();
    await Promise.all(
      [...jobs.values()].map(async (job) => {
        jobResults.set(job.absSrc, await runJob(job));
      }),
    );

    const tokenToHtml = new Map();
    for (const call of calls) {
      const { url, ext } = jobResults.get(call.absSrc);
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
