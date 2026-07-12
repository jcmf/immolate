import path from 'node:path';

// All output writes go through one writer per build so that (a) an output
// file whose bytes are unchanged from the previous build is skipped — its
// timestamp is preserved for rsync/HTTP-caching/make-style consumers — and
// (b) the writer knows every path the build produced, so prune() can delete
// everything else under outputDir at the end (the replacement for the old
// wipe-outputDir-upfront step; renames and deletes still Just Work, and a
// failed build no longer destroys the previous output).
export function createOutputWriter({ fs, outputDir }) {
  const written = new Set();
  const madeDirs = new Set();

  // mkdir -p that survives a previous build's layout: if `dir` or some
  // ancestor of it exists as a regular file (a page that used to write to
  // `/about` and now writes to `/about/index.html`), remove the conflicting
  // file and retry. Detected by stat-verifying rather than by mkdir's error
  // code — Node throws EEXIST for a file in the way, but memfs's recursive
  // mkdir silently no-ops over one.
  async function ensureDir(dir) {
    if (madeDirs.has(dir)) return;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const st = await fs.promises.stat(dir);
      if (!st.isDirectory()) {
        throw Object.assign(new Error(`not a directory: ${dir}`), {
          code: 'ENOTDIR',
        });
      }
    } catch (e) {
      if (e.code !== 'ENOTDIR' && e.code !== 'EEXIST') throw e;
      const rel = path.posix.relative(outputDir, dir);
      const prefixes = [outputDir];
      for (const seg of rel.split('/')) {
        if (seg !== '') prefixes.push(`${prefixes.at(-1)}/${seg}`);
      }
      for (const p of prefixes) {
        const st = await statOrNull(p);
        if (st && !st.isDirectory()) {
          await fs.promises.rm(p, { force: true });
          break;
        }
      }
      await fs.promises.mkdir(dir, { recursive: true });
    }
    madeDirs.add(dir);
  }

  async function statOrNull(p) {
    try {
      return await fs.promises.stat(p);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  // Write `data` (Buffer or string) to absPath, unless a regular file with
  // identical bytes is already there — then skip, preserving its timestamps.
  // Returns true when bytes hit the disk, false on a skip.
  async function writeFile(absPath, data) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    written.add(absPath);
    await ensureDir(path.posix.dirname(absPath));
    const st = await statOrNull(absPath);
    if (st) {
      if (st.isDirectory()) {
        // A directory sits where this build writes a file (e.g. a page moved
        // from about/index.html to outputPath "/about").
        await fs.promises.rm(absPath, { recursive: true, force: true });
      } else if (st.size === buf.length) {
        const existing = await fs.promises.readFile(absPath);
        if (buf.equals(existing)) return false;
      }
    }
    await fs.promises.writeFile(absPath, buf);
    return true;
  }

  // Delete everything under outputDir this build didn't write, then any
  // directories left empty. Call once, after all writeFile calls.
  async function prune() {
    async function walk(dir) {
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (e.code === 'ENOENT') return true;
        throw e;
      }
      let empty = true;
      for (const ent of entries) {
        const p = `${dir}/${ent.name}`;
        if (ent.isDirectory()) {
          if (await walk(p)) {
            await fs.promises.rmdir(p);
          } else {
            empty = false;
          }
        } else if (written.has(p)) {
          empty = false;
        } else {
          await fs.promises.rm(p, { force: true });
        }
      }
      return empty;
    }
    await walk(outputDir);
  }

  return { writeFile, prune };
}
