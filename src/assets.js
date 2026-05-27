import crypto from 'node:crypto';
import path from 'node:path';

// Emitted-asset references are placeholders until the final substitute pass,
// where they're rewritten to a path *relative* to the file that contains the
// reference (a page, or a CSS file in _assets/ or co-located). This keeps the
// output free of root-absolute `/_assets/…` URLs, so a site works when served
// from any subpath.
const EMIT_TOKEN_RE = /__XTATIC_EMIT_([a-f0-9]+\.[a-z0-9]+)__/g;
// Only text assets can carry emit placeholders inside their bytes: css-urls is
// the sole producer that embeds them, and only into CSS. Binary assets are
// written verbatim (and must not be round-tripped through utf8).
const RELATIVIZE_EXTS = new Set(['css']);

export function createAssetRegistry({ fs, outputDir, assetsDir = '_assets' }) {
  const emissions = new Map();
  const assetsRoot = `${outputDir}/${assetsDir}`;

  function emit(bytes, ext) {
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const fname = `${hash}.${ext}`;
    if (!emissions.has(fname)) {
      emissions.set(fname, { absPath: `${assetsRoot}/${fname}`, bytes, ext });
    }
    return `__XTATIC_EMIT_${fname}__`;
  }

  // Replace every emit placeholder in `text` with a path relative to `fromDir`
  // — the output directory of the file that will *contain* the reference.
  // Callers: index.js (page HTML, fromDir = the page's dir), writeAll below
  // (shared CSS, fromDir = _assets/), and assets-plain writeAll (co-located
  // CSS, fromDir = the co-located file's dir).
  function relativize(text, fromDir) {
    return text.replace(EMIT_TOKEN_RE, (_, fname) => {
      const rel = path.posix.relative(fromDir, `${assetsRoot}/${fname}`);
      return rel === '' ? fname : rel;
    });
  }

  async function writeAll() {
    if (emissions.size === 0) return;
    const dirs = new Set();
    for (const { absPath, bytes, ext } of emissions.values()) {
      const dir = absPath.substring(0, absPath.lastIndexOf('/'));
      if (!dirs.has(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
        dirs.add(dir);
      }
      const out = RELATIVIZE_EXTS.has(ext)
        ? Buffer.from(relativize(bytes.toString('utf8'), assetsRoot), 'utf8')
        : bytes;
      await fs.promises.writeFile(absPath, out);
    }
  }

  return { emit, relativize, writeAll };
}
