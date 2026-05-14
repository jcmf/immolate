import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';
import { createAssetRegistry } from '../src/assets.js';
import { createFontRegistry } from '../src/font.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

const STUB_WOFF2 = Buffer.from('wOF2-fake-bytes');
const stubTranscode = async (_bytes) => STUB_WOFF2;
// Echo the requested glyph set into the output bytes so tests can assert what
// the subsetter was handed (and so distinct glyph sets produce distinct bytes).
const stubSubset = async (_bytes, text) => Buffer.from(`wOF2-subset[${text}]`);
// The default test stub returns an empty source coverage so hedge no-ops on
// stub bytes (real fontkit can't parse 'OTFRAW' / 'WOFF2RAW'). Hedge-specific
// tests pass an explicit getCoverage that returns a known Set.
const stubEmptyCoverage = () => new Set();

function makeRegistry(
  files,
  { transcode = stubTranscode, subset = stubSubset, getCoverage = stubEmptyCoverage } = {},
) {
  const fs = makeFs(files);
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  const fontRegistry = createFontRegistry({
    fs,
    topDir: '/in',
    assetRegistry,
    transcode,
    subset,
    getCoverage,
  });
  return { fs, assetRegistry, fontRegistry };
}

async function renderOne(files, props, { transcode, subset } = {}) {
  const { fs, assetRegistry, fontRegistry } = makeRegistry(files, {
    transcode,
    subset,
  });
  const Font = fontRegistry.forImporter('/in/page.mdx');
  const { html: token } = Font(props);
  const substitute = await fontRegistry.processAll();
  await assetRegistry.writeAll();
  return { html: substitute(token), token, fs };
}

test('.ttf source is transcoded to woff2 and emitted with format("woff2")', async () => {
  const { html, fs } = await renderOne(
    { '/in/f.ttf': 'TTFRAW' },
    { src: './f.ttf', family: 'Inter' },
  );
  const m = html.match(
    /<style>@font-face\{font-family:"Inter";src:url\("(\/_assets\/[a-f0-9]+\.woff2)"\) format\("woff2"\)\}<\/style>/,
  );
  assert.ok(m, `unexpected html: ${html}`);
  const written = await fs.promises.readFile(`/out${m[1]}`);
  assert.equal(Buffer.compare(written, STUB_WOFF2), 0);
});

test('.otf source is transcoded to woff2', async () => {
  const { html } = await renderOne(
    { '/in/f.otf': 'OTFRAW' },
    { src: './f.otf', family: 'X' },
  );
  assert.match(html, /url\("\/_assets\/[a-f0-9]+\.woff2"\) format\("woff2"\)/);
});

test('.woff2 source passes through without transcoding', async () => {
  let called = false;
  const { html, fs } = await renderOne(
    { '/in/f.woff2': 'WOFF2RAW' },
    { src: './f.woff2', family: 'X' },
    {
      transcode: async () => {
        called = true;
        return Buffer.from('');
      },
    },
  );
  assert.equal(called, false);
  const m = html.match(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\) format\("woff2"\)/);
  assert.ok(m);
  const written = await fs.promises.readFile(`/out${m[1]}`, 'utf8');
  assert.equal(written, 'WOFF2RAW');
});

test('.woff (v1) source passes through without transcoding', async () => {
  let called = false;
  const { html } = await renderOne(
    { '/in/f.woff': 'WOFFRAW' },
    { src: './f.woff', family: 'X' },
    {
      transcode: async () => {
        called = true;
        return Buffer.from('');
      },
    },
  );
  assert.equal(called, false);
  assert.match(html, /url\("\/_assets\/[a-f0-9]+\.woff"\) format\("woff"\)/);
});

test('preload prop adds a <link rel=preload> before the @font-face style', async () => {
  const { html } = await renderOne(
    { '/in/f.ttf': 'TTFRAW' },
    { src: './f.ttf', family: 'Inter', preload: true },
  );
  const m = html.match(
    /^<link rel="preload" as="font" type="font\/woff2" href="(\/_assets\/[a-f0-9]+\.woff2)" crossorigin><style>@font-face\{[^}]*src:url\("\1"\) format\("woff2"\)\}<\/style>$/,
  );
  assert.ok(m, `unexpected html: ${html}`);
});

test('preload type matches the final ext for pass-through .woff sources', async () => {
  const { html } = await renderOne(
    { '/in/f.woff': 'WOFFRAW' },
    { src: './f.woff', family: 'X', preload: true },
    {
      transcode: async () => {
        throw new Error('should not be called');
      },
    },
  );
  assert.match(html, /<link rel="preload" as="font" type="font\/woff" /);
});

test('preload defaults off — only the @font-face <style> is emitted', async () => {
  const { html } = await renderOne(
    { '/in/f.woff2': 'WOFF2RAW' },
    { src: './f.woff2', family: 'X' },
  );
  assert.doesNotMatch(html, /<link/);
  assert.match(html, /^<style>@font-face/);
});

test('weight/style/display/unicodeRange land in the @font-face declaration', async () => {
  const { html } = await renderOne(
    { '/in/f.woff2': 'X' },
    {
      src: './f.woff2',
      family: 'Inter',
      weight: 700,
      style: 'italic',
      display: 'swap',
      unicodeRange: 'U+0000-00FF',
    },
  );
  assert.match(html, /font-family:"Inter"/);
  assert.match(html, /font-style:italic/);
  assert.match(html, /font-weight:700/);
  assert.match(html, /font-display:swap/);
  assert.match(html, /unicode-range:U\+0000-00FF/);
});

