import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { createAuthenticatedRequestContext, createProtectedApiClient } from '../../src/container/internal/api/authenticated-request-context.mjs';
import { createProgressAdapter } from '../../src/container/internal/progress/progress-adapter.mjs';
import { createProgressRecoveryAdapter, PendingProgressError } from '../../src/container/internal/progress/pending-progress-recovery.mjs';

const baseClaims = Object.freeze({
  learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1'
});
const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
const envelope = (claims) => ({ claims: structuredClone(claims), proof: proof(claims) });
const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });

async function boundRuntime(claims = baseClaims) {
  const opts = {
    manifest: Object.freeze({ appId: claims.appId }),
    expectedReleaseId: claims.releaseId,
    expectedSessionId: claims.sessionId,
    verifier,
    now: () => new Date('2026-08-18T00:10:00.000Z'),
  };
  const runtimeContext = await validateLaunchContext({ launchContext: envelope(claims), ...opts });
  return bindAuthorizedRuntime(runtimeContext);
}

const operations = Object.freeze({
  'progress.checkpoint': {
    method: 'POST', path: '/v1/progress/checkpoint', authorityFields: ['learnerId', 'appId', 'releaseId', 'sessionId'], idempotent: true,
    parseResponse: (body) => (body && typeof body.acknowledged === 'boolean')
      ? { ok: true, data: { acknowledged: body.acknowledged, progressVersion: body.progressVersion, conflict: body.conflict === true } }
      : { ok: false },
  },
});

async function buildHarness({ transport, claims = baseClaims, storage } = {}) {
  const binding = await boundRuntime(claims);
  const calls = [];
  const spiedTransport = async (req) => { calls.push(req); return transport(req); };
  const authContext = createAuthenticatedRequestContext({
    resolveToken: async () => ({ token: 'container-controlled-token', expiresAt: Date.now() + 60000 }),
    refreshToken: async () => ({ token: 'refreshed-token', expiresAt: Date.now() + 60000 }),
  });
  const apiClient = createBabystepsApiClient({
    baseUrl: 'https://staging.api.babysteps.com', contractVersion: '2024-01', transport: spiedTransport,
    authProvider: authContext.getToken, runtimeBinding: binding, operations,
  });
  const progressClient = createProtectedApiClient({ apiClient, authContext, runtimeBinding: binding });

  const sessionIdentity = getRuntimeContext(binding);
  const progressAdapter = createProgressAdapter({ sessionIdentity, progressClient });
  const events = [];
  const recovery = createProgressRecoveryAdapter({
    runtimeBinding: binding,
    progressAdapter,
    ...(storage ? { storage } : {}),
    onTelemetry: (e) => events.push(e),
  });

  return { binding, sessionIdentity, progressAdapter, recovery, calls, events };
}

function checkpointCalls(calls) { return calls.filter((c) => c.url.endsWith('/v1/progress/checkpoint')); }

function sharedStorage() {
  let record = null;
  return Object.freeze({ write: (r) => { record = r; }, read: () => record, clear: () => { record = null; } });
}

test('PA-003-AC01 a transiently failed checkpoint may be retained as PENDING and is not reported as durably saved', async () => {
  const { recovery } = await buildHarness({ transport: async () => ({ status: 500, body: {} }) });
  const result = await recovery.checkpointWithRecovery({ level: 3 });
  assert.equal(result.acknowledged, false);
  assert.equal(result.pending, true);
  assert.ok(recovery.getPendingForBoundSession());
});

test('PA-003-AC02 a pending checkpoint is bound to the exact learner/app/release/session plus schema/content metadata', async () => {
  const { recovery, sessionIdentity } = await buildHarness({ transport: async () => ({ status: 500, body: {} }) });
  await recovery.checkpointWithRecovery({ level: 3 }, { schemaVersion: '2.0', contentVersion: 'v12' });
  const record = recovery.getPendingForBoundSession();
  assert.equal(record.learnerId, sessionIdentity.learnerId);
  assert.equal(record.appId, sessionIdentity.appId);
  assert.equal(record.releaseId, sessionIdentity.releaseId);
  assert.equal(record.sessionId, sessionIdentity.sessionId);
  assert.equal(record.metadata.schemaVersion, '2.0');
  assert.equal(record.metadata.contentVersion, 'v12');
});

