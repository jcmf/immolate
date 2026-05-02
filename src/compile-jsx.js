import { Parser } from 'acorn';
import jsxAcornPlugin from 'acorn-jsx';
import { generate } from 'astring';
import { buildJsx } from 'estree-util-build-jsx';
import * as runtime from './jsx-runtime.js';
import { recmaImports } from './recma-imports.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ParserWithJsx = Parser.extend(jsxAcornPlugin());

const JSX_RUNTIME_IMPORT_SOURCE = '__immolate_internal_jsx_runtime';
const JSX_RUNTIME_IMPORT = `${JSX_RUNTIME_IMPORT_SOURCE}/jsx-runtime`;

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
function awaitImport(spec) {
  return {
    type: 'AwaitExpression',
    argument: { type: 'ImportExpression', source: lit(spec) },
  };
}
function shorthandProp(name) {
  return {
    type: 'Property',
    key: id(name),
    value: id(name),
    kind: 'init',
    shorthand: true,
    computed: false,
    method: false,
  };
}
function aliasProp(keyName, localName) {
  return {
    type: 'Property',
    key: id(keyName),
    value: id(localName),
    kind: 'init',
    shorthand: keyName === localName,
    computed: false,
    method: false,
  };
}

function expandUserImport(node, mkNs) {
  const spec = node.source.value;
  const props = [];
  let nsLocal = null;

  for (const s of node.specifiers) {
    if (s.type === 'ImportDefaultSpecifier') {
      props.push(aliasProp('default', s.local.name));
    } else if (s.type === 'ImportSpecifier') {
      const importedName =
        s.imported.type === 'Identifier' ? s.imported.name : s.imported.value;
      props.push(aliasProp(importedName, s.local.name));
    } else if (s.type === 'ImportNamespaceSpecifier') {
      nsLocal = s.local.name;
    }
  }

  if (props.length === 0 && !nsLocal) {
    return [{ type: 'ExpressionStatement', expression: awaitImport(spec) }];
  }
  if (nsLocal && props.length === 0) {
    return [constDecl(id(nsLocal), awaitImport(spec))];
  }
  if (nsLocal && props.length > 0) {
    return [
      {
        type: 'VariableDeclaration',
        kind: 'const',
        declarations: [
          {
            type: 'VariableDeclarator',
            id: id(nsLocal),
            init: awaitImport(spec),
          },
          {
            type: 'VariableDeclarator',
            id: { type: 'ObjectPattern', properties: props },
            init: id(nsLocal),
          },
        ],
      },
    ];
  }
  return [
    constDecl({ type: 'ObjectPattern', properties: props }, awaitImport(spec)),
  ];
}

function transformModule(ast) {
  const newBody = [];
  const exportProps = [];
  const runtimeProps = [];
  let nsCounter = 0;

  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      if (node.source.value === JSX_RUNTIME_IMPORT) {
        for (const s of node.specifiers) {
          runtimeProps.push(aliasProp(s.imported.name, s.local.name));
        }
        continue;
      }
      newBody.push(...expandUserImport(node, () => `__immolate_ns_${nsCounter++}`));
      continue;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      if (
        (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') &&
        decl.id
      ) {
        newBody.push(decl);
        exportProps.push(aliasProp('default', decl.id.name));
      } else {
        const local = `__immolate_default_${nsCounter++}`;
        newBody.push(constDecl(id(local), decl));
        exportProps.push(aliasProp('default', local));
      }
      continue;
    }
    if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        throw new Error(
          "Re-exports (export ... from '...') aren't supported in .jsx yet.",
        );
      }
      if (node.declaration) {
        const decl = node.declaration;
        newBody.push(decl);
        if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            if (d.id.type !== 'Identifier') {
              throw new Error(
                "Destructuring exports aren't supported in .jsx yet.",
              );
            }
            exportProps.push(shorthandProp(d.id.name));
          }
        } else if (decl.id?.type === 'Identifier') {
          exportProps.push(shorthandProp(decl.id.name));
        }
        continue;
      }
      if (node.specifiers) {
        for (const s of node.specifiers) {
          const exportedName =
            s.exported.type === 'Identifier' ? s.exported.name : s.exported.value;
          exportProps.push(aliasProp(exportedName, s.local.name));
        }
        continue;
      }
    }
    if (node.type === 'ExportAllDeclaration') {
      throw new Error("`export * from '...'` isn't supported in .jsx yet.");
    }
    newBody.push(node);
  }

  if (runtimeProps.length > 0) {
    newBody.unshift({
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [
        {
          type: 'VariableDeclarator',
          id: { type: 'ObjectPattern', properties: runtimeProps },
          init: {
            type: 'MemberExpression',
            object: id('arguments'),
            property: lit(0),
            computed: true,
            optional: false,
          },
        },
      ],
    });
  }

  newBody.push({
    type: 'ReturnStatement',
    argument: { type: 'ObjectExpression', properties: exportProps },
  });

  ast.body = newBody;
}

async function defaultResolve(spec) {
  throw new Error(
    `Cannot import "${spec}": no resolver was provided to compileJsxSource.`,
  );
}

export async function compileJsxSource(source, options = {}) {
  const resolve = options.resolve ?? defaultResolve;
  const ast = ParserWithJsx.parse(source, {
    sourceType: 'module',
    ecmaVersion: 'latest',
  });
  buildJsx(ast, {
    runtime: 'automatic',
    importSource: JSX_RUNTIME_IMPORT_SOURCE,
  });
  transformModule(ast);
  recmaImports()(ast);
  const code = generate(ast);
  const fn = new AsyncFunction(code);
  return await fn({
    ...runtime,
    __immolate_resolve: resolve,
  });
}
