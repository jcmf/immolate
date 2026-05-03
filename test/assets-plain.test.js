import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

function bytes(n, fill = 0xab) {
  return Buffer.alloc(n, fill);
}

test('plain <img src> with small file inlines as data: URL', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="./tiny.png" alt="t" />\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="t">/);
});

test('plain <img src> with large file used by one page co-locates', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="./big.png" alt="b" />\n',
  });
  await fs.promises.writeFile('/in/big.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="big\.png" alt="b">/);
  const stat = await fs.promises.stat('/out/big.png');
  assert.equal(stat.size, 8192);
});

test('plain <img src> with large file used by multiple pages goes to /_assets', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="/shared.png" alt="s" />\n',
    '/in/other.md': '<img src="/shared.png" alt="s" />\n',
  });
  await fs.promises.writeFile('/in/shared.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  const other = await fs.promises.readFile('/out/other/index.html', 'utf8');
  const m1 = root.match(/<img src="(\/_assets\/[a-f0-9]+\.png)"/);
  const m2 = other.match(/<img src="(\/_assets\/[a-f0-9]+\.png)"/);
  assert.ok(m1, `expected /_assets URL in: ${root}`);
  assert.ok(m2, `expected /_assets URL in: ${other}`);
  assert.equal(m1[1], m2[1]);
  const assets = await fs.promises.readdir('/out/_assets');
  assert.equal(assets.length, 1);
});

test('markdown image syntax goes through the asset pipeline', async () => {
  const fs = makeFs({
    '/in/index.md': '![alt text](./tiny.png)\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.match(html, /alt="alt text"/);
});

test('passthrough URLs are not processed', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<img src="https://example.com/x.png" alt="a" />\n' +
      '<img src="data:image/png;base64,AAAA" alt="b" />\n' +
      '<img src="//cdn/y.png" alt="c" />\n' +
      '<img src="#frag" alt="d" />\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /src="https:\/\/example\.com\/x\.png"/);
  assert.match(html, /src="data:image\/png;base64,AAAA"/);
  assert.match(html, /src="\/\/cdn\/y\.png"/);
  assert.match(html, /src="#frag"/);
});

test('data-immolate-placement="inline" forces inline regardless of size', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<img src="./big.png" alt="b" data-immolate-placement="inline" />\n',
  });
  await fs.promises.writeFile('/in/big.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /data-immolate-placement/);
});

test('data-immolate-placement="shared" forces /_assets even when small', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<img src="./tiny.png" alt="t" data-immolate-placement="shared" />\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="\/_assets\/[a-f0-9]+\.png"/);
  assert.doesNotMatch(html, /data-immolate-placement/);
});

test('data-immolate-placement="co-located" forces co-location when viable', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<img src="./tiny.png" alt="t" data-immolate-placement="co-located" />\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="tiny\.png"/);
  const stat = await fs.promises.stat('/out/tiny.png');
  assert.equal(stat.size, 10);
});

test('data-immolate-placement="co-located" throws when not viable', async () => {
  const fs = makeFs({
    '/in/posts/index.md': '# posts\n',
    '/in/posts/p.md':
      '<img src="/shared.png" alt="x" data-immolate-placement="co-located" />\n',
    '/in/index.md': '# root\n',
  });
  await fs.promises.writeFile('/in/shared.png', bytes(10));
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs }),
    /Cannot co-locate/,
  );
});

test('asset not found gives a clear error', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="./missing.png" alt="x" />\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Asset not found.*missing\.png/,
  );
});

test('co-located URL inside a nested page dir uses subdir-relative path', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/posts/index.md': '# posts\n',
    '/in/posts/2024-01-01/index.md':
      '<img src="./img/cover.png" alt="c" />\n',
  });
  await fs.promises.mkdir('/in/posts/2024-01-01/img', { recursive: true });
  await fs.promises.writeFile('/in/posts/2024-01-01/img/cover.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile(
    '/out/posts/2024-01-01/index.html',
    'utf8',
  );
  assert.match(html, /<img src="img\/cover\.png"/);
  const stat = await fs.promises.stat('/out/posts/2024-01-01/img/cover.png');
  assert.equal(stat.size, 8192);
});

test('asset in a parent dir of the page falls back to /_assets (no .. URLs)', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/posts/index.md': '# posts\n',
    '/in/posts/2024-01-01/index.md':
      '<img src="../cover.png" alt="c" />\n',
  });
  await fs.promises.writeFile('/in/posts/cover.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile(
    '/out/posts/2024-01-01/index.html',
    'utf8',
  );
  assert.match(html, /<img src="\/_assets\/[a-f0-9]+\.png"/);
});

test('dynamic <img src={var}> classifies at runtime', async () => {
  const fs = makeFs({
    '/in/index.md':
      "export const a = './tiny.png';\nexport const b = 'https://x/y.png';\n\n" +
      '<img src={a} alt="a" />\n<img src={b} alt="b" />\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,[^"]+" alt="a">/);
  assert.match(html, /<img src="https:\/\/x\/y\.png" alt="b">/);
});

test('<script src> is processed', async () => {
  const fs = makeFs({
    '/in/index.md': '<script src="./app.js"></script>\n',
  });
  await fs.promises.writeFile('/in/app.js', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<script src="app\.js"><\/script>/);
});

test('<link rel="stylesheet"> is processed', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="stylesheet" href="./big.css" />\n',
  });
  await fs.promises.writeFile('/in/big.css', bytes(8192, 0x20));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<link rel="stylesheet" href="big\.css">/);
});

