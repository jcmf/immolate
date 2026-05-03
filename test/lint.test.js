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
  return spawnSync(process.execPath, [cli, top], { encoding: 'utf8' });
}

test('lint passes when imports are well-formed', () => {
  const top = setupTopDir('happy-path', {
    'pages/index.mdx':
      "import {Style} from 'immolate:style';\n\n" +
      '<Style src="/style.css" />\n\n# OK\n',
    'style.css': '.a {}',
  });
  const r = runCli(top);
  assert.equal(r.status, 0, r.stderr);
});

test('default import from immolate:style fails lint with a clear message', () => {
  const top = setupTopDir('default-import-style', {
    'pages/index.mdx':
      "import Style from 'immolate:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Lint failed/);
  assert.match(r.stderr, /"immolate:style" has no default export/);
  assert.match(r.stderr, /import \{Style\} from "immolate:style"/);
});

test('default import from immolate:image fails lint', () => {
  const top = setupTopDir('default-import-image', {
    'pages/index.mdx':
      "import Image from 'immolate:image';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /"immolate:image" has no default export/);
  assert.match(r.stderr, /import \{Image\} from "immolate:image"/);
});

test('typo in named import from immolate:style is flagged', () => {
  const top = setupTopDir('typo-named', {
    'pages/index.mdx':
      "import {Stlye} from 'immolate:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /"immolate:style" has no export named "Stlye"/);
  assert.match(r.stderr, /Available: "Style"/);
});

test('unknown immolate:* spec is flagged with the available list', () => {
  const top = setupTopDir('unknown-spec', {
    'pages/index.mdx':
      "import {x} from 'immolate:nope';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown immolate builtin module "immolate:nope"/);
  assert.match(
    r.stderr,
    /Available: "immolate:builtins", "immolate:image", "immolate:style"/,
  );
});

test('namespace import from immolate:* is flagged', () => {
  const top = setupTopDir('namespace-import', {
    'pages/index.mdx':
      "import * as S from 'immolate:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Namespace import from "immolate:style" is unsupported/);
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
      "import Style from 'immolate:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.equal(nodeFs.existsSync(path.join(top, 'site')), false);
});

test('lint catches builtin misuse in a .jsx component', () => {
  const top = setupTopDir('jsx-builtin-misuse', {
    'pages/index.mdx':
      "import Hero from './hero.jsx';\n\n# r\n\n<Hero />\n",
    'pages/hero.jsx':
      "import Image from 'immolate:image';\n" +
      'export default function Hero() { return <Image src="./x.png" alt="x" />; }\n',
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /"immolate:image" has no default export/);
});
