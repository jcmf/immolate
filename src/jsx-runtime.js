import { withFrame, attachContext } from './render-context.js';

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

const ATTR_RENAME = {
  className: 'class',
  htmlFor: 'for',
};

export const Fragment = Symbol('xtatic.Fragment');

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

function isHtmlObject(value) {
  return value !== null && typeof value === 'object' && typeof value.html === 'string';
}

function isModule(value) {
  return value !== null && typeof value === 'object' && typeof value.default === 'function';
}

function renderChild(child) {
  if (child == null || child === true || child === false) return '';
  if (Array.isArray(child)) {
    let html = '';
    for (const item of child) html += renderChild(item);
    return html;
  }
  if (isHtmlObject(child)) return child.html;
  if (isModule(child)) {
    const file = child.__xtatic_path;
    if (!file) return renderChild(child.default({}));
    return withFrame({ kind: 'module', file, atFile: null, atLine: null, atColumn: null }, () => {
      try {
        return renderChild(child.default({}));
      } catch (err) {
        throw attachContext(err);
      }
    });
  }
  return escapeText(child);
}

function renderAttrs(props) {
  let attrs = '';
  for (const key of Object.keys(props)) {
    if (key === 'children') continue;
    const value = props[key];
    if (value == null || value === false) continue;
    const name = ATTR_RENAME[key] ?? key;
    if (value === true) {
      attrs += ` ${name}`;
    } else {
      attrs += ` ${name}="${escapeAttr(value)}"`;
    }
  }
  return attrs;
}

export function jsx(type, props = {}) {
  if (type === Fragment) {
    return { html: renderChild(props.children) };
  }

  if (typeof type === 'string') {
    const attrs = renderAttrs(props);
    if (VOID_ELEMENTS.has(type)) {
      return { html: `<${type}${attrs}>` };
    }
    return { html: `<${type}${attrs}>${renderChild(props.children)}</${type}>` };
  }

  if (isModule(type) || typeof type === 'function') {
    const fn = isModule(type) ? type.default : type;
    const result = fn(props);
    return isHtmlObject(result) ? result : { html: renderChild(result) };
  }

  throw new TypeError(`Unsupported JSX type: ${String(type)}`);
}

export const jsxs = jsx;

// Development JSX runtime: same output as `jsx`, but for component/module
// renders it pushes a frame onto the render-context stack (with the call site
// from `source = {fileName, lineNumber, columnNumber}`) and tags any thrown
// error with the live stack. String elements (`<div>`, …) skip framing — too
// many, and their renders don't fail. Both compile pipelines run in
// `development` mode so user JSX always calls this.
export function jsxDEV(type, props, _key, _isStaticChildren, source) {
  if (typeof type === 'string' || type === Fragment) {
    return jsx(type, props);
  }
  return withFrame(componentFrame(type, source), () => {
    try {
      return jsx(type, props);
    } catch (err) {
      throw attachContext(err);
    }
  });
}

function componentFrame(type, source) {
  const atFile = source?.fileName ?? null;
  const atLine = source?.lineNumber ?? null;
  const atColumn = source?.columnNumber ?? null;
  if (isModule(type)) {
    return {
      kind: 'module',
      file: type.__xtatic_path ?? null,
      atFile,
      atLine,
      atColumn,
    };
  }
  return { kind: 'component', name: type?.name || null, atFile, atLine, atColumn };
}
