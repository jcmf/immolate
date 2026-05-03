import crypto from 'node:crypto';
import path from 'node:path';
import { rewriteCssUrls } from './css-urls.js';

const DEFAULT_INLINE_THRESHOLD = 2048;
const TOKEN_RE = /__IMMOLATE_STYLE_[a-f0-9]+__/g;

function escAttr(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renameAttr(k) {
  if (k === 'className') return 'class';
  if (k === 'htmlFor') return 'for';
  return k;
}

function renderAttrString(attrs) {
  const parts = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (v === true) parts.push(k);
    else parts.push(`${k}="${escAttr(v)}"`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function makeToken() {
  return `__IMMOLATE_STYLE_${crypto.randomBytes(12).toString('hex')}__`;
}

export function createStyleRegistry({
  fs,
  topDir,
  assetRegistry,
  defaultInlineThreshold = DEFAULT_INLINE_THRESHOLD,
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
    return function Style(props = {}) {
      const { src, inlineThreshold, children: _children, ...rest } = props;

      if (typeof src !== 'string' || src.length === 0) {
        throw new Error(
          `<Style> requires a non-empty src (in "${displayPath(importerAbsPath)}").`,
        );
      }

      const absSrc = resolveSrc(importerAbsPath, src);
      if (!jobs.has(absSrc)) {
        jobs.set(absSrc, {
          absSrc,
          importerDisplay: displayPath(importerAbsPath),
        });
      }

      const token = makeToken();
      const threshold =
        typeof inlineThreshold === 'number'
          ? inlineThreshold
          : defaultInlineThreshold;
      calls.push({ token, absSrc, passThrough: rest, threshold });
      return { html: token };
    };
  }

  async function processAll() {
    const jobResults = new Map();
    await Promise.all(
      [...jobs.values()].map(async (job) => {
        let raw;
        try {
          raw = await fs.promises.readFile(job.absSrc, 'utf8');
        } catch (e) {
          if (e.code === 'ENOENT') {
            throw new Error(
              `<Style>: source not found at ${job.absSrc} (requested by "${job.importerDisplay}").`,
            );
          }
          throw e;
        }
        jobResults.set(
          job.absSrc,
          await rewriteCssUrls({
            css: raw,
            sourceAbsPath: job.absSrc,
            fs,
            topDir,
            assetRegistry,
            notFoundMessage: (url, absRef) =>
              `<Style>: url("${url}") not found at ${absRef} (referenced from "${job.importerDisplay}").`,
          }),
        );
      }),
    );

    const tokenToHtml = new Map();
    for (const call of calls) {
      const css = jobResults.get(call.absSrc);
      const passAttrs = {};
      for (const [k, v] of Object.entries(call.passThrough)) {
        passAttrs[renameAttr(k)] = v;
      }
      const sizeBytes = Buffer.byteLength(css, 'utf8');
      let html;
      if (sizeBytes <= call.threshold) {
        html = `<style${renderAttrString(passAttrs)}>${css}</style>`;
      } else {
        const url = assetRegistry.emit(Buffer.from(css, 'utf8'), 'css');
        const ordered = { rel: 'stylesheet', href: url };
        for (const [k, v] of Object.entries(passAttrs)) {
          if (!(k in ordered)) ordered[k] = v;
        }
        html = `<link${renderAttrString(ordered)}>`;
      }
      tokenToHtml.set(call.token, html);
    }

    return function substitute(html) {
      if (tokenToHtml.size === 0) return html;
      return html.replace(TOKEN_RE, (m) => tokenToHtml.get(m) ?? m);
    };
  }

  return { forImporter, processAll };
}