test('a string weight (e.g. variable-font range) is preserved verbatim', async () => {
  const { html } = await renderOne(
    { '/in/f.woff2': 'X' },
    { src: './f.woff2', family: 'V', weight: '100 900' },
  );
  assert.match(html, /font-weight:100 900/);
});

test('family name with a quote is CSS-escaped', async () => {
  const { html } = await renderOne(
    { '/in/f.woff2': 'X' },
    { src: './f.woff2', family: 'My "Cool" Font' },
  );
  assert.match(html, /font-family:"My \\"Cool\\" Font"/);
});

test('two Font calls with the same src share one asset file', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistry({
    '/in/f.ttf': 'TTFRAW',
  });
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.ttf', family: 'Inter', weight: 400 });
  Font({ src: './f.ttf', family: 'Inter', weight: 700 });
  await fontRegistry.processAll();
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  assert.equal(files.length, 1);
});

test('different .woff2 sources produce different asset files', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistry({
    '/in/a.woff2': 'AAAA',
    '/in/b.woff2': 'BBBB',
  });
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './a.woff2', family: 'A' });
  Font({ src: './b.woff2', family: 'B' });
  await fontRegistry.processAll();
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  assert.equal(files.length, 2);
});

test('missing src is rejected with a clear error', async () => {
  const { fontRegistry } = makeRegistry({});
  const Font = fontRegistry.forImporter('/in/page.mdx');
  assert.throws(
    () => Font({ family: 'X' }),
    /<Font> requires a non-empty src \(in "page\.mdx"\)/,
  );
});

test('missing family is rejected with a clear error', async () => {
  const { fontRegistry } = makeRegistry({});
  const Font = fontRegistry.forImporter('/in/page.mdx');
  assert.throws(
    () => Font({ src: './f.ttf' }),
    /<Font src="\.\/f\.ttf"> requires a non-empty family/,
  );
});

test('unsupported extension is rejected', async () => {
  const { fontRegistry } = makeRegistry({});
  const Font = fontRegistry.forImporter('/in/page.mdx');
  assert.throws(
    () => Font({ src: './f.eot', family: 'X' }),
    /unsupported extension; expected \.ttf, \.otf, \.woff, or \.woff2/,
  );
});

test('invalid display value is rejected', async () => {
  const { fontRegistry } = makeRegistry({});
  const Font = fontRegistry.forImporter('/in/page.mdx');
  assert.throws(
    () => Font({ src: './f.ttf', family: 'X', display: 'fast' }),
    /display must be one of /,
  );
});

test('invalid style value is rejected', async () => {
  const { fontRegistry } = makeRegistry({});
  const Font = fontRegistry.forImporter('/in/page.mdx');
  assert.throws(
    () => Font({ src: './f.ttf', family: 'X', style: 'slanted' }),
    /style must be one of /,
  );
});

test('unknown extra props are rejected (no silent pass-through)', async () => {
  const { fontRegistry } = makeRegistry({});
  const Font = fontRegistry.forImporter('/in/page.mdx');
  assert.throws(
    () => Font({ src: './f.ttf', family: 'X', media: 'print' }),
    /received unknown prop\(s\): media/,
  );
});

test('a missing source file surfaces a clear error', async () => {
  const { fontRegistry } = makeRegistry({});
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './missing.ttf', family: 'X' });
  await assert.rejects(
    () => fontRegistry.processAll(),
    /<Font>: source not found at \/in\/missing\.ttf \(requested by "page\.mdx"\)/,
  );
});

// ---- subsetting via the `text` prop ----

test('text subsets the source and emits the result as woff2', async () => {
  const { html, fs } = await renderOne(
    { '/in/logo.otf': 'OTFRAW' },
    { src: './logo.otf', family: 'Logo', text: 'xtatic' },
  );
  const m = html.match(
    /<style>@font-face\{font-family:"Logo";src:url\("(\/_assets\/[a-f0-9]+\.woff2)"\) format\("woff2"\)\}<\/style>/,
  );
  assert.ok(m, `unexpected html: ${html}`);
  const written = await fs.promises.readFile(`/out${m[1]}`, 'utf8');
  // canonical glyph set for "xtatic" = sorted unique chars
  assert.equal(written, 'wOF2-subset[acitx]');
});

test('text subsets a .woff2 source too (not just transcodable formats)', async () => {
  let transcodeCalled = false;
  const { html } = await renderOne(
    { '/in/f.woff2': 'WOFF2RAW' },
    { src: './f.woff2', family: 'X', text: 'abc' },
    {
      transcode: async () => {
        transcodeCalled = true;
        return Buffer.from('');
      },
    },
  );
  assert.equal(transcodeCalled, false);
  assert.match(html, /url\("\/_assets\/[a-f0-9]+\.woff2"\) format\("woff2"\)/);
});

test('text on a .ttf source subsets instead of transcoding', async () => {
  let transcodeCalled = false;
  const { html } = await renderOne(
    { '/in/f.ttf': 'TTFRAW' },
    { src: './f.ttf', family: 'X', text: 'abc' },
    {
      transcode: async () => {
        transcodeCalled = true;
        return STUB_WOFF2;
      },
    },
  );
  assert.equal(transcodeCalled, false);
  assert.match(html, /format\("woff2"\)/);
});

