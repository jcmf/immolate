import { compile } from '@mdx-js/mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import * as runtime from './jsx-runtime.js';
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
  const compiled = await compile(source, {
    remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter],
    recmaPlugins: [recmaImports, recmaSelf],
    outputFormat: 'function-body',
    baseUrl: 'file:///immolate/',
  });
  const fn = new AsyncFunction(String(compiled));
  const mod = await fn({
    ...runtime,
    baseUrl: 'file:///immolate/',
    __immolate_resolve: resolve,
  });
  return { ...(mod.frontmatter ?? {}), ...mod };
}
