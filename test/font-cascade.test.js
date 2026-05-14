import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCodePointsByFace,
  faceKey,
} from '../src/font-cascade.js';

// Render a single page and return the Set of code points (as a sorted string
// of characters) attributed to a given face by precision:'face' matching.
function attribute({ html, css = '', faces, precision = 'face' }) {
  const pages = [{ outPath: '/p', html }];
  const result = computeCodePointsByFace({
    pages,
    getCssForPage: () => (css ? [css] : []),
    registeredFaces: faces,
    precision,
  });
  const out = {};
  for (const [k, set] of result) {
    out[k] = [...set]
      .sort((a, b) => a - b)
      .map((cp) => String.fromCodePoint(cp))
      .join('');
  }
  return out;
}

function key(face, precision = 'face') {
  return faceKey(
    {
      family: face.family,
      weight: face.weight ?? 400,
      style: face.style ?? 'normal',
      unicodeRange: face.unicodeRange,
    },
    precision,
  );
}

test('css-static: text in a styled element attributes to its family', () => {
  const faces = [{ family: 'Inter', weight: 400, style: 'normal' }];
  const out = attribute({
    html: '<body><p class="x">hello</p></body>',
    css: '.x { font-family: Inter; }',
    faces,
  });
  assert.equal(out[key(faces[0])], 'ehlo');
});

test('css-static: font-family is inherited from an ancestor', () => {
  const faces = [{ family: 'Inter', weight: 400, style: 'normal' }];
  const out = attribute({
    html: '<body><div><p>hello</p></div></body>',
    css: 'body { font-family: Inter; }',
    faces,
  });
  assert.equal(out[key(faces[0])], 'ehlo');
});

test('css-static: <strong> picks up bold weight from UA defaults', () => {
  const faces = [
    { family: 'Inter', weight: 400, style: 'normal' },
    { family: 'Inter', weight: 700, style: 'normal' },
  ];
  const out = attribute({
    html: '<body><p>hi <strong>bold</strong>!</p></body>',
    css: 'body { font-family: Inter; }',
    faces,
  });
  assert.equal(out[key(faces[0])], ' !hi'); // 'hi !' sorted -> ' !hi'
  assert.equal(out[key(faces[1])], 'bdlo'); // 'bold' sorted unique
});

test('css-static: <em> picks up italic style from UA defaults', () => {
  const faces = [
    { family: 'Inter', weight: 400, style: 'normal' },
    { family: 'Inter', weight: 400, style: 'italic' },
  ];
  const out = attribute({
    html: '<body><p>hi <em>x</em></p></body>',
    css: 'body { font-family: Inter; }',
    faces,
  });
  assert.equal(out[key(faces[0])], ' hi');
  assert.equal(out[key(faces[1])], 'x');
});

test('css-static: closest weight wins (450 → 400 over 700)', () => {
  const faces = [
    { family: 'Inter', weight: 400, style: 'normal' },
    { family: 'Inter', weight: 700, style: 'normal' },
  ];
  const out = attribute({
    html: '<body><p style="font-weight:450">x</p></body>',
    css: 'body { font-family: Inter; }',
    faces,
  });
  assert.equal(out[key(faces[0])], 'x');
  assert.equal(out[key(faces[1])], undefined);
});

test('css-static: variable-font weight range absorbs requests inside it', () => {
  const faces = [{ family: 'Inter', weight: '100 900', style: 'normal' }];
  const out = attribute({
    html: '<body><p>a</p><p style="font-weight:700">b</p></body>',
    css: 'body { font-family: Inter; }',
    faces,
  });
  assert.equal(out[key(faces[0])], 'ab');
});

test('css-static: family fallback chain — walks until a match', () => {
  const faces = [{ family: 'Inter', weight: 400, style: 'normal' }];
  const out = attribute({
    html: '<body><p>x</p></body>',
    css: 'body { font-family: "Missing", Inter, sans-serif; }',
    faces,
  });
  assert.equal(out[key(faces[0])], 'x');
});

test('css-static: unmatched family attributes nothing to our faces', () => {
  const faces = [{ family: 'Inter', weight: 400, style: 'normal' }];
  const out = attribute({
    html: '<body><p>x</p></body>',
    css: 'body { font-family: sans-serif; }',
    faces,
  });
  assert.equal(Object.keys(out).length, 0);
});

test('css-static: inline style="font-family" overrides class rules', () => {
  const faces = [
    { family: 'Inter', weight: 400, style: 'normal' },
    { family: 'Roboto', weight: 400, style: 'normal' },
  ];
  const out = attribute({
    html: '<body><p class="x" style="font-family:Roboto">x</p></body>',
    css: '.x { font-family: Inter; }',
    faces,
  });
  assert.equal(out[key(faces[0])], undefined);
  assert.equal(out[key(faces[1])], 'x');
});

test('css-static: inline <style> in the page is parsed for rules', () => {
  const faces = [{ family: 'Inter', weight: 400, style: 'normal' }];
  const out = attribute({
    html: '<body><style>p{font-family:Inter}</style><p>x</p></body>',
    css: '',
    faces,
  });
  assert.equal(out[key(faces[0])], 'x');
});

