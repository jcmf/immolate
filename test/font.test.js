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

function makeRegistry(
  files,
  { transcode = stubTranscode, subset = stubSubset } = {},
) {
  const fs = makeFs(files);
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  const fontRegistry = createFontRegistry({
    fs,
    topDir: '/in',
    assetRegistry,
    transcode,
    subset,
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

const SYSTEM_TTF_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
];
function findSystemTtf() {
  for (const p of SYSTEM_TTF_CANDIDATES) {
    try {
      nodeFs.statSync(p);
      return p;
    } catch {}
  }
  return null;
}

const SYSTEM_TTF_GROUP = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
];
function findSystemTtfGroup() {
  const found = SYSTEM_TTF_GROUP.filter((p) => {
    try {
      nodeFs.statSync(p);
      return true;
    } catch {
      return false;
    }
  });
  return found.length >= 3 ? found : null;
}

test(
  'real wawoff2 produces valid WOFF2 bytes from a system TTF via <Font>',
  { skip: findSystemTtf() == null ? 'no system TTF available' : false },
  async () => {
    const ttfBytes = nodeFs.readFileSync(findSystemTtf());
    const fs = makeFs({});
    fs.mkdirSync('/in', { recursive: true });
    fs.writeFileSync('/in/font.ttf', ttfBytes);
    fs.writeFileSync(
      '/in/index.md',
      "import {Font} from 'xtatic:font';\n\n" +
        '<Font src="./font.ttf" family="X" />\n',
    );
    await build({ inputDir: '/in', outputDir: '/out', fs });
    const html = fs.readFileSync('/out/index.html', 'utf8');
    const m = html.match(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\)/);
    assert.ok(m);
    const written = fs.readFileSync(`/out${m[1]}`);
    assert.equal(written.slice(0, 4).toString('ascii'), 'wOF2');
    assert.ok(written.length < ttfBytes.length);
  },
);

test(
  'real subset-font: text= shrinks a system TTF and emits valid WOFF2 via <Font>',
  { skip: findSystemTtf() == null ? 'no system TTF available' : false },
  async () => {
    const ttfPath = findSystemTtf();
    const ttfBytes = nodeFs.readFileSync(ttfPath);
    const fs = makeFs({});
    fs.mkdirSync('/in', { recursive: true });
    fs.writeFileSync('/in/font.ttf', ttfBytes);
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
    // a 6-glyph subset of a full Unicode face must be dramatically smaller
    assert.ok(
      written.length < ttfBytes.length / 4,
      `subset not small enough: ${written.length} vs ${ttfBytes.length}`,
    );
  },
);

test(
  'concurrent transcodes of distinct TTFs each yield valid wOF2 bytes',
  { skip: findSystemTtfGroup() == null ? 'need 3+ system TTFs' : false },
  async () => {
    const ttfs = findSystemTtfGroup();
    const fs = makeFs({});
    fs.mkdirSync('/in', { recursive: true });
    let body = "import {Font} from 'xtatic:font';\n\n";
    ttfs.forEach((p, i) => {
      fs.writeFileSync(`/in/f${i}.ttf`, nodeFs.readFileSync(p));
      body += `<Font src="./f${i}.ttf" family="F${i}" />\n`;
    });
    fs.writeFileSync('/in/index.md', body);
    await build({ inputDir: '/in', outputDir: '/out', fs });
    const files = fs.readdirSync('/out/_assets');
    assert.equal(files.length, ttfs.length);
    for (const f of files) {
      const bytes = fs.readFileSync(`/out/_assets/${f}`);
      assert.equal(
        bytes.slice(0, 4).toString('ascii'),
        'wOF2',
        `corrupt output: ${f}`,
      );
    }
  },
);