test('PA-003-AC03 on authorized reconnect the pending checkpoint is retried only through the normal PA-001 handoff', async () => {
  let succeed = false;
  const { recovery, calls } = await buildHarness({
    transport: async () => succeed ? { status: 200, body: { acknowledged: true, progressVersion: 'v1' } } : { status: 500, body: {} },
  });
  await recovery.checkpointWithRecovery({ level: 3 });
  succeed = true;
  const outcome = await recovery.retryPending();
  assert.equal(outcome.retried, true);
  assert.equal(outcome.acknowledged, true);
  assert.equal(checkpointCalls(calls).length, 2);
});

test('PA-003-AC04 an acknowledged recovered checkpoint clears pending state and only the Babysteps acknowledgement becomes durable', async () => {
  let succeed = false;
  const { recovery, progressAdapter } = await buildHarness({
    transport: async () => succeed ? { status: 200, body: { acknowledged: true, progressVersion: 'v9' } } : { status: 500, body: {} },
  });
  await recovery.checkpointWithRecovery({ level: 3 });
  succeed = true;
  await recovery.retryPending();

  assert.equal(recovery.getPendingForBoundSession(), null);
  assert.equal(progressAdapter.latestAcknowledged.progressVersion, 'v9');
});

test('PA-003-AC05 a pending record for a different learner/app/release/session is never replayed into the current runtime', async () => {
  const storage = sharedStorage();
  const originalSession = await buildHarness({
    transport: async () => ({ status: 500, body: {} }),
    storage,
  });
  await originalSession.recovery.checkpointWithRecovery({ level: 3 });
  assert.ok(originalSession.recovery.getPendingForBoundSession());

  const differentSession = await buildHarness({
    claims: { ...baseClaims, sessionId: 'session-other' },
    transport: async () => ({ status: 200, body: { acknowledged: true, progressVersion: 'should-not-happen' } }),
    storage,
  });
  const outcome = await differentSession.recovery.retryPending();
  assert.equal(outcome.retried, false);
  assert.equal(checkpointCalls(differentSession.calls).length, 0);
  // The foreign-scope record is cleared, not left dangling or replayed later.
  assert.equal(originalSession.recovery.getPendingForBoundSession(), null);
});

test('PA-003-AC06 a progress-version conflict on retry is exposed safely and does not silently overwrite authoritative progress', async () => {
  let phase = 'fail';
  const { recovery } = await buildHarness({
    transport: async () => phase === 'fail'
      ? { status: 500, body: {} }
      : { status: 200, body: { acknowledged: false, conflict: true, progressVersion: null } },
  });
  await recovery.checkpointWithRecovery({ level: 3 });
  phase = 'conflict';
  const outcome = await recovery.retryPending();

  assert.equal(outcome.retried, true);
  assert.equal(outcome.acknowledged, false);
  assert.equal(outcome.conflict, true);
  assert.equal(recovery.getPendingForBoundSession(), null);
});

test('PA-003-AC07 pending progress from an expired/terminated/non-resumable session is not forced into a new session', async () => {
  const storage = sharedStorage();
  const endedSession = await buildHarness({
    transport: async () => ({ status: 500, body: {} }),
    storage,
    claims: { ...baseClaims, sessionId: 'session-ended' },
  });
  await endedSession.recovery.checkpointWithRecovery({ level: 3 });

  // Resume was denied; the app receives a brand new authorized session instead.
  const newSession = await buildHarness({
    claims: { ...baseClaims, sessionId: 'session-new' },
    transport: async () => ({ status: 200, body: { acknowledged: true, progressVersion: 'should-not-be-used' } }),
    storage,
  });
  const outcome = await newSession.recovery.retryPending();
  assert.equal(outcome.retried, false);
  assert.equal(checkpointCalls(newSession.calls).length, 0);
});

