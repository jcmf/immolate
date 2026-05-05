// Recma plugin: makes a module's own properties (childPages, layout,
// frontmatter, named exports, etc.) accessible as bare identifiers inside JSX
// expressions. It scope-analyzes `_createMdxContent`, collects identifiers
// that aren't bound anywhere up the chain (and aren't well-known globals),
// and prepends `const { … } = props.__xtatic_self ?? {};` to the function
// body. The registry sets `props.__xtatic_self = mm` at render call time.

const GLOBALS = new Set([
  'globalThis', 'undefined', 'NaN', 'Infinity', 'arguments', 'this',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Symbol', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Function',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
  'console',
]);

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.set = new Set();
  }
  declare(name) {
    this.set.add(name);
  }
  has(name) {
    if (this.set.has(name)) return true;
    if (this.parent) return this.parent.has(name);
    return GLOBALS.has(name);
  }
}

function declarePattern(p, scope) {
  if (!p) return;
  switch (p.type) {
    case 'Identifier':
      scope.declare(p.name);
      return;
    case 'ObjectPattern':
      for (const prop of p.properties) {
        if (prop.type === 'RestElement') declarePattern(prop.argument, scope);
        else declarePattern(prop.value, scope);
      }
      return;
    case 'ArrayPattern':
      for (const el of p.elements) if (el) declarePattern(el, scope);
      return;
    case 'AssignmentPattern':
      declarePattern(p.left, scope);
      return;
    case 'RestElement':
      declarePattern(p.argument, scope);
      return;
  }
}

// Pre-declare hoisted names (var, function, class, const/let at this level)
// for a list of statements. Doesn't recurse into nested functions.
function preDeclare(stmts, scope) {
  if (!Array.isArray(stmts)) return;
  for (const node of stmts) {
    if (!node) continue;
    if (node.type === 'FunctionDeclaration' && node.id) {
      scope.declare(node.id.name);
    } else if (node.type === 'ClassDeclaration' && node.id) {
      scope.declare(node.id.name);
    } else if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) declarePattern(decl.id, scope);
    } else if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration
    ) {
      preDeclare([node.declaration], scope);
    } else if (node.type === 'ExportDefaultDeclaration') {
      // export default function foo() {} hoists `foo`
      if (node.declaration?.type === 'FunctionDeclaration' && node.declaration.id) {
        scope.declare(node.declaration.id.name);
      }
    }
  }
}

function walkPatternDefaults(p, scope, refs) {
  if (!p) return;
  switch (p.type) {
    case 'AssignmentPattern':
      walk(p.right, scope, refs, p, 'right');
      walkPatternDefaults(p.left, scope, refs);
      return;
    case 'ObjectPattern':
      for (const prop of p.properties) {
        if (prop.type === 'Property' && prop.computed) {
          walk(prop.key, scope, refs, prop, 'key');
        }
        if (prop.type === 'RestElement') {
          walkPatternDefaults(prop.argument, scope, refs);
        } else if (prop.value) {
          walkPatternDefaults(prop.value, scope, refs);
        }
      }
      return;
    case 'ArrayPattern':
      for (const el of p.elements) if (el) walkPatternDefaults(el, scope, refs);
      return;
    case 'RestElement':
      walkPatternDefaults(p.argument, scope, refs);
      return;
  }
}

