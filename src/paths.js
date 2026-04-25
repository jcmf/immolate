const EXT_RE = /\.mdx?$/;

export function isMdxPath(relPath) {
  return EXT_RE.test(relPath);
}

export function resolveLogicalPath(relPath) {
  if (!EXT_RE.test(relPath)) {
    throw new Error(`Not an MDX file: ${relPath}`);
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
