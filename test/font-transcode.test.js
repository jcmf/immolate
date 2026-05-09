import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import { Volume, createFsFromVolume } from 'memfs';
import { rewriteCssUrls } from '../src/css-urls.js';
import { createAssetRegistry } from '../src/assets.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

const STUB_WOFF2 = Buffer.from('wOF2-fake-bytes');
const stubTranscode = async (_bytes) => STUB_WOFF2;

async function runRewrite(css, fileMap, opts = {}) {
  const fs = makeFs(fileMap);
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  const out = await rewriteCssUrls({
    css,
    sourceAbsPath: '/in/styles.css',
    fs,
    topDir: '/in',
    assetRegistry,
    notFoundMessage: (url, abs) => `not found: ${url} at ${abs}`,
    transcode: stubTranscode,
    ...opts,
  });
  return { out, fs, assetRegistry };
}

test('.ttf url() is transcoded and emitted with .woff2 extension', async () => {
  const { out, fs, assetRegistry } = await runRewrite(
    "@font-face { src: url('./f.ttf'); }",
    { '/in/f.ttf': 'TTFRAW' },
  );
  const m = out.match(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\)/);
  assert.ok(m, `expected woff2 url in: ${out}`);
  await assetRegistry.writeAll();
  const written = await fs.promises.readFile(`/out${m[1]}`);
  assert.equal(Buffer.compare(written, STUB_WOFF2), 0);
});

test('.otf url() is transcoded and emitted with .woff2 extension', async () => {
  const { out } = await runRewrite(
    "@font-face { src: url('./f.otf'); }",
    { '/in/f.otf': 'OTFRAW' },
  );
  assert.match(out, /url\("\/_assets\/[a-f0-9]+\.woff2"\)/);
});

test("format('truetype') adjacent to a transcoded url is rewritten", async () => {
  const { out } = await runRewrite(
    "@font-face { src: url('./f.ttf') format('truetype'); }",
    { '/in/f.ttf': 'TTFRAW' },
  );
  assert.match(out, /url\("\/_assets\/[a-f0-9]+\.woff2"\) format\("woff2"\)/);
  assert.doesNotMatch(out, /truetype/);
});

test('format("opentype") (double-quoted) is rewritten', async () => {
  const { out } = await runRewrite(
    '@font-face { src: url("./f.otf") format("opentype"); }',
    { '/in/f.otf': 'OTFRAW' },
  );
  assert.match(out, /format\("woff2"\)/);
  assert.doesNotMatch(out, /opentype/);
});

test('format(truetype) bare-ident hint is rewritten', async () => {
  const { out } = await runRewrite(
    "@font-face { src: url('./f.ttf') format(truetype); }",
    { '/in/f.ttf': 'TTFRAW' },
  );
  assert.match(out, /format\("woff2"\)/);
  assert.doesNotMatch(out, /format\(truetype\)/);
});

test('whitespace and newlines between url() and format() are preserved', async () => {
  const { out } = await runRewrite(
    "@font-face { src: url('./f.ttf')\n    format('truetype'); }",
    { '/in/f.ttf': 'TTFRAW' },
  );
  assert.match(
    out,
    /url\("\/_assets\/[a-f0-9]+\.woff2"\)\n {4}format\("woff2"\)/,
  );
});

test('url() with no adjacent format() hint just gets the url rewrite', async () => {
  const { out } = await runRewrite(
    "@font-face { src: url('./f.ttf'); }",
    { '/in/f.ttf': 'TTFRAW' },
  );
  assert.match(out, /url\("\/_assets\/[a-f0-9]+\.woff2"\);/);
  assert.doesNotMatch(out, /format/);
});

test('a non-adjacent format() in the same declaration is not touched', async () => {
  const { out } = await runRewrite(
    "@font-face { src: url('./f.ttf'), url('./g.woff2') format('woff2'); }",
    { '/in/f.ttf': 'TTFRAW', '/in/g.woff2': 'GWOFF2' },
  );
  // The .ttf has no adjacent format() so nothing to rewrite there; the second
  // url's format('woff2') was not preceded by a transcode, so it stays
  // verbatim (single-quoted, as the user wrote it).
  assert.match(out, /url\("\/_assets\/[a-f0-9]+\.woff2"\), url\("\/_assets\/[a-f0-9]+\.woff2"\) format\('woff2'\)/);
});

