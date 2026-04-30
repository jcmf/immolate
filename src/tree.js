function makeChildPages() {
  const obj = {};
  Object.defineProperty(obj, Symbol.iterator, {
    enumerable: false,
    configurable: false,
    writable: false,
    value: function* () {
      for (const name of Object.keys(this).sort()) {
        yield this[name];
      }
    },
  });
  return obj;
}

export function assembleTree(entries) {
  const byKey = new Map();
  let root = null;
  for (const entry of entries) {
    byKey.set(entry.segments.join('/'), entry);
    if (entry.segments.length === 0) root = entry;
  }
  if (!root) {
    throw new Error(
      'No root module found (input_dir must contain index.md or index.mdx).',
    );
  }

  for (const entry of entries) {
    entry.mm.childPages = makeChildPages();
  }

  for (const entry of entries) {
    if (entry.segments.length === 0) continue;
    const parentKey = entry.segments.slice(0, -1).join('/');
    const parent = byKey.get(parentKey);
    if (!parent) {
      throw new Error(
        `Module "${entry.segments.join('/')}" has no parent module at "${parentKey || '(root)'}".`,
      );
    }
    const name = entry.segments[entry.segments.length - 1];
    parent.mm.childPages[name] = entry.mm;
  }

  for (const entry of entries) {
    if (entry.mm.layout !== undefined) continue;
    for (let depth = entry.segments.length; depth >= 0; depth--) {
      const ancestor = byKey.get(entry.segments.slice(0, depth).join('/'));
      if (ancestor && ancestor.mm.defaultLayout !== undefined) {
        entry.mm.layout = ancestor.mm.defaultLayout;
        break;
      }
    }
  }

  return root.mm;
}
