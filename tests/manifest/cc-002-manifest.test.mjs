import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManifest, validateManifest } from '../../src/container/internal/manifest/index.mjs';

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

test('CC-002-AC01 valid minimal manifest resolves defaults and may launch', () => {
  const result = resolveManifest(base, options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.optionalCapabilities, []);
  assert.deepEqual(result.manifest.extensionPoints, []);
  assert.deepEqual(result.manifest.contentConfiguration, {});
});

test('CC-002-AC02 missing/malformed required field is rejected with MANIFEST_INVALID', () => {
  const result = validateManifest({ ...base, appId: '' }, options);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MANIFEST_INVALID');
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

test('CC-002-AC06 resolution is deterministic for same inputs', () => {
  const a = resolveManifest(base, options);
  const b = resolveManifest(structuredClone(base), structuredClone(options));
  assert.deepEqual(a, b);
  assert.equal(Object.isFrozen(a.manifest), true);
});
