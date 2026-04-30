import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleTree } from '../src/tree.js';

function entry(segments, props = {}) {
  return {
    relPath: (segments.length === 0 ? 'index' : segments.join('/')) + '.md',
    segments,
    mm: { default: () => ({ html: '' }), ...props },
  };
}

test('errors when no root module is provided', () => {
  assert.throws(() => assembleTree([entry(['foo'])]), /No root module found/);
});

test('returns the root module with empty childPages for a single-file tree', () => {
  const root = assembleTree([entry([])]);
  assert.equal(typeof root.default, 'function');
  assert.deepEqual([...root.childPages], []);
});

test('attaches each child to its parent by last-segment name', () => {
  const root = assembleTree([
    entry([]),
    entry(['a']),
    entry(['b']),
    entry(['a', 'x']),
  ]);
  assert.ok(root.childPages.a);
  assert.ok(root.childPages.b);
  assert.ok(root.childPages.a.childPages.x);
});

test('childPages iteration is sorted by name', () => {
  const root = assembleTree([
    entry([]),
    entry(['c']),
    entry(['a']),
    entry(['b']),
  ]);
  const iterated = [...root.childPages];
  assert.equal(iterated.length, 3);
  assert.equal(iterated[0], root.childPages.a);
  assert.equal(iterated[1], root.childPages.b);
  assert.equal(iterated[2], root.childPages.c);
});

test("a module's layout defaults to its own defaultLayout", () => {
  const tpl = { default: () => ({ html: '' }) };
  const root = assembleTree([entry([], { defaultLayout: tpl })]);
  assert.equal(root.layout, tpl);
});

test("a module without a defaultLayout inherits the nearest ancestor's", () => {
  const rootTpl = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { defaultLayout: rootTpl }),
    entry(['child']),
  ]);
  assert.equal(root.childPages.child.layout, rootTpl);
});

test("the closest ancestor's defaultLayout wins, with fallback up the chain", () => {
  const rootTpl = { default: () => ({ html: '' }) };
  const sectionTpl = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { defaultLayout: rootTpl }),
    entry(['section'], { defaultLayout: sectionTpl }),
    entry(['section', 'leaf']),
    entry(['other']),
    entry(['other', 'leaf']),
  ]);
  assert.equal(root.layout, rootTpl);
  assert.equal(root.childPages.section.layout, sectionTpl);
  assert.equal(
    root.childPages.section.childPages.leaf.layout,
    sectionTpl,
  );
  assert.equal(root.childPages.other.layout, rootTpl);
  assert.equal(
    root.childPages.other.childPages.leaf.layout,
    rootTpl,
  );
});

test('an explicit layout overrides defaultLayout inheritance', () => {
  const dt = { default: () => ({ html: '' }) };
  const explicit = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { defaultLayout: dt }),
    entry(['foo'], { layout: explicit }),
  ]);
  assert.equal(root.childPages.foo.layout, explicit);
});

test('a module with no layout and no ancestor defaultLayout ends up with layout=undefined', () => {
  const root = assembleTree([entry([]), entry(['foo'])]);
  assert.equal(root.layout, undefined);
  assert.equal(root.childPages.foo.layout, undefined);
});

test('errors when a non-root module has no parent in the tree', () => {
  assert.throws(
    () => assembleTree([entry([]), entry(['missing-parent', 'leaf'])]),
    /no parent module at "missing-parent"/,
  );
});

test('childPages iterator is non-enumerable, so spread/Object.keys ignore it', () => {
  const root = assembleTree([entry([]), entry(['a'])]);
  assert.deepEqual(Object.keys(root.childPages), ['a']);
  assert.deepEqual(Object.keys({ ...root.childPages }), ['a']);
});
