import * as fs from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import importPlugin from 'eslint-plugin-import';
import { flat as mdxFlat } from 'eslint-plugin-mdx';
import globals from 'globals';
import { BUILTIN_SPECS } from './builtins-registry.js';
import xtaticBuiltinImports from './eslint-rules/xtatic-builtin-imports.js';

const SOURCE_EXT_RE = /\.(mdx?|jsx?)$/i;
const XTATIC_IGNORE = BUILTIN_SPECS.map((s) => `^${s}$`);

const xtaticPlugin = {
  rules: { 'builtin-imports': xtaticBuiltinImports },
};

export function makeConfig() {
  const sharedRules = {
    'import/no-unresolved': ['error', { ignore: ['^xtatic:'] }],
    'import/named': 'error',
    'import/no-duplicates': 'error',
    'xtatic/builtin-imports': 'error',
  };
  return [
    {
      ignores: ['node_modules/**', '**/node_modules/**'],
    },
    {
      files: ['**/*.{js,mjs,cjs,jsx}'],
      plugins: { import: importPlugin, xtatic: xtaticPlugin },
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
        'import/ignore': XTATIC_IGNORE,
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
      plugins: { import: importPlugin, xtatic: xtaticPlugin },
      languageOptions: {
        parserOptions: { extensions: ['.md'] },
      },
      settings: {
        'import/resolver': {
          node: { extensions: ['.js', '.jsx', '.mjs', '.cjs', '.md', '.mdx'] },
        },
        'import/ignore': XTATIC_IGNORE,
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
  const output = formatResults(results);
  const err = new Error(`Lint failed with ${errorCount} error${errorCount === 1 ? '' : 's'}:\n\n${output}\n`);
  err.lintFailed = true;
  throw err;
}

// One block per file. Each message is printed on its own line and, when the
// message carries a source-code frame (parse errors do), the frame is emitted
// right under that message — not collected into a separate trailing section.
function formatResults(results) {
  const blocks = [];
  for (const r of results) {
    if (r.messages.length === 0) continue;
    const locWidth = Math.max(
      ...r.messages.map((m) => `${m.line ?? 0}:${m.column ?? 0}`.length),
    );
    const sevWidth = Math.max(
      ...r.messages.map((m) => severityLabel(m.severity).length),
    );
    const lines = [r.filePath];
    for (const m of r.messages) {
      const loc = `${m.line ?? 0}:${m.column ?? 0}`.padEnd(locWidth);
      const sev = severityLabel(m.severity).padEnd(sevWidth);
      const rule = m.ruleId ? `  ${m.ruleId}` : '';
      lines.push(`  ${loc}  ${sev}  ${m.message}${rule}`);
      const frame = frameFor(r, m);
      if (frame) lines.push('', frame, '');
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function severityLabel(severity) {
  return severity === 2 ? 'error' : 'warning';
}

function frameFor(r, m) {
  if (!m.fatal || !m.line) return '';
  const source = r.source ?? safeRead(r.filePath);
  if (!source) return '';
  return renderCodeFrame(source, m.line, m.column, m.endLine, m.endColumn);
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function renderCodeFrame(source, line, column, endLine, endColumn) {
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return '';
  const first = Math.max(1, line - 2);
  const last = Math.min(lines.length, line + 2);
  const gutter = String(last).length;
  const out = [];
  for (let i = first; i <= last; i++) {
    const marker = i === line ? '> ' : '  ';
    const num = String(i).padStart(gutter);
    out.push(`${marker}${num} | ${lines[i - 1]}`);
    if (i === line && column) {
      const caretCol = column - 1;
      const caretLen = endLine === line && endColumn && endColumn > column
        ? endColumn - column
        : 1;
      out.push(`  ${' '.repeat(gutter)} | ${' '.repeat(caretCol)}${'^'.repeat(caretLen)}`);
    }
  }
  return out.join('\n');
}
