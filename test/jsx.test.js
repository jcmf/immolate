import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

async function buildAndRead(files, outRel = 'index.html') {
  const fs = makeFs(files);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  return fs.promises.readFile(`/out/${outRel}`, 'utf8');
}

test('an .md file can import a default-export component from a .jsx file', async () => {
  const html = await buildAndRead({
    '/in/index.md':
      "import Banner from './banner.jsx';\n\n<Banner title=\"Hello\" />\n",
    '/in/banner.jsx':
      "export default function Banner({title}) { return <h1 className=\"b\">{title}</h1>; }\n",
  });
  assert.match(html, /<h1 class="b">Hello<\/h1>/);
});

test('an .md file can import named exports from a .jsx file', async () => {
  const html = await buildAndRead({
    '/in/index.md':
      "import { Greeting } from './lib.jsx';\n\n<Greeting name=\"world\" />\n",
    '/in/lib.jsx':
      "export function Greeting({name}) { return <p>hello {name}</p>; }\n",
  });
  assert.match(html, /<p>hello world<\/p>/);
});

test('a .jsx file can import another .jsx file', async () => {
  const html = await buildAndRead({
    '/in/index.md': "import Outer from './outer.jsx';\n\n<Outer />\n",
    '/in/outer.jsx':
      "import Inner from './inner.jsx';\n" +
      'export default function Outer() { return <section><Inner /></section>; }\n',
    '/in/inner.jsx':
      'export default function Inner() { return <em>inner</em>; }\n',
  });
  assert.match(html, /<section><em>inner<\/em><\/section>/);
});

test('a .jsx file can import an .mdx fragment and render it as a component', async () => {
  const html = await buildAndRead({
    '/in/index.md': "import Page from './page.jsx';\n\n<Page />\n",
    '/in/page.jsx':
      "import Frag from './frag.mdx';\n" +
      'export default function Page() { return <article><Frag /></article>; }\n',
    '/in/frag.mdx': '## Sub\n',
  });
  assert.match(html, /<article><h2>Sub<\/h2><\/article>/);
});

test('.jsx files can import html() and readfile() from xtatic:builtins', async () => {
  const html = await buildAndRead({
    '/in/index.md': "import Inj from './inj.jsx';\n\n<Inj />\n",
    '/in/inj.jsx':
      "import {html, readfile} from 'xtatic:builtins';\n" +
      'export default function Inj() {\n' +
      "  return <div>{html('<!doctype-fragment>')}|{readfile('./greet.txt')}</div>;\n" +
      '}\n',
    '/in/greet.txt': 'hi-from-readfile',
  });
  assert.match(html, /<div><!doctype-fragment>\|hi-from-readfile<\/div>/);
});

test('.jsx without importing the builtin can use the name freely', async () => {
  const html = await buildAndRead({
    '/in/index.md': "import C from './c.jsx';\n\n<C />\n",
    '/in/c.jsx':
      'const html = (s) => ({html: "[user:" + s + "]"});\n' +
      'export default function C() { return <span>{html("v")}</span>; }\n',
  });
  assert.match(html, /<span>\[user:v\]<\/span>/);
});

test('non-Identifier top-level statements are allowed in .jsx (plain const)', async () => {
  const html = await buildAndRead({
    '/in/index.md': "import C from './c.jsx';\n\n<C />\n",
    '/in/c.jsx':
      "const SHOUT = (s) => s.toUpperCase();\n" +
      'export default function C() { return <b>{SHOUT("hey")}</b>; }\n',
  });
  assert.match(html, /<b>HEY<\/b>/);
});

test('a parse error in .jsx surfaces with a clear file path and code frame', async () => {
  const fs = makeFs({
    '/in/index.md': "import C from './c.jsx';\n\n<C />\n",
    '/in/c.jsx': 'export default function C() { return <div }\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Failed to compile "c\.jsx"/,
  );
});

test('a .jsx file works in a cycle: .mdx → .jsx → .mdx', async () => {
  const html = await buildAndRead({
    '/in/index.md':
      "import Wrap from './wrap.jsx';\n\n<Wrap />\n",
    '/in/wrap.jsx':
      "import Body from './body.mdx';\n" +
      'export default function Wrap() { return <main><Body /></main>; }\n',
    '/in/body.mdx': '# Cycled body\n',
  });
  assert.match(html, /<main><h1>Cycled body<\/h1><\/main>/);
});

test('.jsx files in the input tree are NOT auto-promoted to pages', async () => {
  const fs = makeFs({
    '/in/index.md': '# Root\n',
    '/in/orphan.jsx':
      'export default function O() { return <p>orphan</p>; }\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  // Only /out/index.html should exist; no /out/orphan/index.html.
  assert.equal(
    await fs.promises
      .stat('/out/orphan/index.html')
      .then(() => true)
      .catch((e) => e.code),
    'ENOENT',
  );
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(root, /<h1>Root<\/h1>/);
});
