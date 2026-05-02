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
  const { html } = renderModule(mm);
  const outPath = [outputDir, ...segments, 'index.html'].join('/');
  const dir = outPath.substring(0, outPath.lastIndexOf('/'));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(outPath, html);
  for (const child of mm.childPages) {
    await writeNode(child, [...segments, child.name], outputDir, fs);
  }
}

function isInsideOrSame(parent, child) {
  if (parent === child) return true;
  const sep = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(sep);
}

function assertSafeOutputDir(outputDir, sources) {
  if (!outputDir || outputDir === '/' || outputDir === '.') {
    throw new Error(
      `outputDir must be a non-root directory path (got "${outputDir}").`,
    );
  }
  for (const [name, dir] of Object.entries(sources)) {
    if (isInsideOrSame(outputDir, dir)) {
      throw new Error(
        `outputDir "${outputDir}" must not be the same as or an ancestor of ${name} "${dir}" (it is wiped at the start of every build).`,
      );
    }
  }
}

export async function build({
  inputDir,
  outputDir,
  topDir,
  layoutsDir,
  remarkPlugins,
  fs,
}) {
  inputDir = path.posix.resolve(inputDir);
  outputDir = path.posix.resolve(outputDir);
  topDir = topDir != null ? path.posix.resolve(topDir) : inputDir;
  layoutsDir =
    layoutsDir != null
      ? path.posix.resolve(layoutsDir)
      : path.posix.join(topDir, 'layouts');
  assertSafeOutputDir(outputDir, { topDir, inputDir, layoutsDir });
  await fs.promises.rm(outputDir, { recursive: true, force: true });
  const files = await walkMdx(fs, inputDir);
  const entries = resolveLogicalPaths(files.map((f) => f.relPath));
  entries.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const absByRel = new Map(files.map((f) => [f.relPath, f.absPath]));

  const registry = createRegistry({ fs, topDir, remarkPlugins });
  for (const entry of entries) {
    entry.absPath = absByRel.get(entry.relPath);
    entry.mm = await registry.loadMdx(entry.absPath);
  }
  const root = assembleTree(entries, { inputDir });
  for (const entry of entries) {
    await resolveLayoutChain(entry.mm, {
      fs,
      layoutsDir,
      registry,
      requesterPath: entry.relPath,
    });
  }
  await writeNode(root, [], outputDir, fs);
}

async function resolveLayoutChain(mm, ctx) {
  if (typeof mm.layout !== 'string') return;
  const tmpl = await loadLayoutByName(mm.layout, ctx);
  mm.layout = tmpl;
  await resolveLayoutChain(tmpl, ctx);
}

async function loadLayoutByName(name, { fs, layoutsDir, registry, requesterPath }) {
  if (/\.mdx?$/.test(name)) {
    return registry.loadMdx(path.posix.join(layoutsDir, name));
  }
  const mdxPath = path.posix.join(layoutsDir, `${name}.mdx`);
  const mdPath = path.posix.join(layoutsDir, `${name}.md`);
  for (const p of [mdxPath, mdPath]) {
    try {
      await fs.promises.stat(p);
      return registry.loadMdx(p);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const requestedBy = requesterPath ? ` (requested by "${requesterPath}")` : '';
  throw new Error(
    `Layout "${name}"${requestedBy} not found: tried ${mdxPath} and ${mdPath}.`,
  );
}
