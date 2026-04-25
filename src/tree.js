const TEMPLATE_NAME = 'template';

function makeChildModules() {
  const obj = {};
  Object.defineProperty(obj, Symbol.iterator, {
    enumerable: false,
    configurable: false,
    writable: false,
    value: function* () {
      for (const name of Object.keys(this).sort()) {
        const child = this[name];
        if (!child.hidden) yield child;
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
    entry.mm.child_modules = makeChildModules();
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
    parent.mm.child_modules[name] = entry.mm;
  }

  for (const entry of entries) {
    if (entry.mm.hidden !== undefined) continue;
    const name = entry.segments[entry.segments.length - 1];
    entry.mm.hidden = name === TEMPLATE_NAME;
  }

  for (const entry of entries) {
    if (entry.mm.template !== undefined) continue;
    if (entry.segments.length === 0) continue;
    const name = entry.segments[entry.segments.length - 1];
    if (name === TEMPLATE_NAME) continue;

    for (let depth = entry.segments.length - 1; depth >= 0; depth--) {
      const ancestor = byKey.get(entry.segments.slice(0, depth).join('/'));
      const t = ancestor?.mm.child_modules[TEMPLATE_NAME];
      if (t) {
        entry.mm.template = t;
        break;
      }
    }
  }

  return root.mm;
}
