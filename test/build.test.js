import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

async function fileExists(fs, path) {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
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

test('skips hidden modules and their subtrees from output', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/visible.md': '# V\n',
    '/in/secret.md': '---\nhidden: true\n---\n# S\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.match(
    await fs.promises.readFile('/out/visible/index.html', 'utf8'),
    /<h1>V<\/h1>/,
  );
  assert.equal(await fileExists(fs, '/out/secret/index.html'), false);
});

test('a sibling template wraps non-root pages and reads their metadata', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/about.md': '---\ntitle: About\n---\n# About me\n',
    '/in/template.md':
      '<html>\n' +
      '<head><title>{props.children.title}</title></head>\n' +
      '<body>{props.children}</body>\n' +
      '</html>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });

  const home = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(home, /<h1>Home<\/h1>/);
  assert.doesNotMatch(home, /<title>/);

  const about = await fs.promises.readFile('/out/about/index.html', 'utf8');
  assert.match(about, /<title>About<\/title>/);
  assert.match(about, /<h1>About me<\/h1>/);

  assert.equal(await fileExists(fs, '/out/template/index.html'), false);
});

test('templates are inherited transitively across nested directories', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/template.md':
      '<wrap>{props.children}</wrap>\n',
    '/in/blog/index.md': '# Blog\n',
    '/in/blog/post.md': '# Post\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });

  // Root: no template
  assert.equal(
    (await fs.promises.readFile('/out/index.html', 'utf8')).trim(),
    '<h1>r</h1>',
  );
  // blog/index.md: inherits root's template
  assert.match(
    await fs.promises.readFile('/out/blog/index.html', 'utf8'),
    /<wrap><h1>Blog<\/h1>\s*<\/wrap>/,
  );
  // blog/post.md: also inherits root's template (no blog/template.md)
  assert.match(
    await fs.promises.readFile('/out/blog/post/index.html', 'utf8'),
    /<wrap><h1>Post<\/h1>\s*<\/wrap>/,
  );
});

test('a string template in frontmatter resolves against templatesDir (bare name → .mdx)', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntemplate: blog\n---\n# Hi\n',
    '/top/templates/blog.mdx': '<wrap>{props.children}</wrap>\n',
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

test('a string template can include an explicit .md or .mdx suffix', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '# r\n',
    '/top/pages/a.md': '---\ntemplate: x.md\n---\n# A\n',
    '/top/pages/b.md': '---\ntemplate: x.mdx\n---\n# B\n',
    '/top/templates/x.md': '<md>{props.children}</md>\n',
    '/top/templates/x.mdx': '<mdx>{props.children}</mdx>\n',
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

test('a string template falls back to .md when .mdx is absent', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntemplate: only-md\n---\n# Hi\n',
    '/top/templates/only-md.md': '<md>{props.children}</md>\n',
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

test('when both .md and .mdx exist for a bare-name template, .mdx wins', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntemplate: dup\n---\n# Hi\n',
    '/top/templates/dup.md': '<md>{props.children}</md>\n',
    '/top/templates/dup.mdx': '<mdx>{props.children}</mdx>\n',
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

test('a string template can use a subpath under templatesDir', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntemplate: layouts/post\n---\n# Hi\n',
    '/top/templates/layouts/post.mdx': '<post>{props.children}</post>\n',
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

test('a template loaded by name can itself declare a string template (chain)', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntemplate: inner\n---\n# Hi\n',
    '/top/templates/inner.mdx':
      '---\ntemplate: outer\n---\n<inner>{props.children}</inner>\n',
    '/top/templates/outer.mdx': '<outer>{props.children}</outer>\n',
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

test('a missing string template errors with both candidate paths in the message', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntemplate: missing\n---\n# Hi\n',
  });
  await assert.rejects(
    () =>
      build({
        inputDir: '/top/pages',
        outputDir: '/out',
        topDir: '/top',
        fs,
      }),
    /Template "missing" not found: tried .*missing\.mdx and .*missing\.md\./,
  );
});

test('a string template overrides an auto-inherited filesystem template', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '# r\n',
    '/top/pages/template.md': '<auto>{props.children}</auto>\n',
    '/top/pages/page.md': '---\ntemplate: custom\n---\n# P\n',
    '/top/templates/custom.mdx': '<custom>{props.children}</custom>\n',
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

test('a module\'s template defaults to its parent\'s child_modules.template, not its own', async () => {
  // Per spec: bar.template defaults to foo.child_modules.template (foo is bar's parent),
  // falling back to root.child_modules.template. So section/index.md (parent = root) uses
  // root/template.md, but section/page.md (parent = section) uses section/template.md.
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/template.md': '<root-tpl>{props.children}</root-tpl>\n',
    '/in/section/index.md': '# S\n',
    '/in/section/template.md': '<section-tpl>{props.children}</section-tpl>\n',
    '/in/section/page.md': '# P\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });

  assert.match(
    await fs.promises.readFile('/out/section/index.html', 'utf8'),
    /<root-tpl><h1>S<\/h1>\s*<\/root-tpl>/,
  );
  assert.match(
    await fs.promises.readFile('/out/section/page/index.html', 'utf8'),
    /<section-tpl><h1>P<\/h1>\s*<\/section-tpl>/,
  );
});
