import { jsx } from './jsx-runtime.js';

const MAX_LAYOUT_DEPTH = 100;

export function renderModule(mm) {
  let current = mm;
  let layout = mm.layout;
  let depth = 0;
  while (layout) {
    if (++depth > MAX_LAYOUT_DEPTH) {
      throw new Error(
        `Layout chain exceeded depth ${MAX_LAYOUT_DEPTH}; possible cycle.`,
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