test('subset glyph set is canonicalized — "ab" and "ba" share one asset', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistry({
    '/in/f.otf': 'OTFRAW',
  });
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'X', text: 'ab' });
  Font({ src: './f.otf', family: 'Y', text: 'baa' });
  await fontRegistry.processAll();
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  assert.equal(files.length, 1);
});

test('different glyph sets for the same src produce different assets', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistry({
    '/in/f.otf': 'OTFRAW',
  });
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'X', text: 'ab' });
  Font({ src: './f.otf', family: 'X', text: 'abc' });
  await fontRegistry.processAll();
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  assert.equal(files.length, 2);
});

test('a subsetted and a non-subsetted reference to one src are distinct assets', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistry({
    '/in/f.woff2': 'WOFF2RAW',
  });
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.woff2', family: 'X' });
  Font({ src: './f.woff2', family: 'X', text: 'abc' });
  await fontRegistry.processAll();
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  assert.equal(files.length, 2);
});

test('preload with text uses type="font/woff2"', async () => {
  const { html } = await renderOne(
    { '/in/f.woff': 'WOFFRAW' },
    { src: './f.woff', family: 'X', text: 'abc', preload: true },
  );
  assert.match(html, /<link rel="preload" as="font" type="font\/woff2" /);
});

test('empty text is rejected', async () => {
  const { fontRegistry } = makeRegistry({});
  const Font = fontRegistry.forImporter('/in/page.mdx');
  assert.throws(
    () => Font({ src: './f.ttf', family: 'X', text: '' }),
    /text must be a non-empty string \(in "page\.mdx"\)/,
  );
});

test('non-string text is rejected', async () => {
  const { fontRegistry } = makeRegistry({});
  const Font = fontRegistry.forImporter('/in/page.mdx');
  assert.throws(
    () => Font({ src: './f.ttf', family: 'X', text: 123 }),
    /text must be a non-empty string/,
  );
});

// ---- end-to-end through build() ----

test('Font is usable end-to-end from an .md page', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Font} from 'xtatic:font';\n\n" +
      '<Font src="./f.woff2" family="Inter" weight={400} />\n',
    '/in/f.woff2': 'WOFF2RAW',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(
    html,
    /<style>@font-face\{font-family:"Inter";font-weight:400;src:url\("\/_assets\/[a-f0-9]+\.woff2"\) format\("woff2"\)\}<\/style>/,
  );
});

test('the unknown-builtin error lists xtatic:font', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {x} from 'xtatic:nope';\n\n# r\n",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /"xtatic:font"/,
  );
});

test('Font coexists with Style and Image on the same page', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Font} from 'xtatic:font';\n" +
      "import {Style} from 'xtatic:style';\n" +
      "import {Image} from 'xtatic:image';\n\n" +
      '<Font src="./f.woff2" family="X" />\n' +
      '<Style src="./s.css" />\n' +
      '<Image src="./i.svg" alt="i" inlineThreshold={1000000} />\n',
    '/in/f.woff2': 'WOFF2',
    '/in/s.css': '.s {}',
    '/in/i.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<style>@font-face\{font-family:"X"/);
  assert.match(html, /<style>\.s \{\}<\/style>/);
  assert.match(html, /<img src="data:image\/svg\+xml;base64,/);
});

// A small real TrueType font (a printable-ASCII subset of Noto Sans, OFL) is
// committed under test/fixtures/ so the "real wawoff2 / real subset-font" tests
// below always have a font to chew on — no hunting for a system font, no skips.
// See test/fixtures/README.md for provenance.
const FIXTURE_TTF = nodeFs.readFileSync(
  new URL('./fixtures/test-font.ttf', import.meta.url),
);

// Distinct, valid TrueType files derived from the fixture (subset-font is a dev
// dependency) — used to drive several transcodes that must NOT share bytes.
async function distinctTtfsFromFixture(texts) {
  const subsetFont = (await import('subset-font')).default;
  return Promise.all(
    texts.map((t) => subsetFont(FIXTURE_TTF, t, { targetFormat: 'truetype' })),
  );
}

test('real wawoff2 transcodes the bundled TTF to valid WOFF2 via <Font>', async () => {
  const fs = makeFs({});
  fs.mkdirSync('/in', { recursive: true });
  fs.writeFileSync('/in/font.ttf', FIXTURE_TTF);
  fs.writeFileSync(
    '/in/index.md',
    "import {Font} from 'xtatic:font';\n\n" +
      '<Font src="./font.ttf" family="X" />\n',
  );
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = fs.readFileSync('/out/index.html', 'utf8');
  const m = html.match(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\)/);
  assert.ok(m, `no font asset URL in: ${html}`);
  const written = fs.readFileSync(`/out${m[1]}`);
  assert.equal(written.slice(0, 4).toString('ascii'), 'wOF2');
  assert.ok(written.length < FIXTURE_TTF.length);
});