function walk(node, scope, refs, parent, key) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, scope, refs, parent, key);
    return;
  }
  if (typeof node !== 'object' || typeof node.type !== 'string') return;

  switch (node.type) {
    case 'Identifier': {
      if (parent) {
        if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
        if (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) return;
        if (parent.type === 'MethodDefinition' && key === 'key' && !parent.computed) return;
        if (parent.type === 'PropertyDefinition' && key === 'key' && !parent.computed) return;
        if (parent.type === 'JSXAttribute' && key === 'name') return;
        if (parent.type === 'LabeledStatement' && key === 'label') return;
        if (parent.type === 'BreakStatement' && key === 'label') return;
        if (parent.type === 'ContinueStatement' && key === 'label') return;
        if (parent.type === 'ImportSpecifier' && key === 'imported') return;
        if (parent.type === 'ExportSpecifier' && key === 'exported') return;
      }
      if (!scope.has(node.name)) refs.add(node.name);
      return;
    }

    case 'VariableDeclaration': {
      for (const decl of node.declarations) {
        if (decl.init) walk(decl.init, scope, refs, decl, 'init');
        walkPatternDefaults(decl.id, scope, refs);
        declarePattern(decl.id, scope);
      }
      return;
    }

    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const inner = new Scope(scope);
      if (node.type === 'FunctionExpression' && node.id) {
        inner.declare(node.id.name);
      }
      if (node.body && node.body.type === 'BlockStatement') {
        preDeclare(node.body.body, inner);
      }
      for (const param of node.params) {
        walkPatternDefaults(param, inner, refs);
        declarePattern(param, inner);
      }
      walk(node.body, inner, refs, node, 'body');
      return;
    }

    case 'CatchClause': {
      const inner = new Scope(scope);
      if (node.param) declarePattern(node.param, inner);
      walk(node.body, inner, refs, node, 'body');
      return;
    }

    case 'BlockStatement': {
      walk(node.body, scope, refs, node, 'body');
      return;
    }

    case 'Property': {
      if (node.computed) walk(node.key, scope, refs, node, 'key');
      else if (node.shorthand && node.key.type === 'Identifier') {
        if (!scope.has(node.key.name)) refs.add(node.key.name);
      }
      walk(node.value, scope, refs, node, 'value');
      return;
    }

    case 'MemberExpression': {
      walk(node.object, scope, refs, node, 'object');
      if (node.computed) walk(node.property, scope, refs, node, 'property');
      return;
    }

    case 'ImportDeclaration':
      return;

    case 'ObjectPattern':
    case 'ArrayPattern':
    case 'RestElement':
    case 'AssignmentPattern':
      return;
  }

  for (const k in node) {
    if (k === 'type' || k === 'loc' || k === 'range' || k === 'start' || k === 'end' || k === 'parent' || k === 'comments') continue;
    const v = node[k];
    if (v && (typeof v === 'object' || Array.isArray(v))) {
      walk(v, scope, refs, node, k);
    }
  }
}

function id(name) {
  return { type: 'Identifier', name };
}

function buildSelfDestructure(names) {
  const properties = names.map((name) => ({
    type: 'Property',
    key: id(name),
    value: id(name),
    kind: 'init',
    shorthand: true,
    computed: false,
    method: false,
  }));
  return {
    type: 'VariableDeclaration',
    kind: 'const',
    declarations: [
      {
        type: 'VariableDeclarator',
        id: { type: 'ObjectPattern', properties },
        init: {
          type: 'LogicalExpression',
          operator: '??',
          left: {
            type: 'MemberExpression',
            object: id('props'),
            property: id('__xtatic_self'),
            computed: false,
            optional: false,
          },
          right: { type: 'ObjectExpression', properties: [] },
        },
      },
    ],
  };
}

export function recmaSelf() {
  return (tree) => {
    const programScope = new Scope();
    preDeclare(tree.body, programScope);

    const target = tree.body.find(
      (n) => n.type === 'FunctionDeclaration' && n.id?.name === '_createMdxContent',
    );
    if (!target || target.body?.type !== 'BlockStatement') return;

    const fnScope = new Scope(programScope);
    preDeclare(target.body.body, fnScope);
    for (const param of target.params) {
      declarePattern(param, fnScope);
    }

    const refs = new Set();
    for (const stmt of target.body.body) {
      walk(stmt, fnScope, refs, target.body, 'body');
    }

    if (refs.size === 0) return;

    const names = [...refs].sort();
    target.body.body.unshift(buildSelfDestructure(names));
  };
}
