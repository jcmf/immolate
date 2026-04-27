import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const testTmp = path.join(repoRoot, 'test-tmp', 'imports-js');

before(() => {
  nodeFs.rmSync(testTmp, { recursive: true, force: true });
});

function setupCase(slug, files) {
  const root = path.join(testTmp, slug);
  const inputDir = path.join(root, 'in');
  const outputDir = path.join(root, 'out');
  nodeFs.mkdirSync(inputDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(inputDir, rel);
    nodeFs.mkdirSync(path.dirname(full), { recursive: true });
    nodeFs.writeFileSync(full, content);
  }
  return { inputDir, outputDir };
}

async function buildAndRead(slug, files, outRel = 'index.html') {
  const { inputDir, outputDir } = setupCase(slug, files);
  await build({ inputDir, outputDir, fs: nodeFs });
  return nodeFs.readFileSync(path.join(outputDir, outRel), 'utf8');
}

test('an .mdx module can import a .js helper as a component (default = .default)', async () => {
  const html = await buildAndRead('mdx-imports-js-component', {
    'index.mdx': "import Card from './card.js';\n\n<Card />",
    'card.js':
      "export default function Card() { return { html: '<div class=\"c\">hi</div>' }; }\n",
  });
  assert.match(html, /<div class="c">hi<\/div>/);
});

test('an .mdx module can import named exports from a .js helper', async () => {
  const html = await buildAndRead('mdx-imports-js-named', {
    'index.mdx': "import { greet } from './lib.js';\n\n{greet('world')}",
    'lib.js': "export function greet(name) { return 'hello ' + name; }\n",
  });
  assert.match(html, /hello world/);
});

test('a .js file can import another .js file via a relative path', async () => {
  const html = await buildAndRead('js-imports-js-relative', {
    'index.mdx': "import Outer from './outer.js';\n\n<Outer />",
    'outer.js':
      "import { tag } from './inner.js';\n" +
      "export default function Outer() {\n" +
      "  return { html: '<' + tag + '>relative-ok</' + tag + '>' };\n" +
      "}\n",
    'inner.js': "export const tag = 'mark';\n",
  });
  assert.match(html, /<mark>relative-ok<\/mark>/);
});

test('a .js file can import bare specifiers (npm / node:)', async () => {
  const html = await buildAndRead('js-imports-bare', {
    'index.mdx': "import { upper } from './u.js';\n\n{upper('abc')}",
    'u.js':
      "import { Buffer } from 'node:buffer';\n" +
      "export function upper(s) {\n" +
      "  return Buffer.from(s).toString('utf8').toUpperCase();\n" +
      "}\n",
  });
  assert.match(html, /ABC/);
});

test('a .js helper that returns html objects works as a JSX component', async () => {
  const html = await buildAndRead('js-component-with-props', {
    'index.mdx':
      "import Box from './box.js';\n\n<Box label=\"hi\" />",
    'box.js':
      "export default function Box(props) {\n" +
      "  return { html: '<span>' + props.label + '</span>' };\n" +
      "}\n",
  });
  assert.match(html, /<span>hi<\/span>/);
});
