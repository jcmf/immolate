import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { createRegistry } from '../src/registry.js';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

// --- registry.expandTemplate unit tests --------------------------------------

async function loadAndExpand(files, tmplRel) {
  const fs = makeFs(files);
  const registry = createRegistry({ fs, topDir: '/in' });
  const abs = `/in/${tmplRel}`;
  const mm = await registry.loadMdx(abs);
  const entries = registry.expandTemplate(mm, abs, {
    toRelPath: (a) => a.replace(/^\/in\//, ''),
  });
  return { mm, entries };
}

test('expandTemplate produces one child entry per pages item', async () => {
  const { entries } = await loadAndExpand(
    {
      '/in/tag-{tag}.md':
        "export const pages = [{ tag: 'rust' }, { tag: 'js' }]\n\n# {tag}\n",
    },
    'tag-{tag}.md',
  );
  assert.deepEqual(
    entries.map((e) => e.relPath),
    ['tag-rust.md', 'tag-js.md'],
  );
  assert.deepEqual(entries[0].segments, ['tag-rust']);
  assert.equal(entries[0].mm.tag, 'rust');
  assert.equal(entries[0].mm.__xtatic_path, 'tag-rust.md');
  assert.match(entries[0].mm.default().html, /rust/);
  assert.match(entries[1].mm.default().html, /js/);
});

test('item-only fields render per-child; a template const is shared', async () => {
  const { entries } = await loadAndExpand(
    {
      '/in/p-{slug}.md':
        "export const site = 'base'\n" +
        "export const pages = [{ slug: 'a' }, { slug: 'b' }]\n\n" +
        '{site}-{slug}\n',
    },
    'p-{slug}.md',
  );
  // `slug` is item-only → free identifier → per-child; `site` is a template
  // const → shared across pages, and inherited onto each child's exports.
  assert.match(entries[0].mm.default().html, /base-a/);
  assert.match(entries[1].mm.default().html, /base-b/);
  assert.equal(entries[0].mm.site, 'base');
  assert.equal(entries[1].mm.site, 'base');
});

test('a pages item that reuses a template export name is an error', async () => {
  await assert.rejects(
    () =>
      loadAndExpand(
        {
          '/in/p-{slug}.md':
            "export const site = 'base'\n" +
            "export const pages = [{ slug: 'a', site: 'x' }]\n\nhi\n",
        },
        'p-{slug}.md',
      ),
    /pages\[0\] sets "site", which the template already exports/,
  );
});

test('expandTemplate does not carry `pages` onto generated children', async () => {
  const { entries } = await loadAndExpand(
    { '/in/x-{k}.md': "export const pages = [{ k: 'a' }]\n\nhi\n" },
    'x-{k}.md',
  );
  assert.equal('pages' in entries[0].mm, false);
});

test('.url on a generated child points at its own substituted path', async () => {
  // No plainAssetRegistry here, so the url getter is identity (root-absolute).
  const { entries } = await loadAndExpand(
    { '/in/tag-{tag}.md': "export const pages = [{ tag: 'rust' }]\n\nhi\n" },
    'tag-{tag}.md',
  );
  assert.equal(entries[0].mm.url, '/tag-rust.md');
});

test('expandTemplate rejects a non-array `pages`', async () => {
  await assert.rejects(
    () =>
      loadAndExpand(
        { '/in/x-{k}.md': 'export const pages = 5\n\nhi\n' },
        'x-{k}.md',
      ),
    /must export an array `pages` \(got number\)/,
  );
});

test('expandTemplate rejects a non-object pages item', async () => {
  await assert.rejects(
    () =>
      loadAndExpand(
        { '/in/x-{k}.md': 'export const pages = [42]\n\nhi\n' },
        'x-{k}.md',
      ),
    /pages\[0\] must be an object \(got number\)/,
  );
});

test('expandTemplate rejects an item missing a placeholder value', async () => {
  await assert.rejects(
    () =>
      loadAndExpand(
        { '/in/tag-{tag}.md': "export const pages = [{ nope: 'x' }]\n\nhi\n" },
        'tag-{tag}.md',
      ),
    /Missing value for filename placeholder "\{tag\}".*pages\[0\]/s,
  );
});

// --- build() integration tests -----------------------------------------------

test('a generator fans out into one page per item, substituting the filename', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/tag-{tag}.md':
      "export const pages = [{ tag: 'rust' }, { tag: 'js' }]\n\n# Tag: {tag}\n",
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const rust = await fs.promises.readFile('/out/tag-rust/index.html', 'utf8');
  const js = await fs.promises.readFile('/out/tag-js/index.html', 'utf8');
  assert.match(rust, /<h1>Tag: rust<\/h1>/);
  assert.match(js, /<h1>Tag: js<\/h1>/);
  // The generator itself does not render at its own slot.
  await assert.rejects(() => fs.promises.readFile('/out/tag-{tag}/index.html', 'utf8'));
});