test('.woff2 sources pass through without transcoding', async () => {
  let called = false;
  const { out } = await runRewrite(
    "@font-face { src: url('./f.woff2') format('woff2'); }",
    { '/in/f.woff2': 'WOFF2RAW' },
    { transcode: async () => { called = true; return Buffer.from(''); } },
  );
  assert.equal(called, false);
  assert.match(out, /url\("\/_assets\/[a-f0-9]+\.woff2"\) format\('woff2'\)/);
});

test('.woff (v1) sources pass through without transcoding', async () => {
  let called = false;
  const { out } = await runRewrite(
    "@font-face { src: url('./f.woff') format('woff'); }",
    { '/in/f.woff': 'WOFFRAW' },
    { transcode: async () => { called = true; return Buffer.from(''); } },
  );
  assert.equal(called, false);
  assert.match(out, /url\("\/_assets\/[a-f0-9]+\.woff"\) format\('woff'\)/);
});

test('non-font extensions are unaffected', async () => {
  const { out } = await runRewrite(
    ".bg { background: url('./pic.png'); }",
    { '/in/pic.png': 'PNG' },
  );
  assert.match(out, /url\("\/_assets\/[a-f0-9]+\.png"\)/);
});

test('passthrough URLs are not transcoded even with .ttf extension', async () => {
  const cssIn =
    "@font-face { src: url('https://cdn.example.com/x.ttf') format('truetype'); }";
  const { out } = await runRewrite(cssIn, {});
  assert.equal(out, cssIn);
});

test('the transcoded asset is content-addressed by the woff2 bytes, not the ttf', async () => {
  const { fs, assetRegistry } = await runRewrite(
    "@font-face { src: url('./a.ttf'); }\n@font-face { src: url('./b.ttf'); }",
    { '/in/a.ttf': 'AAAA', '/in/b.ttf': 'BBBB' },
  );
  await assetRegistry.writeAll();
  const files = (await fs.promises.readdir('/out/_assets')).filter((f) =>
    f.endsWith('.woff2'),
  );
  // Both ttfs transcode to the same stub bytes, so dedupe to 1 file.
  assert.equal(files.length, 1);
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

test(
  'real wawoff2 produces valid WOFF2 bytes from a system TTF',
  { skip: findSystemTtf() == null ? 'no system TTF available' : false },
  async () => {
    const ttfBytes = nodeFs.readFileSync(findSystemTtf());
    const fs = makeFs({});
    fs.mkdirSync('/in', { recursive: true });
    fs.writeFileSync('/in/font.ttf', ttfBytes);
    fs.writeFileSync(
      '/in/styles.css',
      "@font-face { font-family: X; src: url('./font.ttf') format('truetype'); }",
    );
    const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
    const out = await rewriteCssUrls({
      css: fs.readFileSync('/in/styles.css', 'utf8'),
      sourceAbsPath: '/in/styles.css',
      fs,
      topDir: '/in',
      assetRegistry,
      notFoundMessage: (url, abs) => `not found: ${url} at ${abs}`,
      // default transcode = real wawoff2
    });
    const m = out.match(/url\("(\/_assets\/[a-f0-9]+\.woff2)"\)/);
    assert.ok(m);
    assert.match(out, /format\("woff2"\)/);
    await assetRegistry.writeAll();
    const written = fs.readFileSync(`/out${m[1]}`);
    // WOFF2 magic number: 0x774F4632 ('wOF2')
    assert.equal(written.slice(0, 4).toString('ascii'), 'wOF2');
    // Should be smaller than the source TTF (compression).
    assert.ok(written.length < ttfBytes.length, `woff2 (${written.length}) should be smaller than ttf (${ttfBytes.length})`);
  },
);
