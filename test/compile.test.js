import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from '../src/compile.js';

test('compiles plain markdown to a module whose default returns an HTML object', async () => {
  const mm = await compileSource('# Hello');
  assert.deepEqual(mm.default({}), { html: '<h1>Hello</h1>' });
});

test('exposes named exports as top-level module properties', async () => {
  const mm = await compileSource("export const title = 'Hi';\n\n# H\n");
  assert.equal(mm.title, 'Hi');
});

test('exposes frontmatter values as top-level module properties', async () => {
  const mm = await compileSource('---\ntitle: Hello\ncount: 3\n---\n# H\n');
  assert.equal(mm.title, 'Hello');
  assert.equal(mm.count, 3);
});

test('named exports win over frontmatter on collisions', async () => {
  const mm = await compileSource(
    "---\ntitle: FromFrontmatter\n---\nexport const title = 'FromExport';\n\n# H\n",
  );
  assert.equal(mm.title, 'FromExport');
});

test('renders MDX containing JSX through our jsx-runtime', async () => {
  const mm = await compileSource('Hello <em>there</em>.\n');
  const out = mm.default({});
  assert.equal(typeof out.html, 'string');
  assert.match(out.html, /<em>there<\/em>/);
});

test('returns a plain mutable object that can accept added properties', async () => {
  const mm = await compileSource('# Hello\n');
  mm.childPages = { foo: 'bar' };
  assert.equal(mm.childPages.foo, 'bar');
});
