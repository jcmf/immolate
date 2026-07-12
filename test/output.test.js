import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

function bytes(n, fill = 0xab) {
  return Buffer.alloc(n, fill);
}

const OLD = new Date('2001-02-03T04:05:06Z');

async function backdate(fs, path) {
  await fs.promises.utimes(path, OLD, OLD);
}

async function mtime(fs, path) {
  return (await fs.promises.stat(path)).mtimeMs;
}

test('an unchanged output file is not rewritten (timestamp preserved)', async () => {
  const fs = makeFs({
    '/in/index.md': '# home\n',
    '/in/about.md': '# about\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  await backdate(fs, '/out/index.html');
  await backdate(fs, '/out/about/index.html');
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await mtime(fs, '/out/index.html'), OLD.getTime());
  assert.equal(await mtime(fs, '/out/about/index.html'), OLD.getTime());
});

test('a changed page is rewritten; unchanged siblings are not', async () => {
  const fs = makeFs({
    '/in/index.md': '# home\n',
    '/in/about.md': '# about\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  await backdate(fs, '/out/index.html');
  await backdate(fs, '/out/about/index.html');
  await fs.promises.writeFile('/in/about.md', '# about v2\n');
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await mtime(fs, '/out/index.html'), OLD.getTime());
  assert.notEqual(await mtime(fs, '/out/about/index.html'), OLD.getTime());
  const html = await fs.promises.readFile('/out/about/index.html', 'utf8');
  assert.match(html, /about v2/);
});

test('unchanged shared and co-located assets keep their timestamps', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="/shared.png" alt="s" />\n',
    '/in/sub/index.md': '<img src="/shared.png" alt="s" /><img src="./local.png" alt="l" />\n',
  });
  await fs.promises.writeFile('/in/shared.png', bytes(8192));
  await fs.promises.writeFile('/in/sub/local.png', bytes(8192, 0xcd));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const [shared] = await fs.promises.readdir('/out/_assets');
  await backdate(fs, `/out/_assets/${shared}`);
  await backdate(fs, '/out/sub/local.png');
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await mtime(fs, `/out/_assets/${shared}`), OLD.getTime());
  assert.equal(await mtime(fs, '/out/sub/local.png'), OLD.getTime());
});

test('output of a deleted page is pruned, including its emptied directory', async () => {
  const fs = makeFs({
    '/in/index.md': '# home\n',
    '/in/old.md': '# old\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(await fs.promises.stat('/out/old/index.html'));
  await fs.promises.rm('/in/old.md');
  await build({ inputDir: '/in', outputDir: '/out', fs });
  await assert.rejects(fs.promises.stat('/out/old'), /ENOENT/);
  assert.ok(await fs.promises.stat('/out/index.html'));
});

test('files the build did not generate are pruned from outputDir', async () => {
  const fs = makeFs({
    '/in/index.md': '# home\n',
    '/out/stale.html': 'junk',
    '/out/deep/nested/junk.txt': 'junk',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  await assert.rejects(fs.promises.stat('/out/stale.html'), /ENOENT/);
  await assert.rejects(fs.promises.stat('/out/deep'), /ENOENT/);
});

test('a page moving from dir/index.html to an outputPath file replaces the directory', async () => {
  const fs = makeFs({
    '/in/index.md': '# home\n',
    '/in/feed.md': '# feed as page\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(await fs.promises.stat('/out/feed/index.html'));
  await fs.promises.writeFile(
    '/in/feed.md',
    '---\noutputPath: /feed\nlayout: null\n---\nplain feed\n',
  );
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const st = await fs.promises.stat('/out/feed');
  assert.ok(st.isFile());
  assert.match(await fs.promises.readFile('/out/feed', 'utf8'), /plain feed/);
});

test('a page moving from an outputPath file to dir/index.html replaces the file', async () => {
  const fs = makeFs({
    '/in/index.md': '# home\n',
    '/in/feed.md': '---\noutputPath: /feed\nlayout: null\n---\nplain feed\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok((await fs.promises.stat('/out/feed')).isFile());
  await fs.promises.writeFile('/in/feed.md', '# feed as page\n');
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok((await fs.promises.stat('/out/feed')).isDirectory());
  assert.match(
    await fs.promises.readFile('/out/feed/index.html', 'utf8'),
    /feed as page/,
  );
});

test('same-size but different content is rewritten', async () => {
  const fs = makeFs({
    '/in/index.md': 'aaaa\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  await fs.promises.writeFile('/in/index.md', 'aaab\n');
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.match(await fs.promises.readFile('/out/index.html', 'utf8'), /aaab/);
});

test('a failed build leaves the previous output in place', async () => {
  const fs = makeFs({
    '/in/index.md': '# home\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  await fs.promises.writeFile('/in/broken.md', '<img src="./nope.png" />\n');
  await assert.rejects(build({ inputDir: '/in', outputDir: '/out', fs }));
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /home/,
  );
});
