const REQUIRED_STRING_FIELDS = [
  'appId',
  'appVersion',
  'containerContractVersion',
  'contentVersion',
  'progressSchemaVersion',
  'entryPoint'
];

const OPTIONAL_TOP_LEVEL_FIELDS = ['contentConfiguration', 'requiredCapabilities', 'optionalCapabilities', 'extensionPoints'];

// Approved/frozen manifest fields only (CC-002). Unknown top-level fields are rejected
// outright rather than merely denylisted, so alternate/unexpected names cannot smuggle
// platform-authoritative or secret data through the manifest.
const ALLOWED_TOP_LEVEL_FIELDS = new Set([...REQUIRED_STRING_FIELDS, ...OPTIONAL_TOP_LEVEL_FIELDS]);

const PROHIBITED_KEYS = new Set([
  'secret', 'secrets', 'password', 'token', 'authToken', 'accessToken', 'refreshToken',
  'serviceRoleKey', 'databaseUrl', 'dbUrl', 'paymentData', 'billing', 'subscription',
  'learnerId', 'sessionId', 'entitlement', 'sessionCredit', 'parentProfile', 'learnerProfile'
]);

// Nested app-owned data (contentConfiguration) stays opaque/app-defined, but is still
// scanned for these alternate spellings of the same prohibited data categories so it
// cannot become a side channel for secrets or platform-authoritative identifiers.
const PROHIBITED_KEY_PATTERN = /secret|credential|private.*profile|api[_-]?key|access[_-]?token|refresh[_-]?token|parent[_-]?id|user[_-]?id/i;

const DEFAULTS = Object.freeze({
  contentConfiguration: Object.freeze({}),
  requiredCapabilities: Object.freeze([]),
  optionalCapabilities: Object.freeze([]),
  extensionPoints: Object.freeze([])
});

function failure(code, message, details = undefined) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message, ...(details ? { details } : {}) })
  });
}

function containsProhibitedData(value, path = '') {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const current = path ? `${path}.${key}` : key;
    if (PROHIBITED_KEYS.has(key) || PROHIBITED_KEY_PATTERN.test(key)) return current;
    const nested = containsProhibitedData(child, current);
    if (nested) return nested;
  }
  return null;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

export function validateManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return failure('MANIFEST_INVALID', 'App manifest must be an object.');
  }

  const prohibitedPath = containsProhibitedData(manifest);
  if (prohibitedPath) {
    return failure('MANIFEST_PROHIBITED_DATA', 'App manifest contains prohibited runtime or secret data.', { field: prohibitedPath });
  }

  for (const key of Object.keys(manifest)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      return failure('MANIFEST_UNKNOWN_FIELD', 'App manifest contains an unapproved top-level field.', { field: key });
    }
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      return failure('MANIFEST_INVALID', `App manifest field ${field} is required and must be a non-empty string.`);
    }
  }

  if (!isStringArray(manifest.requiredCapabilities)) {
    return failure('MANIFEST_INVALID', 'App manifest field requiredCapabilities is required and must be an array of non-empty strings (an empty array is permitted).');
  }

  for (const field of ['optionalCapabilities', 'extensionPoints']) {
    if (manifest[field] !== undefined && !isStringArray(manifest[field])) {
      return failure('MANIFEST_INVALID', `App manifest field ${field} must be an array of non-empty strings.`);
    }
  }

  if (manifest.contentConfiguration !== undefined && (!manifest.contentConfiguration || typeof manifest.contentConfiguration !== 'object' || Array.isArray(manifest.contentConfiguration))) {
    return failure('MANIFEST_INVALID', 'contentConfiguration must be an object when supplied.');
  }

  const supported = new Set(options.supportedContractVersions ?? []);
  if (!supported.has(manifest.containerContractVersion)) {
    return failure('CONTAINER_VERSION_UNSUPPORTED', 'App manifest targets an unsupported container contract version.');
  }

  const available = new Set(options.availableCapabilities ?? []);
  for (const capability of manifest.requiredCapabilities ?? []) {
    if (!available.has(capability)) {
      return failure('CAPABILITY_UNAVAILABLE', 'A required app capability is unavailable.', { capability });
    }
  }

  const approvedExtensions = new Set(options.approvedExtensionPoints ?? []);
  for (const extension of manifest.extensionPoints ?? []) {
    if (!approvedExtensions.has(extension)) {
      return failure('MANIFEST_INVALID', 'App manifest declares an unapproved extension point.', { extension });
    }
  }

  if (!/^\.\/[^/].*\.m?js$/.test(manifest.entryPoint) || manifest.entryPoint.includes('..')) {
    return failure('ENTRY_POINT_INVALID', 'App entry point must be a package-relative JavaScript module path.');
  }

  return Object.freeze({ ok: true });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function resolveManifest(manifest, options = {}) {
  const validation = validateManifest(manifest, options);
  if (!validation.ok) return validation;

  const available = new Set(options.availableCapabilities ?? []);
  const optional = [...(manifest.optionalCapabilities ?? DEFAULTS.optionalCapabilities)].sort();
  const supportedOptional = optional.filter((capability) => available.has(capability));
  const degradedOptionalCapabilities = optional.filter((capability) => !available.has(capability));

  const resolved = {
    appId: manifest.appId,
    appVersion: manifest.appVersion,
    containerContractVersion: manifest.containerContractVersion,
    contentVersion: manifest.contentVersion,
    contentConfiguration: structuredClone(manifest.contentConfiguration ?? DEFAULTS.contentConfiguration),
    progressSchemaVersion: manifest.progressSchemaVersion,
    requiredCapabilities: [...(manifest.requiredCapabilities ?? DEFAULTS.requiredCapabilities)].sort(),
    optionalCapabilities: supportedOptional,
    extensionPoints: [...(manifest.extensionPoints ?? DEFAULTS.extensionPoints)].sort(),
    entryPoint: manifest.entryPoint
  };

  return deepFreeze({ ok: true, manifest: resolved, degradedOptionalCapabilities });
}

export { DEFAULTS as manifestDefaults };
