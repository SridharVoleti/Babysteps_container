export class DataProjectionError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'DataProjectionError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new DataProjectionError(code, message, metadata); }

// SP-002: allowlisted learning-facing projection fields only. `learnerId`/`sessionId` are
// opaque runtime-scoping identifiers already exposed by the runtime/activity contract
// (see authorized-runtime-identity.mjs) - they are not contact/billing/admin PII.
export const LEARNER_PROJECTION_FIELDS = Object.freeze(['learnerId', 'displayName', 'ageBand', 'preferredLanguage']);
export const SESSION_PROJECTION_FIELDS = Object.freeze(['sessionId', 'appId', 'releaseId', 'correlationId', 'launchMode']);

const FORBIDDEN_FIELD_PATTERN = /email|phone|payment|billing|subscription|invoice|token|secret|password|admin|parent|address|creditcard|ssn|dateofbirth/i;

export function assertNoForbiddenFields(fieldNames, label = 'projection schema') {
  for (const field of fieldNames) {
    if (FORBIDDEN_FIELD_PATTERN.test(field)) {
      fail('FORBIDDEN_FIELD_EXPOSED', `${label} declares a forbidden sensitive field: ${field}`, { field });
    }
  }
  return true;
}

// Self-check: if a future edit ever adds a forbidden-looking field name to the allowlists
// above, importing this module fails immediately instead of silently shipping the leak.
assertNoForbiddenFields(LEARNER_PROJECTION_FIELDS, 'LEARNER_PROJECTION_FIELDS');
assertNoForbiddenFields(SESSION_PROJECTION_FIELDS, 'SESSION_PROJECTION_FIELDS');

function projectAllowlisted(raw, allowedFields, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('DATA_PROJECTION_VIOLATION', `${label} projection requires a raw platform object.`);
  }
  const projected = {};
  for (const field of allowedFields) {
    if (field in raw) projected[field] = raw[field];
  }
  return Object.freeze(projected);
}

const AGE_BANDS = Object.freeze([
  { max: 5, band: '3-5' },
  { max: 8, band: '6-8' },
  { max: 11, band: '9-11' },
  { max: 14, band: '12-14' },
]);

// Prefer a derived, less-identifying value (age band) over raw date-of-birth/profile data
// whenever the learning purpose is sufficiently served by the band alone.
export function deriveAgeBand(ageYears) {
  if (typeof ageYears !== 'number' || !Number.isFinite(ageYears) || ageYears < 0) return null;
  for (const { max, band } of AGE_BANDS) {
    if (ageYears <= max) return band;
  }
  return '15+';
}

export function projectLearnerContext(rawLearner) {
  const projected = projectAllowlisted(rawLearner, LEARNER_PROJECTION_FIELDS, 'Learner');
  if (!('ageBand' in projected) && typeof rawLearner?.ageYears === 'number') {
    return Object.freeze({ ...projected, ageBand: deriveAgeBand(rawLearner.ageYears) });
  }
  return projected;
}

export function projectSessionContext(rawSession) {
  return projectAllowlisted(rawSession, SESSION_PROJECTION_FIELDS, 'Session');
}

// SP-002: the only approved kinds of client-local persistence. Anything else is rejected so
// app-specific/unrelated platform data (parent/billing/contact) can never accumulate locally.
export const APPROVED_LOCAL_RECORD_KINDS = Object.freeze([
  'session-state',
  'progress-checkpoint',
  'content-version-binding',
  'pending-progress-recovery',
]);

// SP-002-P0: an approved record *kind* is not approval for an arbitrary payload. Each kind
// has its own minimal, explicit field allowlist - an unknown top-level field is rejected by
// default rather than silently persisted, and every field (including nested app-owned
// payloads such as a staged progress checkpoint) is still scanned for sensitive/prohibited
// field names before it may be written.
const LOCAL_RECORD_FIELD_SCHEMAS = Object.freeze({
  'session-state': Object.freeze(['lifecycleState', 'startedAt', 'pausedAt', 'resumedAt', 'endedAt', 'lastActiveAt', 'connectedMs']),
  'progress-checkpoint': Object.freeze(['activityId', 'checkpointId', 'status', 'sequence', 'progressVersion', 'acknowledged', 'savedAt']),
  'content-version-binding': Object.freeze(['appId', 'releaseId', 'sessionId', 'contentVersion', 'integrity']),
  'pending-progress-recovery': Object.freeze(['scope', 'learnerId', 'appId', 'releaseId', 'sessionId', 'appProgress', 'metadata', 'idempotencyKey', 'stagedAt']),
});

function containsForbiddenField(value, path = '') {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const current = path ? `${path}.${key}` : key;
    if (FORBIDDEN_FIELD_PATTERN.test(key)) return current;
    const nested = containsForbiddenField(child, current);
    if (nested) return nested;
  }
  return null;
}

function validateRecordValue(kind, value) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('LOCAL_STORAGE_POLICY_VIOLATION', `Local storage record value for "${kind}" must be a plain object.`, { kind });
  }
  const allowedFields = new Set(LOCAL_RECORD_FIELD_SCHEMAS[kind] ?? []);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      fail('LOCAL_STORAGE_POLICY_VIOLATION', `Local storage record for "${kind}" declares a field outside its approved schema: ${field}`, { kind, field });
    }
  }
  const forbiddenPath = containsForbiddenField(value);
  if (forbiddenPath) {
    fail('LOCAL_STORAGE_POLICY_VIOLATION', `Local storage record for "${kind}" contains a prohibited sensitive field: ${forbiddenPath}`, { kind, field: forbiddenPath });
  }
}

export function createApprovedLocalStore({ backingStore, onTelemetry = () => {} }) {
  if (!backingStore || typeof backingStore.setItem !== 'function' || typeof backingStore.getItem !== 'function') {
    fail('LOCAL_STORAGE_POLICY_VIOLATION', 'A backing storage adapter with setItem/getItem is required.');
  }

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({ event, ...extra }));
  }

  function namespacedKey(kind, sessionId, key) {
    return `${kind}::${sessionId}::${key}`;
  }

  function write(kind, sessionId, key, value) {
    if (!APPROVED_LOCAL_RECORD_KINDS.includes(kind)) {
      emit('local_storage_policy_violation', { kind });
      fail('LOCAL_STORAGE_POLICY_VIOLATION', `Local storage record kind is not approved: ${kind}`, { kind });
    }
    try {
      validateRecordValue(kind, value);
    } catch (error) {
      emit('local_storage_policy_violation', { kind });
      throw error;
    }
    backingStore.setItem(namespacedKey(kind, sessionId, key), value);
    return { written: true };
  }

  function read(kind, sessionId, key) {
    if (!APPROVED_LOCAL_RECORD_KINDS.includes(kind)) {
      emit('local_storage_policy_violation', { kind });
      fail('LOCAL_STORAGE_POLICY_VIOLATION', `Local storage record kind is not approved: ${kind}`, { kind });
    }
    return backingStore.getItem(namespacedKey(kind, sessionId, key)) ?? null;
  }

  function clearSessionScoped(sessionId) {
    if (typeof backingStore.keys !== 'function' || typeof backingStore.removeItem !== 'function') return { cleared: 0 };
    let cleared = 0;
    for (const storedKey of backingStore.keys()) {
      if (storedKey.includes(`::${sessionId}::`)) {
        backingStore.removeItem(storedKey);
        cleared += 1;
      }
    }
    emit('local_storage_session_cleared', { sessionId, cleared });
    return { cleared };
  }

  return Object.freeze({ write, read, clearSessionScoped });
}
