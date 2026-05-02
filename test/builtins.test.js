import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

async function buildAndRead(files, outRel = 'index.html') {
  const fs = makeFs(files);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  return fs.promises.readFile(`/out/${outRel}`, 'utf8');
}

test('html() injects raw, unescaped HTML at the call site', async () => {
  const html = await buildAndRead({
    '/in/index.md': '# Hi\n\n{html(\'<!DOCTYPE html>\')}\n',
  });
  assert.match(html, /<!DOCTYPE html>/);
  assert.doesNotMatch(html, /&lt;!DOCTYPE/);
});

test('html() works inside a JSX child position', async () => {
  const html = await buildAndRead({
    '/in/index.md': "# H\n\n<div>{html('<b>raw</b>')}</div>\n",
  });
  assert.match(html, /<div><b>raw<\/b><\/div>/);
});

test('a user export named html shadows the builtin (user wins)', async () => {
  const html = await buildAndRead({
    '/in/index.md':
      "export const html = (s) => ({html: '[shadow:' + s + ']'});\n\n# H\n\n{html('inner')}\n",
  });
  assert.match(html, /\[shadow:inner\]/);
  assert.doesNotMatch(html, /<inner>/);
});

test('html() is available in layouts the same way', async () => {
  const fs = makeFs({
    '/in/index.md': '---\nlayout: shell\n---\n\n# Body\n',
    '/layouts/shell.mdx':
      "{html('<!DOCTYPE html>')}\n<html><body>{props.children}</body></html>\n",
  });
  await build({
    inputDir: '/in',
    outputDir: '/out',
    layoutsDir: '/layouts',
    fs,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<h1>Body<\/h1>/);
});
