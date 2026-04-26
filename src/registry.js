import path from 'node:path';
import { compileSource } from './compile.js';

const MDX_EXT_RE = /\.mdx?$/;
const JS_EXT_RE = /\.js$/;

export function isMdxLike(absPath) {
  return MDX_EXT_RE.test(absPath);
}

export function isJs(absPath) {
  return JS_EXT_RE.test(absPath);
}

export function createRegistry({ fs, inputDir }) {
  const mdxModules = new Map();
  const jsModules = new Map();

  function resolveSpec(importerAbsPath, spec) {
    if (spec.startsWith('/')) {
      return path.posix.join(inputDir, spec);
    }
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return path.posix.resolve(path.posix.dirname(importerAbsPath), spec);
    }
    throw new Error(
      `Cannot resolve import "${spec}" from "${importerAbsPath}": specs must start with "/", "./", or "../".`,
    );
  }

  async function loadJs(absPath) {
    if (jsModules.has(absPath)) return jsModules.get(absPath);
    const pending = (async () => {
      const source = await fs.promises.readFile(absPath, 'utf8');
      const dataUrl =
        'data:text/javascript;base64,' +
        Buffer.from(source, 'utf8').toString('base64');
      return await import(dataUrl);
    })();
    jsModules.set(absPath, pending);
    return pending;
  }

  async function loadMdx(absPath) {
    if (mdxModules.has(absPath)) return mdxModules.get(absPath).mm;
    const mm = {};
    mdxModules.set(absPath, { mm, status: 'compiling' });
    const source = await fs.promises.readFile(absPath, 'utf8');
    const compiled = await compileSource(source, {
      importerPath: absPath,
      resolve: makeResolver(absPath),
    });
    Object.assign(mm, compiled);
    mdxModules.get(absPath).status = 'done';
    return mm;
  }

  function makeResolver(importerAbsPath) {
    return async function resolve(spec) {
      const absPath = resolveSpec(importerAbsPath, spec);
      if (isMdxLike(absPath)) return await loadMdx(absPath);
      if (isJs(absPath)) return await loadJs(absPath);
      throw new Error(
        `Unsupported import "${spec}" from "${importerAbsPath}": only .md, .mdx, and .js are supported.`,
      );
    };
  }

  return { loadMdx, loadJs, mdxModules, jsModules, resolveSpec };
}
