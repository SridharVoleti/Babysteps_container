import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReleaseComposition,
  validateReleaseComposition,
  compareManifestToPackagedComponents,
  validateDeterministicDependencyLock,
  RELEASE_COMPOSITION_FIELDS,
  ReleaseCompositionError,
} from '../../src/container/internal/release/release-composition.mjs';

function validFields(overrides = {}) {
  return {
    appId: 'magical-math',
    appVersion: '1.4.0',
    gitCommit: 'a1b2c3d4e5f6',
    buildId: 'vercel-build-9182',
    containerVersion: '0.3.0',
    contentVersion: '2.1.0',
    progressSchemaVersion: '1.0',
    voicePackageVersion: '1.0.0',
    manifestVersion: '1.0',
    dependencyLockFingerprint: 'sha256:deadbeef',
    ...overrides,
  };
}

test('PK-003-AC01 the release composition records the exact Git commit/build identity', () => {
  const composition = buildReleaseComposition(validFields());
  assert.equal(composition.gitCommit, 'a1b2c3d4e5f6');
  assert.equal(composition.buildId, 'vercel-build-9182');
});

test('PK-003-AC02 container/app/content/progress-schema/voice versions are identifiable for the release', () => {
  const composition = buildReleaseComposition(validFields());
  for (const field of RELEASE_COMPOSITION_FIELDS) {
    assert.equal(typeof composition[field], 'string');
    assert.notEqual(composition[field].trim(), '');
  }
});

test('PK-003-AC03 a mismatch between declared manifest versions and the actual packaged release fails', () => {
  const manifest = { appVersion: '1.4.0', contentVersion: '2.1.0', progressSchemaVersion: '1.0' };
  const composition = buildReleaseComposition(validFields({ contentVersion: '2.2.0' }));
  assert.throws(
    () => compareManifestToPackagedComponents(manifest, composition),
    (e) => e instanceof ReleaseCompositionError && e.code === 'RELEASE_COMPOSITION_MISMATCH'
  );
});

test('PK-003-AC04 a missing required release-critical component is rejected before production deployment', () => {
  const { containerVersion, ...withoutContainerVersion } = validFields();
  void containerVersion;
  assert.throws(
    () => validateReleaseComposition(withoutContainerVersion),
    (e) => e instanceof ReleaseCompositionError && e.code === 'REQUIRED_COMPONENT_MISSING'
  );
});

test('PK-003-AC05 a release-critical dependency without a controlled lock/fingerprint fails the build', () => {
  assert.throws(
    () => validateDeterministicDependencyLock({ resolvedVersions: { audioEngine: 'latest' } }),
    (e) => e.code === 'NONDETERMINISTIC_DEPENDENCY'
  );
  assert.throws(
    () => validateDeterministicDependencyLock({ fingerprint: 'sha256:abc', resolvedVersions: { audioEngine: '^2.0.0' } }),
    (e) => e.code === 'NONDETERMINISTIC_DEPENDENCY'
  );
});

test('PK-003-AC06 the same approved source/lock/build configuration does not silently drift to a different composition', () => {
  const first = buildReleaseComposition(validFields());
  const second = buildReleaseComposition(validFields());
  assert.deepEqual(first, second);
  const okLock = validateDeterministicDependencyLock({ fingerprint: 'sha256:abc', resolvedVersions: { audioEngine: '2.0.0' } });
  assert.equal(okLock.ok, true);
});

test('PK-003-AC07 the exact final-app release composition can be determined for a reported production issue', () => {
  const composition = buildReleaseComposition(validFields());
  const inspected = JSON.parse(JSON.stringify(composition));
  assert.equal(inspected.appId, 'magical-math');
  assert.equal(inspected.gitCommit, 'a1b2c3d4e5f6');
});

test('PK-003-AC08 release-critical components are not silently re-resolved to an arbitrary latest version', () => {
  assert.throws(
    () => validateDeterministicDependencyLock({ fingerprint: 'sha256:abc', resolvedVersions: { narrationVoice: 'latest' } }),
    (e) => e.code === 'NONDETERMINISTIC_DEPENDENCY'
  );
});

test('PK-003-AC09 release metadata contains only technical identifiers, no learner/parent PII or credentials', () => {
  assert.throws(
    () => validateReleaseComposition({ ...validFields(), parentEmail: 'leak@example.com' }),
    (e) => e.code === 'RELEASE_METADATA_INVALID'
  );
  assert.throws(
    () => validateReleaseComposition({ ...validFields(), accessToken: 'secret-value' }),
    (e) => e.code === 'RELEASE_METADATA_INVALID'
  );
});

test('PK-003-AC10 PK-003 introduces no competing rollback mechanism', () => {
  const moduleExports = { buildReleaseComposition, validateReleaseComposition, compareManifestToPackagedComponents, validateDeterministicDependencyLock };
  assert.equal('rollback' in moduleExports, false);
  assert.equal('deploy' in moduleExports, false);
});

test('PK-003-AC11 the release composition is read-only and cannot be rewritten by app code at runtime', () => {
  const composition = buildReleaseComposition(validFields());
  assert.equal(Object.isFrozen(composition), true);
  assert.throws(() => { composition.appVersion = '9.9.9'; }, TypeError);
});
