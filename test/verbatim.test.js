import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

async function exists(fs, p) {
  try {
    await fs.promises.stat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

test('a directory with a .xtatic-verbatim marker is copied byte-for-byte to its mirrored position', async () => {
  const legacyHtml =
    '<!doctype html>\n<html><body><a href="/legacy/feed.xml">feed</a><img src="./img/logo.png"></body></html>\n';
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/legacy/.xtatic-verbatim': '',
    '/in/legacy/page.html': legacyHtml,
    '/in/legacy/feed.xml': '<?xml version="1.0"?><feed/>\n',
    '/in/legacy/deep/notes.md': '# not a page\n',
    '/in/legacy/img/logo.png': 'not really a png',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  // Mirrored positions, no foo/index.html remapping, no attribute rewriting.
  assert.equal(await fs.promises.readFile('/out/legacy/page.html', 'utf8'), legacyHtml);
  assert.equal(
    await fs.promises.readFile('/out/legacy/feed.xml', 'utf8'),
    '<?xml version="1.0"?><feed/>\n',
  );
  assert.equal(
    await fs.promises.readFile('/out/legacy/deep/notes.md', 'utf8'),
    '# not a page\n',
  );
  assert.equal(
    await fs.promises.readFile('/out/legacy/img/logo.png', 'utf8'),
    'not really a png',
  );
  // The .md under the marker did not become a page, and the marker isn't copied.
  assert.equal(await exists(fs, '/out/legacy/deep/notes/index.html'), false);
  assert.equal(await exists(fs, '/out/legacy/page/index.html'), false);
  assert.equal(await exists(fs, '/out/legacy/.xtatic-verbatim'), false);
});

test('verbatim files do not appear in the module tree', async () => {
  const fs = makeFs({
    '/in/index.md': '<ul>{childPages.map((c) => <li>{c.name}</li>)}</ul>\n',
    '/in/about.md': '# about\n',
    '/in/legacy/.xtatic-verbatim': '',
    '/in/legacy/index.html': '<html></html>\n',
    '/in/legacy/old.md': '# old\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.equal(html, '<ul><li>about</li></ul>');
});

test('links from pages to verbatim files resolve to page-relative URLs with the literal filename', async () => {
  const fs = makeFs({
    '/in/index.md':
      '[feed](./legacy/feed.xml)\n\n[home](/in/legacy/index.html#top)\n\n<img src="./legacy/logo.png" alt="l" />\n',
    '/in/docs/intro.md': '[feed](/in/legacy/feed.xml?v=2)\n',
    '/in/hand.html':
      '<html><body><a href="./legacy/feed.xml">f</a><link rel="stylesheet" href="./legacy/site.css"></body></html>\n',
    '/in/legacy/.xtatic-verbatim': '',
    '/in/legacy/feed.xml': '<feed/>',
    '/in/legacy/index.html': '<html></html>',
    '/in/legacy/logo.png': 'png',
    '/in/legacy/site.css': 'body{color:red}',
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/', fs });
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(root, /<a href="legacy\/feed\.xml">feed<\/a>/);
  assert.match(root, /<a href="legacy\/index\.html#top">home<\/a>/);
  assert.match(root, /<img src="legacy\/logo\.png" alt="l">/);
  const intro = await fs.promises.readFile('/out/docs/intro/index.html', 'utf8');
  assert.match(intro, /<a href="\.\.\/\.\.\/legacy\/feed\.xml\?v=2">feed<\/a>/);
  const hand = await fs.promises.readFile('/out/hand/index.html', 'utf8');
  assert.match(hand, /<a href="\.\.\/legacy\/feed\.xml">f<\/a>/);
  // A stylesheet link to a verbatim .css stays a <link> (no inlining) and is
  // not copied a second time under _assets/.
  assert.match(hand, /<link rel="stylesheet" href="\.\.\/legacy\/site\.css">/);
  assert.equal(await exists(fs, '/out/_assets'), false);
  assert.equal(await fs.promises.readFile('/out/legacy/site.css', 'utf8'), 'body{color:red}');
});

test('a page and a verbatim file writing to the same output path is an error', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/about.md': '# about\n',
    '/in/about/.xtatic-verbatim': '',
    '/in/about/index.html': '<html></html>\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    /Two sources write to the same output path "\/out\/about\/index\.html": verbatim file "about\/index\.html" and "about"/,
  );
});

test('a verbatim file may not land inside the assets directory', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/_assets/.xtatic-verbatim': '',
    '/in/_assets/x.txt': 'x',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    /Verbatim file "_assets\/x\.txt" writes to "\/out\/_assets\/x\.txt", which is inside the generated assets directory/,
  );
});

test('nested markers are harmless and {placeholder} filenames are literal under a marker', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/v/.xtatic-verbatim': '',
    '/in/v/tag-{tag}.md': 'literal\n',
    '/in/v/inner/.xtatic-verbatim': '',
    '/in/v/inner/a.txt': 'a',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await fs.promises.readFile('/out/v/tag-{tag}.md', 'utf8'), 'literal\n');
  assert.equal(await fs.promises.readFile('/out/v/inner/a.txt', 'utf8'), 'a');
  assert.equal(await exists(fs, '/out/v/inner/.xtatic-verbatim'), false);
});

test('a marker at the input root leaves no page sources', async () => {
  const fs = makeFs({
    '/in/.xtatic-verbatim': '',
    '/in/index.md': '# root\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    /No page sources found/,
  );
});

test('verbatim output is pruned and refreshed across rebuilds', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/v/.xtatic-verbatim': '',
    '/in/v/a.txt': 'a1',
    '/in/v/b.txt': 'b',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await fs.promises.readFile('/out/v/b.txt', 'utf8'), 'b');
  await fs.promises.writeFile('/in/v/a.txt', 'a2');
  await fs.promises.unlink('/in/v/b.txt');
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await fs.promises.readFile('/out/v/a.txt', 'utf8'), 'a2');
  assert.equal(await exists(fs, '/out/v/b.txt'), false);
  // Removing the marker turns the directory back into ordinary input: the
  // stale verbatim copy is pruned and nothing references a.txt any more.
  await fs.promises.unlink('/in/v/.xtatic-verbatim');
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await exists(fs, '/out/v/a.txt'), false);
});
