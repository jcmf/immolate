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

test('readfile() reads a sibling file via a bare relative path', async () => {
  const html = await buildAndRead({
    '/in/index.md': "{readfile('greeting.txt')}\n",
    '/in/greeting.txt': 'hello from a sibling',
  });
  assert.match(html, /hello from a sibling/);
});

test('readfile() resolves "./" and "../" against the module directory', async () => {
  const fs = makeFs({
    '/in/index.md': "root: {readfile('./root.txt')}\n",
    '/in/root.txt': 'R',
    '/in/posts/index.md': '# Posts\n',
    '/in/posts/hi.md': "child: {readfile('../shared.txt')}\n",
    '/in/shared.txt': 'S',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(root, /root: R/);
  const child = await fs.promises.readFile('/out/posts/hi/index.html', 'utf8');
  assert.match(child, /child: S/);
});

test('readfile() treats "/foo" as relative to topDir, not module dir', async () => {
  const fs = makeFs({
    '/top/pages/index.md': "{readfile('/data/x.txt')}\n",
    '/top/data/x.txt': 'top-relative-ok',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/top/site',
    topDir: '/top',
    fs,
  });
  const html = await fs.promises.readFile('/top/site/index.html', 'utf8');
  assert.match(html, /top-relative-ok/);
});

test('readfile() throws a clear error when the file is missing', async () => {
  const fs = makeFs({
    '/in/index.md': "{readfile('./missing.txt')}\n",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /readfile\("\.\/missing\.txt"\): file not found at \/in\/missing\.txt \(requested by "index\.md"\)/,
  );
});

test('a user export named readfile shadows the builtin (user wins)', async () => {
  const html = await buildAndRead({
    '/in/index.md':
      "export const readfile = (p) => '[stub:' + p + ']';\n\n{readfile('whatever')}\n",
  });
  assert.match(html, /\[stub:whatever\]/);
});
