import path from 'node:path';
import { createAssetRegistry } from './assets.js';
import { createPlainAssetRegistry } from './assets-plain.js';
import { createFontRegistry } from './font.js';
import { createImageRegistry } from './image.js';
import { createStyleRegistry } from './style.js';
import { resolveLogicalPaths } from './paths.js';
import { assembleTree } from './tree.js';
import { renderModule } from './render.js';
import { attachContext, formatContext, withFrame } from './render-context.js';
import { createRegistry } from './registry.js';
import { wrapZipFs } from './zipfs.js';

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

function computeOutPath(mm, segments, outputDir, pageLabel) {
  if (mm.outputPath === undefined) {
    return [outputDir, ...segments, 'index.html'].join('/');
  }
  const op = mm.outputPath;
  const where = ` (set on page "${pageLabel}")`;
  if (typeof op !== 'string') {
    throw new Error(
      `outputPath${where} must be a string (got ${typeof op}).`,
    );
  }
  if (!op.startsWith('/') || op === '/' || op.endsWith('/')) {
    throw new Error(
      `Invalid outputPath "${op}"${where}: must be an absolute path starting with "/" and naming a file (not a directory).`,
    );
  }
  if (op.split('/').includes('..')) {
    throw new Error(
      `Invalid outputPath "${op}"${where}: must not contain ".." segments.`,
    );
  }
  return path.posix.join(outputDir, op);
}

function renderTree(mm, segments, outputDir, assetsDirAbs, pages, seen) {
  const page = segments.length ? segments.join('/') : '/';
  const outPath = computeOutPath(mm, segments, outputDir, page);
  if (isInsideOrSame(assetsDirAbs, outPath)) {
    throw new Error(
      `Page "${page}" writes to "${outPath}", which is inside the generated assets directory "${assetsDirAbs}". ` +
        `Rename the page (or its outputPath), or set a different xtatic.assetsDir.`,
    );
  }
  const prior = seen.get(outPath);
  if (prior !== undefined) {
    throw new Error(
      `Two pages write to the same output path "${outPath}": "${prior}" and "${page}".`,
    );
  }
  seen.set(outPath, page);
  const { html } = withFrame(
    { kind: 'page', page, file: mm.__xtatic_path ?? null },
    () => {
      try {
        return renderModule(mm);
      } catch (err) {
        throw attachContext(err);
      }
    },
  );
  pages.push({ outPath, html });
  for (const child of mm.childPages) {
    renderTree(child, [...segments, child.name], outputDir, assetsDirAbs, pages, seen);
  }
}

async function writePages(pages, substitute, fs) {
  const dirs = new Set();
  for (const { outPath, html } of pages) {
    const dir = outPath.substring(0, outPath.lastIndexOf('/'));
    if (!dirs.has(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
      dirs.add(dir);
    }
    await fs.promises.writeFile(outPath, substitute(html, outPath));
  }
}

function isInsideOrSame(parent, child) {
  if (parent === child) return true;
  const sep = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(sep);
}

function assertValidAssetsDir(assetsDir) {
  if (typeof assetsDir !== 'string' || assetsDir === '') {
    throw new Error(
      `assetsDir must be a non-empty string (got ${JSON.stringify(assetsDir)}).`,
    );
  }
  if (assetsDir.includes('/') || assetsDir === '.' || assetsDir === '..') {
    throw new Error(
      `assetsDir "${assetsDir}" must be a single path segment (no "/", ".", or "..").`,
    );
  }
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

export async function build(options) {
  try {
    return await buildImpl(options);
  } catch (err) {
    // A render error (possibly deferred to a registry's processAll) carries a
    // snapshot of the page / layout / component chain that led to it; fold it
    // into the message so every consumer (cli, watch, serve-error) shows it.
    if (
      err &&
      typeof err === 'object' &&
      err.xtaticContext &&
      !err.xtaticContextRendered
    ) {
      const ctx = formatContext(err.xtaticContext);
      if (ctx) {
        err.message = `${err.message}\n\n${ctx}`;
        err.xtaticContextRendered = true;
      }
    }
    throw err;
  }
}

async function buildImpl({
  inputDir,
  outputDir,
  topDir,
  layoutsDir,
  remarkPlugins,
  imageInlineThreshold,
  styleInlineThreshold,
  assetInlineThreshold,
  assetsDir = '_assets',
  autoInstall = false,
  install,
  fontSubset,
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
  assertValidAssetsDir(assetsDir);
  const assetsDirAbs = path.posix.join(outputDir, assetsDir);
  fs = wrapZipFs(fs);
  await fs.promises.rm(outputDir, { recursive: true, force: true });
  const files = await walkMdx(fs, inputDir);
  const entries = resolveLogicalPaths(files.map((f) => f.relPath));
  entries.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const absByRel = new Map(files.map((f) => [f.relPath, f.absPath]));

  const assetRegistry = createAssetRegistry({ fs, outputDir, assetsDir });
  const imageRegistry = createImageRegistry({
    fs,
    topDir,
    assetRegistry,
    defaultInlineThreshold: imageInlineThreshold,
    autoInstall,
    install,
  });
  const styleRegistry = createStyleRegistry({
    fs,
    topDir,
    assetRegistry,
    defaultInlineThreshold: styleInlineThreshold,
  });
  const fontRegistry = createFontRegistry({
    fs,
    topDir,
    assetRegistry,
    autoInstall,
    install,
    fontSubset,
  });
  const plainAssetRegistry = createPlainAssetRegistry({
    fs,
    topDir,
    outputDir,
    assetRegistry,
    defaultInlineThreshold: assetInlineThreshold,
  });
  const registry = createRegistry({
    fs,
    topDir,
    remarkPlugins,
    imageRegistry,
    styleRegistry,
    fontRegistry,
    plainAssetRegistry,
  });
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
  const pages = [];
  renderTree(root, [], outputDir, assetsDirAbs, pages, new Map());
  const imageSubstitute = await imageRegistry.processAll();
  const styleSubstitute = await styleRegistry.processAll();
  // Plain-asset runs before font so the font registry can ask
  // plainAssetRegistry.cssForPage(html) (alongside styleRegistry.cssForPage)
  // for the CSS that reaches each page — needed by the css-static cascade
  // engine (commit 3+). Substitute composition is order-independent because
  // token namespaces are disjoint.
  const assetSubstitute = await plainAssetRegistry.processAll(pages);
  const fontSubstitute = await fontRegistry.processAll(pages, {
    cssForPage: (html) => [
      ...styleRegistry.cssForPage(html),
      ...plainAssetRegistry.cssForPage(html),
    ],
  });
  await assetRegistry.writeAll();
  await plainAssetRegistry.writeAll();
  // Relativize runs last (outermost): the four registry substitutes leave
  // `__XTATIC_EMIT_…__` placeholders for shared /_assets/ files; this rewrites
  // each to a path relative to the page's own output directory.
  const substitute = (html, outPath) =>
    assetRegistry.relativize(
      assetSubstitute(
        fontSubstitute(styleSubstitute(imageSubstitute(html)), outPath),
        outPath,
      ),
      path.posix.dirname(outPath),
    );
  await writePages(pages, substitute, fs);
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
