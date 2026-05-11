import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cli = path.join(repoRoot, 'src', 'cli.js');
const testTmp = path.join(repoRoot, 'test-tmp', 'init');

const xtaticVersion = JSON.parse(
  nodeFs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
).version;

before(() => {
  nodeFs.rmSync(testTmp, { recursive: true, force: true });
});

function setupTopDir(slug, files = {}) {
  const top = path.join(testTmp, slug);
  nodeFs.mkdirSync(top, { recursive: true });
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

function readPkg(top) {
  return JSON.parse(
    nodeFs.readFileSync(path.join(top, 'package.json'), 'utf8'),
  );
}

test('init creates package.json when none exists', () => {
  const top = setupTopDir('create-new');
  const r = runCli(['init', top]);
  assert.equal(r.status, 0, r.stderr);
  const pkg = readPkg(top);
  assert.equal(pkg.name, 'create-new');
  assert.equal(pkg.private, true);
  assert.equal(pkg.devDependencies.xtatic, `^${xtaticVersion}`);
  assert.equal(pkg.xtatic.autoInstall, true);
  assert.match(r.stdout, /created/);
});

test('init adds xtatic to devDependencies when absent', () => {
  const top = setupTopDir('add-devdep', {
    'package.json': JSON.stringify({
      name: 'pre-existing',
      devDependencies: { lodash: '^4.0.0' },
    }),
  });
  const r = runCli(['init', top]);
  assert.equal(r.status, 0, r.stderr);
  const pkg = readPkg(top);
  assert.equal(pkg.name, 'pre-existing');
  assert.equal(pkg.devDependencies.xtatic, `^${xtaticVersion}`);
  assert.equal(pkg.devDependencies.lodash, '^4.0.0');
  assert.equal(pkg.xtatic.autoInstall, true);
});

test('init does not overwrite an existing xtatic dependency', () => {
  const top = setupTopDir('preserve-dep', {
    'package.json': JSON.stringify({
      name: 'site',
      dependencies: { xtatic: '0.5.0' },
    }),
  });
  const r = runCli(['init', top]);
  assert.equal(r.status, 0, r.stderr);
  const pkg = readPkg(top);
  assert.equal(pkg.dependencies.xtatic, '0.5.0');
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.xtatic.autoInstall, true);
});

test('init does not move xtatic from devDependencies', () => {
  const top = setupTopDir('preserve-devdep', {
    'package.json': JSON.stringify({
      name: 'site',
      devDependencies: { xtatic: '0.8.0' },
    }),
  });
  const r = runCli(['init', top]);
  assert.equal(r.status, 0, r.stderr);
  const pkg = readPkg(top);
  assert.equal(pkg.devDependencies.xtatic, '0.8.0');
  assert.equal(pkg.xtatic.autoInstall, true);
});

test('init preserves other xtatic config keys and sets autoInstall to true', () => {
  const top = setupTopDir('preserve-config', {
    'package.json': JSON.stringify({
      name: 'site',
      devDependencies: { xtatic: '*' },
      xtatic: { inputDir: 'src/pages', autoInstall: false },
    }),
  });
  const r = runCli(['init', top]);
  assert.equal(r.status, 0, r.stderr);
  const pkg = readPkg(top);
  assert.equal(pkg.xtatic.inputDir, 'src/pages');
  assert.equal(pkg.xtatic.autoInstall, true);
});

test('init is idempotent (second run does nothing)', () => {
  const top = setupTopDir('idempotent');
  const r1 = runCli(['init', top]);
  assert.equal(r1.status, 0, r1.stderr);
  const pkg1 = readPkg(top);
  const r2 = runCli(['init', top]);
  assert.equal(r2.status, 0, r2.stderr);
  const pkg2 = readPkg(top);
  assert.deepEqual(pkg2, pkg1);
  assert.match(r2.stdout, /nothing to do/);
});

test('init defaults to CWD when no arg is given', () => {
  const top = setupTopDir('cwd');
  const r = runCli(['init'], { cwd: top });
  assert.equal(r.status, 0, r.stderr);
  const pkg = readPkg(top);
  assert.equal(pkg.xtatic.autoInstall, true);
});

test('init rejects malformed package.json with a clear message', () => {
  const top = setupTopDir('malformed', {
    'package.json': '{ not json',
  });
  const r = runCli(['init', top]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Failed to parse/);
});

test('init writes a trailing newline', () => {
  const top = setupTopDir('trailing-newline');
  const r = runCli(['init', top]);
  assert.equal(r.status, 0, r.stderr);
  const text = nodeFs.readFileSync(path.join(top, 'package.json'), 'utf8');
  assert.ok(text.endsWith('\n'), 'package.json should end with a newline');
});
