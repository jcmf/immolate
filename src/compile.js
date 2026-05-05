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
  const compiled = await compile(source, {
    remarkPlugins: [
      remarkFrontmatter,
      remarkMdxFrontmatter,
      ...userRemarkPlugins,
    ],
    recmaPlugins: [recmaImports, recmaAssets, recmaSelf],
    outputFormat: 'function-body',
    baseUrl: 'file:///xtatic/',
  });
  const fn = new AsyncFunction(String(compiled));
  const mod = await fn({
    ...runtime,
    baseUrl: 'file:///xtatic/',
    __xtatic_resolve: resolve,
    __xtatic_asset: asset ?? ((value) => value),
  });
  return { ...(mod.frontmatter ?? {}), ...mod };
}
