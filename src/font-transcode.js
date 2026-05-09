export const TRANSCODABLE_FONT_EXTS = new Set(['ttf', 'otf']);

let wawoff2Promise = null;
async function loadWawoff2() {
  if (wawoff2Promise) return wawoff2Promise;
  wawoff2Promise = import('wawoff2').then(
    (m) => m.default ?? m,
    () => {
      throw new Error(
        `Font transcoding requires the 'wawoff2' package, which is not installed. Run: npm install wawoff2`,
      );
    },
  );
  return wawoff2Promise;
}

// wawoff2 is a singleton WASM module; its `compress` returns a Uint8Array
// view into the WASM heap that gets clobbered by the next call. Serialize so
// the bytes are copied (Buffer.from) before another compress can run.
let queue = Promise.resolve();
export async function transcodeToWoff2(bytes) {
  const wawoff2 = await loadWawoff2();
  const next = queue.then(async () => {
    const out = await wawoff2.compress(bytes);
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  });
  queue = next.catch(() => {});
  return next;
}
