'use strict';

// Custom eslint-plugin-import resolver that teaches the import-correctness rules
// about xtatic's leading-"/" convention: in .md/.mdx/.jsx files a spec like
// "/components/Foo.md" resolves against the project root (topDir, threaded in
// via the resolver config), not the filesystem root that the stock node
// resolver would assume. Everything else (./, ../, bare/npm specs) is delegated
// to eslint-import-resolver-node unchanged, so genuinely-broken paths still
// report { found: false } and keep firing import/no-unresolved.
//
// .js files are deliberately NOT remapped: they load through Node's real
// import() (see CLAUDE.md), where "/foo" really is a filesystem-absolute path —
// so the lint behavior matches the build behavior in both directions.
//
// CommonJS (.cjs) on purpose: eslint-module-utils require()s the resolver and
// xtatic's package.json is "type":"module".

const path = require('path');
const node = require('eslint-import-resolver-node');

// Files whose imports flow through xtatic's __xtatic_resolve at build time
// (src/recma-imports.js rewrites them; src/registry.js resolveSpec maps "/" to
// topDir). Keep in sync with resolveSpec.
const XTATIC_RESOLVED = /\.(mdx?|jsx)$/i;

exports.interfaceVersion = 2;

exports.resolve = function resolve(source, file, config) {
  let spec = source;
  const topDir = config && config.topDir;
  if (topDir && source.startsWith('/') && XTATIC_RESOLVED.test(file)) {
    spec = path.join(topDir, source);
  }
  return node.resolve(spec, file, config);
};
