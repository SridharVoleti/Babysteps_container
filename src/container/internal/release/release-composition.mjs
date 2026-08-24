export class ReleaseCompositionError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ReleaseCompositionError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new ReleaseCompositionError(code, message, metadata); }

// PK-003: the complete set of release-critical component identifiers a deployed Vercel
// release must be traceable to. Purely technical version/build identifiers - no learner
// content, PII, credentials or payment data is ever part of this record.
export const RELEASE_COMPOSITION_FIELDS = Object.freeze([
  'appId',
  'appVersion',
  'gitCommit',
  'buildId',
  'containerVersion',
  'contentVersion',
  'progressSchemaVersion',
  'voicePackageVersion',
  'manifestVersion',
  'dependencyLockFingerprint',
]);

const FORBIDDEN_FIELD_PATTERN = /token|secret|password|credential|email|phone|payment|billing|ssn|parentname|learnername|address/i;

export function validateReleaseComposition(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('RELEASE_METADATA_INVALID', 'A release composition record must be an object.');
  }
  for (const field of RELEASE_COMPOSITION_FIELDS) {
    if (typeof candidate[field] !== 'string' || candidate[field].trim() === '') {
      fail('REQUIRED_COMPONENT_MISSING', `Release composition is missing a required component: ${field}`, { field });
    }
  }
  for (const key of Object.keys(candidate)) {
    if (FORBIDDEN_FIELD_PATTERN.test(key)) {
      fail('RELEASE_METADATA_INVALID', `Release composition must not contain non-technical/sensitive fields: ${key}`, { field: key });
    }
  }
  return { ok: true };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

// Build-time only: produces one immutable, inspectable release composition record. There is
// no corresponding "update" function - a release composition cannot be rewritten after build.
export function buildReleaseComposition(fields) {
  const candidate = { ...fields };
  validateReleaseComposition(candidate);
  return deepFreeze(candidate);
}

// PK-003-AC03/AC04: fails the build when the resolved app manifest's declared versions do
// not match what CI actually packaged into the release.
export function compareManifestToPackagedComponents(manifest, releaseComposition) {
  const checks = [
    ['appVersion', 'appVersion'],
    ['contentVersion', 'contentVersion'],
    ['progressSchemaVersion', 'progressSchemaVersion'],
  ];
  const mismatches = [];
  for (const [manifestField, packagedField] of checks) {
    if (manifest?.[manifestField] !== releaseComposition?.[packagedField]) {
      mismatches.push({ field: manifestField, declared: manifest?.[manifestField], packaged: releaseComposition?.[packagedField] });
    }
  }
  if (mismatches.length > 0) {
    fail('RELEASE_COMPOSITION_MISMATCH', 'The resolved manifest and the actual packaged release do not match.', { mismatches });
  }
  return { ok: true };
}

const LOOSE_VERSION_PATTERN = /^(latest|\*|\^|~)/;

// PK-003-AC05/AC06/AC08: release-critical dependencies must resolve deterministically. A
// missing fingerprint or a loose/mutable version range fails the build instead of letting the
// same approved source silently drift to a different dependency version on rebuild.
export function validateDeterministicDependencyLock({ fingerprint, resolvedVersions = {} } = {}) {
  if (typeof fingerprint !== 'string' || fingerprint.trim() === '') {
    fail('NONDETERMINISTIC_DEPENDENCY', 'A deterministic dependency lock fingerprint is required for release-critical components.');
  }
  const loose = Object.entries(resolvedVersions).filter(([, version]) => typeof version !== 'string' || LOOSE_VERSION_PATTERN.test(version.trim()));
  if (loose.length > 0) {
    fail('NONDETERMINISTIC_DEPENDENCY', 'Release-critical dependencies must resolve to exact, pinned versions rather than mutable ranges.', {
      dependencies: loose.map(([name]) => name),
    });
  }
  return { ok: true };
}
