import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManifest, validateManifest } from '../../src/container/internal/manifest/index.mjs';
import { loadAppPackage } from '../../src/container/internal/manifest/load-app-package.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';

const base = {
  appId: 'magical-math',
  appVersion: '1.0.0',
  containerContractVersion: '1.0',
  contentVersion: '2026.08',
  progressSchemaVersion: '1',
  requiredCapabilities: ['progress'],
  entryPoint: './index.mjs'
};

const options = {
  supportedContractVersions: ['1.0'],
  availableCapabilities: ['progress', 'audio'],
  approvedExtensionPoints: ['activity-renderer']
};

function boundRuntimeFor(appId) {
  return bindAuthorizedRuntime({ learnerId: 'learner-1', appId, releaseId: 'release-1', sessionId: 'session-1' });
}

test('CC-002-AC01 valid minimal manifest resolves defaults and entry point may load', async () => {
  let loaded = false;
  const result = await loadAppPackage('/tmp/app.manifest.json', options, {
    readText: async () => JSON.stringify(base),
    loadModule: async () => { loaded = true; return { default: Object.freeze({ id: 'magical-math' }), start: () => true }; },
    runtimeBinding: boundRuntimeFor('magical-math'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.appDefinition.id, 'magical-math');
  assert.equal(loaded, true);
  assert.deepEqual(result.manifest.optionalCapabilities, []);
  assert.deepEqual(result.manifest.extensionPoints, []);
  assert.deepEqual(result.manifest.contentConfiguration, {});
});

test('CC-002-AC02 missing/malformed required field is rejected before app code', async () => {
  let loaded = false;
  const result = await loadAppPackage('/tmp/app.manifest.json', options, {
    readText: async () => JSON.stringify({ ...base, appId: '' }),
    loadModule: async () => { loaded = true; return {}; },
    runtimeBinding: boundRuntimeFor('magical-math'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MANIFEST_INVALID');
  assert.equal(loaded, false);
});

test('CC-002-AC03 unsupported contract is rejected with stable compatibility error', () => {
  const result = validateManifest({ ...base, containerContractVersion: '9.9' }, options);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONTAINER_VERSION_UNSUPPORTED');
});

test('CC-002-AC04 unknown required capability blocks launch while unknown optional capability degrades', () => {
  const required = validateManifest({ ...base, requiredCapabilities: ['unknown'] }, options);
  assert.equal(required.ok, false);
  assert.equal(required.error.code, 'CAPABILITY_UNAVAILABLE');

  const optional = resolveManifest({ ...base, optionalCapabilities: ['unknown', 'audio'] }, options);
  assert.equal(optional.ok, true);
  assert.deepEqual(optional.manifest.optionalCapabilities, ['audio']);
  assert.deepEqual(optional.degradedOptionalCapabilities, ['unknown']);
});

test('CC-002-AC05 prohibited secret/authority fields fail without leaking values', () => {
  const secret = 'super-secret-value';
  const result = validateManifest({ ...base, authToken: secret, learnerId: 'learner-123' }, options);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MANIFEST_PROHIBITED_DATA');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('CC-002-AC09 omitted requiredCapabilities fails validation; an explicit empty array is accepted', () => {
  const { requiredCapabilities, ...withoutField } = base;
  void requiredCapabilities;
  const omitted = validateManifest(withoutField, options);
  assert.equal(omitted.ok, false);
  assert.equal(omitted.error.code, 'MANIFEST_INVALID');

  const nonArray = validateManifest({ ...base, requiredCapabilities: 'progress' }, options);
  assert.equal(nonArray.ok, false);
  assert.equal(nonArray.error.code, 'MANIFEST_INVALID');

  const explicitlyEmpty = validateManifest({ ...base, requiredCapabilities: [] }, options);
  assert.equal(explicitlyEmpty.ok, true);
});

test('CC-002-AC11 unknown top-level manifest fields are rejected under a strict allowlist', () => {
  const result = validateManifest({ ...base, unexpectedField: 'anything' }, options);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MANIFEST_UNKNOWN_FIELD');
  assert.equal(result.error.details.field, 'unexpectedField');
});

test('CC-002-AC11 alternate spellings of sensitive/platform-authoritative data are still rejected inside nested contentConfiguration', () => {
  for (const [key, value] of [
    ['apiKey', 'sk-abc123'],
    ['access_token', 'tok-abc123'],
    ['parentId', 'parent-1'],
    ['userId', 'user-1'],
  ]) {
    const result = validateManifest({ ...base, contentConfiguration: { [key]: value } }, options);
    assert.equal(result.ok, false, `expected ${key} to be rejected`);
    assert.equal(result.error.code, 'MANIFEST_PROHIBITED_DATA');
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test('CC-002-AC11 an arbitrary unknown nested key inside contentConfiguration remains app-owned opaque data', () => {
  const result = validateManifest({ ...base, contentConfiguration: { curriculumTier: 'advanced', boardTheme: 'wood' } }, options);
  assert.equal(result.ok, true);
});

test('CC-002-AC06 resolution is deterministic for same inputs', () => {
  const a = resolveManifest(base, options);
  const b = resolveManifest(structuredClone(base), structuredClone(options));
  assert.deepEqual(a, b);
  assert.equal(Object.isFrozen(a.manifest), true);
});
