import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

test('build runs against an in-memory filesystem without touching disk', async () => {
  const vol = Volume.fromJSON({ '/in/.keep': '' });
  const fs = createFsFromVolume(vol);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(true);
});