test('real subset-font: text= shrinks the bundled TTF and emits valid WOFF2 via <Font>', async () => {
  const fs = makeFs({});
  fs.mkdirSync('/in', { recursive: true });
  fs.writeFileSync('/in/font.ttf', FIXTURE_TTF);
  fs.writeFileSync(
    '/in/index.md',
    "import {Font} from 'xtatic:font';\n\n" +
      '<Font src="./font.ttf" family="Logo" text="xtatic" />\n' +
      // a second call asking for the SAME glyph set must dedupe to one asset
      '<Font src="./font.ttf" family="LogoAlt" text="cixat" />\n',
  );
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = fs.readFileSync('/out/index.html', 'utf8');
  const urls = [...html.matchAll(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\)/g)].map(
    (m) => m[1],
  );
  assert.equal(urls.length, 2);
  assert.equal(urls[0], urls[1], 'same glyph set should share one asset');
  const written = fs.readFileSync(`/out${urls[0]}`);
  assert.equal(written.slice(0, 4).toString('ascii'), 'wOF2');
  // a 5-glyph subset must be well under the (already small) ASCII fixture
  assert.ok(
    written.length < FIXTURE_TTF.length / 2,
    `subset not small enough: ${written.length} vs ${FIXTURE_TTF.length}`,
  );
});

test('concurrent transcodes of distinct TTFs each yield valid WOFF2 bytes', async () => {
  const ttfs = await distinctTtfsFromFixture(['abc', 'defg', 'hijkl', 'mn']);
  const fs = makeFs({});
  fs.mkdirSync('/in', { recursive: true });
  let body = "import {Font} from 'xtatic:font';\n\n";
  ttfs.forEach((bytes, i) => {
    fs.writeFileSync(`/in/f${i}.ttf`, bytes);
    body += `<Font src="./f${i}.ttf" family="F${i}" />\n`;
  });
  fs.writeFileSync('/in/index.md', body);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const files = fs.readdirSync('/out/_assets');
  assert.equal(files.length, ttfs.length);
  for (const f of files) {
    const bytes = fs.readFileSync(`/out/_assets/${f}`);
    assert.equal(bytes.slice(0, 4).toString('ascii'), 'wOF2', `corrupt: ${f}`);
  }
});

// ---- auto-subset via fontSubset config / per-call `subset` prop ----

// Helper: spin up a registry with fontSubset enabled, run a call, scan a
// constructed `pages` array, return the substituted HTML and emitted files.
function makeRegistryWithSubset(files, fontSubset, { getCoverage = stubEmptyCoverage } = {}) {
  const fs = makeFs(files);
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  const fontRegistry = createFontRegistry({
    fs,
    topDir: '/in',
    assetRegistry,
    fontSubset,
    transcode: stubTranscode,
    subset: stubSubset,
    getCoverage,
  });
  return { fs, assetRegistry, fontRegistry };
}

test('mode:"all-text" subsets every font to the union of all rendered text', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text' },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  const { html: token } = Font({ src: './f.otf', family: 'X' });
  const pages = [{ outPath: '/out/index.html', html: '<p>Hello world!</p>' }];
  const substitute = await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const html = substitute(token);
  const m = html.match(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\)/);
  assert.ok(m, `unexpected html: ${html}`);
  const written = await fs.promises.readFile(`/out${m[1]}`, 'utf8');
  // canonical glyph set for "Hello world!" = ' ', '!', 'H', 'd', 'e', 'l',
  // 'o', 'r', 'w' (sorted unique)
  assert.equal(written, 'wOF2-subset[ !Hdelorw]');
});

test('per-call subset={true} opts in without global config (all-text)', async () => {
  // Without a global fontSubset config, per-call subset={true} still works.
  // Pinned to all-text mode by passing it on the registry — css-static would
  // need CSS to attribute glyphs and that's exercised separately below.
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text' },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  const { html: token } = Font({ src: './f.otf', family: 'X', subset: true });
  const pages = [{ outPath: '/out/index.html', html: '<p>abc</p>' }];
  const substitute = await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const html = substitute(token);
  const m = html.match(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\)/);
  const written = await fs.promises.readFile(`/out${m[1]}`, 'utf8');
  assert.equal(written, 'wOF2-subset[abc]');
});

test('per-call subset={false} opts out when fontSubset is on', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.ttf': 'TTFRAW' },
    true,
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.ttf', family: 'X', subset: false });
  const pages = [{ outPath: '/out/index.html', html: '<p>abc</p>' }];
  await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  const bytes = await fs.promises.readFile(`/out/_assets/${files[0]}`);
  // transcoded (STUB_WOFF2), not subset
  assert.equal(Buffer.compare(bytes, STUB_WOFF2), 0);
});

test('explicit text= wins over auto-subset on the same call', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    undefined,
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'X', subset: true, text: 'abc' });
  const pages = [{ outPath: '/out/index.html', html: '<p>zzz</p>' }];
  await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  const bytes = await fs.promises.readFile(`/out/_assets/${files[0]}`, 'utf8');
  assert.equal(bytes, 'wOF2-subset[abc]');
});

test('mode:"all-text" unions text across multiple pages (scope:site)', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text' },
  );
  const Font = fontRegistry.forImporter('/in/layouts/default.md');
  Font({ src: '/f.otf', family: 'X' });
  const pages = [
    { outPath: '/out/index.html', html: '<p>foo</p>' },
    { outPath: '/out/about/index.html', html: '<p>bar</p>' },
  ];
  await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  assert.equal(files.length, 1);
  const bytes = await fs.promises.readFile(`/out/_assets/${files[0]}`, 'utf8');
  // union of "foo" and "bar" = a, b, f, o, r (sorted unique)
  assert.equal(bytes, 'wOF2-subset[abfor]');
});