test('<link rel="icon"> is processed', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="icon" href="./favicon.ico" />\n',
  });
  await fs.promises.writeFile('/in/favicon.ico', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<link rel="icon" href="data:image\/x-icon;base64,/);
});

test('<link rel="canonical"> is NOT processed (not an asset rel)', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<link rel="canonical" href="https://example.com/page" />\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/page">/);
});

test('<link> with shorthand "shortcut icon" rel is processed', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<link rel="shortcut icon" href="./favicon.ico" />\n',
  });
  await fs.promises.writeFile('/in/favicon.ico', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /href="data:image\/x-icon;base64,/);
});

test('<video src> and <video poster> are both processed', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<video src="./clip.mp4" poster="./thumb.png"></video>\n',
  });
  await fs.promises.writeFile('/in/clip.mp4', bytes(8192));
  await fs.promises.writeFile('/in/thumb.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /src="clip\.mp4"/);
  assert.match(html, /poster="data:image\/png;base64,/);
});

test('<source src> and <audio src> are processed', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<audio><source src="./song.ogg" type="audio/ogg" /></audio>\n' +
      '<audio src="./alt.mp3"></audio>\n',
  });
  await fs.promises.writeFile('/in/song.ogg', bytes(10));
  await fs.promises.writeFile('/in/alt.mp3', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<source src="data:audio\/ogg;base64,/);
  assert.match(html, /<audio src="data:audio\/mpeg;base64,/);
});

test('CSS via plain <link> has its url() refs rewritten', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="stylesheet" href="./main.css" />\n',
    '/in/main.css': ".bg { background: url('./bg.png'); }",
  });
  await fs.promises.writeFile('/in/bg.png', bytes(8192));
  await build({
    inputDir: '/in',
    outputDir: '/out',
    topDir: '/in',
    fs,
    assetInlineThreshold: 0,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const linkHref = html.match(/href="([^"]+)"/)[1];
  const cssPath = linkHref.startsWith('/')
    ? `/out${linkHref}`
    : `/out/${linkHref}`;
  const cssOut = await fs.promises.readFile(cssPath, 'utf8');
  const urlMatch = cssOut.match(/url\("(\/_assets\/[a-f0-9]+\.png)"\)/);
  assert.ok(urlMatch, `expected rewritten url in: ${cssOut}`);
  const referenced = await fs.promises.stat(`/out${urlMatch[1]}`);
  assert.equal(referenced.size, 8192);
});

test('CSS via plain <link> with topDir-absolute url() resolves against topDir', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="stylesheet" href="/css/main.css" />\n',
    '/in/css/main.css': ".bg { background: url('/img/hero.png'); }",
  });
  await fs.promises.mkdir('/in/img', { recursive: true });
  await fs.promises.writeFile('/in/img/hero.png', bytes(8192));
  await build({
    inputDir: '/in',
    outputDir: '/out',
    topDir: '/in',
    fs,
    assetInlineThreshold: 0,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const linkHref = html.match(/href="([^"]+)"/)[1];
  const cssPath = linkHref.startsWith('/')
    ? `/out${linkHref}`
    : `/out/${linkHref}`;
  const cssOut = await fs.promises.readFile(cssPath, 'utf8');
  assert.match(cssOut, /url\("\/_assets\/[a-f0-9]+\.png"\)/);
});

test('inline CSS (data: URL) has its url() refs rewritten before encoding', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="stylesheet" href="./main.css" />\n',
    '/in/main.css': ".bg { background: url('./bg.png'); }",
  });
  await fs.promises.writeFile('/in/bg.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const m = html.match(/href="data:text\/css;base64,([^"]+)"/);
  assert.ok(m, `expected inline data: link in: ${html}`);
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  assert.match(decoded, /url\("\/_assets\/[a-f0-9]+\.png"\)/);
});

test('CSS missing url() ref surfaces a clear error', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="stylesheet" href="./main.css" />\n',
    '/in/main.css': ".bg { background: url('./missing.png'); }",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs }),
    /Asset url\("\.\/missing\.png"\) not found/,
  );
});

test('plain <img src> in a .jsx component goes through the asset pipeline', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import Pic from './pic.jsx';\n\n<Pic />\n",
    '/in/pic.jsx':
      "export default function Pic() {\n" +
      "  return <img src='./tiny.png' alt='t' />;\n" +
      "}\n",
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,/);
});

test('escape hatch works inside .jsx', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import Pic from './pic.jsx';\n\n<Pic />\n",
    '/in/pic.jsx':
      "export default function Pic() {\n" +
      "  return <img src='./big.png' alt='b' data-immolate-placement='inline' />;\n" +
      "}\n",
  });
  await fs.promises.writeFile('/in/big.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /data-immolate-placement/);
});

test('respects assetInlineThreshold config', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="./mid.png" alt="m" />\n',
  });
  await fs.promises.writeFile('/in/mid.png', bytes(100));
  await build({
    inputDir: '/in',
    outputDir: '/out',
    fs,
    assetInlineThreshold: 50,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.doesNotMatch(html, /data:image/);
});
