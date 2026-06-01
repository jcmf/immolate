import path from 'node:path';
import { createAssetRegistry } from './assets.js';
import { createPlainAssetRegistry } from './assets-plain.js';
import { createFontRegistry } from './font.js';
import { createImageRegistry } from './image.js';
import { createStyleRegistry } from './style.js';
import { resolveLogicalPath, hasPlaceholders } from './paths.js';
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

function renderTree(mm, segments, outputDir, topDir, assetsDirAbs, pages, seen) {
  const page = segments.length ? segments.join('/') : '/';
  const outPath = computeOutPath(mm, segments, outputDir, page);
  // Source-tree position of this page, used by the plain-asset registry to map
  // <a href="./other.md"> link targets onto their rendered output paths.
  const srcPath =
    mm.__xtatic_path != null
      ? path.posix.join(topDir, mm.__xtatic_path)
      : null;
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
  pages.push({ outPath, srcPath, html });
  for (const child of mm.childPages) {
    renderTree(child, [...segments, child.name], outputDir, topDir, assetsDirAbs, pages, seen);
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

// Reject two entries (ordinary or generator-produced) that resolve to the same
// logical path. Mirrors resolveLogicalPaths' check but spans the merged set;
// generator-produced entries carry an `origin` ("template → substituted") for a
// clearer message than the virtual substituted relPath alone.
function assertUniqueLogicalPaths(entries) {
  const claimed = new Map();
  for (const e of entries) {
    const key = e.segments.join('/');
    const existing = claimed.get(key);
    if (existing !== undefined) {
      const label = key === '' ? '(root)' : key;
      throw new Error(
        `Multiple input files map to the same output path "${label}": ${existing} and ${e.origin ?? e.relPath}`,
      );
    }
    claimed.set(key, e.origin ?? e.relPath);
  }
}

// Suggest a generator filename for a file that exported `pages` without one:
// foo.md → foo-{slug}.md, blog/post.mdx → blog/post-{slug}.mdx.
function placeholderHint(relPath) {
  const slash = relPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : relPath.slice(0, slash + 1);
  const file = slash === -1 ? relPath : relPath.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const base = dot === -1 ? file : file.slice(0, dot);
  const ext = dot === -1 ? '' : file.slice(dot);
  return `${dir}${base}-{slug}${ext}`;
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

// Read a source file named by a render-context frame (a topDir-relative display
// path, or an absolute path for sources outside topDir) so formatContext can
// print its code frame. Sync (formatContext is sync), best-effort (a missing or
// unreadable file just means no frame), and memoized since a trace can name the
// same file twice.
function makeSourceReader(fs, topDir) {
  if (!fs || typeof fs.readFileSync !== 'function') return () => null;
  const cache = new Map();
  return (file) => {
    if (!file) return null;
    if (cache.has(file)) return cache.get(file);
    let text = null;
    try {
      const abs = path.posix.isAbsolute(file)
        ? file
        : path.posix.join(topDir, file);
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      text = null;
    }
    cache.set(file, text);
    return text;
  };
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
      const topDir =
        options.topDir != null
          ? path.posix.resolve(options.topDir)
          : path.posix.resolve(options.inputDir);
      const ctx = formatContext(err.xtaticContext, {
        readSource: makeSourceReader(options.fs, topDir),
        codeFrameWidth: options.codeFrameWidth ?? 120,
      });
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
  // Page generators are files whose name carries `{placeholder}` tokens (e.g.
  // tag-{tag}.md); they expand into one page per `pages` item instead of
  // rendering at their own slot. Everything else is an ordinary page.
  const templateFiles = [];
  const normalFiles = [];
  for (const f of files) {
    (hasPlaceholders(f.relPath) ? templateFiles : normalFiles).push(f);
  }
  const entries = normalFiles.map((f) => ({
    relPath: f.relPath,
    segments: resolveLogicalPath(f.relPath),
    absPath: f.absPath,
  }));

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
    entry.mm = await registry.loadMdx(entry.absPath);
  }
  // A file that exports `pages` but isn't a generator (no {placeholder} in its
  // name) would silently render once and drop the export — surface it instead.
  for (const entry of entries) {
    if (entry.mm.pages !== undefined) {
      throw new Error(
        `"${entry.relPath}" exports \`pages\` but its filename has no {placeholder}; ` +
          `rename it (e.g. ${placeholderHint(entry.relPath)}) to generate multiple pages from it.`,
      );
    }
  }
  // Expand each generator into its synthetic child pages, then fold them into
  // the entry set so they flow through tree assembly and rendering as usual.
  const toRelPath = (abs) => path.posix.relative(inputDir, abs);
  for (const f of templateFiles) {
    const tmplMm = await registry.loadMdx(f.absPath);
    for (const e of registry.expandTemplate(tmplMm, f.absPath, { toRelPath })) {
      entries.push(e);
    }
  }
  assertUniqueLogicalPaths(entries);
  entries.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
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
  renderTree(root, [], outputDir, topDir, assetsDirAbs, pages, new Map());
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
