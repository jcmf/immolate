#!/usr/bin/env node
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import remarkSmartypants from 'remark-smartypants';
import { build } from './index.js';
import { runLint } from './lint.js';
import { serve } from './serve.js';
import { watch } from './watch.js';

const HELP = `xtatic — static-site generator (MDX in, plain HTML out)

Usage:
  xtatic [command] [args...]

Commands:
  build [top_dir]   Build the site. top_dir defaults to the current directory.
  watch [top_dir]   Build, then rebuild on every change under top_dir.
  serve [top_dir]   Watch and serve the output over HTTP (default port 3000;
                    override with XTATIC_PORT).
  browse [top_dir]  Same as "serve", and open the root page in a browser.
  help              Show this help.

If no command is given, "build" is run with no arguments.`;

const KNOWN = new Set(['build', 'watch', 'serve', 'browse']);

const args = process.argv.slice(2);
const command = args[0] ?? 'build';
const rest = args.slice(1);

if (command === 'help') {
  console.log(HELP);
  process.exit(0);
}

if (!KNOWN.has(command)) {
  console.error(`xtatic: unknown command "${command}"`);
  console.error('Run "xtatic help" for usage.');
  process.exit(1);
}

if (rest.length > 1) {
  console.error(`Usage: xtatic ${command} [top_dir]`);
  process.exit(1);
}

const topDir = path.resolve(rest[0] ?? '.');
let inputDir = 'pages';
let outputDir = 'site';
let layoutsDir = 'layouts';
let remarkPluginSpecs = [];
let smartypantsConfig = true;
let imageInlineThreshold;
let styleInlineThreshold;
let assetInlineThreshold;
let errorLayout;
let errorReloadInterval;

const pkgPath = path.join(topDir, 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.xtatic?.inputDir) inputDir = pkg.xtatic.inputDir;
  if (pkg.xtatic?.outputDir) outputDir = pkg.xtatic.outputDir;
  if (pkg.xtatic?.layoutsDir) layoutsDir = pkg.xtatic.layoutsDir;
  if (pkg.xtatic?.remarkPlugins) remarkPluginSpecs = pkg.xtatic.remarkPlugins;
  if (pkg.xtatic && 'smartypants' in pkg.xtatic) {
    const v = pkg.xtatic.smartypants;
    if (
      v !== true &&
      v !== false &&
      !(v && typeof v === 'object' && !Array.isArray(v))
    ) {
      console.error(
        `xtatic.smartypants must be true, false, or an options object; got ${JSON.stringify(v)}.`,
      );
      process.exit(1);
    }
    smartypantsConfig = v;
  }
  if (typeof pkg.xtatic?.imageInlineThreshold === 'number') {
    imageInlineThreshold = pkg.xtatic.imageInlineThreshold;
  }
  if (typeof pkg.xtatic?.styleInlineThreshold === 'number') {
    styleInlineThreshold = pkg.xtatic.styleInlineThreshold;
  }
  if (typeof pkg.xtatic?.assetInlineThreshold === 'number') {
    assetInlineThreshold = pkg.xtatic.assetInlineThreshold;
  }
  if (pkg.xtatic?.errorLayout != null) {
    if (typeof pkg.xtatic.errorLayout !== 'string') {
      console.error(
        `xtatic.errorLayout must be a string path; got ${JSON.stringify(pkg.xtatic.errorLayout)}.`,
      );
      process.exit(1);
    }
    errorLayout = path.resolve(topDir, pkg.xtatic.errorLayout);
  }
  if (pkg.xtatic?.errorReloadInterval != null) {
    const v = pkg.xtatic.errorReloadInterval;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      console.error(
        `xtatic.errorReloadInterval must be a non-negative number (seconds); got ${JSON.stringify(v)}.`,
      );
      process.exit(1);
    }
    errorReloadInterval = v;
  }
}

inputDir = path.resolve(topDir, inputDir);
outputDir = path.resolve(topDir, outputDir);
layoutsDir = path.resolve(topDir, layoutsDir);

async function loadRemarkPlugins(specs) {
  if (!Array.isArray(specs)) {
    throw new Error(
      `xtatic.remarkPlugins must be an array; got ${typeof specs}.`,
    );
  }
  const require = createRequire(path.join(topDir, 'package.json'));
  const loaded = [];
  for (const spec of specs) {
    let name, opts;
    if (typeof spec === 'string') {
      name = spec;
    } else if (
      Array.isArray(spec) &&
      spec.length >= 1 &&
      typeof spec[0] === 'string'
    ) {
      [name, opts] = spec;
    } else {
      throw new Error(
        `xtatic.remarkPlugins entries must be a string or [name, options] tuple; got ${JSON.stringify(spec)}.`,
      );
    }
    let resolved;
    try {
      resolved = require.resolve(name);
    } catch {
      throw new Error(
        `Cannot resolve remark plugin "${name}" from ${topDir}. Is it installed?`,
      );
    }
    const mod = await import(pathToFileURL(resolved).href);
    const fn = mod.default ?? mod;
    if (typeof fn !== 'function') {
      throw new Error(
        `Remark plugin "${name}" did not export a function (got ${typeof fn}).`,
      );
    }
    loaded.push(opts === undefined ? fn : [fn, opts]);
  }
  return loaded;
}

let remarkPlugins;
try {
  remarkPlugins = await loadRemarkPlugins(remarkPluginSpecs);
} catch (e) {
  if (process.env.XTATIC_DEBUG) throw e;
  console.error(e.message);
  console.error('\n(set XTATIC_DEBUG=1 for the full stack)');
  process.exit(1);
}

if (smartypantsConfig !== false) {
  const smartypants =
    smartypantsConfig && typeof smartypantsConfig === 'object'
      ? [remarkSmartypants, smartypantsConfig]
      : remarkSmartypants;
  remarkPlugins = [smartypants, ...remarkPlugins];
}

const buildOptions = {
  inputDir,
  outputDir,
  topDir,
  layoutsDir,
  remarkPlugins,
  imageInlineThreshold,
  styleInlineThreshold,
  assetInlineThreshold,
};

if (command === 'build') {
  try {
    await runLint({ topDir, outputDir });
    await build({ ...buildOptions, fs });
  } catch (e) {
    if (process.env.XTATIC_DEBUG) throw e;
    console.error(e.message);
    console.error('\n(set XTATIC_DEBUG=1 for the full stack)');
    process.exit(1);
  }
} else if (command === 'watch') {
  await watch({ buildOptions });
} else {
  let port = 3000;
  if (process.env.XTATIC_PORT != null) {
    const n = Number(process.env.XTATIC_PORT);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      console.error(`xtatic: invalid XTATIC_PORT="${process.env.XTATIC_PORT}"`);
      process.exit(1);
    }
    port = n;
  }
  try {
    await serve({
      buildOptions,
      port,
      open: command === 'browse',
      errorLayout,
      errorReloadInterval,
    });
  } catch (e) {
    if (process.env.XTATIC_DEBUG) throw e;
    console.error(e.message);
    console.error('\n(set XTATIC_DEBUG=1 for the full stack)');
    process.exit(1);
  }
}
