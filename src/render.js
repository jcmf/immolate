import { jsx } from './jsx-runtime.js';

const MAX_TEMPLATE_DEPTH = 100;

export function renderModule(mm) {
  let current = mm;
  let template = mm.template;
  let depth = 0;
  while (template) {
    if (++depth > MAX_TEMPLATE_DEPTH) {
      throw new Error(
        `Template chain exceeded depth ${MAX_TEMPLATE_DEPTH}; possible cycle.`,
      );
    }
    const inner = current;
    const t = template;
    current = {
      ...t,
      default: (props = {}) => t.default({ ...props, children: inner }),
    };
    template = template.template;
  }
  return jsx(current, {});
}
