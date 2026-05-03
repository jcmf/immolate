import { BUILTIN_EXPORTS, BUILTIN_SPECS } from '../builtins-registry.js';

const SCHEME_RE = /^immolate:/;

function listSpecs() {
  return BUILTIN_SPECS.map((s) => `"${s}"`).join(', ');
}

function listExports(spec) {
  return BUILTIN_EXPORTS[spec].map((n) => `"${n}"`).join(', ');
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Validate imports from immolate:* builtin modules against the known export registry',
    },
    schema: [],
    messages: {
      unknownSpec:
        'Unknown immolate builtin module "{{spec}}". Available: {{available}}.',
      defaultImport:
        '"{{spec}}" has no default export. Use `import {{exportList}} from "{{spec}}"` instead.',
      namespaceImport:
        'Namespace import from "{{spec}}" is unsupported. Use `import {{exportList}} from "{{spec}}"` instead.',
      unknownNamed:
        '"{{spec}}" has no export named "{{name}}". Available: {{available}}.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const spec = node.source.value;
        if (typeof spec !== 'string' || !SCHEME_RE.test(spec)) return;

        if (!(spec in BUILTIN_EXPORTS)) {
          context.report({
            node: node.source,
            messageId: 'unknownSpec',
            data: { spec, available: listSpecs() },
          });
          return;
        }

        const exports = BUILTIN_EXPORTS[spec];
        const exportList = `{${exports.join(', ')}}`;

        for (const sp of node.specifiers) {
          if (sp.type === 'ImportDefaultSpecifier') {
            context.report({
              node: sp,
              messageId: 'defaultImport',
              data: { spec, exportList },
            });
          } else if (sp.type === 'ImportNamespaceSpecifier') {
            context.report({
              node: sp,
              messageId: 'namespaceImport',
              data: { spec, exportList },
            });
          } else if (sp.type === 'ImportSpecifier') {
            const name = sp.imported.name ?? sp.imported.value;
            if (!exports.includes(name)) {
              context.report({
                node: sp,
                messageId: 'unknownNamed',
                data: { spec, name, available: listExports(spec) },
              });
            }
          }
        }
      },
    };
  },
};
