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
