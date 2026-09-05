import crypto from 'node:crypto';
import path from 'node:path';
import { createErrorCollector } from './errors.js';
import { attachContext, currentStack } from './render-context.js';
import { loadOptionalDep } from './install.js';

const DEFAULT_INLINE_THRESHOLD = 8192;
const VALID_FORMATS = new Set(['avif', 'webp', 'jpeg', 'jpg', 'png']);
const FIT_VALUES = new Set(['cover', 'contain', 'fill', 'inside', 'outside']);
const SVG_RE = /\.svg$/i;
const TOKEN_RE = /__XTATIC_IMG_[a-f0-9]+__/g;

const MIME = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
};

let sharpPromise = null;
function loadSharp({ autoInstall, topDir, install } = {}) {
  if (sharpPromise) return sharpPromise;
  const p = loadOptionalDep({
    pkg: 'sharp',
    importer: async () => (await import('sharp')).default,
    autoInstall,
    topDir,
    install,
    missingMessage: `<Image> requires the 'sharp' package, which is not installed. Run: npm install sharp`,
  });
  sharpPromise = p;
  p.catch(() => {
    if (sharpPromise === p) sharpPromise = null;
  });
  return p;
}

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
  return `__XTATIC_IMG_${crypto.randomBytes(12).toString('hex')}__`;
}

export function createImageRegistry({
  fs,
  topDir,
  assetRegistry,
  defaultInlineThreshold = DEFAULT_INLINE_THRESHOLD,
  autoInstall = false,
  install,
  // Build-wide error collector (see errors.js); strict by default. See the
  // matching note in style.js.
  errors = createErrorCollector(),
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
    return function Image(props = {}) {
      const {
        src,
        alt,
        width,
        height,
        format,
        quality,
        fit,
        inlineThreshold,
        children: _children,
        ...rest
      } = props;

      if (typeof src !== 'string' || src.length === 0) {
        throw new Error(
          `<Image> requires a non-empty src (in "${displayPath(importerAbsPath)}").`,
        );
      }
      if (alt === undefined) {
        throw new Error(
          `<Image src="${src}"> requires an alt attribute (use alt="" for purely decorative images, in "${displayPath(importerAbsPath)}").`,
        );
      }

      const absSrc = resolveSrc(importerAbsPath, src);
      const isSvg = SVG_RE.test(absSrc);

      if (isSvg && format !== undefined) {
        throw new Error(
          `<Image src="${src}">: format option is not supported for SVG sources (in "${displayPath(importerAbsPath)}").`,
        );
      }

      let opts;
      if (isSvg) {
        opts = { kind: 'svg' };
      } else {
        const fmt = format ?? 'avif';
        if (!VALID_FORMATS.has(fmt)) {
          throw new Error(
            `<Image src="${src}">: format must be one of ${[...VALID_FORMATS].join(', ')}; got "${fmt}".`,
          );
        }
        if (fit !== undefined && !FIT_VALUES.has(fit)) {
          throw new Error(
            `<Image src="${src}">: fit must be one of ${[...FIT_VALUES].join(', ')}; got "${fit}".`,
          );
        }
        opts = {
          kind: 'raster',
          width: typeof width === 'number' ? width : null,
          height: typeof height === 'number' ? height : null,
          format: fmt,
          quality: typeof quality === 'number' ? quality : null,
          fit: fit ?? 'inside',
        };
      }

      const jobKey = `${absSrc}|${JSON.stringify(opts)}`;
      if (!jobs.has(jobKey)) {
        jobs.set(jobKey, {
          absSrc,
          opts,
          importerDisplay: displayPath(importerAbsPath),
          context: currentStack(),
        });
      }

      const token = makeToken();
      const threshold =
        typeof inlineThreshold === 'number'
          ? inlineThreshold
          : defaultInlineThreshold;
      calls.push({
        token,
        jobKey,
        alt,
        passThrough: rest,
        threshold,
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
            `<Image>: source not found at ${job.absSrc} (requested by "${job.importerDisplay}").`,
          );
        }
        throw e;
      }

      if (job.opts.kind === 'svg') {
        return {
          bytes,
          format: 'svg',
          mediaType: MIME.svg,
          width: null,
          height: null,
        };
      }

      const sharp = await loadSharp({ autoInstall, topDir, install });
      let pipeline = sharp(bytes).rotate();
      if (job.opts.width != null || job.opts.height != null) {
        pipeline = pipeline.resize({
          width: job.opts.width ?? undefined,
          height: job.opts.height ?? undefined,
          fit: job.opts.fit,
          withoutEnlargement: true,
        });
      }
      const formatOpts =
        job.opts.quality != null ? { quality: job.opts.quality } : {};
      pipeline = pipeline.toFormat(job.opts.format, formatOpts);
      let out;
      try {
        out = await pipeline.toBuffer({ resolveWithObject: true });
      } catch (e) {
        throw new Error(
          `<Image>: failed to process source "${job.importerDisplay}" → ${path.posix.basename(job.absSrc)}: ${e.message}`,
        );
      }
      return {
        bytes: out.data,
        format: job.opts.format,
        mediaType: MIME[job.opts.format],
        width: out.info.width,
        height: out.info.height,
      };
    } catch (e) {
      throw attachContext(e, job.context);
    }
  }

  async function processAll() {
    const jobResults = new Map();
    await Promise.all(
      [...jobs.entries()].map(async ([key, job]) => {
        try {
          jobResults.set(key, await runJob(job));
        } catch (e) {
          errors.report(e);
        }
      }),
    );

    const tokenToHtml = new Map();

    for (const call of calls) {
      const result = jobResults.get(call.jobKey);
      if (result === undefined) continue; // job failed (keep-going): token stays
      const { bytes, format, mediaType, width, height } = result;

      let urlSrc;
      if (bytes.length <= call.threshold) {
        urlSrc = `data:${mediaType};base64,${bytes.toString('base64')}`;
      } else {
        const ext = format === 'jpg' ? 'jpg' : format;
        urlSrc = assetRegistry.emit(bytes, ext);
      }

      const attrs = {};
      for (const [k, v] of Object.entries(call.passThrough)) {
        attrs[renameAttr(k)] = v;
      }
      const ordered = { src: urlSrc, alt: call.alt };
      if (width != null && attrs.width === undefined) ordered.width = width;
      if (height != null && attrs.height === undefined) ordered.height = height;
      for (const [k, v] of Object.entries(attrs)) {
        if (!(k in ordered)) ordered[k] = v;
      }
      tokenToHtml.set(call.token, `<img${renderAttrString(ordered)}>`);
    }

    return function substitute(html) {
      if (tokenToHtml.size === 0) return html;
      return html.replace(TOKEN_RE, (m) => tokenToHtml.get(m) ?? m);
    };
  }

  return { forImporter, processAll };
}
