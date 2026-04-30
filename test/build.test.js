import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

test('writes the root index.md to output_dir/index.html', async () => {
  const fs = makeFs({ '/in/index.md': '# Hello\n' });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<h1>Hello<\/h1>/);
});

test('all four equivalent input forms produce the same output path', async () => {
  for (const layout of [
    { '/in/index.md': '# r\n', '/in/foo.md': '# F\n' },
    { '/in/index.md': '# r\n', '/in/foo.mdx': '# F\n' },
    { '/in/index.md': '# r\n', '/in/foo/index.md': '# F\n' },
    { '/in/index.md': '# r\n', '/in/foo/index.mdx': '# F\n' },
  ]) {
    const fs = makeFs(layout);
    await build({ inputDir: '/in', outputDir: '/out', fs });
    const html = await fs.promises.readFile('/out/foo/index.html', 'utf8');
    assert.match(html, /<h1>F<\/h1>/);
  }
});

test('errors when no root index.md/.mdx exists', async () => {
  const fs = makeFs({ '/in/foo.md': '# F\n' });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /No root module found/,
  );
});

test('errors on collision between two equivalent forms', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/foo.md': '# A\n',
    '/in/foo.mdx': '# B\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /same output path/,
  );
});

test('defaultLayout on the root applies to the root and all descendants', async () => {
  const fs = makeFs({
    '/top/pages/index.md':
      '---\ntitle: Home\ndefaultLayout: layout\n---\n# Home\n',
    '/top/pages/about.md': '---\ntitle: About\n---\n# About me\n',
    '/top/pages/blog/index.md': '---\ntitle: Blog\n---\n# Blog\n',
    '/top/pages/blog/post.md': '---\ntitle: Post\n---\n# Post\n',
    '/top/layouts/layout.mdx':
      '<html>\n' +
      '<head><title>{props.children.title}</title></head>\n' +
      '<body>{props.children}</body>\n' +
      '</html>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });

  for (const [path, title] of [
    ['/out/index.html', 'Home'],
    ['/out/about/index.html', 'About'],
    ['/out/blog/index.html', 'Blog'],
    ['/out/blog/post/index.html', 'Post'],
  ]) {
    const html = await fs.promises.readFile(path, 'utf8');
    assert.match(html, new RegExp(`<title>${title}</title>`));
  }
});

test('a subtree index can set its own defaultLayout that wins for its descendants', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ndefaultLayout: outer\n---\n# r\n',
    '/top/pages/section/index.md':
      '---\ndefaultLayout: inner\n---\n# S\n',
    '/top/pages/section/page.md': '# P\n',
    '/top/pages/other/index.md': '# O-section\n',
    '/top/pages/other/page.md': '# O\n',
    '/top/layouts/outer.mdx': '<outer>{props.children}</outer>\n',
    '/top/layouts/inner.mdx': '<inner>{props.children}</inner>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });

  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<outer><h1>r<\/h1>\s*<\/outer>/,
  );
  assert.match(
    await fs.promises.readFile('/out/section/index.html', 'utf8'),
    /<inner><h1>S<\/h1>\s*<\/inner>/,
  );
  assert.match(
    await fs.promises.readFile('/out/section/page/index.html', 'utf8'),
    /<inner><h1>P<\/h1>\s*<\/inner>/,
  );
  assert.match(
    await fs.promises.readFile('/out/other/page/index.html', 'utf8'),
    /<outer><h1>O<\/h1>\s*<\/outer>/,
  );
});

test('a string layout in frontmatter resolves against layoutsDir (bare name → .mdx)', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: blog\n---\n# Hi\n',
    '/top/layouts/blog.mdx': '<wrap>{props.children}</wrap>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<wrap><h1>Hi<\/h1>\s*<\/wrap>/,
  );
});

test('a string layout can include an explicit .md or .mdx suffix', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '# r\n',
    '/top/pages/a.md': '---\nlayout: x.md\n---\n# A\n',
    '/top/pages/b.md': '---\nlayout: x.mdx\n---\n# B\n',
    '/top/layouts/x.md': '<md>{props.children}</md>\n',
    '/top/layouts/x.mdx': '<mdx>{props.children}</mdx>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/a/index.html', 'utf8'),
    /<md><h1>A<\/h1>\s*<\/md>/,
  );
  assert.match(
    await fs.promises.readFile('/out/b/index.html', 'utf8'),
    /<mdx><h1>B<\/h1>\s*<\/mdx>/,
  );
});

test('a string layout falls back to .md when .mdx is absent', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: only-md\n---\n# Hi\n',
    '/top/layouts/only-md.md': '<md>{props.children}</md>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<md><h1>Hi<\/h1>\s*<\/md>/,
  );
});

test('when both .md and .mdx exist for a bare-name layout, .mdx wins', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: dup\n---\n# Hi\n',
    '/top/layouts/dup.md': '<md>{props.children}</md>\n',
    '/top/layouts/dup.mdx': '<mdx>{props.children}</mdx>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<mdx><h1>Hi<\/h1>\s*<\/mdx>/,
  );
});

test('a string layout can use a subpath under layoutsDir', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: posts/article\n---\n# Hi\n',
    '/top/layouts/posts/article.mdx': '<post>{props.children}</post>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<post><h1>Hi<\/h1>\s*<\/post>/,
  );
});

test('a layout loaded by name can itself declare a string layout (chain)', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: inner\n---\n# Hi\n',
    '/top/layouts/inner.mdx':
      '---\nlayout: outer\n---\n<inner>{props.children}</inner>\n',
    '/top/layouts/outer.mdx': '<outer>{props.children}</outer>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<outer><inner><h1>Hi<\/h1>\s*<\/inner>\s*<\/outer>/,
  );
});

test('a missing string layout errors with both candidate paths in the message', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: missing\n---\n# Hi\n',
  });
  await assert.rejects(
    () =>
      build({
        inputDir: '/top/pages',
        outputDir: '/out',
        topDir: '/top',
        fs,
      }),
    /Layout "missing" not found: tried .*missing\.mdx and .*missing\.md\./,
  );
});

test('an explicit string layout overrides defaultLayout inherited from an ancestor', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ndefaultLayout: auto\n---\n# r\n',
    '/top/pages/page.md': '---\nlayout: custom\n---\n# P\n',
    '/top/layouts/auto.mdx': '<auto>{props.children}</auto>\n',
    '/top/layouts/custom.mdx': '<custom>{props.children}</custom>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/page/index.html', 'utf8'),
    /<custom><h1>P<\/h1>\s*<\/custom>/,
  );
});
