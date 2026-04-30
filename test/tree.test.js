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

function child(parent, name) {
  return parent.childPages.find((c) => c.name === name);
}

test('errors when no root module is provided', () => {
  assert.throws(() => assembleTree([entry(['foo'])]), /No root module found/);
});

test('returns the root module with empty childPages for a single-file tree', () => {
  const root = assembleTree([entry([])]);
  assert.equal(typeof root.default, 'function');
  assert.deepEqual(root.childPages, []);
});

test('attaches each child to its parent and tags it with its last-segment name', () => {
  const root = assembleTree([
    entry([]),
    entry(['a']),
    entry(['b']),
    entry(['a', 'x']),
  ]);
  assert.deepEqual(
    root.childPages.map((c) => c.name),
    ['a', 'b'],
  );
  assert.deepEqual(
    child(root, 'a').childPages.map((c) => c.name),
    ['x'],
  );
});

test('childPages is sorted by name regardless of input order', () => {
  const root = assembleTree([
    entry([]),
    entry(['c']),
    entry(['a']),
    entry(['b']),
  ]);
  assert.deepEqual(
    root.childPages.map((c) => c.name),
    ['a', 'b', 'c'],
  );
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
  assert.equal(child(root, 'child').layout, rootTpl);
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
  const section = child(root, 'section');
  const other = child(root, 'other');
  assert.equal(section.layout, sectionTpl);
  assert.equal(child(section, 'leaf').layout, sectionTpl);
  assert.equal(other.layout, rootTpl);
  assert.equal(child(other, 'leaf').layout, rootTpl);
});

test('an explicit layout overrides defaultLayout inheritance', () => {
  const dt = { default: () => ({ html: '' }) };
  const explicit = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { defaultLayout: dt }),
    entry(['foo'], { layout: explicit }),
  ]);
  assert.equal(child(root, 'foo').layout, explicit);
});

test('a module with no layout and no ancestor defaultLayout ends up with layout=undefined', () => {
  const root = assembleTree([entry([]), entry(['foo'])]);
  assert.equal(root.layout, undefined);
  assert.equal(child(root, 'foo').layout, undefined);
});

test('errors when a non-root module has no parent in the tree', () => {
  assert.throws(
    () => assembleTree([entry([]), entry(['missing-parent', 'leaf'])]),
    /no parent module at "missing-parent"/,
  );
});

test('childPages is a real Array (supports .map, .find, .length, etc.)', () => {
  const root = assembleTree([entry([]), entry(['a']), entry(['b'])]);
  assert.equal(Array.isArray(root.childPages), true);
  assert.equal(root.childPages.length, 2);
  assert.deepEqual(root.childPages.map((c) => c.name), ['a', 'b']);
});

test('the root has no name set; only attached children do', () => {
  const root = assembleTree([entry([]), entry(['a'])]);
  assert.equal(root.name, undefined);
  assert.equal(child(root, 'a').name, 'a');
});
