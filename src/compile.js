import { compile } from '@mdx-js/mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import * as runtime from './jsx-runtime.js';
import { recmaAssets } from './recma-assets.js';
import { recmaImports } from './recma-imports.js';
import { recmaSelf } from './recma-self.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function defaultResolve(spec) {
  throw new Error(
    `Cannot import "${spec}": no resolver was provided to compileSource.`,
  );
}

export async function compileSource(source, options = {}) {
  const resolve = options.resolve ?? defaultResolve;
  const asset = options.asset;
  const userRemarkPlugins = options.remarkPlugins ?? [];
  // `development: true` makes the compiler emit `jsxDEV(…, source)` calls with
  // call-site positions, which the render-context stack uses for error
  // reporting; the VFile path becomes the `fileName` in those positions. The
  // generated runtime import (`…/jsx-dev-runtime`) is still rewritten to a
  // destructure from `arguments[0]` by `outputFormat: 'function-body'`, so we
  // just need `jsxDEV` on the runtime namespace below — no real module.
  const compiled = await compile(
    { value: source, path: options.importerDisplay ?? '<source>' },
    {
      remarkPlugins: [
        remarkFrontmatter,
        remarkMdxFrontmatter,
        ...userRemarkPlugins,
      ],
      recmaPlugins: [recmaImports, recmaAssets, recmaSelf],
      outputFormat: 'function-body',
      // Always full MDX, even for `.md` — without this, supplying a `.md` VFile
      // path (for the `jsxDEV` source `fileName`) flips MDX into plain-markdown
      // mode and `import`/JSX become literal text.
      format: 'mdx',
      development: true,
      baseUrl: 'file:///xtatic/',
    },
  );
  const fn = new AsyncFunction(String(compiled));
  let mod;
  try {
    mod = await fn({
      ...runtime,
      baseUrl: 'file:///xtatic/',
      __xtatic_resolve: resolve,
      __xtatic_asset: asset ?? ((value) => value),
    });
  } catch (e) {
    // A throw here is a runtime error from evaluating the module body (e.g. a
    // top-level `export const x = f()` whose f() threw), not an MDX compile
    // error. Tag it so the caller labels it as evaluation and keeps the
    // original stack (which points at the real throw site).
    if (e && typeof e === 'object') e.xtaticEvalError = true;
    throw e;
  }
  return { ...(mod.frontmatter ?? {}), ...mod };
}