test('generated pages join the tree: a listing links them via childPages + url', async () => {
  const fs = makeFs({
    '/in/index.md':
      "{childPages.map((c) => <a href={c.url}>{c.tag}</a>)}\n",
    '/in/tag-{tag}.md':
      "export const pages = [{ tag: 'rust' }, { tag: 'js' }]\n\n# {tag}\n",
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const home = await fs.promises.readFile('/out/index.html', 'utf8');
  // childPages is sorted by name: tag-js then tag-rust; urls are clean dir URLs.
  assert.match(home, /<a href="tag-js\/">js<\/a>/);
  assert.match(home, /<a href="tag-rust\/">rust<\/a>/);
});

test('item exports drive metadata; the substituted name defaults title', async () => {
  const fs = makeFs({
    '/top/layouts/base.mdx':
      '<html><head><title>{props.children.title}</title></head><body>{props.children}</body></html>\n',
    '/top/pages/index.md': '# Home\n',
    '/top/pages/tag-{tag}.md':
      '---\nlayout: base\n---\n' +
      "export const pages = [{ tag: 'rust' }, { tag: 'js', title: 'Custom JS' }]\n\n# {tag}\n",
  });
  await build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs });
  const rust = await fs.promises.readFile('/out/tag-rust/index.html', 'utf8');
  const js = await fs.promises.readFile('/out/tag-js/index.html', 'utf8');
  // tag-rust → name-derived title; tag-js → item-set title wins.
  assert.match(rust, /<title>Tag Rust<\/title>/);
  assert.match(js, /<title>Custom JS<\/title>/);
});

test('an item can redirect its write location with outputPath', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/feed-{slug}.md':
      "export const pages = [{ slug: 'main', outputPath: '/feed.xml' }]\n\nhi {slug}\n",
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const feed = await fs.promises.readFile('/out/feed.xml', 'utf8');
  assert.match(feed, /hi main/);
});

test('a generator can be nested under a section directory', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/blog/index.md': '# Blog\n',
    '/in/blog/post-{slug}.md':
      "export const pages = [{ slug: 'a' }, { slug: 'b' }]\n\n# {slug}\n",
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const a = await fs.promises.readFile('/out/blog/post-a/index.html', 'utf8');
  assert.match(a, /<h1>a<\/h1>/);
  await fs.promises.readFile('/out/blog/post-b/index.html', 'utf8');
});

test('a non-generator file exporting `pages` is an error with a hint', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/posts.md': "export const pages = [{ slug: 'a' }]\n\nhi\n",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /"posts\.md" exports `pages` but its filename has no \{placeholder\}.*posts-\{slug\}\.md/s,
  );
});

test('two items with the same substituted slug collide', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/tag-{tag}.md':
      "export const pages = [{ tag: 'x' }, { tag: 'x' }]\n\nhi\n",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /same output path "tag-x"/,
  );
});

test('a generated slug colliding with a real file is an error', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/tag-rust.md': '# real\n',
    '/in/tag-{tag}.md': "export const pages = [{ tag: 'rust' }]\n\nhi\n",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /same output path "tag-rust"/,
  );
});

test('an empty pages array produces no pages', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/tag-{tag}.md': 'export const pages = []\n\nhi {tag}\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const home = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(home, /<h1>Home<\/h1>/);
});
