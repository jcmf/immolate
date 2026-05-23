import * as fs from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import importPlugin from 'eslint-plugin-import';
import { flat as mdxFlat } from 'eslint-plugin-mdx';
import globals from 'globals';
import { BUILTIN_SPECS } from './builtins-registry.js';
import xtaticBuiltinImports from './eslint-rules/xtatic-builtin-imports.js';
import { color, colorEnabled, highlight } from './log.js';

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

export async function runLint({ topDir, outputDir, codeFrameWidth = 120 }) {
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
  const output = formatResults(results, codeFrameWidth);
  const err = new Error(`Lint failed with ${errorCount} error${errorCount === 1 ? '' : 's'}:\n\n${output}\n`);
  err.lintFailed = true;
  throw err;
}

// One block per file. Each message is printed on its own line and, when the
// message carries a source-code frame (parse errors do), the frame is emitted
// right under that message — not collected into a separate trailing section.
function formatResults(results, codeFrameWidth) {
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
      const frame = frameFor(r, m, codeFrameWidth);
      if (frame) lines.push('', frame, '');
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function severityLabel(severity) {
  return severity === 2 ? 'error' : 'warning';
}

function frameFor(r, m, codeFrameWidth) {
  if (!m.fatal || !m.line) return '';
  const source = r.source ?? safeRead(r.filePath);
  if (!source) return '';
  return renderCodeFrame(source, m.line, m.column, m.endLine, m.endColumn, codeFrameWidth);
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

const ELLIPSIS = '…';

// Clip a long source line down to `maxWidth` visible columns. The error line is
// windowed *around* its span (so the offending region stays on screen even when
// it sits deep in a long line), with `…` markers on whichever ends were cut;
// context lines are left-anchored (we keep their start). `maxWidth` of 0 (or a
// line already within budget) means no clipping. Returns the visible body plus
// the span's offset/length within it (clamped to the window) for the caller to
// place the caret or the highlight. `start` is the 0-indexed span column.
function windowLine(text, maxWidth, start, len) {
  if (!maxWidth || text.length <= maxWidth) {
    return { body: text, spanStart: start, spanLen: len };
  }
  if (start == null) {
    // Context line: keep the head, mark the tail as cut.
    return { body: text.slice(0, maxWidth) + ELLIPSIS, spanStart: null, spanLen: 0 };
  }
  // Center the window on the span, clamped within the line, then pin to the
  // right edge if centering ran past end-of-line so we always use the full width.
  const anchor = Math.min(start, text.length);
  let winStart = Math.max(0, anchor - Math.floor((maxWidth - Math.min(len, maxWidth)) / 2));
  let winEnd = Math.min(text.length, winStart + maxWidth);
  winStart = Math.max(0, winEnd - maxWidth);
  const prefix = winStart > 0 ? ELLIPSIS : '';
  const suffix = winEnd < text.length ? ELLIPSIS : '';
  const body = prefix + text.slice(winStart, winEnd) + suffix;
  const spanStart = prefix.length + (start - winStart);
  // Clip the span to what's visible in the window (it may extend past winEnd).
  const spanLen = Math.min(len, body.length - suffix.length - spanStart);
  return { body, spanStart, spanLen };
}

// When color is on, the offending span is highlighted inline on the source line
// itself (self-locating — it survives soft-wrapping of a long line, unlike a
// caret on a separate row). When color is off (NO_COLOR, piped output, CI), we
// fall back to the classic caret row so plain-text consumers still get a marker.
// Lines wider than `maxWidth` are windowed first (see windowLine).
function renderCodeFrame(source, line, column, endLine, endColumn, maxWidth = 0) {
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return '';
  const first = Math.max(1, line - 2);
  const last = Math.min(lines.length, line + 2);
  const gutter = String(last).length;
  const useColor = colorEnabled();
  const out = [];
  for (let i = first; i <= last; i++) {
    const isErr = i === line;
    const marker = isErr ? '> ' : '  ';
    const num = String(i).padStart(gutter);
    if (isErr && column) {
      const len = endLine === line && endColumn && endColumn > column
        ? endColumn - column
        : 1;
      const w = windowLine(lines[i - 1], maxWidth, column - 1, len);
      const start = w.spanStart;
      if (useColor) {
        const before = w.body.slice(0, start);
        // An empty slice means the error sits past end-of-line; paint one space
        // so there's still a visible block (the caret row had the same fudge).
        const span = w.body.slice(start, start + Math.max(1, w.spanLen)) || ' ';
        const after = w.body.slice(start + Math.max(1, w.spanLen));
        out.push(`${color('red', `${marker}${num}`)} | ${before}${highlight(span)}${after}`);
      } else {
        out.push(`${marker}${num} | ${w.body}`);
        out.push(`  ${' '.repeat(gutter)} | ${' '.repeat(start)}${'^'.repeat(Math.max(1, w.spanLen))}`);
      }
    } else {
      out.push(`${marker}${num} | ${windowLine(lines[i - 1], maxWidth).body}`);
    }
  }
  return out.join('\n');
}
