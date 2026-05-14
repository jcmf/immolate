import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';
import { createAssetRegistry } from '../src/assets.js';
import { createStyleRegistry } from '../src/style.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

test('inlines as <style> when CSS is below the inline threshold', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="./tiny.css" />\n',
    '/in/tiny.css': '.a { color: red; }',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<style>\.a \{ color: red; \}<\/style>/);
});

test('emits a content-addressed file and <link> when CSS is above the threshold', async () => {
  const css = '.b { color: blue; }';
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="./big.css" inlineThreshold={0} />\n',
    '/in/big.css': css,
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const m = html.match(/<link rel="stylesheet" href="(\/_assets\/[a-f0-9]+\.css)">/);
  assert.ok(m, `expected link tag in: ${html}`);
  const written = await fs.promises.readFile(`/out${m[1]}`, 'utf8');
  assert.equal(written, css);
});

test('two pages using the same CSS share one /_assets file', async () => {
  const css = '.shared { color: green; }';
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '# r\n\n<Style src="/shared.css" inlineThreshold={0} />\n',
    '/in/other.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '# o\n\n<Style src="/shared.css" inlineThreshold={0} />\n',
    '/in/shared.css': css,
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  const other = await fs.promises.readFile('/out/other/index.html', 'utf8');
  const rootHref = root.match(/href="(\/_assets\/[a-f0-9]+\.css)"/)[1];
  const otherHref = other.match(/href="(\/_assets\/[a-f0-9]+\.css)"/)[1];
  assert.equal(rootHref, otherHref);
  const assets = await fs.promises.readdir('/out/_assets');
  assert.equal(assets.length, 1);
});

test('rewrites url() references relative to the source CSS directory', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="/css/main.css" inlineThreshold={0} />\n',
    '/in/css/main.css':
      ".bg { background-image: url('./bg.png'); }",
    '/in/css/bg.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('binary'),
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const linkHref = html.match(/href="(\/_assets\/[a-f0-9]+\.css)"/)[1];
  const cssOut = await fs.promises.readFile(`/out${linkHref}`, 'utf8');
  const urlMatch = cssOut.match(/url\("(\/_assets\/[a-f0-9]+\.png)"\)/);
  assert.ok(urlMatch, `expected rewritten url in: ${cssOut}`);
  const referenced = await fs.promises.stat(`/out${urlMatch[1]}`);
  assert.ok(referenced.size > 0);
});

test('rewrites url() with a leading-slash path against topDir', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="/css/main.css" inlineThreshold={0} />\n',
    '/in/css/main.css':
      ".bg { background-image: url('/img/hero.png'); }",
    '/in/img/hero.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('binary'),
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const linkHref = html.match(/href="(\/_assets\/[a-f0-9]+\.css)"/)[1];
  const cssOut = await fs.promises.readFile(`/out${linkHref}`, 'utf8');
  assert.match(cssOut, /url\("\/_assets\/[a-f0-9]+\.png"\)/);
});

test('passes data:, http(s):, //, and # URLs through verbatim', async () => {
  const cssIn =
    '.a { background: url(data:image/png;base64,AAAA); }\n' +
    '.b { background: url("https://example.com/x.png"); }\n' +
    '.c { background: url(//cdn.example.com/y.png); }\n' +
    '.d { clip-path: url(#mask); }';
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="./pass.css" inlineThreshold={1000000} />\n',
    '/in/pass.css': cssIn,
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /url\(data:image\/png;base64,AAAA\)/);
  assert.match(html, /url\("https:\/\/example\.com\/x\.png"\)/);
  assert.match(html, /url\(\/\/cdn\.example\.com\/y\.png\)/);
  assert.match(html, /url\(#mask\)/);
});

test('fonts referenced via @font-face url() resolve and emit', async () => {
  const fontBytes = Buffer.from('FONTBYTES');
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="./fonts.css" inlineThreshold={0} />\n',
    '/in/fonts.css':
      "@font-face { font-family: 'X'; src: url('./fx.woff2') format('woff2'); }",
    '/in/fx.woff2': fontBytes.toString('binary'),
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const linkHref = html.match(/href="(\/_assets\/[a-f0-9]+\.css)"/)[1];
  const cssOut = await fs.promises.readFile(`/out${linkHref}`, 'utf8');
  assert.match(cssOut, /url\("\/_assets\/[a-f0-9]+\.woff2"\)/);
});

test('.ttf url() inside CSS emits as-is (no auto-transcode); use <Font> for woff2', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="./fonts.css" inlineThreshold={0} />\n',
    '/in/fonts.css':
      "@font-face { font-family: 'X'; src: url('./fx.ttf') format('truetype'); }",
    '/in/fx.ttf': 'TTFRAW',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const linkHref = html.match(/href="(\/_assets\/[a-f0-9]+\.css)"/)[1];
  const cssOut = await fs.promises.readFile(`/out${linkHref}`, 'utf8');
  assert.match(cssOut, /url\("\/_assets\/[a-f0-9]+\.ttf"\) format\('truetype'\)/);
  assert.doesNotMatch(cssOut, /woff2/);
});

test('pass-through attrs survive: media on <style> and on <link>', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="./small.css" media="print" />\n' +
      '<Style src="./big.css" inlineThreshold={0} media="screen" />\n',
    '/in/small.css': '.a {}',
    '/in/big.css': '.b {}',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<style media="print">\.a \{\}<\/style>/);
  assert.match(html, /<link rel="stylesheet" href="\/_assets\/[a-f0-9]+\.css" media="screen">/);
});