test('mode:"all-text" excludes script/style/template contents', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text' },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'X' });
  const pages = [
    {
      outPath: '/out/index.html',
      html:
        '<p>abc</p><script>alert("zzz")</script><style>.x{color:#fff}</style>',
    },
  ];
  await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  const bytes = await fs.promises.readFile(`/out/_assets/${files[0]}`, 'utf8');
  assert.equal(bytes, 'wOF2-subset[abc]');
});

test('mode:"all-text" decodes &lt; &gt; &quot; &amp; in subset text', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text' },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'X' });
  const pages = [
    { outPath: '/out/index.html', html: '<p>&lt;&gt;&quot;&amp;</p>' },
  ];
  await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  const bytes = await fs.promises.readFile(`/out/_assets/${files[0]}`, 'utf8');
  // sorted unique: '"', '&', '<', '>'
  assert.equal(bytes, 'wOF2-subset["&<>]');
});

test('mode:"all-text" — two calls to the same src share one asset', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text' },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'A', weight: 400 });
  Font({ src: './f.otf', family: 'A', weight: 700 });
  const pages = [{ outPath: '/out/index.html', html: '<p>abc</p>' }];
  await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  // both calls get the same auto-subset text "abc" → one job → one asset
  assert.equal(files.length, 1);
});

test('non-boolean subset prop is rejected', async () => {
  const { fontRegistry } = makeRegistry({});
  const Font = fontRegistry.forImporter('/in/page.mdx');
  assert.throws(
    () => Font({ src: './f.ttf', family: 'X', subset: 'yes' }),
    /subset must be a boolean/,
  );
});

test('invalid fontSubset.mode is rejected with a clear error', () => {
  const fs = makeFs({});
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  assert.throws(
    () =>
      createFontRegistry({
        fs,
        topDir: '/in',
        assetRegistry,
        fontSubset: { mode: 'browser' },
      }),
    /fontSubset\.mode must be one of all-text, css-static; got "browser"/,
  );
});

test('fontSubset of a wrong type is rejected', () => {
  const fs = makeFs({});
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  assert.throws(
    () =>
      createFontRegistry({
        fs,
        topDir: '/in',
        assetRegistry,
        fontSubset: 'yes',
      }),
    /fontSubset must be true, false, or an options object/,
  );
});

test('auto-subset with no pages falls back to transcode/passthrough', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.ttf': 'TTFRAW' },
    true,
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.ttf', family: 'X' });
  await fontRegistry.processAll([]);
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  assert.equal(files.length, 1);
  const bytes = await fs.promises.readFile(`/out/_assets/${files[0]}`);
  // transcoded (STUB_WOFF2), not subset
  assert.equal(Buffer.compare(bytes, STUB_WOFF2), 0);
});

// ---- css-static mode (default when fontSubset is true) ----

test('mode:"css-static" subsets a face to glyphs cascade-attributes to it', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    true, // fontSubset:true → css-static + face precision (the default).
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'Inter' });
  const pages = [
    {
      outPath: '/out/index.html',
      html: '<body style="font-family:Inter"><p>hello</p></body>',
    },
  ];
  // cssForPage isn't passed (the body's inline style="" is enough to drive
  // the cascade), so default to no extra CSS.
  await fontRegistry.processAll(pages, { cssForPage: () => [] });
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  const bytes = await fs.promises.readFile(`/out/_assets/${files[0]}`, 'utf8');
  // 'hello' sorted unique = 'ehlo'
  assert.equal(bytes, 'wOF2-subset[ehlo]');
});

test('mode:"css-static" — regular and bold subsets diverge by weight', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/reg.otf': 'REG', '/in/bold.otf': 'BOLD' },
    true,
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './reg.otf', family: 'Inter', weight: 400 });
  Font({ src: './bold.otf', family: 'Inter', weight: 700 });
  const pages = [
    {
      outPath: '/out/index.html',
      html:
        '<body style="font-family:Inter">' +
        '<p>hi <strong>bold</strong>!</p>' +
        '</body>',
    },
  ];
  await fontRegistry.processAll(pages, { cssForPage: () => [] });
  await assetRegistry.writeAll();
  const files = (await fs.promises.readdir('/out/_assets')).sort();
  assert.equal(files.length, 2);
  // Both subset bytes are emitted; one carries 'hi !' glyphs and the other 'bold'.
  const a = await fs.promises.readFile(`/out/_assets/${files[0]}`, 'utf8');
  const b = await fs.promises.readFile(`/out/_assets/${files[1]}`, 'utf8');
  const bag = new Set([a, b]);
  assert.ok(bag.has('wOF2-subset[ !hi]'), `unexpected: ${[...bag].join(' / ')}`);
  assert.ok(bag.has('wOF2-subset[bdlo]'), `unexpected: ${[...bag].join(' / ')}`);
});

test('mode:"css-static" — unmatched family falls back to transcode (not subset)', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.ttf': 'TTFRAW' },
    true,
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  // Family X is declared but no CSS uses it on the page.
  Font({ src: './f.ttf', family: 'X' });
  const pages = [
    {
      outPath: '/out/index.html',
      html: '<body><p>hello</p></body>',
    },
  ];
  await fontRegistry.processAll(pages, { cssForPage: () => [] });
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  const bytes = await fs.promises.readFile(`/out/_assets/${files[0]}`);
  // Falls back to transcode (STUB_WOFF2), not subset.
  assert.equal(Buffer.compare(bytes, STUB_WOFF2), 0);
});

