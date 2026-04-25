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

test('iteration over child_modules is sorted by name and skips hidden modules', () => {
  const root = assembleTree([
    entry([]),
    entry(['c']),
    entry(['a']),
    entry(['b'], { hidden: true }),
  ]);
  const iterated = [...root.child_modules];
  assert.equal(iterated.length, 2);
  assert.equal(iterated[0], root.child_modules.a);
  assert.equal(iterated[1], root.child_modules.c);
});

test('hidden modules are still accessible as named properties on child_modules', () => {
  const root = assembleTree([entry([]), entry(['secret'], { hidden: true })]);
  assert.ok(root.child_modules.secret);
  assert.equal(root.child_modules.secret.hidden, true);
});

test('a module named "template" defaults to hidden=true', () => {
  const root = assembleTree([entry([]), entry(['template'])]);
  assert.equal(root.child_modules.template.hidden, true);
});

test('non-template modules default to hidden=false (including the root)', () => {
  const root = assembleTree([entry([]), entry(['foo'])]);
  assert.equal(root.hidden, false);
  assert.equal(root.child_modules.foo.hidden, false);
});

test('explicit hidden values override defaults', () => {
  const root = assembleTree([
    entry([]),
    entry(['template'], { hidden: false }),
    entry(['foo'], { hidden: true }),
  ]);
  assert.equal(root.child_modules.template.hidden, false);
  assert.equal(root.child_modules.foo.hidden, true);
});

test('siblings inherit their parent\'s child template', () => {
  const root = assembleTree([
    entry([]),
    entry(['template']),
    entry(['foo']),
  ]);
  assert.equal(root.child_modules.foo.template, root.child_modules.template);
});

test('the closest ancestor template wins, with fallback up the chain', () => {
  const root = assembleTree([
    entry([]),
    entry(['template']),
    entry(['nested']),
    entry(['nested', 'template']),
    entry(['nested', 'leaf']),
    entry(['other']),
    entry(['other', 'leaf']),
  ]);
  assert.equal(
    root.child_modules.nested.child_modules.leaf.template,
    root.child_modules.nested.child_modules.template,
  );
  assert.equal(
    root.child_modules.other.child_modules.leaf.template,
    root.child_modules.template,
  );
});

test('a template module does not auto-inherit a template', () => {
  const root = assembleTree([
    entry([]),
    entry(['template']),
    entry(['nested']),
    entry(['nested', 'template']),
  ]);
  assert.equal(
    root.child_modules.nested.child_modules.template.template,
    undefined,
  );
});

test('the root module never gets a default template', () => {
  const root = assembleTree([entry([]), entry(['template'])]);
  assert.equal(root.template, undefined);
});

test('an explicit template value on a module is preserved', () => {
  const customTemplate = { default: () => ({ html: '<x></x>' }) };
  const root = assembleTree([
    entry([]),
    entry(['template']),
    entry(['foo'], { template: customTemplate }),
  ]);
  assert.equal(root.child_modules.foo.template, customTemplate);
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
