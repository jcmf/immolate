import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { zipSync, strToU8 } from 'fflate';
import { build } from '../src/index.js';
import { wrapZipFs } from '../src/zipfs.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

function makeZip(entries) {
  const obj = {};
  for (const [name, value] of Object.entries(entries)) {
    obj[name] = typeof value === 'string' ? strToU8(value) : value;
  }
  return Buffer.from(zipSync(obj));
}

test('readfile() reads an entry from inside a .zip path', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {readfile} from 'xtatic:builtins';\n\n" +
      "{readfile('/bundle.zip/hello.txt')}\n",
  });
  await fs.promises.writeFile('/in/bundle.zip', makeZip({ 'hello.txt': 'zip-content' }));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /zip-content/);
});

test('readfile() supports nested entry paths inside a zip', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {readfile} from 'xtatic:builtins';\n\n" +
      "{readfile('/bundle.zip/sub/dir/note.txt')}\n",
  });
  await fs.promises.writeFile(
    '/in/bundle.zip',
    makeZip({ 'sub/dir/note.txt': 'nested-ok' }),
  );
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /nested-ok/);
});

test('plain <img src> served from inside a zip is processed', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="/bundle.zip/pic.png" alt="z" />\n',
  });
  const png = Buffer.alloc(20, 0xcd);
  await fs.promises.writeFile('/in/bundle.zip', makeZip({ 'pic.png': png }));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  // 20 bytes is below the 4KB inline threshold → data URL
  const expectedB64 = png.toString('base64');
  assert.match(html, new RegExp(`<img src="data:image/png;base64,${expectedB64}" alt="z">`));
});

test('CSS url() pointing inside a zip resolves via the wrapper', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<link rel="stylesheet" href="./fonts.css" />\n',
    '/in/fonts.css':
      "@font-face { font-family: F; src: url('/fonts.zip/Inter-Regular.woff2') format('woff2'); }\n",
  });
  const woff2 = Buffer.alloc(64, 0x42);
  await fs.promises.writeFile(
    '/in/fonts.zip',
    makeZip({ 'Inter-Regular.woff2': woff2 }),
  );
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const assets = await fs.promises.readdir('/out/_assets');
  const woff2Asset = assets.find((n) => n.endsWith('.woff2'));
  assert.ok(woff2Asset, `expected a .woff2 asset, got: ${assets.join(', ')}`);
  const emitted = await fs.promises.readFile(`/out/_assets/${woff2Asset}`);
  assert.deepEqual(Buffer.from(emitted), woff2);
});

test('wrapZipFs throws ENOENT with available-entries hint for missing entries', async () => {
  const base = makeFs({});
  await base.promises.writeFile(
    '/b.zip',
    makeZip({ 'present.txt': 'x', 'also.txt': 'y' }),
  );
  const wrapped = wrapZipFs(base);
  await assert.rejects(
    () => wrapped.promises.readFile('/b.zip/missing.txt'),
    /no entry "missing\.txt" inside zip.*also\.txt.*present\.txt/s,
  );
  assert.throws(
    () => wrapped.readFileSync('/b.zip/missing.txt'),
    /no entry "missing\.txt" inside zip/,
  );
});

test('wrapZipFs is a no-op for paths without a .zip/ segment', async () => {
  const base = makeFs({ '/x.txt': 'hi' });
  const wrapped = wrapZipFs(base);
  const buf = await wrapped.promises.readFile('/x.txt', 'utf8');
  assert.equal(buf, 'hi');
  assert.equal(wrapped.readFileSync('/x.txt', 'utf8'), 'hi');
});

test('wrapZipFs caches a zip across multiple reads', async () => {
  const base = makeFs({});
  await base.promises.writeFile(
    '/b.zip',
    makeZip({ 'a.txt': 'A', 'b.txt': 'B' }),
  );
  let reads = 0;
  const counting = {
    ...base,
    readFileSync: (...args) => {
      reads++;
      return base.readFileSync(...args);
    },
    promises: {
      ...base.promises,
      readFile: async (...args) => {
        reads++;
        return base.promises.readFile(...args);
      },
    },
  };
  const wrapped = wrapZipFs(counting);
  const a = await wrapped.promises.readFile('/b.zip/a.txt', 'utf8');
  const b = await wrapped.promises.readFile('/b.zip/b.txt', 'utf8');
  assert.equal(a, 'A');
  assert.equal(b, 'B');
  assert.equal(reads, 1, 'underlying zip should be read only once');
});
