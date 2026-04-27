import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const testTmp = path.join(repoRoot, 'test-tmp');
const slug = 'smoke';

before(() => {
  nodeFs.rmSync(path.join(testTmp, slug), { recursive: true, force: true });
});

test('build with no fs injection writes real files end-to-end', async () => {
  const root = path.join(testTmp, slug);
  const inputDir = path.join(root, 'in');
  const outputDir = path.join(root, 'out');
  nodeFs.mkdirSync(inputDir, { recursive: true });
  nodeFs.writeFileSync(path.join(inputDir, 'index.md'), '# Hello\n');
  nodeFs.writeFileSync(path.join(inputDir, 'about.mdx'), '# About\n');

  await build({ inputDir, outputDir, fs: nodeFs });

  assert.match(
    nodeFs.readFileSync(path.join(outputDir, 'index.html'), 'utf8'),
    /<h1>Hello<\/h1>/,
  );
  assert.match(
    nodeFs.readFileSync(path.join(outputDir, 'about', 'index.html'), 'utf8'),
    /<h1>About<\/h1>/,
  );
});
