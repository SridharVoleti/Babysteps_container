import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadAppPackage } from '../../src/container/internal/manifest/load-app-package.mjs';
import { defineLearningApp } from '../../src/container/public/index.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';

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

function boundRuntimeFor(appId) {
  return bindAuthorizedRuntime({ learnerId: 'learner-1', appId, releaseId: 'release-1', sessionId: 'session-1' });
}

test('CC-002-AC10 loading an app package without an authorized runtime binding fails closed before reading the manifest', async () => {
  let readAttempted = false;
  const result = await loadAppPackage('/tmp/app.manifest.json', options, {
    readText: async () => { readAttempted = true; return JSON.stringify(base); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTHORIZATION_REQUIRED');
  assert.equal(readAttempted, false);
});

test('CC-002-AC10 a loaded app whose id matches the validated manifest appId binds successfully and freezes the resolved identity', async () => {
  const result = await loadAppPackage('/tmp/app.manifest.json', options, {
    readText: async () => JSON.stringify(base),
    loadModule: async () => ({ default: defineLearningApp({ id: 'magical-math' }) }),
    runtimeBinding: boundRuntimeFor('magical-math'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.appDefinition.id, 'magical-math');
  assert.equal(Object.isFrozen(result.appDefinition), true);
});

test('CC-002-AC10 an authorized runtime bound to a different appId than the manifest fails closed before the module is imported', async () => {
  let loaded = false;
  const result = await loadAppPackage('/tmp/app.manifest.json', options, {
    readText: async () => JSON.stringify(base),
    loadModule: async () => { loaded = true; return { default: defineLearningApp({ id: 'magical-math' }) }; },
    runtimeBinding: boundRuntimeFor('a-different-authorized-app'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APP_IDENTITY_MISMATCH');
  assert.equal(loaded, false);
});

test('CC-002-AC10 a loaded app declaring a different identity than the manifest fails closed before execution', async () => {
  let started = false;
  const result = await loadAppPackage('/tmp/app.manifest.json', options, {
    readText: async () => JSON.stringify(base),
    loadModule: async () => ({
      default: defineLearningApp({ id: 'a-completely-different-app' }),
      start: () => { started = true; },
    }),
    runtimeBinding: boundRuntimeFor('magical-math'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APP_IDENTITY_MISMATCH');
  assert.equal(started, false);
});

test('CC-002-AC10 an app module with no default export identity fails closed', async () => {
  const result = await loadAppPackage('/tmp/app.manifest.json', options, {
    readText: async () => JSON.stringify(base),
    loadModule: async () => ({ start: () => true }),
    runtimeBinding: boundRuntimeFor('magical-math'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APP_IDENTITY_MISMATCH');
});

test('CC-002-AC10 the repository example app and manifest use the same canonical identity', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../apps/example/app.manifest.json', import.meta.url), 'utf8'));
  const appModule = await import('../../apps/example/index.mjs');
  assert.equal(appModule.default.id, manifest.appId);
});
