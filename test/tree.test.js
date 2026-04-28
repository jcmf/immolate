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

test('returns the root module with empty child_modules for a single-file tree', () => {
  const root = assembleTree([entry([])]);
  assert.equal(typeof root.default, 'function');
  assert.deepEqual([...root.child_modules], []);
});

test('attaches each child to its parent by last-segment name', () => {
  const root = assembleTree([
    entry([]),
    entry(['a']),
    entry(['b']),
    entry(['a', 'x']),
  ]);
  assert.ok(root.child_modules.a);
  assert.ok(root.child_modules.b);
  assert.ok(root.child_modules.a.child_modules.x);
});

test('child_modules iteration is sorted by name', () => {
  const root = assembleTree([
    entry([]),
    entry(['c']),
    entry(['a']),
    entry(['b']),
  ]);
  const iterated = [...root.child_modules];
  assert.equal(iterated.length, 3);
  assert.equal(iterated[0], root.child_modules.a);
  assert.equal(iterated[1], root.child_modules.b);
  assert.equal(iterated[2], root.child_modules.c);
});

test("a module's template defaults to its own default_template", () => {
  const tpl = { default: () => ({ html: '' }) };
  const root = assembleTree([entry([], { default_template: tpl })]);
  assert.equal(root.template, tpl);
});

test("a module without a default_template inherits the nearest ancestor's", () => {
  const rootTpl = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { default_template: rootTpl }),
    entry(['child']),
  ]);
  assert.equal(root.child_modules.child.template, rootTpl);
});

test("the closest ancestor's default_template wins, with fallback up the chain", () => {
  const rootTpl = { default: () => ({ html: '' }) };
  const sectionTpl = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { default_template: rootTpl }),
    entry(['section'], { default_template: sectionTpl }),
    entry(['section', 'leaf']),
    entry(['other']),
    entry(['other', 'leaf']),
  ]);
  assert.equal(root.template, rootTpl);
  assert.equal(root.child_modules.section.template, sectionTpl);
  assert.equal(
    root.child_modules.section.child_modules.leaf.template,
    sectionTpl,
  );
  assert.equal(root.child_modules.other.template, rootTpl);
  assert.equal(
    root.child_modules.other.child_modules.leaf.template,
    rootTpl,
  );
});

test('an explicit template overrides default_template inheritance', () => {
  const dt = { default: () => ({ html: '' }) };
  const explicit = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { default_template: dt }),
    entry(['foo'], { template: explicit }),
  ]);
  assert.equal(root.child_modules.foo.template, explicit);
});

test('a module with no template and no ancestor default_template ends up with template=undefined', () => {
  const root = assembleTree([entry([]), entry(['foo'])]);
  assert.equal(root.template, undefined);
  assert.equal(root.child_modules.foo.template, undefined);
});

test('errors when a non-root module has no parent in the tree', () => {
  assert.throws(
    () => assembleTree([entry([]), entry(['missing-parent', 'leaf'])]),
    /no parent module at "missing-parent"/,
  );
});

test('child_modules iterator is non-enumerable, so spread/Object.keys ignore it', () => {
  const root = assembleTree([entry([]), entry(['a'])]);
  assert.deepEqual(Object.keys(root.child_modules), ['a']);
  assert.deepEqual(Object.keys({ ...root.child_modules }), ['a']);
});
