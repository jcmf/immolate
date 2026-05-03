import * as fs from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import importPlugin from 'eslint-plugin-import';
import { flat as mdxFlat } from 'eslint-plugin-mdx';
import globals from 'globals';
import { BUILTIN_SPECS } from './builtins-registry.js';
import immolateBuiltinImports from './eslint-rules/immolate-builtin-imports.js';

const SOURCE_EXT_RE = /\.(mdx?|jsx?)$/i;
const IMMOLATE_IGNORE = BUILTIN_SPECS.map((s) => `^${s}$`);

const immolatePlugin = {
  rules: { 'builtin-imports': immolateBuiltinImports },
};

export function makeConfig() {
  const sharedRules = {
    'import/no-unresolved': ['error', { ignore: ['^immolate:'] }],
    'import/named': 'error',
    'import/no-duplicates': 'error',
    'immolate/builtin-imports': 'error',
  };
  return [
    {
      ignores: ['node_modules/**', '**/node_modules/**'],
    },
    {
      files: ['**/*.{js,mjs,cjs,jsx}'],
      plugins: { import: importPlugin, immolate: immolatePlugin },
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: { ...globals.es2022, ...globals.node },
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      settings: {
        'import/resolver': {
          node: { extensions: ['.js', '.jsx', '.mjs', '.cjs'] },
        },
        'import/ignore': IMMOLATE_IGNORE,
      },
      rules: {
        ...sharedRules,
        'no-undef': 'error',
        'import/default': 'error',
      },
    },
    mdxFlat,
    {
      files: ['**/*.{md,mdx}'],
      plugins: { import: importPlugin, immolate: immolatePlugin },
      languageOptions: {
        parserOptions: { extensions: ['.md'] },
      },
      settings: {
        'import/resolver': {
          node: { extensions: ['.js', '.jsx', '.mjs', '.cjs', '.md', '.mdx'] },
        },
        'import/ignore': IMMOLATE_IGNORE,
      },
      rules: {
        ...sharedRules,
        'no-unused-expressions': 'off',
      },
    },
  ];
}

function walkLintTargets(topDir, outputDir) {
  const results = [];
  const outAbs = path.resolve(outputDir);
  function recurse(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (abs === outAbs) continue;
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      if (ent.isDirectory()) {
        recurse(abs);
      } else if (ent.isFile() && SOURCE_EXT_RE.test(ent.name)) {
        results.push(abs);
      }
    }
  }
  recurse(path.resolve(topDir));
  return results;
}

export async function runLint({ topDir, outputDir }) {
  const files = walkLintTargets(topDir, outputDir);
  if (files.length === 0) return;
  const eslint = new ESLint({
    cwd: path.resolve(topDir),
    overrideConfigFile: true,
    overrideConfig: makeConfig(),
  });
  const results = await eslint.lintFiles(files);
  const errorCount = results.reduce((n, r) => n + r.errorCount, 0);
  if (errorCount === 0) return;
  const formatter = await eslint.loadFormatter('stylish');
  const output = await formatter.format(results);
  const err = new Error(`Lint failed with ${errorCount} error${errorCount === 1 ? '' : 's'}:\n\n${output}`);
  err.lintFailed = true;
  throw err;
}
