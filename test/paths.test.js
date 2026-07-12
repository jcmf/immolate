import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLogicalPath,
  resolveLogicalPaths,
  extractPlaceholders,
  hasPlaceholders,
  substituteFilename,
} from '../src/paths.js';

test('index.md at the root maps to the empty segment list', () => {
  assert.deepEqual(resolveLogicalPath('index.md'), []);
  assert.deepEqual(resolveLogicalPath('index.mdx'), []);
});

test('top-level files map to a single segment', () => {
  assert.deepEqual(resolveLogicalPath('foo.md'), ['foo']);
  assert.deepEqual(resolveLogicalPath('foo.mdx'), ['foo']);
});

test('nested index files drop the trailing "index" segment', () => {
  assert.deepEqual(resolveLogicalPath('foo/index.md'), ['foo']);
  assert.deepEqual(resolveLogicalPath('foo/bar/index.mdx'), ['foo', 'bar']);
});

test('nested non-index files keep the file basename as the last segment', () => {
  assert.deepEqual(resolveLogicalPath('foo/bar.md'), ['foo', 'bar']);
  assert.deepEqual(resolveLogicalPath('foo/bar/baz.mdx'), ['foo', 'bar', 'baz']);
});

test('rejects paths without an .md or .mdx extension', () => {
  assert.throws(() => resolveLogicalPath('foo.txt'), /Not a page source file/);
  assert.throws(() => resolveLogicalPath('foo'), /Not a page source file/);
});

test('resolveLogicalPaths returns one entry per input', () => {
  const entries = resolveLogicalPaths([
    'index.md',
    'foo.md',
    'bar/index.md',
    'bar/baz.mdx',
  ]);
  assert.deepEqual(entries, [
    { relPath: 'index.md', segments: [] },
    { relPath: 'foo.md', segments: ['foo'] },
    { relPath: 'bar/index.md', segments: ['bar'] },
    { relPath: 'bar/baz.mdx', segments: ['bar', 'baz'] },
  ]);
});

test('detects collisions across the four equivalent forms', () => {
  assert.throws(
    () => resolveLogicalPaths(['foo.md', 'foo.mdx']),
    /same output path "foo"/,
  );
  assert.throws(
    () => resolveLogicalPaths(['foo.md', 'foo/index.md']),
    /same output path "foo"/,
  );
  assert.throws(
    () => resolveLogicalPaths(['foo/bar.mdx', 'foo/bar/index.md']),
    /same output path "foo\/bar"/,
  );
  assert.throws(
    () => resolveLogicalPaths(['index.md', 'index.mdx']),
    /same output path "\(root\)"/,
  );
});

test('extractPlaceholders pulls bracketed names from a filename, in order', () => {
  assert.deepEqual(extractPlaceholders('tag-{tag}.md'), ['tag']);
  assert.deepEqual(extractPlaceholders('{year}-{slug}.mdx'), ['year', 'slug']);
  assert.deepEqual(extractPlaceholders('plain.md'), []);
});

test('hasPlaceholders is true only when the filename carries a placeholder', () => {
  assert.equal(hasPlaceholders('tag-{tag}.md'), true);
  assert.equal(hasPlaceholders('blog/post-{slug}.mdx'), true);
  assert.equal(hasPlaceholders('plain.md'), false);
  assert.equal(hasPlaceholders('blog/index.md'), false);
});

test('hasPlaceholders rejects placeholders in a directory segment', () => {
  assert.throws(
    () => hasPlaceholders('tag-{x}/index.md'),
    /directory segment "tag-\{x\}".*not supported/,
  );
});

test('substituteFilename fills placeholders from values', () => {
  assert.equal(substituteFilename('tag-{tag}.md', { tag: 'rust' }), 'tag-rust.md');
  assert.equal(
    substituteFilename('{year}-{slug}.mdx', { year: '2026', slug: 'hello' }),
    '2026-hello.mdx',
  );
});

test('substituteFilename rejects missing, non-string, and unsafe values', () => {
  assert.throws(
    () => substituteFilename('tag-{tag}.md', {}),
    /Missing value for filename placeholder "\{tag\}"/,
  );
  assert.throws(
    () => substituteFilename('tag-{tag}.md', { tag: 5 }),
    /must be a string \(got number\)/,
  );
  assert.throws(
    () => substituteFilename('tag-{tag}.md', { tag: 'a/b' }),
    /must be a non-empty path segment with no "\/"/,
  );
  assert.throws(
    () => substituteFilename('tag-{tag}.md', { tag: '' }),
    /must be a non-empty path segment/,
  );
});

test('substituteFilename weaves template + index context into errors', () => {
  assert.throws(
    () => substituteFilename('tag-{tag}.md', {}, { template: 'tag-{tag}.md', index: 2 }),
    /in template "tag-\{tag\}.md" \(pages\[2\]\)/,
  );
});
