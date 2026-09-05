import path from 'node:path';

const URL_RE = /url\(([^)]+)\)/g;
const EXT_RE = /\.([a-z0-9]+)$/i;

// Same rule as assets-plain.js: any scheme-prefixed value is not a file.
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isPassthroughUrl(url) {
  return SCHEME_RE.test(url) || url.startsWith('//') || url.startsWith('#');
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
      const ext = (EXT_RE.exec(absRef)?.[1] ?? 'bin').toLowerCase();
      return assetRegistry.emit(bytes, ext);
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
    } else {
      out += `url("${r}")`;
    }
    last = m.index + m[0].length;
  }
  out += css.slice(last);
  return out;
}
