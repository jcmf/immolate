#!/usr/bin/env node
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from './index.js';
import { runLint } from './lint.js';

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error('Usage: xtatic [top_dir]');
  process.exit(1);
}

const topDir = path.resolve(args[0] ?? '.');
let inputDir = 'pages';
let outputDir = 'site';
let layoutsDir = 'layouts';
let remarkPluginSpecs = [];
let imageInlineThreshold;
let styleInlineThreshold;
let assetInlineThreshold;

const pkgPath = path.join(topDir, 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.xtatic?.inputDir) inputDir = pkg.xtatic.inputDir;
  if (pkg.xtatic?.outputDir) outputDir = pkg.xtatic.outputDir;
  if (pkg.xtatic?.layoutsDir) layoutsDir = pkg.xtatic.layoutsDir;
  if (pkg.xtatic?.remarkPlugins) remarkPluginSpecs = pkg.xtatic.remarkPlugins;
  if (typeof pkg.xtatic?.imageInlineThreshold === 'number') {
    imageInlineThreshold = pkg.xtatic.imageInlineThreshold;
  }
  if (typeof pkg.xtatic?.styleInlineThreshold === 'number') {
    styleInlineThreshold = pkg.xtatic.styleInlineThreshold;
  }
  if (typeof pkg.xtatic?.assetInlineThreshold === 'number') {
    assetInlineThreshold = pkg.xtatic.assetInlineThreshold;
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

try {
  await runLint({ topDir, outputDir });
  const remarkPlugins = await loadRemarkPlugins(remarkPluginSpecs);
  await build({
    inputDir,
    outputDir,
    topDir,
    layoutsDir,
    remarkPlugins,
    imageInlineThreshold,
    styleInlineThreshold,
    assetInlineThreshold,
    fs,
  });
} catch (e) {
  if (process.env.XTATIC_DEBUG) throw e;
  console.error(e.message);
  console.error('\n(set XTATIC_DEBUG=1 for the full stack)');
  process.exit(1);
}
