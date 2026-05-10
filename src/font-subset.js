let subsetFontPromise = null;
async function loadSubsetFont() {
  if (subsetFontPromise) return subsetFontPromise;
  subsetFontPromise = import('subset-font').then(
    (m) => m.default ?? m,
    () => {
      throw new Error(
        `Font subsetting requires the 'subset-font' package, which is not installed. Run: npm install subset-font`,
      );
    },
  );
  return subsetFontPromise;
}

// subset-font drives HarfBuzz via a singleton WASM instance whose heap is
// shared across calls; concurrent subsets would corrupt each other's malloc'd
// buffers. Serialize, mirroring transcodeToWoff2.
let queue = Promise.resolve();
export async function subsetToWoff2(bytes, text) {
  const subsetFont = await loadSubsetFont();
  const next = queue.then(async () => {
    const out = await subsetFont(bytes, text, { targetFormat: 'woff2' });
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  });
  queue = next.catch(() => {});
  return next;
}
