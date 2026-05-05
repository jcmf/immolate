import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cli = path.join(repoRoot, 'src', 'cli.js');
const testTmp = path.join(repoRoot, 'test-tmp', 'cli');

before(() => {
  nodeFs.rmSync(testTmp, { recursive: true, force: true });
});

function setupTopDir(slug, { pkg, files }) {
  const top = path.join(testTmp, slug);
  nodeFs.mkdirSync(top, { recursive: true });
  if (pkg !== undefined) {
    nodeFs.writeFileSync(path.join(top, 'package.json'), JSON.stringify(pkg));
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(top, rel);
    nodeFs.mkdirSync(path.dirname(full), { recursive: true });
    nodeFs.writeFileSync(full, content);
  }
  return top;
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    ...opts,
  });
}

test('CLI defaults to pages/ → site/ under topDir when no package.json exists', () => {
  const top = setupTopDir('defaults', {
    files: { 'pages/index.md': '# Default layout\n' },
  });
  const r = runCli([top]);
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, 'site', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>Default layout<\/h1>/);
});

test('CLI with no positional arg uses CWD as topDir', () => {
  const top = setupTopDir('cwd', {
    files: { 'pages/index.md': '# From CWD\n' },
  });
  const r = runCli([], { cwd: top });
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, 'site', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>From CWD<\/h1>/);
});

test('CLI reads inputDir/outputDir from package.json xtatic section', () => {
  const top = setupTopDir('config-override', {
    pkg: { xtatic: { inputDir: 'src/pages', outputDir: 'dist' } },
    files: { 'src/pages/index.md': '# Custom\n' },
  });
  const r = runCli([top]);
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, 'dist', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>Custom<\/h1>/);
  assert.equal(nodeFs.existsSync(path.join(top, 'site')), false);
});

test('CLI resolves relative config paths against topDir, not the working directory', () => {
  const top = setupTopDir('relative-resolution', {
    pkg: { xtatic: { inputDir: 'src/pages', outputDir: 'dist' } },
    files: { 'src/pages/index.md': '# Relative\n' },
  });
  const r = runCli([top], { cwd: repoRoot });
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, 'dist', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>Relative<\/h1>/);
  assert.equal(nodeFs.existsSync(path.join(repoRoot, 'src', 'pages')), false);
  assert.equal(nodeFs.existsSync(path.join(repoRoot, 'dist')), false);
});

test('CLI ignores package.json when it has no xtatic section', () => {
  const top = setupTopDir('no-xtatic-section', {
    pkg: { name: 'unrelated' },
    files: { 'pages/index.md': '# Plain\n' },
  });
  const r = runCli([top]);
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, 'site', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>Plain<\/h1>/);
});

test('CLI exits non-zero with usage message when given too many args', () => {
  const r = runCli(['a', 'b']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: xtatic \[top_dir\]/);
});

test('CLI prints a clean error and exits 1, with no internal stack', () => {
  const top = setupTopDir('error-clean', {
    files: { 'pages/index.md': '# Hi {foo.}\n' },
  });
  const r = runCli([top]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Lint failed with /);
  assert.match(r.stderr, /pages\/index\.md/);
  assert.match(r.stderr, /\(set XTATIC_DEBUG=1 for the full stack\)/);
  assert.doesNotMatch(r.stderr, /at \w.*lint\.js/);
  assert.doesNotMatch(r.stderr, /\[cause\]:/);
});

test('CLI with XTATIC_DEBUG=1 surfaces the full stack', () => {
  const top = setupTopDir('error-debug', {
    files: { 'pages/index.md': '# Hi {foo.}\n' },
  });
  const r = runCli([top], { env: { ...process.env, XTATIC_DEBUG: '1' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /at \w.*lint\.js/);
});
