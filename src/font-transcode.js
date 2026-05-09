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

export async function transcodeToWoff2(bytes) {
  const wawoff2 = await loadWawoff2();
  const out = await wawoff2.compress(bytes);
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
