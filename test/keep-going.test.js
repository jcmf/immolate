import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

// Run a keep-going build and return the AggregateError it rejects with.
async function buildExpectingErrors(fs, extra = {}) {
  let caught;
  try {
    await build({ inputDir: '/in', outputDir: '/out', fs, keepGoing: true, ...extra });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'expected the build to reject');
  assert.ok(caught instanceof AggregateError, `expected AggregateError, got ${caught}`);
  assert.equal(caught.xtaticKeepGoing, true);
  return caught;
}

const exists = (fs, p) => fs.existsSync(p);

test('keepGoing: a page with a compile error is skipped, the rest are written', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/good.md': '# Good\n',
    '/in/broken.md': '# Broken\n\n<div>\n',
  });
  const err = await buildExpectingErrors(fs);
  assert.equal(err.errors.length, 1);
  assert.match(err.message, /^Build finished with 1 error:/);
  assert.match(err.message, /\[1\/1\] Failed to compile "broken\.md"/);
  assert.match(err.message, /1 page was not written because of the errors above: broken$/);
  assert.deepEqual(err.skippedPages, ['broken']);
  assert.ok(exists(fs, '/out/index.html'));
  assert.ok(exists(fs, '/out/good/index.html'));
  assert.ok(!exists(fs, '/out/broken/index.html'));
});

test('without keepGoing the same input throws the plain error (unchanged behavior)', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/broken.md': '# Broken\n\n<div>\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    (e) => !(e instanceof AggregateError) && /Failed to compile "broken\.md"/.test(e.message),
  );
  assert.ok(!exists(fs, '/out/index.html'));
});

test('keepGoing: several independent errors are all reported, numbered', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/a.md': '# A\n\n<div>\n',
    '/in/b.md': '# B\n\n<span>\n',
    '/in/c.md': '# C\n',
  });
  const err = await buildExpectingErrors(fs);
  assert.equal(err.errors.length, 2);
  assert.match(err.message, /^Build finished with 2 errors:/);
  assert.match(err.message, /\[1\/2\] Failed to compile "a\.md"/);
  assert.match(err.message, /\[2\/2\] Failed to compile "b\.md"/);
  assert.match(err.message, /2 pages were not written because of the errors above: a, b$/);
  assert.ok(exists(fs, '/out/c/index.html'));
});

test('keepGoing: a broken import shared by two pages is reported once, both pages skipped', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/x.md': "import Bad from './lib/bad.mdx'\n\n<Bad />\n",
    '/in/y.md': "import Bad from './lib/bad.mdx'\n\n<Bad />\n",
    '/in/lib/bad.mdx': '<div>\n',
  });
  const err = await buildExpectingErrors(fs);
  assert.equal(err.errors.length, 1);
  assert.match(err.message, /Failed to compile "lib\/bad\.mdx"/);
  // lib/bad.mdx is a page in its own right, so it's listed too — but the one
  // error object behind all three is reported once.
  assert.deepEqual(err.skippedPages, ['lib/bad', 'x', 'y']);
  assert.ok(exists(fs, '/out/index.html'));
  assert.ok(!exists(fs, '/out/x/index.html'));
  assert.ok(!exists(fs, '/out/y/index.html'));
});

test('keepGoing: a missing layout shared by many pages is reported once; pages without it still build', async () => {
  const fs = makeFs({
    '/in/index.md': '---\ndefaultLayout: nope\n---\n# Home\n',
    '/in/a.md': '# A\n',
    '/in/b.md': '# B\n',
    '/in/plain.md': '---\nlayout: null\n---\n# Plain\n',
  });
  const err = await buildExpectingErrors(fs);
  assert.equal(err.errors.length, 1);
  assert.match(err.message, /Layout "nope" \(requested by "a\.md"\) not found/);
  assert.deepEqual(err.skippedPages, ['/', 'a', 'b']);
  assert.ok(exists(fs, '/out/plain/index.html'));
  assert.ok(!exists(fs, '/out/index.html'));
  assert.ok(!exists(fs, '/out/a/index.html'));
});

test('keepGoing: a render-time throw skips that page with its context trace; children still render', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/docs/index.md':
      "export function Boom() { throw new Error('kaboom') }\n\n<Boom />\n",
    '/in/docs/child.md': '# Child\n',
  });
  const err = await buildExpectingErrors(fs);
  assert.equal(err.errors.length, 1);
  assert.match(err.message, /kaboom/);
  assert.match(err.message, /in <Boom> at docs\/index\.md:3:1/);
  assert.match(err.message, /while building page docs/);
  assert.deepEqual(err.skippedPages, ['docs']);
  assert.ok(exists(fs, '/out/docs/child/index.html'));
  assert.ok(!exists(fs, '/out/docs/index.html'));
});

