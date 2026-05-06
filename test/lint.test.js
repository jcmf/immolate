import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cli = path.join(repoRoot, 'src', 'cli.js');
const testTmp = path.join(repoRoot, 'test-tmp', 'lint');

before(() => {
  nodeFs.rmSync(testTmp, { recursive: true, force: true });
});

function setupTopDir(slug, files) {
  const top = path.join(testTmp, slug);
  nodeFs.mkdirSync(top, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(top, rel);
    nodeFs.mkdirSync(path.dirname(full), { recursive: true });
    nodeFs.writeFileSync(full, content);
  }
  return top;
}

function runCli(top) {
  return spawnSync(process.execPath, [cli, 'build', top], { encoding: 'utf8' });
}

test('lint passes when imports are well-formed', () => {
  const top = setupTopDir('happy-path', {
    'pages/index.mdx':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="/style.css" />\n\n# OK\n',
    'style.css': '.a {}',
  });
  const r = runCli(top);
  assert.equal(r.status, 0, r.stderr);
});

test('default import from xtatic:style fails lint with a clear message', () => {
  const top = setupTopDir('default-import-style', {
    'pages/index.mdx':
      "import Style from 'xtatic:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Lint failed/);
  assert.match(r.stderr, /"xtatic:style" has no default export/);
  assert.match(r.stderr, /import \{Style\} from "xtatic:style"/);
});

test('default import from xtatic:image fails lint', () => {
  const top = setupTopDir('default-import-image', {
    'pages/index.mdx':
      "import Image from 'xtatic:image';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /"xtatic:image" has no default export/);
  assert.match(r.stderr, /import \{Image\} from "xtatic:image"/);
});

test('typo in named import from xtatic:style is flagged', () => {
  const top = setupTopDir('typo-named', {
    'pages/index.mdx':
      "import {Stlye} from 'xtatic:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /"xtatic:style" has no export named "Stlye"/);
  assert.match(r.stderr, /Available: "Style"/);
});

test('unknown xtatic:* spec is flagged with the available list', () => {
  const top = setupTopDir('unknown-spec', {
    'pages/index.mdx':
      "import {x} from 'xtatic:nope';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown xtatic builtin module "xtatic:nope"/);
  assert.match(
    r.stderr,
    /Available: "xtatic:builtins", "xtatic:image", "xtatic:style"/,
  );
});

test('namespace import from xtatic:* is flagged', () => {
  const top = setupTopDir('namespace-import', {
    'pages/index.mdx':
      "import * as S from 'xtatic:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Namespace import from "xtatic:style" is unsupported/);
});

test('importing a non-existent relative path is flagged', () => {
  const top = setupTopDir('unresolved-path', {
    'pages/index.mdx':
      "import X from './missing.mdx';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Lint failed/);
  assert.match(r.stderr, /Unable to resolve path to module/);
});

test('idiomatic default import from .mdx is allowed', () => {
  const top = setupTopDir('mdx-default-allowed', {
    'pages/index.mdx':
      "import About from './about.mdx';\n\n# Index\n\n<About />\n",
    'pages/about.mdx': '# About\n',
  });
  const r = runCli(top);
  assert.equal(r.status, 0, r.stderr);
});

test('lint failure exits 1 before any build output is written', () => {
  const top = setupTopDir('no-build-on-lint-fail', {
    'pages/index.mdx':
      "import Style from 'xtatic:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.equal(nodeFs.existsSync(path.join(top, 'site')), false);
});

test('lint catches builtin misuse inside a .md layout', () => {
  const top = setupTopDir('md-layout-builtin', {
    'pages/index.md': '---\nlayout: default\n---\n\n# hi\n',
    'layouts/default.md':
      "import Style from 'xtatic:style';\n\n" +
      '<Style src="./style.css" />\n\n{children}\n',
    'layouts/style.css': '.a {}',
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /layouts\/default\.md/);
  assert.match(r.stderr, /"xtatic:style" has no default export/);
});

test('lint catches a typo in a .md file (parsed as MDX)', () => {
  const top = setupTopDir('md-typo', {
    'pages/index.md':
      "import {Stlye} from 'xtatic:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pages\/index\.md/);
  assert.match(r.stderr, /"xtatic:style" has no export named "Stlye"/);
});

test('lint catches builtin misuse in a .jsx component', () => {
  const top = setupTopDir('jsx-builtin-misuse', {
    'pages/index.mdx':
      "import Hero from './hero.jsx';\n\n# r\n\n<Hero />\n",
    'pages/hero.jsx':
      "import Image from 'xtatic:image';\n" +
      'export default function Hero() { return <Image src="./x.png" alt="x" />; }\n',
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /"xtatic:image" has no default export/);
});