test('PA-003-AC08 repeated retries after intermittent failures preserve the original idempotency identity with no duplicate advancement', async () => {
  let call = 0;
  const { recovery, calls } = await buildHarness({
    transport: async () => {
      call += 1;
      if (call < 3) return { status: 500, body: {} };
      return { status: 200, body: { acknowledged: true, progressVersion: 'v1' } };
    },
  });
  await recovery.checkpointWithRecovery({ level: 3 });
  const firstRetry = await recovery.retryPending();
  assert.equal(firstRetry.retried, false);
  const secondRetry = await recovery.retryPending();
  assert.equal(secondRetry.retried, true);

  const attempts = checkpointCalls(calls);
  assert.equal(attempts.length, 3);
  const keys = new Set(attempts.map((a) => a.body.idempotencyKey));
  assert.equal(keys.size, 1);

  // The platform's actual transport idempotency identity (the Idempotency-Key HTTP header)
  // must be the same value on every attempt/retry, not a fresh UUID generated per call.
  const headerKeys = new Set(attempts.map((a) => a.headers['Idempotency-Key']));
  assert.equal(headerKeys.size, 1);
  assert.equal([...headerKeys][0], [...keys][0]);
});

test('PA-003-P0 the transport Idempotency-Key header carries the same logical checkpoint identity as the body key, and a new checkpoint gets a new identity', async () => {
  const { recovery, calls } = await buildHarness({ transport: async () => ({ status: 500, body: {} }) });
  await recovery.checkpointWithRecovery({ level: 3 });
  const first = checkpointCalls(calls)[0];
  assert.equal(first.headers['Idempotency-Key'], first.body.idempotencyKey);

  await recovery.checkpointWithRecovery({ level: 4 });
  const second = checkpointCalls(calls)[1];
  assert.notEqual(second.headers['Idempotency-Key'], first.headers['Idempotency-Key']);
  assert.equal(second.headers['Idempotency-Key'], second.body.idempotencyKey);
});

test('PA-003-AC09 a pending client storage failure surfaces a normalized recovery error and is never represented as durably saved', async () => {
  const failingStorage = Object.freeze({
    write: () => { throw new Error('quota exceeded'); },
    read: () => null,
    clear: () => {},
  });
  const { recovery } = await buildHarness({ transport: async () => ({ status: 500, body: {} }), storage: failingStorage });
  await assert.rejects(
    () => recovery.checkpointWithRecovery({ level: 3 }),
    (e) => e instanceof PendingProgressError && e.code === 'PENDING_PROGRESS_STORAGE_FAILED'
  );
});

test('PA-003-AC10 obsolete pending progress is cleared and not retained indefinitely', async () => {
  const { recovery } = await buildHarness({ transport: async () => ({ status: 500, body: {} }) });
  await recovery.checkpointWithRecovery({ level: 3 });
  assert.ok(recovery.getPendingForBoundSession());

  recovery.clearPending('SESSION_ENDED');
  assert.equal(recovery.getPendingForBoundSession(), null);
});

test('PA-003-AC11 pending-progress telemetry contains only coarse technical metadata, not full progress payloads', async () => {
  let succeed = false;
  const { recovery, events } = await buildHarness({
    transport: async () => succeed ? { status: 200, body: { acknowledged: true, progressVersion: 'v1' } } : { status: 500, body: {} },
  });
  await recovery.checkpointWithRecovery({ level: 3, note: 'struggled badly with fractions today' });
  succeed = true;
  await recovery.retryPending();

  assert.ok(events.length >= 2);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'sessionId', 'correlationId', 'reason', 'progressVersion'].includes(k)));
    assert.equal(JSON.stringify(event).includes('fractions'), false);
  }
});