test('css-static: pseudo-class :hover always-true (over-includes)', () => {
  const faces = [
    { family: 'Inter', weight: 400, style: 'normal' },
    { family: 'Inter', weight: 700, style: 'normal' },
  ];
  // a:hover { font-weight: bold } — treated as always-applied, so the link
  // text contributes to the bold face too.
  const out = attribute({
    html: '<body><a href="x">click</a></body>',
    css: 'body{font-family:Inter} a:hover{font-weight:bold}',
    faces,
  });
  // weight cascade: a inherits 400 from body, then :hover-always-true makes
  // it 700. So the matched face is 700.
  assert.equal(out[key(faces[1])], 'cikl');
});

test('css-static: unicode-range on the declared face filters attributed glyphs', () => {
  const faces = [
    { family: 'A', weight: 400, style: 'normal', unicodeRange: 'U+0061-0063' }, // a-c
    { family: 'A', weight: 400, style: 'normal', unicodeRange: 'U+0064-0066' }, // d-f
  ];
  // Both faces share family+weight+style but split unicode-range. Since the
  // engine picks the BEST face for a request (and they tie on weight/style),
  // it'll pick whichever sorts first. To exercise unicode-range filtering
  // cleanly, give them different weights so each face only sees its requested
  // codepoints.
  const split = [
    { family: 'A', weight: 400, style: 'normal', unicodeRange: 'U+0061-0063' },
    { family: 'A', weight: 700, style: 'normal' },
  ];
  const out = attribute({
    html: '<body><p>abcdef</p></body>',
    css: 'body{font-family:A; font-weight: 400}',
    faces: split,
  });
  // Face 0 (range a-c) only catches a, b, c.
  assert.equal(out[key(split[0])], 'abc');
});

test('css-static: <pre>/<code>/<kbd> get UA monospace family by default', () => {
  // Without any author CSS or registered mono family, our Inter face won't
  // catch code glyphs.
  const faces = [{ family: 'Inter', weight: 400, style: 'normal' }];
  const out = attribute({
    html: '<body><p>hi <code>X</code></p></body>',
    css: 'body{font-family:Inter}',
    faces,
  });
  assert.equal(out[key(faces[0])], ' hi'); // 'X' was attributed to monospace, not Inter
});

test('css-static: precision:"family" merges weights/styles into one bucket', () => {
  const faces = [
    { family: 'Inter', weight: 400, style: 'normal' },
    { family: 'Inter', weight: 700, style: 'normal' },
  ];
  const out = attribute({
    html: '<body><p>a <strong>b</strong></p></body>',
    css: 'body{font-family:Inter}',
    faces,
    precision: 'family',
  });
  // Single bucket keyed by family.
  assert.equal(Object.keys(out).length, 1);
  assert.equal(out['inter'], ' ab');
});

test('css-static: @font-face declared only in user CSS is not attributed', () => {
  // No <Font> calls, only a user @font-face. Engine recognizes the face for
  // matching purposes (so text resolves to it), but doesn't yield it as a
  // subsettable face — registeredFaces is empty.
  const out = attribute({
    html: '<body><p>x</p></body>',
    css: '@font-face{font-family:UserOnly;src:url("u.woff2")} body{font-family:UserOnly}',
    faces: [],
  });
  assert.equal(Object.keys(out).length, 0);
});

test('css-static: <script> and <style> text is not attributed as glyphs', () => {
  const faces = [{ family: 'Inter', weight: 400, style: 'normal' }];
  const out = attribute({
    html:
      '<body style="font-family:Inter">' +
      'visible<script>script_text</script><style>style_text</style>' +
      '</body>',
    css: '',
    faces,
  });
  // Only "visible" attributes, sorted unique: 'beilsv'.
  assert.equal(out[key(faces[0])], 'beilsv');
});

test('css-static: ID selector has higher specificity than class', () => {
  const faces = [
    { family: 'A', weight: 400, style: 'normal' },
    { family: 'B', weight: 400, style: 'normal' },
  ];
  const out = attribute({
    html: '<body><p id="hero" class="x">y</p></body>',
    css: '#hero{font-family:B} .x{font-family:A}',
    faces,
  });
  assert.equal(out[key(faces[1])], 'y');
  assert.equal(out[key(faces[0])], undefined);
});

test('css-static: !important on a class beats an ID specificity', () => {
  const faces = [
    { family: 'A', weight: 400, style: 'normal' },
    { family: 'B', weight: 400, style: 'normal' },
  ];
  const out = attribute({
    html: '<body><p id="hero" class="x">y</p></body>',
    css: '#hero{font-family:B} .x{font-family:A !important}',
    faces,
  });
  assert.equal(out[key(faces[0])], 'y');
});

test('css-static: descendant combinator (a b)', () => {
  const faces = [{ family: 'X', weight: 400, style: 'normal' }];
  const out = attribute({
    html: '<body><section><p>match</p></section><p>nope</p></body>',
    css: 'section p { font-family: X; }',
    faces,
  });
  assert.equal(out[key(faces[0])], 'achmt');
});

test('css-static: child combinator (a > b) only matches direct children', () => {
  const faces = [{ family: 'X', weight: 400, style: 'normal' }];
  const out = attribute({
    html: '<body><section><p>nope</p><div><p>match</p></div></section></body>',
    css: 'section > p { font-family: X; }',
    faces,
  });
  // Only direct-child <p> ("nope") matches; the nested one doesn't.
  assert.equal(out[key(faces[0])], 'enop');
});

test('css-static: empty HTML / no body yields no attribution', () => {
  const out = attribute({
    html: '',
    css: '',
    faces: [{ family: 'X', weight: 400, style: 'normal' }],
  });
  assert.equal(Object.keys(out).length, 0);
});
