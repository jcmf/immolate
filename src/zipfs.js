import { unzipSync } from 'fflate';

const ZIP_SEG_RE = /\.zip\//;

function splitZipPath(p) {
  if (typeof p !== 'string') return null;
  const m = ZIP_SEG_RE.exec(p);
  if (!m) return null;
  const idx = m.index;
  const zipPath = p.slice(0, idx + 4);
  const entryPath = p.slice(idx + 5);
  if (entryPath === '') return null;
  return { zipPath, entryPath };
}

function asUint8(b) {
  if (b instanceof Uint8Array) return b;
  return new Uint8Array(b);
}

function decode(bytes, encoding) {
  const buf = Buffer.from(bytes);
  if (!encoding) return buf;
  const enc = typeof encoding === 'string' ? encoding : encoding?.encoding;
  return enc ? buf.toString(enc) : buf;
}

function getEntry(entries, entryPath, fullPath) {
  const bytes = entries[entryPath];
  if (!bytes) {
    const known = Object.keys(entries)
      .filter((n) => !n.endsWith('/'))
      .sort()
      .join(', ');
    const err = new Error(
      `ENOENT: no entry "${entryPath}" inside zip (path: ${fullPath}). Available entries: ${known || '(none)'}.`,
    );
    err.code = 'ENOENT';
    throw err;
  }
  return bytes;
}

export function wrapZipFs(fs) {
  const cache = new Map();
  const pending = new Map();

  function loadSync(zipPath) {
    let entries = cache.get(zipPath);
    if (!entries) {
      const bytes = fs.readFileSync(zipPath);
      entries = unzipSync(asUint8(bytes));
      cache.set(zipPath, entries);
    }
    return entries;
  }

  function loadAsync(zipPath) {
    const cached = cache.get(zipPath);
    if (cached) return Promise.resolve(cached);
    let p = pending.get(zipPath);
    if (p) return p;
    p = (async () => {
      const bytes = await fs.promises.readFile(zipPath);
      const entries = unzipSync(asUint8(bytes));
      cache.set(zipPath, entries);
      pending.delete(zipPath);
      return entries;
    })();
    pending.set(zipPath, p);
    return p;
  }

  return {
    ...fs,
    readFileSync(p, encoding) {
      const split = splitZipPath(p);
      if (!split) return fs.readFileSync(p, encoding);
      const entries = loadSync(split.zipPath);
      const bytes = getEntry(entries, split.entryPath, p);
      return decode(bytes, encoding);
    },
    promises: {
      ...fs.promises,
      async readFile(p, encoding) {
        const split = splitZipPath(p);
        if (!split) return fs.promises.readFile(p, encoding);
        const entries = await loadAsync(split.zipPath);
        const bytes = getEntry(entries, split.entryPath, p);
        return decode(bytes, encoding);
      },
    },
  };
}
