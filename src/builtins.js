import path from 'node:path';

export function html(s) {
  return { html: String(s) };
}

// Turn a page module (the objects in `childPages`, or anything reached via
// `import`) into a link to its rendered output, relative to whatever page the
// link ends up on. Delegates to `asset` with the page's `/`-rooted source
// path, so the page-link rewriting (clean dir URLs, outputPath overrides,
// per-page relative resolution) applies — and the result is a deferred token,
// so it resolves wherever it lands, not just inside <a href>.
export function makePageHref({ asset, importerDisplay }) {
  return function pageHref(page) {
    if (
      page == null ||
      typeof page !== 'object' ||
      typeof page.__xtatic_path !== 'string'
    ) {
      const got =
        page == null ? String(page) : `a ${typeof page} without a source path`;
      throw new Error(
        `pageHref: expected a page module (e.g. an entry of childPages), got ${got} (in "${importerDisplay}").`,
      );
    }
    return asset(`/${page.__xtatic_path}`);
  };
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
