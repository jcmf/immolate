import path from 'node:path';
import { resolveLogicalPaths } from './paths.js';
import { assembleTree } from './tree.js';
import { renderModule } from './render.js';
import { createRegistry } from './registry.js';

const MDX_EXT_RE = /\.mdx?$/;

async function walkMdx(fs, root) {
  const results = [];
  async function recurse(absDir, relDir) {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const childAbs = `${absDir}/${ent.name}`;
      const childRel = relDir === '' ? ent.name : `${relDir}/${ent.name}`;
      if (ent.isDirectory()) {
        await recurse(childAbs, childRel);
      } else if (ent.isFile() && MDX_EXT_RE.test(ent.name)) {
        results.push({ absPath: childAbs, relPath: childRel });
      }
    }
  }
  await recurse(root, '');
  return results;
}

async function writeNode(mm, segments, outputDir, fs) {
  if (mm.hidden) return;
  const { html } = renderModule(mm);
  const outPath = [outputDir, ...segments, 'index.html'].join('/');
  const dir = outPath.substring(0, outPath.lastIndexOf('/'));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(outPath, html);
  for (const name of Object.keys(mm.child_modules).sort()) {
    await writeNode(mm.child_modules[name], [...segments, name], outputDir, fs);
  }
}

export async function build({
  inputDir,
  outputDir,
  topDir,
  templatesDir,
  fs,
}) {
  inputDir = path.posix.resolve(inputDir);
  topDir = topDir != null ? path.posix.resolve(topDir) : inputDir;
  templatesDir =
    templatesDir != null
      ? path.posix.resolve(templatesDir)
      : path.posix.join(topDir, 'templates');
  const files = await walkMdx(fs, inputDir);
  const entries = resolveLogicalPaths(files.map((f) => f.relPath));
  entries.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const absByRel = new Map(files.map((f) => [f.relPath, f.absPath]));

  const registry = createRegistry({ fs, topDir });
  for (const entry of entries) {
    entry.absPath = absByRel.get(entry.relPath);
    entry.mm = await registry.loadMdx(entry.absPath);
  }
  for (const entry of entries) {
    await resolveTemplateChain(entry.mm, { fs, templatesDir, registry });
  }
  const root = assembleTree(entries);
  await writeNode(root, [], outputDir, fs);
}

async function resolveTemplateChain(mm, ctx) {
  if (typeof mm.template !== 'string') return;
  const tmpl = await loadTemplateByName(mm.template, ctx);
  mm.template = tmpl;
  await resolveTemplateChain(tmpl, ctx);
}

async function loadTemplateByName(name, { fs, templatesDir, registry }) {
  if (/\.mdx?$/.test(name)) {
    return registry.loadMdx(path.posix.join(templatesDir, name));
  }
  const mdxPath = path.posix.join(templatesDir, `${name}.mdx`);
  const mdPath = path.posix.join(templatesDir, `${name}.md`);
  for (const p of [mdxPath, mdPath]) {
    try {
      await fs.promises.stat(p);
      return registry.loadMdx(p);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  throw new Error(
    `Template "${name}" not found: tried ${mdxPath} and ${mdPath}.`,
  );
}
