import { loadOptionalDep } from './install.js';

export const TRANSCODABLE_FONT_EXTS = new Set(['ttf', 'otf']);

let wawoff2Promise = null;
function loadWawoff2({ autoInstall, topDir, install } = {}) {
  if (wawoff2Promise) return wawoff2Promise;
  const p = loadOptionalDep({
    pkg: 'wawoff2',
    importer: async () => {
      const m = await import('wawoff2');
      return m.default ?? m;
    },
    autoInstall,
    topDir,
    install,
    missingMessage: `Font transcoding requires the 'wawoff2' package, which is not installed. Run: npm install wawoff2`,
  });
  wawoff2Promise = p;
  p.catch(() => {
    if (wawoff2Promise === p) wawoff2Promise = null;
  });
  return p;
}

// wawoff2 is a singleton WASM module; its `compress` returns a Uint8Array
// view into the WASM heap that gets clobbered by the next call. Serialize so
// the bytes are copied (Buffer.from) before another compress can run.
let queue = Promise.resolve();
export async function transcodeToWoff2(bytes, opts = {}) {
  const wawoff2 = await loadWawoff2(opts);
  const next = queue.then(async () => {
    const out = await wawoff2.compress(bytes);
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  });
  queue = next.catch(() => {});
  return next;
}
