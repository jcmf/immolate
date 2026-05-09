import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ansiToHtml, stripAnsi, renderErrorPage } from '../src/serve-error.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const testTmp = path.join(repoRoot, 'test-tmp', 'serve-error');

before(() => {
  nodeFs.rmSync(testTmp, { recursive: true, force: true });
});

function makeTopDir(slug, files) {
  const top = path.join(testTmp, slug);
  nodeFs.mkdirSync(top, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(top, rel);
    nodeFs.mkdirSync(path.dirname(full), { recursive: true });
    nodeFs.writeFileSync(full, content);
  }
  return top;
}

test('stripAnsi removes SGR escapes', () => {
  const s = '\x1b[31merror\x1b[39m: \x1b[2mfoo\x1b[22m';
  assert.equal(stripAnsi(s), 'error: foo');
});

test('ansiToHtml wraps colored runs in <span> with inline style', () => {
  const html = ansiToHtml('\x1b[31merror\x1b[39m: bad');
  assert.match(html, /<span style="color:#cd3131">error<\/span>/);
  assert.match(html, /: bad$/);
});

test('ansiToHtml escapes HTML characters in payload text', () => {
  const html = ansiToHtml('plain <a> & "b"');
  assert.equal(html, 'plain &lt;a&gt; &amp; "b"');
});

test('ansiToHtml handles bold + dim + reset transitions', () => {
  const html = ansiToHtml('\x1b[1mB\x1b[22mN\x1b[2mD\x1b[0mE');
  assert.match(html, /<span style="font-weight:bold">B<\/span>/);
  assert.match(html, /N/);
  assert.match(html, /<span style="opacity:0.65">D<\/span>/);
  assert.match(html, /E$/);
});

test('ansiToHtml closes spans cleanly at end of string', () => {
  const html = ansiToHtml('\x1b[31mred');
  const opens = (html.match(/<span/g) ?? []).length;
  const closes = (html.match(/<\/span>/g) ?? []).length;
  assert.equal(opens, closes);
});

test('renderErrorPage uses built-in template by default', async () => {
  const err = new Error('boom');
  const { contentType, body } = await renderErrorPage(err, {});
  assert.equal(contentType, 'text/html; charset=utf-8');
  assert.match(body, /<!DOCTYPE html>/);
  assert.match(body, /xtatic build failed/);
  assert.match(body, /boom/);
});

test('renderErrorPage includes meta refresh when reloadInterval > 0', async () => {
  const { body } = await renderErrorPage(new Error('x'), { reloadInterval: 5 });
  assert.match(body, /<meta http-equiv="refresh" content="5">/);
});

test('renderErrorPage omits meta refresh when reloadInterval is 0', async () => {
  const { body } = await renderErrorPage(new Error('x'), { reloadInterval: 0 });
  assert.doesNotMatch(body, /http-equiv="refresh"/);
});

test('renderErrorPage uses errorLayout when provided', async () => {
  const top = makeTopDir('layout-ok', {
    'err.js':
      "export default ({errorText, reloadInterval}) =>\n" +
      "  `<html><body data-reload=\"${reloadInterval}\">${errorText}</body></html>`;\n",
  });
  const { contentType, body } = await renderErrorPage(new Error('zzz'), {
    topDir: top,
    errorLayout: 'err.js',
    reloadInterval: 7,
  });
  assert.equal(contentType, 'text/html; charset=utf-8');
  assert.match(body, /<body data-reload="7">Error: zzz/);
});

test('renderErrorPage falls back to built-in when errorLayout throws', async () => {
  const top = makeTopDir('layout-throw', {
    'err.js': "export default () => { throw new Error('layout-broke'); };\n",
  });
  const { contentType, body } = await renderErrorPage(new Error('orig'), {
    topDir: top,
    errorLayout: 'err.js',
  });
  assert.equal(contentType, 'text/html; charset=utf-8');
  assert.match(body, /xtatic build failed/);
  assert.match(body, /orig/);
  assert.match(body, /errorLayout failed to render: layout-broke/);
});

test('renderErrorPage falls back when errorLayout default is not a function', async () => {
  const top = makeTopDir('layout-not-fn', {
    'err.js': "export default 42;\n",
  });
  const { body } = await renderErrorPage(new Error('orig'), {
    topDir: top,
    errorLayout: 'err.js',
  });
  assert.match(body, /errorLayout failed to render: errorLayout default export is not a function/);
});

test('renderErrorPage falls back when errorLayout returns non-string', async () => {
  const top = makeTopDir('layout-bad-return', {
    'err.js': "export default () => ({not: 'a string'});\n",
  });
  const { body } = await renderErrorPage(new Error('orig'), {
    topDir: top,
    errorLayout: 'err.js',
  });
  assert.match(body, /errorLayout failed to render: errorLayout returned object/);
});
