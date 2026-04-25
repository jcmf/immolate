import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderModule } from '../src/render.js';
import { jsx } from '../src/jsx-runtime.js';

test('renders a templateless module by invoking its default with no props', () => {
  const mm = { default: () => ({ html: '<p>hi</p>' }) };
  assert.deepEqual(renderModule(mm), { html: '<p>hi</p>' });
});

test('a single template wraps the module, receiving it as props.children', () => {
  const leaf = {
    title: 'L',
    default: () => jsx('p', { children: 'leaf-body' }),
  };
  leaf.template = {
    default: (props) => jsx('html', {
      children: [
        jsx('head', { children: jsx('title', { children: props.children.title }) }),
        jsx('body', { children: props.children }),
      ],
    }),
  };
  assert.deepEqual(
    renderModule(leaf),
    { html: '<html><head><title>L</title></head><body><p>leaf-body</p></body></html>' },
  );
});

test('a template-of-template wraps the chain, the outer template seeing the inner template\'s metadata', () => {
  const leaf = { default: () => jsx('p', { children: 'L' }) };
  const inner = {
    label: 'inner',
    default: (props) => jsx('main', { children: props.children }),
  };
  const outer = {
    default: (props) => jsx('html', {
      children: [
        jsx('head', { children: props.children.label ?? 'no-label' }),
        jsx('body', { children: props.children }),
      ],
    }),
  };
  leaf.template = inner;
  inner.template = outer;
  assert.deepEqual(
    renderModule(leaf),
    { html: '<html><head>inner</head><body><main><p>L</p></main></body></html>' },
  );
});

test('does not mutate the original module objects', () => {
  const leaf = {
    title: 'L',
    default: () => ({ html: '<p>L</p>' }),
  };
  const tpl = {
    name: 'T',
    default: (props) => jsx('section', { children: props.children }),
  };
  leaf.template = tpl;
  const before = { ...leaf };
  renderModule(leaf);
  assert.deepEqual({ ...leaf }, before);
});

test('detects template cycles', () => {
  const a = { default: (props) => jsx('a', { children: props.children }) };
  const b = { default: (props) => jsx('b', { children: props.children }) };
  a.template = b;
  b.template = a;
  assert.throws(() => renderModule(a), /Template chain exceeded depth/);
});