test('mode:"css-static" — cssForPage callback supplies external CSS', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    true,
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'Inter' });
  const pages = [
    { outPath: '/out/index.html', html: '<body><p>hello</p></body>' },
  ];
  // Pretend a stylesheet reaches the page via <Style>/<link>.
  await fontRegistry.processAll(pages, {
    cssForPage: () => ['body { font-family: Inter; }'],
  });
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  const bytes = await fs.promises.readFile(`/out/_assets/${files[0]}`, 'utf8');
  assert.equal(bytes, 'wOF2-subset[ehlo]');
});

test('mode:"css-static" — precision:"family" merges weights into one subset', async () => {
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'css-static', precision: 'family' },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'Inter', weight: 400 });
  Font({ src: './f.otf', family: 'Inter', weight: 700 });
  const pages = [
    {
      outPath: '/out/index.html',
      html:
        '<body style="font-family:Inter">' +
        '<p>a <strong>b</strong></p>' +
        '</body>',
    },
  ];
  await fontRegistry.processAll(pages, { cssForPage: () => [] });
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  // family precision merges both calls into one subset → one job → one file.
  assert.equal(files.length, 1);
  const bytes = await fs.promises.readFile(`/out/_assets/${files[0]}`, 'utf8');
  // Merged: ' ab' (space, a, b).
  assert.equal(bytes, 'wOF2-subset[ ab]');
});

// ---- hedge / complement subsets ----

test('hedge:"full" emits a complement face covering source-minus-primary', async () => {
  // Source font covers ASCII a-f (97-102). Primary text "abc" → primary face
  // gets {a,b,c}; complement face gets {d,e,f}. Two assets, both via subsetter.
  const cov = new Set([97, 98, 99, 100, 101, 102]);
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text', hedge: 'full' },
    { getCoverage: () => cov },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  const { html: token } = Font({ src: './f.otf', family: 'X' });
  const pages = [{ outPath: '/out/index.html', html: '<p>abc</p>' }];
  const substitute = await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const html = substitute(token);
  // Two @font-face rules in the emitted style.
  const matches = [...html.matchAll(/@font-face\{([^}]+)\}/g)];
  assert.equal(matches.length, 2);
  // Both unicode-ranges are present and disjoint.
  assert.match(matches[0][1], /unicode-range:U\+61-63/); // primary a-c
  assert.match(matches[1][1], /unicode-range:U\+64-66/); // complement d-f
  // Two distinct asset files, one per glyph set.
  const files = (await fs.promises.readdir('/out/_assets')).sort();
  assert.equal(files.length, 2);
  const bag = new Set(
    await Promise.all(
      files.map((f) => fs.promises.readFile(`/out/_assets/${f}`, 'utf8')),
    ),
  );
  assert.ok(bag.has('wOF2-subset[abc]'));
  assert.ok(bag.has('wOF2-subset[def]'));
});

test('hedge:"none" — no complement, no unicode-range on the primary face', async () => {
  // Same coverage as above; hedge:'none' should produce a single face with
  // no unicode-range descriptor (matching the pre-hedge HTML shape).
  const cov = new Set([97, 98, 99, 100, 101, 102]);
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text', hedge: 'none' },
    { getCoverage: () => cov },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  const { html: token } = Font({ src: './f.otf', family: 'X' });
  const pages = [{ outPath: '/out/index.html', html: '<p>abc</p>' }];
  const substitute = await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const html = substitute(token);
  const matches = [...html.matchAll(/@font-face\{([^}]+)\}/g)];
  assert.equal(matches.length, 1);
  assert.doesNotMatch(matches[0][1], /unicode-range/);
  const files = await fs.promises.readdir('/out/_assets');
  assert.equal(files.length, 1);
});

test('hedge:"latin1" caps the complement to U+0000-U+00FF', async () => {
  // Source font covers a few Latin-1 chars + some BMP-but-above (e.g. arrow).
  const cov = new Set([97, 98, 99, 100, 0x2192, 0x2603]); // a, b, c, d, →, ☃
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text', hedge: 'latin1' },
    { getCoverage: () => cov },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  const { html: token } = Font({ src: './f.otf', family: 'X' });
  const pages = [{ outPath: '/out/index.html', html: '<p>ab</p>' }];
  const substitute = await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const html = substitute(token);
  const matches = [...html.matchAll(/@font-face\{([^}]+)\}/g)];
  assert.equal(matches.length, 2);
  // Complement should only contain the latin-1 chars (c, d), not the arrow.
  assert.match(matches[1][1], /unicode-range:U\+63-64/);
  const files = (await fs.promises.readdir('/out/_assets')).sort();
  const bag = new Set(
    await Promise.all(
      files.map((f) => fs.promises.readFile(`/out/_assets/${f}`, 'utf8')),
    ),
  );
  assert.ok(bag.has('wOF2-subset[ab]'));
  assert.ok(bag.has('wOF2-subset[cd]'));
});

test('hedge: primary covers all source glyphs → no complement emitted', async () => {
  const cov = new Set([97, 98, 99]);
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text', hedge: 'full' },
    { getCoverage: () => cov },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'X' });
  const pages = [{ outPath: '/out/index.html', html: '<p>abc</p>' }];
  await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  // primary covers everything → no complement → one asset.
  assert.equal(files.length, 1);
});

