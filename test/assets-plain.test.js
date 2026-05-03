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
