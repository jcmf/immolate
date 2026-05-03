import crypto from 'node:crypto';

export function createAssetRegistry({ fs, outputDir }) {
  const emissions = new Map();

  function emit(bytes, ext) {
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const fname = `${hash}.${ext}`;
    if (!emissions.has(fname)) {
      emissions.set(fname, { absPath: `${outputDir}/_assets/${fname}`, bytes });
    }
    return `/_assets/${fname}`;
  }

  async function writeAll() {
    if (emissions.size === 0) return;
    const dirs = new Set();
    for (const { absPath, bytes } of emissions.values()) {
      const dir = absPath.substring(0, absPath.lastIndexOf('/'));
      if (!dirs.has(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
        dirs.add(dir);
      }
      await fs.promises.writeFile(absPath, bytes);
    }
  }

  return { emit, writeAll };
}