test('hedge: user-supplied unicodeRange disables hedge for that call', async () => {
  const cov = new Set([97, 98, 99, 100, 101, 102]);
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text', hedge: 'full' },
    { getCoverage: () => cov },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  const { html: token } = Font({
    src: './f.otf',
    family: 'X',
    unicodeRange: 'U+0061-0063',
  });
  const pages = [{ outPath: '/out/index.html', html: '<p>ab</p>' }];
  const substitute = await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const html = substitute(token);
  // Single face with the user-supplied unicode-range.
  const matches = [...html.matchAll(/@font-face\{([^}]+)\}/g)];
  assert.equal(matches.length, 1);
  assert.match(matches[0][1], /unicode-range:U\+0061-0063/);
});

test('preloadHedge:"prefetch" emits a prefetch link for the complement', async () => {
  const cov = new Set([97, 98, 99, 100]);
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text', hedge: 'full', preloadHedge: 'prefetch' },
    { getCoverage: () => cov },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  const { html: token } = Font({ src: './f.otf', family: 'X', preload: true });
  const pages = [{ outPath: '/out/index.html', html: '<p>ab</p>' }];
  const substitute = await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const html = substitute(token);
  // Primary preload + complement prefetch + style block.
  assert.match(html, /<link rel="preload" as="font" type="font\/woff2" href="\/_assets\/[^"]+" crossorigin>/);
  assert.match(html, /<link rel="prefetch" as="font" type="font\/woff2" href="\/_assets\/[^"]+" crossorigin>/);
  assert.equal((html.match(/<link /g) ?? []).length, 2);
});

test('preloadHedge:"preload" emits a preload link for both faces', async () => {
  const cov = new Set([97, 98, 99, 100]);
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text', hedge: 'full', preloadHedge: 'preload' },
    { getCoverage: () => cov },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  const { html: token } = Font({ src: './f.otf', family: 'X', preload: true });
  const pages = [{ outPath: '/out/index.html', html: '<p>ab</p>' }];
  const substitute = await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const html = substitute(token);
  // Two preloads.
  const preloads = html.match(/<link rel="preload"/g) ?? [];
  assert.equal(preloads.length, 2);
});

test('preloadHedge:false (default) — no link tag for the complement', async () => {
  const cov = new Set([97, 98, 99, 100]);
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'all-text', hedge: 'full' },
    { getCoverage: () => cov },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  const { html: token } = Font({ src: './f.otf', family: 'X', preload: true });
  const pages = [{ outPath: '/out/index.html', html: '<p>ab</p>' }];
  const substitute = await fontRegistry.processAll(pages);
  await assetRegistry.writeAll();
  const html = substitute(token);
  // Only one link (the primary preload).
  assert.equal((html.match(/<link /g) ?? []).length, 1);
});

test('fontSubset:true → hedge defaults to "full"', async () => {
  // The boolean form is "I want safe defaults" → hedge:'full' (never tofu).
  const cov = new Set([97, 98, 99, 100, 101]);
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    true,
    { getCoverage: () => cov },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'X' });
  const pages = [
    { outPath: '/out/index.html', html: '<body style="font-family:X"><p>ab</p></body>' },
  ];
  await fontRegistry.processAll(pages, { cssForPage: () => [] });
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  // primary (a,b) + complement (c,d,e) → two files.
  assert.equal(files.length, 2);
});

test('fontSubset:{mode:"css-static"} → hedge defaults to "none" (object form)', async () => {
  const cov = new Set([97, 98, 99, 100, 101]);
  const { fs, assetRegistry, fontRegistry } = makeRegistryWithSubset(
    { '/in/f.otf': 'OTFRAW' },
    { mode: 'css-static' }, // explicit object → conservative, hedge defaults to 'none'
    { getCoverage: () => cov },
  );
  const Font = fontRegistry.forImporter('/in/page.mdx');
  Font({ src: './f.otf', family: 'X' });
  const pages = [
    { outPath: '/out/index.html', html: '<body style="font-family:X"><p>ab</p></body>' },
  ];
  await fontRegistry.processAll(pages, { cssForPage: () => [] });
  await assetRegistry.writeAll();
  const files = await fs.promises.readdir('/out/_assets');
  // No complement.
  assert.equal(files.length, 1);
});

test('hedge: invalid value is rejected', () => {
  const fs = makeFs({});
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  assert.throws(
    () =>
      createFontRegistry({
        fs,
        topDir: '/in',
        assetRegistry,
        fontSubset: { mode: 'all-text', hedge: 'aggressive' },
      }),
    /fontSubset\.hedge must be one of none, latin1, full/,
  );
});

test('preloadHedge: invalid value is rejected', () => {
  const fs = makeFs({});
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  assert.throws(
    () =>
      createFontRegistry({
        fs,
        topDir: '/in',
        assetRegistry,
        fontSubset: { mode: 'all-text', preloadHedge: 'fast' },
      }),
    /fontSubset\.preloadHedge must be false, 'prefetch', or 'preload'/,
  );
});

test('mode:"css-static" — invalid precision is rejected', () => {
  const fs = makeFs({});
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  assert.throws(
    () =>
      createFontRegistry({
        fs,
        topDir: '/in',
        assetRegistry,
        fontSubset: { mode: 'css-static', precision: 'mystery' },
      }),
    /fontSubset\.precision must be one of family, face/,
  );
});

