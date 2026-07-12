// Extensions that make a file a page source: .md/.mdx (compiled through MDX)
// and .html (shipped verbatim after asset processing).
const EXT_RE = /\.(?:mdx?|html)$/;

// `{name}` placeholder tokens in a filename — the slug template for a page
// generator (e.g. `tag-{tag}.md`). The name must be a valid identifier so it
// can map to a pages-item key. `_G` (global) is for extraction/substitution;
// the bare one is for `.test()` so we never juggle `lastIndex`.
const PLACEHOLDER_RE_G = /\{([A-Za-z_$][\w$]*)\}/g;
const PLACEHOLDER_RE = /\{([A-Za-z_$][\w$]*)\}/;

export function isPagePath(relPath) {
  return EXT_RE.test(relPath);
}

// The names of `[placeholder]` tokens in a filename, in order (may repeat).
export function extractPlaceholders(filename) {
  const names = [];
  for (const m of filename.matchAll(PLACEHOLDER_RE_G)) names.push(m[1]);
  return names;
}

// True when a relPath's filename carries `{placeholder}` tokens (it's a page
// generator). Placeholders in a directory segment are unsupported in v1 and
// throw rather than being silently treated as a literal directory name.
export function hasPlaceholders(relPath) {
  const segments = relPath.split('/');
  const filename = segments.pop();
  for (const seg of segments) {
    if (PLACEHOLDER_RE.test(seg)) {
      throw new Error(
        `Path placeholder in directory segment "${seg}" of "${relPath}" is not supported; placeholders may only appear in the filename.`,
      );
    }
  }
  return PLACEHOLDER_RE.test(filename);
}

// Replace each `{name}` in a filename with `values[name]`, validating that the
// substituted value is a single, non-empty path segment. `ctx` (template name +
// pages index) is woven into error messages so a bad item is easy to find.
export function substituteFilename(filename, values, ctx = {}) {
  const where = ctx.template ? ` in template "${ctx.template}"` : '';
  const at = ctx.index != null ? ` (pages[${ctx.index}])` : '';
  return filename.replace(PLACEHOLDER_RE_G, (_, name) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(
        `Missing value for filename placeholder "{${name}}"${where}${at}: each pages item must provide "${name}".`,
      );
    }
    if (typeof value !== 'string') {
      throw new Error(
        `Filename placeholder "{${name}}"${where}${at} must be a string (got ${typeof value}).`,
      );
    }
    if (value === '' || value === '.' || value === '..' || value.includes('/')) {
      throw new Error(
        `Invalid value ${JSON.stringify(value)} for filename placeholder "{${name}}"${where}${at}: must be a non-empty path segment with no "/".`,
      );
    }
    return value;
  });
}

export function resolveLogicalPath(relPath) {
  if (!EXT_RE.test(relPath)) {
    throw new Error(`Not a page source file: ${relPath}`);
  }
  const withoutExt = relPath.replace(EXT_RE, '');
  const segments = withoutExt.split('/').filter((s) => s.length > 0);
  if (segments.length > 0 && segments[segments.length - 1] === 'index') {
    segments.pop();
  }
  return segments;
}

export function resolveLogicalPaths(relPaths) {
  const claimed = new Map();
  const entries = [];
  for (const relPath of relPaths) {
    const segments = resolveLogicalPath(relPath);
    const key = segments.join('/');
    if (claimed.has(key)) {
      const existing = claimed.get(key);
      const label = key === '' ? '(root)' : key;
      throw new Error(
        `Multiple input files map to the same output path "${label}": ${existing} and ${relPath}`,
      );
    }
    claimed.set(key, relPath);
    entries.push({ relPath, segments });
  }
  return entries;
}
