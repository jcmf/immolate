import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import sharp from 'sharp';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

async function makePng(width, height, color = { r: 255, g: 0, b: 0 }) {
  return await sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

const SVG_FIXTURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`;

test('inlines as data URL when output is below inlineThreshold', async () => {
  const png = await makePng(2, 2);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./dot.png" alt="dot" inlineThreshold={1000000} />\n',
  });
  await fs.promises.writeFile('/in/dot.png', png);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/avif;base64,[A-Za-z0-9+/=]+"/);
  assert.match(html, /alt="dot"/);
});

test('emits a content-addressed file when output is above inlineThreshold', async () => {
  const png = await makePng(8, 8);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./dot.png" alt="d" inlineThreshold={0} />\n',
  });
  await fs.promises.writeFile('/in/dot.png', png);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const m = html.match(/<img src="(\/_assets\/[a-f0-9]+\.avif)"/);
  assert.ok(m, `expected asset URL in: ${html}`);
  const fname = m[1].split('/').pop();
  const stat = await fs.promises.stat(`/out/_assets/${fname}`);
  assert.ok(stat.size > 0);
});

test('emits width and height attrs computed from the processed image', async () => {
  const png = await makePng(8, 4);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./r.png" alt="r" inlineThreshold={1000000} />\n',
  });
  await fs.promises.writeFile('/in/r.png', png);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /width="8"/);
  assert.match(html, /height="4"/);
});

test('user-specified width resizes with aspect ratio preserved', async () => {
  const png = await makePng(40, 20);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./r.png" alt="r" width={20} inlineThreshold={1000000} />\n',
  });
  await fs.promises.writeFile('/in/r.png', png);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /width="20"/);
  assert.match(html, /height="10"/);
});

test('does not enlarge an image past its source dimensions', async () => {
  const png = await makePng(8, 8);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./small.png" alt="s" width={1000} inlineThreshold={1000000} />\n',
  });
  await fs.promises.writeFile('/in/small.png', png);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /width="8"/);
  assert.match(html, /height="8"/);
});

test('two pages using the same image+opts emit only one asset file', async () => {
  const png = await makePng(8, 8);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '# r\n\n<Image src="/shared.png" alt="x" inlineThreshold={0} />\n',
    '/in/other.md':
      "import {Image} from 'immolate:image';\n\n" +
      '# o\n\n<Image src="/shared.png" alt="x" inlineThreshold={0} />\n',
  });
  await fs.promises.writeFile('/in/shared.png', png);
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  const other = await fs.promises.readFile('/out/other/index.html', 'utf8');
  const rootSrc = root.match(/src="(\/_assets\/[a-f0-9]+\.avif)"/)[1];
  const otherSrc = other.match(/src="(\/_assets\/[a-f0-9]+\.avif)"/)[1];
  assert.equal(rootSrc, otherSrc);
  const assets = await fs.promises.readdir('/out/_assets');
  assert.equal(assets.length, 1);
});

test('different processing opts on the same source emit separate jobs', async () => {
  const png = await makePng(40, 40);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./a.png" alt="a" width={10} inlineThreshold={0} />\n' +
      '<Image src="./a.png" alt="a" width={20} inlineThreshold={0} />\n',
  });
  await fs.promises.writeFile('/in/a.png', png);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const assets = await fs.promises.readdir('/out/_assets');
  assert.equal(assets.length, 2);
});

test('missing alt is rejected with a clear error', async () => {
  const png = await makePng(2, 2);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./dot.png" />\n',
  });
  await fs.promises.writeFile('/in/dot.png', png);
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /<Image src="\.\/dot\.png"> requires an alt attribute/,
  );
});

test('alt="" is allowed for decorative images', async () => {
  const png = await makePng(2, 2);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./dot.png" alt="" inlineThreshold={1000000} />\n',
  });
  await fs.promises.writeFile('/in/dot.png', png);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/avif[^"]+" alt=""/);
});

test('SVG sources are passed through verbatim, not rasterized', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./icon.svg" alt="i" inlineThreshold={0} />\n',
    '/in/icon.svg': SVG_FIXTURE,
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const m = html.match(/<img src="(\/_assets\/[a-f0-9]+\.svg)"/);
  assert.ok(m);
  const written = await fs.promises.readFile(`/out${m[1]}`, 'utf8');
  assert.equal(written, SVG_FIXTURE);
});

test('format option switches the encoder', async () => {
  const png = await makePng(8, 8);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./d.png" alt="d" format="webp" inlineThreshold={0} />\n',
  });
  await fs.promises.writeFile('/in/d.png', png);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="\/_assets\/[a-f0-9]+\.webp"/);
});

test('an invalid format is rejected', async () => {
  const png = await makePng(2, 2);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./d.png" alt="d" format="bmp" />\n',
  });
  await fs.promises.writeFile('/in/d.png', png);
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /format must be one of/,
  );
});

test('format is not allowed on SVG sources', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./i.svg" alt="i" format="avif" />\n',
    '/in/i.svg': SVG_FIXTURE,
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /format option is not supported for SVG sources/,
  );
});

test('pass-through attrs survive: className → class, loading, decoding', async () => {
  const png = await makePng(2, 2);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./d.png" alt="d" className="hero" loading="lazy" decoding="async" inlineThreshold={1000000} />\n',
  });
  await fs.promises.writeFile('/in/d.png', png);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /class="hero"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /decoding="async"/);
});

test('imageInlineThreshold build option sets the project-wide default', async () => {
  const png = await makePng(8, 8);
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./d.png" alt="d" />\n',
  });
  await fs.promises.writeFile('/in/d.png', png);
  await build({
    inputDir: '/in',
    outputDir: '/out',
    imageInlineThreshold: 0,
    fs,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="\/_assets\//);
});

test('a missing image source surfaces a clear error', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Image} from 'immolate:image';\n\n" +
      '<Image src="./missing.png" alt="x" />\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /<Image>: source not found at \/in\/missing\.png \(requested by "index\.md"\)/,
  );
});

test('Image works when imported from a .jsx component', async () => {
  const png = await makePng(2, 2);
  const fs = makeFs({
    '/in/index.md':
      "import Hero from './hero.jsx';\n\n# r\n\n<Hero />\n",
    '/in/hero.jsx':
      "import {Image} from 'immolate:image';\n" +
      'export default function Hero() {\n' +
      '  return <Image src="./pic.png" alt="hero" inlineThreshold={1000000} />;\n' +
      '}\n',
  });
  await fs.promises.writeFile('/in/pic.png', png);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/avif/);
  assert.match(html, /alt="hero"/);
});

test('importing immolate:foo errors with the available list', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {x} from 'immolate:foo';\n\n# r\n",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Unknown builtin module "immolate:foo".*"immolate:builtins", "immolate:image"/s,
  );
});