test('keepGoing: a missing plain asset skips only the page that references it', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n\n![pic](./missing.png)\n',
    '/in/ok.md': '# OK\n\n![pic](./real.png)\n',
    '/in/real.png': 'PNGBYTES',
  });
  const err = await buildExpectingErrors(fs);
  assert.equal(err.errors.length, 1);
  assert.match(err.message, /Asset not found at \/in\/missing\.png/);
  assert.match(err.message, /in <img> at index\.md:3:1/);
  assert.deepEqual(err.skippedPages, ['/']);
  assert.ok(!exists(fs, '/out/index.html'));
  const ok = fs.readFileSync('/out/ok/index.html', 'utf8');
  assert.match(ok, /src="data:image\/png;base64,/);
  assert.doesNotMatch(ok, /__XTATIC_/);
});

test('keepGoing: a missing <Style> source skips the referencing page; a missing <Image> source too', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/s.md': "import {Style} from 'xtatic:style'\n\n<Style src=\"./nope.css\" />\n",
    '/in/i.md': "import {Image} from 'xtatic:image'\n\n<Image src=\"./nope.svg\" alt=\"\" />\n",
  });
  const err = await buildExpectingErrors(fs);
  assert.equal(err.errors.length, 2);
  assert.match(err.message, /<Style>: source not found at \/in\/nope\.css/);
  assert.match(err.message, /<Image>: source not found at \/in\/nope\.svg/);
  assert.deepEqual(err.skippedPages, ['i', 's']);
  assert.ok(exists(fs, '/out/index.html'));
  assert.ok(!exists(fs, '/out/s/index.html'));
  assert.ok(!exists(fs, '/out/i/index.html'));
});

test('keepGoing: an output-path collision drops the later claimant and keeps the first', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/a.md': '---\noutputPath: /same.html\n---\n# A\n',
    '/in/b.md': '---\noutputPath: /same.html\n---\n# B\n',
  });
  const err = await buildExpectingErrors(fs);
  assert.equal(err.errors.length, 1);
  assert.match(err.message, /Two pages write to the same output path "\/out\/same\.html": "a" and "b"/);
  assert.deepEqual(err.skippedPages, ['b']);
  assert.match(fs.readFileSync('/out/same.html', 'utf8'), /<h1>A<\/h1>/);
  assert.ok(exists(fs, '/out/index.html'));
});

test('keepGoing: a link to a page that failed still resolves to its URL, never a copied source', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n\n[Broken](./broken.md)\n',
    '/in/broken.md': "export function Boom() { throw new Error('no') }\n\n<Boom />\n",
  });
  const err = await buildExpectingErrors(fs);
  assert.deepEqual(err.skippedPages, ['broken']);
  const html = fs.readFileSync('/out/index.html', 'utf8');
  assert.match(html, /href="broken\/"/);
  assert.ok(!exists(fs, '/out/_assets'));
});

test('keepGoing: a generator whose getPages() throws produces no pages; the rest build', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/tag-{tag}.md':
      "export const getPages = () => { throw new Error('bad list') }\n\n# Tag\n",
    '/in/other.md': '# Other\n',
  });
  const err = await buildExpectingErrors(fs);
  assert.equal(err.errors.length, 1);
  assert.match(err.message, /Page generator "tag-\{tag\}\.md" getPages\(\) threw: bad list/);
  assert.deepEqual(err.skippedPages, ['tag-{tag}']);
  assert.ok(exists(fs, '/out/other/index.html'));
});

test('keepGoing: stale output is still pruned, and a skipped page\'s old output goes with it', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/gone.md': '# Gone\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(exists(fs, '/out/gone/index.html'));
  fs.writeFileSync('/in/gone.md', '<div>\n');
  fs.writeFileSync('/out/stale.txt', 'old');
  const err = await buildExpectingErrors(fs);
  assert.deepEqual(err.skippedPages, ['gone']);
  assert.ok(exists(fs, '/out/index.html'));
  assert.ok(!exists(fs, '/out/gone/index.html'));
  assert.ok(!exists(fs, '/out/stale.txt'));
});

test('keepGoing: when every page fails, nothing is written and the errors are still reported', async () => {
  const fs = makeFs({
    '/in/index.md': '<div>\n',
    '/in/a.md': '<span>\n',
  });
  const err = await buildExpectingErrors(fs);
  assert.equal(err.errors.length, 2);
  assert.deepEqual(err.skippedPages, ['/', 'a']);
  assert.doesNotMatch(err.message, /No page sources found/);
  assert.ok(!exists(fs, '/out'));
});

test('keepGoing: a fatal (non-per-page) error is listed after the collected ones', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/bad.md': '<div>\n',
  });
  const err = await buildExpectingErrors(fs, { assetsDir: 'a/b' });
  assert.equal(err.errors.length, 1);
  assert.match(err.message, /assetsDir "a\/b" must be a single path segment/);
});

test('keepGoing: a render-context trace is rendered for every collected error, not just the first', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/p.md': "export function A() { throw new Error('first') }\n\n<A />\n",
    '/in/q.md': "export function B() { throw new Error('second') }\n\n<B />\n",
  });
  const err = await buildExpectingErrors(fs);
  assert.match(err.message, /first[\s\S]*in <A> at p\.md:3:1[\s\S]*second[\s\S]*in <B> at q\.md:3:1/);
});
