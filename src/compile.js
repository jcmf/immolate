import { evaluate } from '@mdx-js/mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import * as runtime from './jsx-runtime.js';

export async function compileSource(source) {
  const mod = await evaluate(source, {
    ...runtime,
    remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter],
  });
  return { ...(mod.frontmatter ?? {}), ...mod };
}
