import path from 'node:path';

// A directory under inputDir containing this (empty) marker file is copied to
// the output byte-for-byte, mirroring its source-tree position: no page
// mapping, no layout, no HTML parsing, no asset processing. The marker itself
// is never copied. Nested markers are harmless (already verbatim).
export const VERBATIM_MARKER = '.xtatic-verbatim';

// True when `dirent`s (from readdir withFileTypes) include the marker file.
export function hasVerbatimMarker(dirents) {
  return dirents.some((d) => d.name === VERBATIM_MARKER && !d.isDirectory());
}

// Every regular file under `absDir` (recursively, sorted for determinism),
// excluding marker files, as `{absPath, relPath}` where relPath is relative to
// inputDir (`relDir` is absDir's own inputDir-relative path, '' for the root).
export async function collectVerbatimFiles(fs, absDir, relDir) {
  const results = [];
  async function recurse(dirAbs, dirRel) {
    const entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const childAbs = `${dirAbs}/${ent.name}`;
      const childRel = dirRel === '' ? ent.name : `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) {
        await recurse(childAbs, childRel);
      } else if (ent.isFile() && ent.name !== VERBATIM_MARKER) {
        results.push({ absPath: childAbs, relPath: childRel });
      }
    }
  }
  await recurse(absDir, relDir);
  return results;
}

// Copy each verbatim file to `outputDir/<relPath>` through the build's shared
// output writer (so unchanged files keep their mtime and prune() knows about
// them). `entries` carry `outPath` (stamped by index.js after the collision
// checks).
export async function writeVerbatimFiles({ fs, writer, entries }) {
  for (const { absPath, outPath } of entries) {
    const bytes = await fs.promises.readFile(absPath);
    await writer.writeFile(outPath, bytes);
  }
}

export function verbatimOutPath(outputDir, relPath) {
  return path.posix.join(outputDir, relPath);
}
