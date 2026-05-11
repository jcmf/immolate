import { loadOptionalDep } from './install.js';

let subsetFontPromise = null;
function loadSubsetFont({ autoInstall, topDir, install } = {}) {
  if (subsetFontPromise) return subsetFontPromise;
  const p = loadOptionalDep({
    pkg: 'subset-font',
    importer: async () => {
      const m = await import('subset-font');
      return m.default ?? m;
    },
    autoInstall,
    topDir,
    install,
    missingMessage: `Font subsetting requires the 'subset-font' package, which is not installed. Run: npm install subset-font`,
  });
  subsetFontPromise = p;
  p.catch(() => {
    if (subsetFontPromise === p) subsetFontPromise = null;
  });
  return p;
}

// subset-font drives HarfBuzz via a singleton WASM instance whose heap is
// shared across calls; concurrent subsets would corrupt each other's malloc'd
// buffers. Serialize, mirroring transcodeToWoff2.
let queue = Promise.resolve();
export async function subsetToWoff2(bytes, text, opts = {}) {
  const subsetFont = await loadSubsetFont(opts);
  const next = queue.then(async () => {
    const out = await subsetFont(bytes, text, { targetFormat: 'woff2' });
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  });
  queue = next.catch(() => {});
  return next;
}
