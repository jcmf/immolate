import { resolveLogicalPaths } from './paths.js';
import { compileSource } from './compile.js';
import { assembleTree } from './tree.js';
import { renderModule } from './render.js';

const MDX_EXT_RE = /\.mdx?$/;

async function walkMdx(fs, root) {
  const results = [];
  async function recurse(absDir, relDir) {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
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

export async function build({ inputDir, outputDir, fs }) {
  const files = await walkMdx(fs, inputDir);
  const entries = resolveLogicalPaths(files.map((f) => f.relPath));
  const absByRel = new Map(files.map((f) => [f.relPath, f.absPath]));
  for (const entry of entries) {
    entry.absPath = absByRel.get(entry.relPath);
  }
  for (const entry of entries) {
    const source = await fs.promises.readFile(entry.absPath, 'utf8');
    entry.mm = await compileSource(source);
  }
  const root = assembleTree(entries);
  await writeNode(root, [], outputDir, fs);
}
