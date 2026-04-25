import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLogicalPath, resolveLogicalPaths } from '../src/paths.js';

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
  assert.throws(() => resolveLogicalPath('foo.txt'), /Not an MDX file/);
  assert.throws(() => resolveLogicalPath('foo'), /Not an MDX file/);
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