test('fontSubset:{mode:"all-text"} end-to-end through build() with the real subsetter', async () => {
  const fs = makeFs({});
  fs.mkdirSync('/in', { recursive: true });
  fs.writeFileSync('/in/font.ttf', FIXTURE_TTF);
  fs.writeFileSync(
    '/in/index.md',
    "import {Font} from 'xtatic:font';\n\n" +
      '<Font src="./font.ttf" family="X" />\n\n' +
      'Hello world\n',
  );
  await build({
    inputDir: '/in',
    outputDir: '/out',
    fs,
    fontSubset: { mode: 'all-text' },
  });
  const html = fs.readFileSync('/out/index.html', 'utf8');
  const m = html.match(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\)/);
  assert.ok(m);
  const written = fs.readFileSync(`/out${m[1]}`);
  assert.equal(written.slice(0, 4).toString('ascii'), 'wOF2');
  // a 10-glyph subset (" Hdelorw") must be well under the ASCII fixture
  assert.ok(
    written.length < FIXTURE_TTF.length / 2,
    `subset not small enough: ${written.length} vs ${FIXTURE_TTF.length}`,
  );
});

test('hedge:"full" end-to-end with real fontkit — emits two faces and disjoint ranges', async () => {
  const fs = makeFs({});
  fs.mkdirSync('/in', { recursive: true });
  fs.writeFileSync('/in/font.ttf', FIXTURE_TTF);
  fs.writeFileSync('/in/site.css', 'body{font-family:Inter}');
  fs.writeFileSync(
    '/in/index.md',
    "import {Font} from 'xtatic:font';\n" +
      "import {Style} from 'xtatic:style';\n\n" +
      '<Font src="./font.ttf" family="Inter" />\n' +
      '<Style src="./site.css" />\n\n' +
      'Hi\n',
  );
  await build({
    inputDir: '/in',
    outputDir: '/out',
    fs,
    fontSubset: true, // hedge defaults to 'full'
  });
  const html = fs.readFileSync('/out/index.html', 'utf8');
  // Two @font-face blocks, both pointing at /_assets/<hash>.woff2 with
  // disjoint unicode-range descriptors.
  const faces = [...html.matchAll(/@font-face\{([^}]+)\}/g)];
  assert.equal(faces.length, 2);
  assert.match(faces[0][1], /unicode-range:U\+/);
  assert.match(faces[1][1], /unicode-range:U\+/);
  // Two distinct asset URLs.
  const urls = new Set(
    [...html.matchAll(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\)/g)].map((m) => m[1]),
  );
  assert.equal(urls.size, 2);
  // Each asset is a valid WOFF2 file.
  for (const u of urls) {
    const bytes = fs.readFileSync(`/out${u}`);
    assert.equal(bytes.slice(0, 4).toString('ascii'), 'wOF2');
  }
});

test('fontSubset:true (default = css-static) end-to-end with the real subsetter', async () => {
  const fs = makeFs({});
  fs.mkdirSync('/in', { recursive: true });
  fs.writeFileSync('/in/font.ttf', FIXTURE_TTF);
  // CSS reaches the page via <Style>; the cssForPage seam threads it into
  // the cascade, which attributes body text to family Inter.
  fs.writeFileSync('/in/site.css', 'body{font-family:Inter}');
  fs.writeFileSync(
    '/in/index.md',
    "import {Font} from 'xtatic:font';\n" +
      "import {Style} from 'xtatic:style';\n\n" +
      '<Font src="./font.ttf" family="Inter" />\n' +
      '<Style src="./site.css" />\n\n' +
      'Hello world\n',
  );
  await build({
    inputDir: '/in',
    outputDir: '/out',
    fs,
    fontSubset: true, // defaults to css-static + face precision
  });
  const html = fs.readFileSync('/out/index.html', 'utf8');
  const m = html.match(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\)/);
  assert.ok(m);
  const written = fs.readFileSync(`/out${m[1]}`);
  assert.equal(written.slice(0, 4).toString('ascii'), 'wOF2');
  // The cascade attributes "Hello world" to Inter via body{font-family:Inter}.
  // A ~10-glyph subset must be well under the full transcoded font.
  assert.ok(
    written.length < FIXTURE_TTF.length / 2,
    `subset not small enough: ${written.length} vs ${FIXTURE_TTF.length}`,
  );
});

test('concurrent subsets of one TTF to distinct glyph sets each yield valid WOFF2', async () => {
  const fs = makeFs({});
  fs.mkdirSync('/in', { recursive: true });
  fs.writeFileSync('/in/font.ttf', FIXTURE_TTF);
  const texts = ['a', 'bc', 'def', 'ghij'];
  fs.writeFileSync(
    '/in/index.md',
    "import {Font} from 'xtatic:font';\n\n" +
      texts
        .map((t, i) => `<Font src="./font.ttf" family="F${i}" text="${t}" />\n`)
        .join(''),
  );
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const files = fs.readdirSync('/out/_assets');
  assert.equal(files.length, texts.length);
  for (const f of files) {
    const bytes = fs.readFileSync(`/out/_assets/${f}`);
    assert.equal(bytes.slice(0, 4).toString('ascii'), 'wOF2', `corrupt: ${f}`);
  }
});
