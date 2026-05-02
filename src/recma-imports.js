const SPEC_RE = /^(?:\.\.?\/|\/).+\.(mdx?|jsx?)$|^immolate:[a-z][a-z0-9-]*$/;
const MDX_LIKE_RE = /\.mdx?$/;

function id(name) {
  return { type: 'Identifier', name };
}

function lit(value) {
  return { type: 'Literal', value };
}

function constDecl(idNode, init) {
  return {
    type: 'VariableDeclaration',
    kind: 'const',
    declarations: [{ type: 'VariableDeclarator', id: idNode, init }],
  };
}

function exprStmt(expression) {
  return { type: 'ExpressionStatement', expression };
}

function makeResolveAwait(spec) {
  return {
    type: 'AwaitExpression',
    argument: {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: {
          type: 'MemberExpression',
          object: id('arguments'),
          property: lit(0),
          computed: true,
          optional: false,
        },
        property: id('__immolate_resolve'),
        computed: false,
        optional: false,
      },
      arguments: [lit(spec)],
      optional: false,
    },
  };
}

function literalSpec(node) {
  if (
    node?.type === 'Literal' &&
    typeof node.value === 'string' &&
    SPEC_RE.test(node.value)
  ) {
    return node.value;
  }
  if (
    node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === '_resolveDynamicMdxSpecifier' &&
    node.arguments?.length === 1
  ) {
    return literalSpec(node.arguments[0]);
  }
  return null;
}

function isImportAwait(node) {
  if (node?.type !== 'AwaitExpression') return false;
  if (node.argument?.type !== 'ImportExpression') return false;
  return literalSpec(node.argument.source) != null;
}

function specOf(awaitNode) {
  return literalSpec(awaitNode.argument.source);
}

function isDefaultKey(prop) {
  if (prop.type !== 'Property') return false;
  const k = prop.key;
  if (k.type === 'Identifier') return k.name === 'default';
  if (k.type === 'Literal') return k.value === 'default';
  return false;
}

function splitDefault(pattern) {
  let defaultLocal = null;
  const remaining = [];
  for (const prop of pattern.properties) {
    if (isDefaultKey(prop)) {
      defaultLocal = prop.value;
    } else {
      remaining.push(prop);
    }
  }
  return { defaultLocal, remaining };
}

export function recmaImports() {
  return (tree) => {
    const newBody = [];
    let nsCounter = 0;

    for (const node of tree.body) {
      if (
        node.type === 'ExpressionStatement' &&
        isImportAwait(node.expression)
      ) {
        const spec = specOf(node.expression);
        newBody.push(exprStmt(makeResolveAwait(spec)));
        continue;
      }

      if (node.type !== 'VariableDeclaration' || node.kind !== 'const') {
        newBody.push(node);
        continue;
      }

      const localImportNs = new Map();

      for (const decl of node.declarations) {
        if (decl.id.type === 'Identifier' && isImportAwait(decl.init)) {
          const spec = specOf(decl.init);
          newBody.push(constDecl(id(decl.id.name), makeResolveAwait(spec)));
          localImportNs.set(decl.id.name, {
            spec,
            isMdx: MDX_LIKE_RE.test(spec),
          });
          continue;
        }

        if (decl.id.type === 'ObjectPattern' && isImportAwait(decl.init)) {
          const spec = specOf(decl.init);
          const isMdx = MDX_LIKE_RE.test(spec);

          if (!isMdx) {
            newBody.push(constDecl(decl.id, makeResolveAwait(spec)));
            continue;
          }

          const nsName = `__immolate_ns_${nsCounter++}`;
          newBody.push(constDecl(id(nsName), makeResolveAwait(spec)));
          const { defaultLocal, remaining } = splitDefault(decl.id);
          if (defaultLocal) {
            newBody.push(constDecl(defaultLocal, id(nsName)));
          }
          if (remaining.length > 0) {
            newBody.push(
              constDecl(
                { type: 'ObjectPattern', properties: remaining },
                id(nsName),
              ),
            );
          }
          continue;
        }

        if (
          decl.id.type === 'ObjectPattern' &&
          decl.init?.type === 'Identifier' &&
          localImportNs.has(decl.init.name)
        ) {
          const { isMdx } = localImportNs.get(decl.init.name);
          if (!isMdx) {
            newBody.push({
              type: 'VariableDeclaration',
              kind: 'const',
              declarations: [decl],
            });
            continue;
          }
          const { defaultLocal, remaining } = splitDefault(decl.id);
          if (defaultLocal) {
            newBody.push(constDecl(defaultLocal, id(decl.init.name)));
          }
          if (remaining.length > 0) {
            newBody.push(
              constDecl(
                { type: 'ObjectPattern', properties: remaining },
                id(decl.init.name),
              ),
            );
          }
          continue;
        }

        newBody.push({
          type: 'VariableDeclaration',
          kind: 'const',
          declarations: [decl],
        });
      }
    }

    tree.body = newBody;
  };
}
