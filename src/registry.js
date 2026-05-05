import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { html as htmlBuiltin, makeReadfile } from './builtins.js';
import { BUILTIN_SPECS } from './builtins-registry.js';
import { compileJsxSource } from './compile-jsx.js';
import { compileSource } from './compile.js';

const MDX_EXT_RE = /\.mdx?$/;
const JSX_EXT_RE = /\.jsx$/;
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

export function isJsx(absPath) {
  return JSX_EXT_RE.test(absPath);
}

export function isJs(absPath) {
  return JS_EXT_RE.test(absPath);
}

export function createRegistry({ fs, topDir, remarkPlugins, imageRegistry, styleRegistry, plainAssetRegistry }) {
  const mdxModules = new Map();
  const jsxModules = new Map();
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

  async function loadJsx(absPath) {
    if (jsxModules.has(absPath)) return jsxModules.get(absPath).mm;
    const mm = {};
    jsxModules.set(absPath, { mm, status: 'compiling' });
    const source = await fs.promises.readFile(absPath, 'utf8');
    let compiled;
    try {
      compiled = await compileJsxSource(source, {
        resolve: makeResolver(absPath),
        asset: plainAssetRegistry?.forImporter(absPath),
      });
    } catch (e) {
      throw makeCompileError(displayPath(absPath), source, e);
    }
    Object.assign(mm, compiled);
    jsxModules.get(absPath).status = 'done';
    return mm;
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
        asset: plainAssetRegistry?.forImporter(absPath),
        remarkPlugins,
      });
    } catch (e) {
      throw makeCompileError(displayPath(absPath), source, e);
    }
    Object.assign(mm, compiled);
    const original = mm.default;
    mm.default = (props = {}) => original({ ...props, __xtatic_self: mm });
    mdxModules.get(absPath).status = 'done';
    return mm;
  }

  function makeResolver(importerAbsPath) {
    return async function resolve(spec) {
      if (spec.startsWith('xtatic:')) {
        if (spec === 'xtatic:builtins') {
          return {
            html: htmlBuiltin,
            readfile: makeReadfile({
              fs,
              topDir,
              importerAbsPath,
              importerDisplay: displayPath(importerAbsPath),
            }),
            asset: plainAssetRegistry
              ? plainAssetRegistry.forImporter(importerAbsPath)
              : (value) => value,
          };
        }
        if (spec === 'xtatic:image') {
          if (!imageRegistry) {
            throw new Error(
              `"xtatic:image" was imported from "${displayPath(importerAbsPath)}" but no image registry was provided to createRegistry.`,
            );
          }
          return { Image: imageRegistry.forImporter(importerAbsPath) };
        }
        if (spec === 'xtatic:style') {
          if (!styleRegistry) {
            throw new Error(
              `"xtatic:style" was imported from "${displayPath(importerAbsPath)}" but no style registry was provided to createRegistry.`,
            );
          }
          return { Style: styleRegistry.forImporter(importerAbsPath) };
        }
        const available = BUILTIN_SPECS.map((s) => `"${s}"`).join(', ');
        throw new Error(
          `Unknown builtin module "${spec}" imported from "${displayPath(importerAbsPath)}". Available: ${available}.`,
        );
      }
      const absPath = resolveSpec(importerAbsPath, spec);
      if (isMdxLike(absPath)) return await loadMdx(absPath);
      if (isJsx(absPath)) return await loadJsx(absPath);
      if (isJs(absPath)) return await loadJs(absPath);
      throw new Error(
        `Unsupported import "${spec}" from "${displayPath(importerAbsPath)}": only .md, .mdx, .jsx, and .js are supported.`,
      );
    };
  }

  return { loadMdx, loadJsx, loadJs, mdxModules, jsxModules, jsModules, resolveSpec };
}
