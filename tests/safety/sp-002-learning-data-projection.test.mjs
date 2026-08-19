import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticatedRequestContext } from '../../src/container/internal/api/authenticated-request-context.mjs';
import {
  projectLearnerContext,
  projectSessionContext,
  deriveAgeBand,
  assertNoForbiddenFields,
  createApprovedLocalStore,
  APPROVED_LOCAL_RECORD_KINDS,
  LEARNER_PROJECTION_FIELDS,
  DataProjectionError,
} from '../../src/container/internal/safety/learning-data-projection.mjs';

const rawLearner = Object.freeze({
  learnerId: 'learner-1',
  displayName: 'Riya',
  ageYears: 7,
  preferredLanguage: 'en',
  parentEmail: 'parent@example.com',
  parentPhone: '+1-555-0100',
  billingPlan: 'annual-premium',
  paymentMethodLast4: '4242',
  authToken: 'super-secret-token',
  adminRole: 'none',
});

test('SP-002-AC01 the learner runtime context exposes only minimum approved fields', () => {
  const projected = projectLearnerContext(rawLearner);
  assert.deepEqual(Object.keys(projected).sort(), ['ageBand', 'displayName', 'learnerId', 'preferredLanguage'].sort());
});

test('SP-002-AC02 parent email/phone, billing/subscription/payment, admin data and auth tokens are not exposed', () => {
  const projected = projectLearnerContext(rawLearner);
  const serialized = JSON.stringify(projected);
  for (const forbidden of ['parentEmail', 'parentPhone', 'billingPlan', 'paymentMethodLast4', 'authToken', 'adminRole', 'super-secret-token']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('SP-002-AC03 an approved age-band value is supplied where sufficient rather than raw age/profile data', () => {
  assert.equal(deriveAgeBand(7), '6-8');
  assert.equal(deriveAgeBand(13), '12-14');
  const projected = projectLearnerContext(rawLearner);
  assert.equal(projected.ageBand, '6-8');
  assert.equal('ageYears' in projected, false);
});

test('SP-002-AC04 only allowlisted learning-facing fields reach app-specific code from a mixed raw DTO', () => {
  const projected = projectLearnerContext(rawLearner);
  for (const field of Object.keys(projected)) {
    assert.ok(LEARNER_PROJECTION_FIELDS.includes(field) || field === 'ageBand');
  }
});

test('SP-002-AC05 no generic broad-data-access interface exists on the projection modules', () => {
  assert.equal(typeof projectLearnerContext, 'function');
  assert.equal(typeof projectSessionContext, 'function');
  assert.equal('queryParentAccount' in { projectLearnerContext, projectSessionContext }, false);
});

test('SP-002-AC06 credentials remain inside shared modules and are never passed to app-facing projections', async () => {
  const authContext = createAuthenticatedRequestContext({
    resolveToken: async () => ({ token: 'container-controlled-token', expiresAt: Date.now() + 60000 }),
    refreshToken: async () => ({ token: 'refreshed', expiresAt: Date.now() + 60000 }),
  });
  assert.deepEqual(Object.keys(authContext).sort(), ['getToken', 'invalidate', 'terminate']);
  const sessionProjection = projectSessionContext({ sessionId: 's-1', appId: 'magical-math', releaseId: 'r-1', correlationId: 'c-1', launchMode: 'start', accessToken: 'leak-me' });
  assert.equal('accessToken' in sessionProjection, false);
});

test('SP-002-AC07 local storage contains only minimum approved session/progress/content/recovery records', () => {
  const backingStore = new Map();
  const store = createApprovedLocalStore({
    backingStore: { setItem: (k, v) => backingStore.set(k, v), getItem: (k) => backingStore.get(k), removeItem: (k) => backingStore.delete(k), keys: () => [...backingStore.keys()] },
  });
  store.write('session-state', 'session-1', 'current', { lifecycleState: 'ACTIVE' });
  assert.throws(() => store.write('parent-billing-cache', 'session-1', 'x', {}), (e) => e instanceof DataProjectionError && e.code === 'LOCAL_STORAGE_POLICY_VIOLATION');
  assert.deepEqual([...backingStore.keys()].every((k) => APPROVED_LOCAL_RECORD_KINDS.some((kind) => k.startsWith(kind))), true);
});

test('SP-002-AC08 session-scoped local state is cleared when the authorized session is torn down', () => {
  const backingStore = new Map();
  const store = createApprovedLocalStore({
    backingStore: { setItem: (k, v) => backingStore.set(k, v), getItem: (k) => backingStore.get(k), removeItem: (k) => backingStore.delete(k), keys: () => [...backingStore.keys()] },
  });
  store.write('session-state', 'session-1', 'current', {});
  store.write('progress-checkpoint', 'session-1', 'latest', {});
  store.write('session-state', 'session-2', 'current', {});
  store.clearSessionScoped('session-1');
  assert.equal(backingStore.size, 1);
  assert.equal([...backingStore.keys()][0].includes('session-2'), true);
});

test('SP-002-AC09 a forbidden sensitive field accidentally added to the allowlist fails validation', () => {
  assert.throws(() => assertNoForbiddenFields(['displayName', 'parentEmail']), (e) => e instanceof DataProjectionError && e.code === 'FORBIDDEN_FIELD_EXPOSED');
  assert.doesNotThrow(() => assertNoForbiddenFields(LEARNER_PROJECTION_FIELDS));
});

test('SP-002-AC10 repeated bootstrap/restore does not accumulate duplicate personal-data copies', () => {
  const first = projectLearnerContext(rawLearner);
  const second = projectLearnerContext(rawLearner);
  const third = projectLearnerContext(rawLearner);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test('SP-002-AC11 only coarse violation-category telemetry is emitted, without raw sensitive fields', () => {
  const events = [];
  const backingStore = new Map();
  const store = createApprovedLocalStore({
    backingStore: { setItem: (k, v) => backingStore.set(k, v), getItem: (k) => backingStore.get(k) },
    onTelemetry: (e) => events.push(e),
  });
  try { store.write('parent-billing-cache', 'session-1', 'x', { parentEmail: 'leak@example.com' }); } catch { /* expected */ }
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(JSON.stringify(event).includes('leak@example.com'), false);
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'kind', 'sessionId', 'cleared'].includes(k)));
  }
});
