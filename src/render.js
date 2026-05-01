import { jsx } from './jsx-runtime.js';

const MAX_LAYOUT_DEPTH = 100;

function layoutLabel(mm) {
  return mm.name ?? '(layout)';
}

export function renderModule(mm) {
  let current = mm;
  let layout = mm.layout;
  const visited = new Set([mm]);
  const chain = [layoutLabel(mm)];
  while (layout) {
    if (visited.has(layout)) {
      chain.push(layoutLabel(layout));
      throw new Error(`Layout cycle detected: ${chain.join(' → ')}.`);
    }
    visited.add(layout);
    chain.push(layoutLabel(layout));
    if (chain.length > MAX_LAYOUT_DEPTH) {
      throw new Error(
        `Layout chain exceeded depth ${MAX_LAYOUT_DEPTH}: ${chain.slice(0, 10).join(' → ')} → … (${chain.length} total).`,
      );
    }
    const inner = current;
    const t = layout;
    current = {
      ...t,
      default: (props = {}) => t.default({ ...props, children: inner }),
    };
    layout = layout.layout;
  }
  return jsx(current, {});
}
