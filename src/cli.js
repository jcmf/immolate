#!/usr/bin/env node
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from './index.js';

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error('Usage: immolate [top_dir]');
  process.exit(1);
}

const topDir = path.resolve(args[0] ?? '.');
let inputDir = 'pages';
let outputDir = 'site';
let layoutsDir = 'layouts';
let remarkPluginSpecs = [];
let imageInlineThreshold;
let styleInlineThreshold;

const pkgPath = path.join(topDir, 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.immolate?.inputDir) inputDir = pkg.immolate.inputDir;
  if (pkg.immolate?.outputDir) outputDir = pkg.immolate.outputDir;
  if (pkg.immolate?.layoutsDir) layoutsDir = pkg.immolate.layoutsDir;
  if (pkg.immolate?.remarkPlugins) remarkPluginSpecs = pkg.immolate.remarkPlugins;
  if (typeof pkg.immolate?.imageInlineThreshold === 'number') {
    imageInlineThreshold = pkg.immolate.imageInlineThreshold;
  }
  if (typeof pkg.immolate?.styleInlineThreshold === 'number') {
    styleInlineThreshold = pkg.immolate.styleInlineThreshold;
  }
}

inputDir = path.resolve(topDir, inputDir);
outputDir = path.resolve(topDir, outputDir);
layoutsDir = path.resolve(topDir, layoutsDir);

async function loadRemarkPlugins(specs) {
  if (!Array.isArray(specs)) {
    throw new Error(
      `immolate.remarkPlugins must be an array; got ${typeof specs}.`,
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
        `immolate.remarkPlugins entries must be a string or [name, options] tuple; got ${JSON.stringify(spec)}.`,
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
  const remarkPlugins = await loadRemarkPlugins(remarkPluginSpecs);
  await build({
    inputDir,
    outputDir,
    topDir,
    layoutsDir,
    remarkPlugins,
    imageInlineThreshold,
    styleInlineThreshold,
    fs,
  });
} catch (e) {
  if (process.env.IMMOLATE_DEBUG) throw e;
  console.error(e.message);
  console.error('\n(set IMMOLATE_DEBUG=1 for the full stack)');
  process.exit(1);
}
