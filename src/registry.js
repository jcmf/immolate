import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { html as htmlBuiltin } from './builtins.js';
import { compileSource } from './compile.js';

const MDX_EXT_RE = /\.mdx?$/;
const JS_EXT_RE = /\.js$/;

function compileErrorPosition(cause) {
  const line =
    cause.line ??
    cause.place?.start?.line ??
    cause.place?.line ??
    null;
  const column =
    cause.column ??
    cause.place?.start?.column ??
    cause.place?.column ??
    null;
  return { line, column };
}

function codeFrame(source, line, column) {
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return null;
  const errorLine = lines[line - 1];
  const gutter = String(line).length;
  const head = `${String(line).padStart(gutter)} | ${errorLine}`;
  if (!column) return head;
  const caretIndent = ' '.repeat(Math.max(0, column - 1));
  return `${head}\n${' '.repeat(gutter)} | ${caretIndent}^`;
}

function makeCompileError(displayPath, source, cause) {
  const { line, column } = compileErrorPosition(cause);
  const reason = cause.reason ?? cause.message ?? String(cause);
  const where = line != null && column != null ? ` (line ${line}, column ${column})` : '';
  let msg = `Failed to compile "${displayPath}"${where}: ${reason}`;
  if (line != null) {
    const frame = codeFrame(source, line, column);
    if (frame) msg += `\n\n${frame}`;
  }
  if (cause.url) msg += `\n\nSee: ${cause.url}`;
  return new Error(msg);
}

export function isMdxLike(absPath) {
  return MDX_EXT_RE.test(absPath);
}

export function isJs(absPath) {
  return JS_EXT_RE.test(absPath);
}

export function createRegistry({ fs, topDir, remarkPlugins }) {
  const mdxModules = new Map();
  const jsModules = new Map();

  function displayPath(absPath) {
    const rel = path.posix.relative(topDir, absPath);
    return rel && !rel.startsWith('..') ? rel : absPath;
  }

  function resolveSpec(importerAbsPath, spec) {
    if (spec.startsWith('/')) {
      return path.posix.join(topDir, spec);
    }
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return path.posix.resolve(path.posix.dirname(importerAbsPath), spec);
    }
    throw new Error(
      `Cannot resolve import "${spec}" from "${displayPath(importerAbsPath)}": specs must start with "/", "./", or "../".`,
    );
  }

  async function loadJs(absPath) {
    if (jsModules.has(absPath)) return jsModules.get(absPath);
    const pending = import(pathToFileURL(absPath).href);
    jsModules.set(absPath, pending);
    return pending;
  }

  async function loadMdx(absPath) {
    if (mdxModules.has(absPath)) return mdxModules.get(absPath).mm;
    const mm = {};
    mdxModules.set(absPath, { mm, status: 'compiling' });
    const source = await fs.promises.readFile(absPath, 'utf8');
    let compiled;
    try {
      compiled = await compileSource(source, {
        importerPath: absPath,
        resolve: makeResolver(absPath),
        remarkPlugins,
      });
    } catch (e) {
      throw makeCompileError(displayPath(absPath), source, e);
    }
    Object.assign(mm, compiled);
    mm.html ??= htmlBuiltin;
    const original = mm.default;
    mm.default = (props = {}) => original({ ...props, __immolate_self: mm });
    mdxModules.get(absPath).status = 'done';
    return mm;
  }

  function makeResolver(importerAbsPath) {
    return async function resolve(spec) {
      const absPath = resolveSpec(importerAbsPath, spec);
      if (isMdxLike(absPath)) return await loadMdx(absPath);
      if (isJs(absPath)) return await loadJs(absPath);
      throw new Error(
        `Unsupported import "${spec}" from "${displayPath(importerAbsPath)}": only .md, .mdx, and .js are supported.`,
      );
    };
  }

  return { loadMdx, loadJs, mdxModules, jsModules, resolveSpec };
}
