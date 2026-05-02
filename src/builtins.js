import path from 'node:path';

export function html(s) {
  return { html: String(s) };
}

export function makeReadfile({ fs, topDir, importerAbsPath, importerDisplay }) {
  return function readfile(spec) {
    if (typeof spec !== 'string' || spec.length === 0) {
      throw new Error(
        `readfile: path must be a non-empty string (got ${typeof spec === 'string' ? '""' : typeof spec}).`,
      );
    }
    const absPath = spec.startsWith('/')
      ? path.posix.join(topDir, spec)
      : path.posix.resolve(path.posix.dirname(importerAbsPath), spec);
    try {
      return fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error(
          `readfile("${spec}"): file not found at ${absPath} (requested by "${importerDisplay}").`,
        );
      }
      throw e;
    }
  };
}
