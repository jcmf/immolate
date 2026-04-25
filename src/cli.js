#!/usr/bin/env node
import * as fs from 'node:fs';
import { build } from './index.js';

const [inputDir, outputDir, ...rest] = process.argv.slice(2);
if (!inputDir || !outputDir || rest.length > 0) {
  console.error('Usage: immolate <input_dir> <output_dir>');
  process.exit(1);
}

await build({ inputDir, outputDir, fs });
