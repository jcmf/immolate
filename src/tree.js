import title from 'title';

const NAME_PATTERN =
  /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2}))(?:-(.*))?$/;

function nameDefaults(name) {
  const m = NAME_PATTERN.exec(name);
  let date;
  let remainder = name;
  if (m) {
    const y = m[1] ?? m[4];
    const mo = m[2] ?? m[5];
    const d = m[3] ?? m[6];
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) {
      date = `${y}-${mo}-${d}`;
      remainder = m[7] ?? '';
    }
  }
  let titleStr;
  if (remainder !== '') {
    const spaced = remainder.replaceAll('-', ' ');
    titleStr = spaced === spaced.toLowerCase() ? title(spaced) : spaced;
  }
  return { date, title: titleStr };
}

export function assembleTree(entries, options = {}) {
  const byKey = new Map();
  let root = null;
  for (const entry of entries) {
    byKey.set(entry.segments.join('/'), entry);
    if (entry.segments.length === 0) root = entry;
  }
  if (!root) {
    const where = options.inputDir ? ` in "${options.inputDir}"` : '';
    throw new Error(
      `No root module found${where}: create index.md or index.mdx there.`,
    );
  }

  for (const entry of entries) {
    entry.mm.childPages = [];
  }

  for (const entry of entries) {
    if (entry.segments.length === 0) continue;
    const parentKey = entry.segments.slice(0, -1).join('/');
    const parent = byKey.get(parentKey);
    if (!parent) {
      throw new Error(
        `Module "${entry.relPath}" has no parent module at "${parentKey}": create ${parentKey}/index.md or ${parentKey}/index.mdx.`,
      );
    }
    const name = entry.segments[entry.segments.length - 1];
    entry.mm.name = name;
    const defaults = nameDefaults(name);
    if (entry.mm.date === undefined && defaults.date !== undefined) {
      entry.mm.date = defaults.date;
    }
    if (entry.mm.title === undefined && defaults.title !== undefined) {
      entry.mm.title = defaults.title;
    }
    parent.mm.childPages.push(entry.mm);
  }

  for (const entry of entries) {
    entry.mm.childPages.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
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
