import * as fs from 'node:fs';
import path from 'node:path';
import { build } from './index.js';
import { runLint } from './lint.js';

export async function watch({ buildOptions, debounceMs = 100 }) {
  const { topDir, outputDir } = buildOptions;
  const state = { error: null };

  let building = false;
  let dirty = false;
  let timer = null;
  // Pending promise while a build is in flight, null when idle. Lets serve mode
  // hold a request until the (re)build that may be wiping/rewriting outputDir
  // has finished, instead of serving 404s or a half-written tree.
  let inFlight = null;

  async function runOnce() {
    building = true;
    let done;
    inFlight = new Promise((r) => {
      done = r;
    });
    const start = Date.now();
    try {
      await runLint({ topDir, outputDir });
      await build({ ...buildOptions, fs });
      state.error = null;
      console.log(`[xtatic] built in ${Date.now() - start}ms`);
    } catch (e) {
      state.error = e;
      console.error(`[xtatic] build failed: ${e.message}`);
      if (process.env.XTATIC_DEBUG) console.error(e.stack);
    } finally {
      building = false;
      inFlight = null;
      done();
      if (dirty) {
        dirty = false;
        schedule();
      }
    }
  }

  async function whenIdle() {
    while (inFlight) await inFlight;
  }

  function schedule() {
    if (building) {
      dirty = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runOnce();
    }, debounceMs);
  }

  await runOnce();

  const ignoredDirs = [outputDir, path.join(topDir, 'node_modules')];
  function isIgnored(abs) {
    for (const p of ignoredDirs) {
      if (abs === p || abs.startsWith(p + path.sep)) return true;
    }
    return false;
  }

  const watcher = fs.watch(topDir, { recursive: true, persistent: true });
  watcher.on('change', (_eventType, filename) => {
    if (!filename) return;
    const abs = path.resolve(topDir, String(filename));
    if (isIgnored(abs)) return;
    schedule();
  });
  watcher.on('error', (e) => {
    console.error(`[xtatic] watcher error: ${e.message}`);
  });

  console.log(`[xtatic] watching ${topDir} (Ctrl-C to stop)`);
  return { watcher, state, whenIdle };
}
