import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';
import { createRegistry } from '../src/registry.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

test('default import binds to the whole module for .mdx', async () => {
  const fs = makeFs({
    '/in/index.mdx':
      "import About from './about.mdx';\n\n" +
      'Title is: {About.title}\n\n' +
      '<About />\n',
    '/in/about.mdx': '---\ntitle: About me\n---\n# About body\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /Title is: About me/);
  assert.match(html, /<h1>About body<\/h1>/);
});

test('named imports pull frontmatter and named exports off an .mdx module', async () => {
  const fs = makeFs({
    '/in/index.mdx':
      "import { title, tag } from './meta.mdx';\n\n" +
      '{title}-{tag}\n',
    '/in/meta.mdx':
      '---\ntitle: T\n---\nexport const tag = "Q";\n\n# m\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /T-Q/);
});

test('namespace imports give the whole .mdx module', async () => {
  const fs = makeFs({
    '/in/index.mdx':
      "import * as About from './about.mdx';\n\n" +
      '{About.title}: <About />',
    '/in/about.mdx': '---\ntitle: About\n---\n# A',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /About: <h1>A<\/h1>/);
});

test('mixed default + named in one statement', async () => {
  const fs = makeFs({
    '/in/index.mdx':
      "import About, { title } from './about.mdx';\n\n" +
      '{title}\n\n<About />',
    '/in/about.mdx': '---\ntitle: T\n---\n# A',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /T/);
  assert.match(html, /<h1>A<\/h1>/);
});

test('absolute import paths root at topDir, defaulting to inputDir when not given', async () => {
  const fs = makeFs({
    '/in/index.mdx':
      "import About from '/about.mdx';\n\n" +
      '{About.title}\n',
    '/in/about.mdx': '---\ntitle: ABS\n---\n# A',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /ABS/);
});

test('absolute import paths root at topDir, allowing imports from outside inputDir', async () => {
  const fs = makeFs({
    '/top/pages/index.mdx':
      "import Card from '/components/card.mdx';\n\n<Card />",
    '/top/components/card.mdx': '# Card from outside pages\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<h1>Card from outside pages<\/h1>/);
});

test('imports work across nested directories with ../', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/blog/index.mdx':
      "import About from '../about.mdx';\n\n{About.title}",
    '/in/about.mdx': '---\ntitle: From Parent\n---\n# A',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/blog/index.html', 'utf8');
  assert.match(html, /From Parent/);
});

test('circular .mdx imports compile and render correctly', async () => {
  const fs = makeFs({
    '/in/index.mdx':
      "import B from './b.mdx';\n\n" +
      "export const title = 'A';\n\n" +
      'A says B is: {B.title}',
    '/in/b.mdx':
      "import A from './index.mdx';\n\n" +
      "export const title = 'B';\n\n" +
      'B says A is: {A.title}',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const home = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(home, /A says B is: B/);
  const b = await fs.promises.readFile('/out/b/index.html', 'utf8');
  assert.match(b, /B says A is: A/);
});

test('a module imported by name and rendered transitively works (cycle through render)', async () => {
  const fs = makeFs({
    '/in/index.mdx':
      "import B from './b.mdx';\n\n# Index\n\n<B />",
    '/in/b.mdx':
      "import A from './index.mdx';\n\nB-link-to:{A.title}",
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const home = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(home, /<h1>Index<\/h1>/);
  assert.match(home, /B-link-to:/);
});

test('importing a missing .mdx file errors', async () => {
  const fs = makeFs({
    '/in/index.mdx': "import X from './missing.mdx';\n\n<X />",
  });
  await assert.rejects(() =>
    build({ inputDir: '/in', outputDir: '/out', fs }),
  );
});

test('an unsupported import extension is rejected', async () => {
  const fs = makeFs({
    '/in/index.mdx': "import x from './foo.txt';\n\n{x}",
  });
  // The recma plugin skips non-matching specs, leaving MDX's `await import('./foo.txt')`
  // intact, which then hits Node's loader and errors at runtime.
  await assert.rejects(() =>
    build({ inputDir: '/in', outputDir: '/out', fs }),
  );
});

test('side-effect-only import resolves but binds nothing', async () => {
  // The .mdx target has no side effects, but importing it should still resolve
  // (i.e., compile cleanly).
  const fs = makeFs({
    '/in/index.mdx': "import './marker.mdx';\n\n# Hi",
    '/in/marker.mdx': '# m\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<h1>Hi<\/h1>/);
});

test('two pages importing the same .mdx share one mm (no double compile)', async () => {
  const fs = makeFs({
    '/in/index.mdx':
      "import S from './shared.mdx';\n\n{S.title} from index",
    '/in/page.mdx':
      "import S from './shared.mdx';\n\n{S.title} from page",
    '/in/shared.mdx':
      '---\ntitle: SHARED\n---\nexport let count = (globalThis.__c = (globalThis.__c ?? 0) + 1);\n\n# S',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  // shared.mdx's top-level export should have run exactly once.
  assert.equal(globalThis.__c, 1);
  delete globalThis.__c;
});

test('registry.resolveSpec rejects bare specs and shows the importer relative to topDir', () => {
  const reg = createRegistry({ fs: makeFs({}), topDir: '/top' });
  assert.throws(
    () => reg.resolveSpec('/top/pages/index.mdx', 'bare-pkg'),
    /Cannot resolve import "bare-pkg" from "pages\/index\.mdx": specs must start with "\/", "\.\/", or "\.\.\/"\./,
  );
});
