import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOptionalDep } from '../src/install.js';

const SENTINEL = Symbol('mod');
const silentLog = () => {};

test('loadOptionalDep returns importer result on success without invoking install', async () => {
  let installCalls = 0;
  const got = await loadOptionalDep({
    pkg: 'fictional',
    importer: async () => SENTINEL,
    autoInstall: true,
    topDir: '/anywhere',
    install: async () => {
      installCalls++;
    },
    missingMessage: 'should not throw',
    log: silentLog,
  });
  assert.equal(got, SENTINEL);
  assert.equal(installCalls, 0);
});

test('loadOptionalDep throws missingMessage when autoInstall is off', async () => {
  await assert.rejects(
    loadOptionalDep({
      pkg: 'fictional',
      importer: async () => {
        throw new Error('ENOENT fictional');
      },
      autoInstall: false,
      topDir: '/anywhere',
      install: async () => {
        throw new Error('install should not be called');
      },
      missingMessage: "the 'fictional' package is not installed",
      log: silentLog,
    }),
    /the 'fictional' package is not installed/,
  );
});

test('loadOptionalDep installs and retries when autoInstall is on', async () => {
  let importCalls = 0;
  let installCalls = 0;
  const got = await loadOptionalDep({
    pkg: 'fictional',
    importer: async () => {
      importCalls++;
      if (importCalls === 1) throw new Error('not installed');
      return SENTINEL;
    },
    autoInstall: true,
    topDir: '/anywhere',
    install: async ({ pkg, topDir }) => {
      installCalls++;
      assert.equal(pkg, 'fictional');
      assert.equal(topDir, '/anywhere');
    },
    missingMessage: 'still missing',
    log: silentLog,
  });
  assert.equal(got, SENTINEL);
  assert.equal(importCalls, 2);
  assert.equal(installCalls, 1);
});

test('loadOptionalDep throws missingMessage when retry after install still fails', async () => {
  let installCalls = 0;
  await assert.rejects(
    loadOptionalDep({
      pkg: 'fictional',
      importer: async () => {
        throw new Error('still ENOENT');
      },
      autoInstall: true,
      topDir: '/anywhere',
      install: async () => {
        installCalls++;
      },
      missingMessage: 'the package is still missing',
      log: silentLog,
    }),
    /the package is still missing/,
  );
  assert.equal(installCalls, 1);
});

test('loadOptionalDep skips install when topDir is missing', async () => {
  let installCalls = 0;
  await assert.rejects(
    loadOptionalDep({
      pkg: 'fictional',
      importer: async () => {
        throw new Error('ENOENT');
      },
      autoInstall: true,
      install: async () => {
        installCalls++;
      },
      missingMessage: 'not installed',
      log: silentLog,
    }),
    /not installed/,
  );
  assert.equal(installCalls, 0);
});
