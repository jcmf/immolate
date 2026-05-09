import path from 'node:path';
import {
  TRANSCODABLE_FONT_EXTS,
  transcodeToWoff2,
} from './font-transcode.js';

const URL_RE = /url\(([^)]+)\)/g;
const EXT_RE = /\.([a-z0-9]+)$/i;
const FORMAT_HINT_RE = /^(\s*)format\([^)]*\)/;

function isPassthroughUrl(url) {
  return (
    url.startsWith('data:') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('//') ||
    url.startsWith('#')
  );
}

function unquote(inner) {
  const trimmed = inner.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Rewrites url(...) tokens in `css` so each non-passthrough reference is
// resolved (against `sourceAbsPath`'s directory, or against `topDir` if it
// starts with /), read from `fs`, and emitted via `assetRegistry.emit` to a
// content-addressed /_assets/ URL. Caller passes a label-producing
// `notFoundMessage(url, absRef)` so the error wording matches the call site.
export async function rewriteCssUrls({
  css,
  sourceAbsPath,
  fs,
  topDir,
  assetRegistry,
  notFoundMessage,
  transcode = transcodeToWoff2,
}) {
  const sourceDir = path.posix.dirname(sourceAbsPath);
  const matches = [...css.matchAll(URL_RE)];
  if (matches.length === 0) return css;

  const replacements = await Promise.all(
    matches.map(async (m) => {
      const url = unquote(m[1]);
      if (isPassthroughUrl(url)) return null;
      const absRef = url.startsWith('/')
        ? path.posix.join(topDir, url)
        : path.posix.resolve(sourceDir, url);
      let bytes;
      try {
        bytes = await fs.promises.readFile(absRef);
      } catch (e) {
        if (e.code === 'ENOENT') {
          throw new Error(notFoundMessage(url, absRef));
        }
        throw e;
      }
      let ext = (EXT_RE.exec(absRef)?.[1] ?? 'bin').toLowerCase();
      let transcoded = false;
      if (TRANSCODABLE_FONT_EXTS.has(ext)) {
        bytes = await transcode(bytes);
        ext = 'woff2';
        transcoded = true;
      }
      return { url: assetRegistry.emit(bytes, ext), transcoded };
    }),
  );

  let out = '';
  let last = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const r = replacements[i];
    out += css.slice(last, m.index);
    if (r == null) {
      out += m[0];
      last = m.index + m[0].length;
    } else {
      out += `url("${r.url}")`;
      last = m.index + m[0].length;
      if (r.transcoded) {
        const hint = FORMAT_HINT_RE.exec(css.slice(last));
        if (hint) {
          out += `${hint[1]}format("woff2")`;
          last += hint[0].length;
        }
      }
    }
  }
  out += css.slice(last);
  return out;
}
