#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import { build } from './index.js';

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error('Usage: immolate [top_dir]');
  process.exit(1);
}

const topDir = path.resolve(args[0] ?? '.');
let inputDir = 'pages';
let outputDir = 'site';

const pkgPath = path.join(topDir, 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.immolate?.inputDir) inputDir = pkg.immolate.inputDir;
  if (pkg.immolate?.outputDir) outputDir = pkg.immolate.outputDir;
}

inputDir = path.resolve(topDir, inputDir);
outputDir = path.resolve(topDir, outputDir);

await build({ inputDir, outputDir, topDir, fs });