test('className is renamed to class on the emitted tag', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="./tiny.css" className="theme" />\n',
    '/in/tiny.css': '.a {}',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<style class="theme">/);
});

test('missing src is rejected with a clear error', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n<Style />\n",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /<Style> requires a non-empty src \(in "index\.md"\)/,
  );
});

test('a missing CSS source surfaces a clear error', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="./missing.css" />\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /<Style>: source not found at \/in\/missing\.css \(requested by "index\.md"\)/,
  );
});

test('a missing url() reference surfaces a clear error', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="./broken.css" />\n',
    '/in/broken.css': ".a { background: url('./missing.png'); }",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /<Style>: url\("\.\/missing\.png"\) not found at \/in\/missing\.png \(referenced from "index\.md"\)/,
  );
});

test('styleInlineThreshold build option sets the project-wide default', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="./tiny.css" />\n',
    '/in/tiny.css': '.a {}',
  });
  await build({
    inputDir: '/in',
    outputDir: '/out',
    styleInlineThreshold: 0,
    fs,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/_assets\//);
});

test('Style works when imported from a .jsx component', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import Theme from './theme.jsx';\n\n# r\n\n<Theme />\n",
    '/in/theme.jsx':
      "import {Style} from 'xtatic:style';\n" +
      'export default function Theme() {\n' +
      '  return <Style src="./theme.css" />;\n' +
      '}\n',
    '/in/theme.css': '.t { color: teal; }',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<style>\.t \{ color: teal; \}<\/style>/);
});

test('importing xtatic:style alongside xtatic:image works on the same page', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n" +
      "import {Image} from 'xtatic:image';\n\n" +
      '<Style src="./s.css" />\n' +
      '<Image src="./i.svg" alt="i" inlineThreshold={1000000} />\n',
    '/in/s.css': '.s {}',
    '/in/i.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<style>\.s \{\}<\/style>/);
  assert.match(html, /<img src="data:image\/svg\+xml;base64,/);
});

test('the unknown-builtin error lists xtatic:style', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {x} from 'xtatic:nope';\n\n# r\n",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /"xtatic:builtins", "xtatic:image", "xtatic:style", "xtatic:font"/,
  );
});

// ---- cssForPage seam (consumed by the font-cascade engine in commit 3+) ----

test('cssForPage returns rewritten CSS for tokens that appear in the html', async () => {
  const fs = makeFs({ '/in/a.css': '.a { color: red; }' });
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  const styleRegistry = createStyleRegistry({
    fs,
    topDir: '/in',
    assetRegistry,
  });
  const Style = styleRegistry.forImporter('/in/page.mdx');
  const { html: token } = Style({ src: './a.css' });
  await styleRegistry.processAll();
  const pageHtml = `<head>${token}</head><body>hi</body>`;
  assert.deepEqual(styleRegistry.cssForPage(pageHtml), [
    '.a { color: red; }',
  ]);
});

test('cssForPage returns [] when no style tokens appear in the html', async () => {
  const fs = makeFs({ '/in/a.css': '.a { color: red; }' });
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  const styleRegistry = createStyleRegistry({
    fs,
    topDir: '/in',
    assetRegistry,
  });
  const Style = styleRegistry.forImporter('/in/page.mdx');
  Style({ src: './a.css' }); // registered but token not in page
  await styleRegistry.processAll();
  assert.deepEqual(styleRegistry.cssForPage('<p>hello</p>'), []);
});

test('cssForPage dedupes by source — two tokens, one CSS file → one entry', async () => {
  const fs = makeFs({ '/in/a.css': '.a {}' });
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  const styleRegistry = createStyleRegistry({
    fs,
    topDir: '/in',
    assetRegistry,
  });
  const Style = styleRegistry.forImporter('/in/page.mdx');
  const t1 = Style({ src: './a.css' }).html;
  const t2 = Style({ src: './a.css' }).html;
  await styleRegistry.processAll();
  const result = styleRegistry.cssForPage(`${t1}${t2}`);
  assert.equal(result.length, 1);
  assert.equal(result[0], '.a {}');
});

test('cssForPage returns CSS from multiple distinct sources', async () => {
  const fs = makeFs({
    '/in/a.css': '.a {}',
    '/in/b.css': '.b {}',
  });
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  const styleRegistry = createStyleRegistry({
    fs,
    topDir: '/in',
    assetRegistry,
  });
  const Style = styleRegistry.forImporter('/in/page.mdx');
  const t1 = Style({ src: './a.css' }).html;
  const t2 = Style({ src: './b.css' }).html;
  await styleRegistry.processAll();
  const result = styleRegistry.cssForPage(`${t1}${t2}`).sort();
  assert.deepEqual(result, ['.a {}', '.b {}']);
});

test('the same url() referenced from two CSS files dedupes to one asset', async () => {
  const png = Buffer.from('PNGBYTES');
  const fs = makeFs({
    '/in/index.md':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="/a.css" inlineThreshold={0} />\n' +
      '<Style src="/b.css" inlineThreshold={0} />\n',
    '/in/a.css': ".a { background: url('/shared.png'); }",
    '/in/b.css': ".b { background: url('/shared.png'); }",
    '/in/shared.png': png.toString('binary'),
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const pngFiles = (await fs.promises.readdir('/out/_assets')).filter((f) =>
    f.endsWith('.png'),
  );
  assert.equal(pngFiles.length, 1);
});
