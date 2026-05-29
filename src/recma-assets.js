// Recma plugin: rewrites JSX calls for whitelisted (tag, attribute) pairs so
// the attribute value flows through __xtatic_asset(value, opts). Static-string
// data-xtatic-placement attributes are pulled out of the props at compile
// time and passed as the second argument.
//
// Two tag-arg shapes are matched:
//   - _jsx('img', { src: ... })           — direct JSX in MDX/JSX source
//   - _jsx(_components.img, { src: ... }) — MDX's lowering of markdown ![alt](...)
//
// At the top of the program body, where `arguments[0]` is the runtime object,
// we inject `const __xtatic_asset = arguments[0].__xtatic_asset;` so the
// rewritten calls inside _createMdxContent (where `arguments` refers to props)
// can resolve via lexical capture.

const VALID_PLACEMENTS = new Set(['inline', 'shared', 'co-located', 'auto']);
const JSX_CALLEES = new Set(['_jsx', '_jsxs', '_jsxDEV', 'jsx', 'jsxs', 'jsxDEV']);

const ASSET_LINK_RELS = new Set([
  'stylesheet',
  'icon',
  'shortcut',
  'apple-touch-icon',
  'apple-touch-icon-precomposed',
  'mask-icon',
  'preload',
  'prefetch',
  'modulepreload',
  'manifest',
]);

function linkRelTokens(propsNode) {
  const relProp = findProp(propsNode, 'rel');
  if (!relProp || !isStringLiteral(relProp.value)) return null;
  return relProp.value.value.toLowerCase().split(/\s+/);
}

function linkRelIsAsset(propsNode) {
  const tokens = linkRelTokens(propsNode);
  if (!tokens) return false;
  return tokens.some((r) => ASSET_LINK_RELS.has(r));
}

function linkKind(propsNode) {
  const tokens = linkRelTokens(propsNode);
  if (tokens && tokens.includes('stylesheet')) return 'stylesheet';
  return null;
}

// Each rule lists attributes to rewrite, optionally guarded by a predicate
// over the props ObjectExpression. Bare-list shorthand (e.g. ['src']) is
// treated as { attrs: ['src'] } with no predicate.
const DEFAULT_TAG_RULES = {
  img: ['src'],
  script: ['src'],
  source: ['src'],
  audio: ['src'],
  video: ['src', 'poster'],
  link: { attrs: ['href'], predicate: linkRelIsAsset, getKind: linkKind },
  a: ['href'],
  area: ['href'],
};

function normalizeRule(rule) {
  if (Array.isArray(rule)) return { attrs: rule, predicate: null, getKind: null };
  return {
    attrs: rule.attrs,
    predicate: rule.predicate ?? null,
    getKind: rule.getKind ?? null,
  };
}

function isJsxCallee(node) {
  return node?.type === 'Identifier' && JSX_CALLEES.has(node.name);
}

function isStringLiteral(node) {
  return node?.type === 'Literal' && typeof node.value === 'string';
}

// In `development` mode (always, for us), the lowered call is
// `_jsxDEV(type, props, key, isStaticChildren, {fileName, lineNumber,
// columnNumber}, this)` — argument index 4 is the source object literal that
// `estree-util-build-jsx` builds. Pull the call site out of it so it can ride
// along into __xtatic_asset for error reporting. Returns null for the
// production `_jsx`/`_jsxs` shape (no source argument).
function extractLoc(node) {
  const src = node.arguments[4];
  if (!src || src.type !== 'ObjectExpression') return null;
  const fileProp = findProp(src, 'fileName');
  if (!isStringLiteral(fileProp?.value)) return null;
  const numProp = (name) => {
    const p = findProp(src, name);
    return p?.value?.type === 'Literal' && typeof p.value.value === 'number'
      ? p.value.value
      : null;
  };
  return {
    file: fileProp.value.value,
    line: numProp('lineNumber'),
    column: numProp('columnNumber'),
  };
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

function makeAssetCall(originalValue, optsObj) {
  const callArgs = [originalValue];
  const entries = Object.entries(optsObj).filter(([, v]) => v != null);
  if (entries.length > 0) {
    callArgs.push({
      type: 'ObjectExpression',
      properties: entries.map(([k, v]) => ({
        type: 'Property',
        key: { type: 'Identifier', name: k },
        value: { type: 'Literal', value: v },
        kind: 'init',
        shorthand: false,
        computed: false,
        method: false,
      })),
    });
  }
  return {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: '__xtatic_asset' },
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
        id: { type: 'Identifier', name: '__xtatic_asset' },
        init: {
          type: 'MemberExpression',
          object: {
            type: 'MemberExpression',
            object: { type: 'Identifier', name: 'arguments' },
            property: { type: 'Literal', value: 0 },
            computed: true,
            optional: false,
          },
          property: { type: 'Identifier', name: '__xtatic_asset' },
          computed: false,
          optional: false,
        },
      },
    ],
  };
}

function processJsxCall(node, tagRules) {
  if (!isJsxCallee(node.callee)) return false;
  if (node.arguments.length < 2) return false;
  const tagName = tagNameOf(node.arguments[0]);
  if (!tagName) return false;
  const rule = tagRules[tagName];
  if (!rule) return false;
  const propsNode = node.arguments[1];
  if (propsNode?.type !== 'ObjectExpression') return false;
  const { attrs, predicate, getKind } = normalizeRule(rule);
  if (predicate && !predicate(propsNode)) return false;

  let placement;
  const placementProp = findProp(propsNode, 'data-xtatic-placement');
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
  const kind = getKind ? getKind(propsNode) : null;
  const loc = extractLoc(node);

  let rewrote = false;
  for (const attr of attrs) {
    const prop = findProp(propsNode, attr);
    if (!prop) continue;
    prop.value = makeAssetCall(prop.value, {
      placement: passPlacement,
      kind,
      tag: loc ? tagName : null,
      locFile: loc?.file ?? null,
      locLine: loc?.line ?? null,
      locColumn: loc?.column ?? null,
    });
    rewrote = true;
  }
  return rewrote;
}

function walk(node, tagRules, state) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, tagRules, state);
    return;
  }
  if (typeof node !== 'object' || typeof node.type !== 'string') return;
  if (node.type === 'CallExpression') {
    if (processJsxCall(node, tagRules)) state.rewrote = true;
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
    walk(node[key], tagRules, state);
  }
}

export function recmaAssets(opts = {}) {
  const tagRules = opts.tagRules ?? DEFAULT_TAG_RULES;
  return (tree) => {
    const state = { rewrote: false };
    walk(tree, tagRules, state);
    if (state.rewrote && tree.type === 'Program') {
      tree.body.unshift(makeTopDecl());
    }
  };
}
