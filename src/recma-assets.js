// Recma plugin: rewrites JSX calls for whitelisted (tag, attribute) pairs so
// the attribute value flows through __immolate_asset(value, opts). Static-string
// data-immolate-placement attributes are pulled out of the props at compile
// time and passed as the second argument.
//
// Two tag-arg shapes are matched:
//   - _jsx('img', { src: ... })           — direct JSX in MDX/JSX source
//   - _jsx(_components.img, { src: ... }) — MDX's lowering of markdown ![alt](...)
//
// At the top of the program body, where `arguments[0]` is the runtime object,
// we inject `const __immolate_asset = arguments[0].__immolate_asset;` so the
// rewritten calls inside _createMdxContent (where `arguments` refers to props)
// can resolve via lexical capture.

const VALID_PLACEMENTS = new Set(['inline', 'shared', 'co-located', 'auto']);
const JSX_CALLEES = new Set(['_jsx', '_jsxs', '_jsxDEV', 'jsx', 'jsxs', 'jsxDEV']);

const DEFAULT_TAG_ATTRS = {
  img: ['src'],
};

function isJsxCallee(node) {
  return node?.type === 'Identifier' && JSX_CALLEES.has(node.name);
}

function isStringLiteral(node) {
  return node?.type === 'Literal' && typeof node.value === 'string';
}

function tagNameOf(node) {
  if (isStringLiteral(node)) return node.value;
  if (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property?.type === 'Identifier'
  ) {
    return node.property.name;
  }
  return null;
}

function propKeyName(prop) {
  if (prop.type !== 'Property') return null;
  const k = prop.key;
  if (k.type === 'Identifier' && !prop.computed) return k.name;
  if (k.type === 'Literal' && typeof k.value === 'string') return k.value;
  return null;
}

function findProp(propsNode, name) {
  if (propsNode?.type !== 'ObjectExpression') return null;
  for (const prop of propsNode.properties) {
    if (propKeyName(prop) === name) return prop;
  }
  return null;
}

function makeAssetCall(originalValue, placement) {
  const callArgs = [originalValue];
  if (placement) {
    callArgs.push({
      type: 'ObjectExpression',
      properties: [
        {
          type: 'Property',
          key: { type: 'Identifier', name: 'placement' },
          value: { type: 'Literal', value: placement },
          kind: 'init',
          shorthand: false,
          computed: false,
          method: false,
        },
      ],
    });
  }
  return {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: '__immolate_asset' },
    arguments: callArgs,
    optional: false,
  };
}

function makeTopDecl() {
  return {
    type: 'VariableDeclaration',
    kind: 'const',
    declarations: [
      {
        type: 'VariableDeclarator',
        id: { type: 'Identifier', name: '__immolate_asset' },
        init: {
          type: 'MemberExpression',
          object: {
            type: 'MemberExpression',
            object: { type: 'Identifier', name: 'arguments' },
            property: { type: 'Literal', value: 0 },
            computed: true,
            optional: false,
          },
          property: { type: 'Identifier', name: '__immolate_asset' },
          computed: false,
          optional: false,
        },
      },
    ],
  };
}

function processJsxCall(node, tagAttrs) {
  if (!isJsxCallee(node.callee)) return false;
  if (node.arguments.length < 2) return false;
  const tagName = tagNameOf(node.arguments[0]);
  if (!tagName) return false;
  const attrs = tagAttrs[tagName];
  if (!attrs) return false;
  const propsNode = node.arguments[1];
  if (propsNode?.type !== 'ObjectExpression') return false;

  let placement;
  const placementProp = findProp(propsNode, 'data-immolate-placement');
  if (placementProp) {
    if (
      isStringLiteral(placementProp.value) &&
      VALID_PLACEMENTS.has(placementProp.value.value)
    ) {
      placement = placementProp.value.value;
      propsNode.properties = propsNode.properties.filter(
        (p) => p !== placementProp,
      );
    }
  }
  const passPlacement = placement && placement !== 'auto' ? placement : null;

  let rewrote = false;
  for (const attr of attrs) {
    const prop = findProp(propsNode, attr);
    if (!prop) continue;
    prop.value = makeAssetCall(prop.value, passPlacement);
    rewrote = true;
  }
  return rewrote;
}

function walk(node, tagAttrs, state) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, tagAttrs, state);
    return;
  }
  if (typeof node !== 'object' || typeof node.type !== 'string') return;
  if (node.type === 'CallExpression') {
    if (processJsxCall(node, tagAttrs)) state.rewrote = true;
  }
  for (const key in node) {
    if (
      key === 'type' ||
      key === 'loc' ||
      key === 'range' ||
      key === 'start' ||
      key === 'end' ||
      key === 'parent' ||
      key === 'comments'
    )
      continue;
    walk(node[key], tagAttrs, state);
  }
}

export function recmaAssets(opts = {}) {
  const tagAttrs = opts.tagAttrs ?? DEFAULT_TAG_ATTRS;
  return (tree) => {
    const state = { rewrote: false };
    walk(tree, tagAttrs, state);
    if (state.rewrote && tree.type === 'Program') {
      tree.body.unshift(makeTopDecl());
    }
  };
}
