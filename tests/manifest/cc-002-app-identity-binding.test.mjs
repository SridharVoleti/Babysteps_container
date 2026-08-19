import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadAppPackage } from '../../src/container/internal/manifest/load-app-package.mjs';
import { defineLearningApp } from '../../src/container/public/index.mjs';

const base = {
  appId: 'magical-math',
  appVersion: '1.0.0',
  containerContractVersion: '1.0',
  contentVersion: '2026.08',
  progressSchemaVersion: '1',
  requiredCapabilities: [],
  entryPoint: './index.mjs',
};

const options = { supportedContractVersions: ['1.0'], availableCapabilities: [], approvedExtensionPoints: [] };

test('CC-002-AC10 a loaded app whose id matches the validated manifest appId binds successfully and freezes the resolved identity', async () => {
  const result = await loadAppPackage('/tmp/app.manifest.json', options, {
    readText: async () => JSON.stringify(base),
    loadModule: async () => ({ default: defineLearningApp({ id: 'magical-math' }) }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.appDefinition.id, 'magical-math');
  assert.equal(Object.isFrozen(result.appDefinition), true);
});

test('CC-002-AC10 a loaded app declaring a different identity than the manifest fails closed before execution', async () => {
  let started = false;
  const result = await loadAppPackage('/tmp/app.manifest.json', options, {
    readText: async () => JSON.stringify(base),
    loadModule: async () => ({
      default: defineLearningApp({ id: 'a-completely-different-app' }),
      start: () => { started = true; },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APP_IDENTITY_MISMATCH');
  assert.equal(started, false);
});

test('CC-002-AC10 an app module with no default export identity fails closed', async () => {
  const result = await loadAppPackage('/tmp/app.manifest.json', options, {
    readText: async () => JSON.stringify(base),
    loadModule: async () => ({ start: () => true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APP_IDENTITY_MISMATCH');
});

test('CC-002-AC10 the repository example app and manifest use the same canonical identity', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../apps/example/app.manifest.json', import.meta.url), 'utf8'));
  const appModule = await import('../../apps/example/index.mjs');
  assert.equal(appModule.default.id, manifest.appId);
});
