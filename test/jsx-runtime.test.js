import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsx, jsxs, Fragment } from '../src/jsx-runtime.js';

test('renders a basic element with text children', () => {
  assert.deepEqual(jsx('p', { children: 'hi' }), { html: '<p>hi</p>' });
});

test('renders an empty element', () => {
  assert.deepEqual(jsx('div', {}), { html: '<div></div>' });
});

test('renders void elements without a closing tag', () => {
  assert.deepEqual(jsx('br', {}), { html: '<br>' });
  assert.deepEqual(jsx('img', { src: '/x.png' }), { html: '<img src="/x.png">' });
});

test('renders attributes', () => {
  assert.deepEqual(
    jsx('a', { href: '/x', children: 'go' }),
    { html: '<a href="/x">go</a>' },
  );
});

test('renames className to class and htmlFor to for', () => {
  assert.deepEqual(
    jsx('label', { className: 'lbl', htmlFor: 'name', children: 'Name' }),
    { html: '<label class="lbl" for="name">Name</label>' },
  );
});

test('emits boolean attributes without a value when true and skips when false', () => {
  assert.deepEqual(
    jsx('input', { type: 'checkbox', checked: true, disabled: false }),
    { html: '<input type="checkbox" checked>' },
  );
});

test('omits null and undefined attributes', () => {
  assert.deepEqual(
    jsx('div', { id: null, title: undefined, 'data-x': 'y' }),
    { html: '<div data-x="y"></div>' },
  );
});

test('escapes attribute values', () => {
  assert.deepEqual(
    jsx('a', { href: 'x"&y', children: 'q' }),
    { html: '<a href="x&quot;&amp;y">q</a>' },
  );
});

test('escapes text children', () => {
  assert.deepEqual(
    jsx('p', { children: '<script>&' }),
    { html: '<p>&lt;script&gt;&amp;</p>' },
  );
});

test('renders numeric children', () => {
  assert.deepEqual(jsx('p', { children: 42 }), { html: '<p>42</p>' });
});

test('renders null/undefined/true/false children as empty', () => {
  assert.deepEqual(jsx('p', { children: null }), { html: '<p></p>' });
  assert.deepEqual(jsx('p', { children: undefined }), { html: '<p></p>' });
  assert.deepEqual(jsx('p', { children: true }), { html: '<p></p>' });
  assert.deepEqual(jsx('p', { children: false }), { html: '<p></p>' });
});

test('renders array children, flattening and mixing types', () => {
  assert.deepEqual(
    jsxs('p', { children: ['a', 1, null, { html: '<b>x</b>' }, ['c', 'd']] }),
    { html: '<p>a1<b>x</b>cd</p>' },
  );
});

test('passes HTML-object children through unescaped', () => {
  assert.deepEqual(
    jsx('div', { children: { html: '<span>raw</span>' } }),
    { html: '<div><span>raw</span></div>' },
  );
});

test('uses a module as a tag, forwarding props (including children)', () => {
  const Wrap = {
    default: (props) => jsx('section', { className: props.kind, children: props.children }),
  };
  assert.deepEqual(
    jsx(Wrap, { kind: 'foo', children: 'inner' }),
    { html: '<section class="foo">inner</section>' },
  );
});

test('renders a module as a child by invoking its default with no props', () => {
  const Greet = {
    default: () => jsx('span', { children: 'hi' }),
  };
  assert.deepEqual(
    jsx('div', { children: Greet }),
    { html: '<div><span>hi</span></div>' },
  );
});

test('uses a function as a component tag', () => {
  const Hello = (props) => jsx('em', { children: props.name });
  assert.deepEqual(jsx(Hello, { name: 'world' }), { html: '<em>world</em>' });
});

test('renders Fragment as just its children', () => {
  assert.deepEqual(
    jsxs(Fragment, { children: [jsx('a', {}), jsx('b', {})] }),
    { html: '<a></a><b></b>' },
  );
});

test('handles deep nesting', () => {
  const tree = jsx('article', {
    children: jsxs('section', {
      children: [
        jsx('h1', { children: 'Title' }),
        jsx('p', { children: ['Hello, ', jsx('strong', { children: 'world' })] }),
      ],
    }),
  });
  assert.deepEqual(tree, {
    html: '<article><section><h1>Title</h1><p>Hello, <strong>world</strong></p></section></article>',
  });
});

// Templates per spec: invoked with the wrapped module as `children`,
// so the template can read metadata off the module before rendering it.
test('a template-style module receives the wrapped module as children and can read its metadata', () => {
  const leaf = {
    title: 'Hello',
    default: () => jsx('p', { children: 'body' }),
  };
  const Template = {
    default: (props) => jsx('html', {
      children: [
        jsx('head', { children: jsx('title', { children: props.children.title }) }),
        jsx('body', { children: props.children }),
      ],
    }),
  };
  assert.deepEqual(
    jsx(Template, { children: leaf }),
    { html: '<html><head><title>Hello</title></head><body><p>body</p></body></html>' },
  );
});
