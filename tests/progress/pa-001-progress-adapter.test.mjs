import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { createAuthenticatedRequestContext, createProtectedApiClient } from '../../src/container/internal/api/authenticated-request-context.mjs';
import { createProgressAdapter, ProgressAdapterError } from '../../src/container/internal/progress/progress-adapter.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

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

function checkpointOperation(overrides = {}) {
  return {
    method: 'POST', path: '/v1/progress/checkpoint', authorityFields: ['learnerId', 'appId', 'releaseId', 'sessionId'], idempotent: true,
    parseResponse: (body) => (body && typeof body.acknowledged === 'boolean')
      ? { ok: true, data: { acknowledged: body.acknowledged, progressVersion: body.progressVersion, conflict: body.conflict === true, authoritativeProgressVersion: body.authoritativeProgressVersion } }
      : { ok: false },
    ...overrides,
  };
}

async function buildHarness({ transport, claims = baseClaims, operationOverrides = {} } = {}) {
  const binding = await boundRuntime(claims);
  const calls = [];
  const spiedTransport = async (req) => { calls.push(req); return transport(req); };
  const authContext = createAuthenticatedRequestContext({
    resolveToken: async () => ({ token: 'container-controlled-token', expiresAt: Date.now() + 60000 }),
    refreshToken: async () => ({ token: 'refreshed-token', expiresAt: Date.now() + 60000 }),
  });
  const apiClient = createBabystepsApiClient({
    baseUrl: 'https://staging.api.babysteps.com', contractVersion: '2024-01', transport: spiedTransport,
    authProvider: authContext.getToken, runtimeBinding: binding,
    operations: Object.freeze({ 'progress.checkpoint': checkpointOperation(operationOverrides) }),
  });
  const progressClient = createProtectedApiClient({ apiClient, authContext, runtimeBinding: binding });

  const sessionIdentity = getRuntimeContext(binding);
  const events = [];
  const adapter = createProgressAdapter({ sessionIdentity, progressClient, onTelemetry: (e) => events.push(e) });

  return { binding, sessionIdentity, adapter, calls, events };
}

function checkpointCalls(calls) { return calls.filter((c) => c.url.endsWith('/v1/progress/checkpoint')); }

test('PA-001-AC01 a meaningful learning checkpoint is submitted through the shared adapter using the bound runtime context', async () => {
  const { adapter, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { acknowledged: true, progressVersion: 'v1' } }),
  });
  const result = await adapter.checkpoint({ level: 3, streak: 5 });
  assert.equal(result.acknowledged, true);
  assert.equal(result.progressVersion, 'v1');
  const [call] = checkpointCalls(calls);
  assert.equal(call.body.appProgress.level, 3);
  assert.equal(call.body.learnerId, 'learner-1');
  assert.equal(call.body.sessionId, 'session-1');
});

test('PA-001-AC02 Magical Math and Chess use structurally different progress payloads through the same shared adapter', async () => {
  const math = await buildHarness({
    transport: async () => ({ status: 200, body: { acknowledged: true, progressVersion: 'm1' } }),
  });
  const chess = await buildHarness({
    claims: { ...baseClaims, appId: 'chess-master', sessionId: 'session-2' },
    transport: async () => ({ status: 200, body: { acknowledged: true, progressVersion: 'c1' } }),
  });

  const mathResult = await math.adapter.checkpoint({ questionsSolved: 12, mistakeRate: 0.1 });
  const chessResult = await chess.adapter.checkpoint({ opening: 'Sicilian', movesPlayed: 14, evaluation: -0.3 });

  assert.equal(mathResult.progressVersion, 'm1');
  assert.equal(chessResult.progressVersion, 'c1');
});

test('PA-001-AC03 app code cannot write progress directly to Babysteps/Supabase; only the shared adapter is permitted', () => {
  const directDb = inspectSource('apps/demo/rogue-progress.mjs', "import { createClient } from '@supabase/supabase-js';");
  assert.equal(directDb.some((v) => v.code === 'DIRECT_PLATFORM_DATA_ACCESS'), true);

  const privateImport = inspectSource(
    'apps/demo/rogue-progress-import.mjs',
    "import { createProgressAdapter } from '../../src/container/internal/progress/progress-adapter.mjs';"
  );
  assert.equal(privateImport.some((v) => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);
});

test('PA-001-AC04 learnerId, appId, releaseId and sessionId are derived from the bound runtime, never trusted from app-supplied values', async () => {
  const { adapter, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { acknowledged: true, progressVersion: 'v1' } }),
  });

  // A checkpoint call with no caller-supplied identity uses the bound runtime's identity.
  await adapter.checkpoint({ level: 1 });
  const [call] = checkpointCalls(calls);
  assert.equal(call.body.learnerId, 'learner-1');
  assert.equal(call.body.sessionId, 'session-1');

  // An attempt to substitute a different identity is rejected outright rather than trusted/merged.
  await assert.rejects(
    () => adapter.checkpoint({ level: 1 }, { learnerId: 'evil-learner', sessionId: 'evil-session' }),
    (e) => e instanceof ProgressAdapterError && e.code === 'PROGRESS_VALIDATION_FAILED'
  );
  assert.equal(checkpointCalls(calls).length, 1);
});

test('PA-001-AC05 a valid acknowledged checkpoint returns a typed durable acknowledgement with authoritative progress version', async () => {
  const { adapter } = await buildHarness({
    transport: async () => ({ status: 200, body: { acknowledged: true, progressVersion: 'v7' } }),
  });
  const result = await adapter.checkpoint({ level: 4 });
  assert.equal(result.acknowledged, true);
  assert.equal(result.progressVersion, 'v7');
  assert.equal(adapter.latestAcknowledged.progressVersion, 'v7');
});

test('PA-001-AC06 a rejected/failed checkpoint is never represented as durably persisted', async () => {
  const { adapter: rejectedAdapter } = await buildHarness({
    transport: async () => ({ status: 200, body: { acknowledged: false, progressVersion: null } }),
  });
  const rejected = await rejectedAdapter.checkpoint({ level: 1 });
  assert.equal(rejected.acknowledged, false);
  assert.equal(rejectedAdapter.latestAcknowledged, null);

  const { adapter: failedAdapter } = await buildHarness({
    transport: async () => ({ status: 500, body: {} }),
  });
  await assert.rejects(
    () => failedAdapter.checkpoint({ level: 1 }),
    (e) => e instanceof ProgressAdapterError && e.code === 'PROGRESS_SAVE_FAILED'
  );
  assert.equal(failedAdapter.latestAcknowledged, null);
});

test('PA-001-AC07 a malformed/invalid app progress payload fails safely and is never reported as saved', async () => {
  const { adapter, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { acknowledged: true, progressVersion: 'v1' } }),
  });
  await assert.rejects(() => adapter.checkpoint(null), (e) => e instanceof ProgressAdapterError && e.code === 'PROGRESS_VALIDATION_FAILED');
  await assert.rejects(() => adapter.checkpoint('not-an-object'), (e) => e.code === 'PROGRESS_VALIDATION_FAILED');
  assert.equal(checkpointCalls(calls).length, 0);
});

test('PA-001-AC08 retrying the same logical checkpoint does not create unintended duplicate authoritative progress advancement', async () => {
  let attempt = 0;
  const { adapter, calls } = await buildHarness({
    transport: async () => {
      attempt += 1;
      if (attempt === 1) return new Promise(() => {});
      return { status: 200, body: { acknowledged: true, progressVersion: 'v1' } };
    },
    operationOverrides: { retry: { maxAttempts: 3, retryableStatuses: [503], timeoutMs: 30 } },
  });
  const result = await adapter.checkpoint({ level: 1 });
  assert.equal(result.acknowledged, true);

  const attempts = checkpointCalls(calls);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].headers['Idempotency-Key'], attempts[1].headers['Idempotency-Key']);
});

test('PA-001-AC09 an authoritative progress conflict from Babysteps is preserved rather than silently overwritten locally', async () => {
  const { adapter } = await buildHarness({
    transport: async () => ({ status: 200, body: { acknowledged: false, conflict: true, authoritativeProgressVersion: 'v9' } }),
  });
  const result = await adapter.checkpoint({ level: 2 });
  assert.equal(result.acknowledged, false);
  assert.equal(result.conflict, true);
  assert.equal(result.authoritativeProgressVersion, 'v9');
  assert.equal(adapter.latestAcknowledged, null);
});

test('PA-001-AC10 only the last Babysteps-acknowledged progress/version is treated as durable', async () => {
  let call = 0;
  const { adapter } = await buildHarness({
    transport: async () => {
      call += 1;
      if (call === 1) return { status: 200, body: { acknowledged: true, progressVersion: 'v1' } };
      if (call === 2) return { status: 200, body: { acknowledged: true, progressVersion: 'v2' } };
      return { status: 500, body: {} };
    },
  });
  await adapter.checkpoint({ level: 1 });
  await adapter.checkpoint({ level: 2 });
  assert.equal(adapter.latestAcknowledged.progressVersion, 'v2');

  await assert.rejects(() => adapter.checkpoint({ level: 3 }));
  assert.equal(adapter.latestAcknowledged.progressVersion, 'v2');
});

test('PA-001-AC11 checkpoint telemetry contains only coarse technical metadata, not full learner progress payloads', async () => {
  const { adapter, events } = await buildHarness({
    transport: async () => ({ status: 200, body: { acknowledged: true, progressVersion: 'v1' } }),
  });
  await adapter.checkpoint({ level: 1, sensitiveNote: 'learner struggled with fractions today' });

  assert.ok(events.length >= 1);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'sessionId', 'correlationId', 'progressVersion', 'reason', 'conflict'].includes(k)));
    assert.equal(JSON.stringify(event).includes('sensitiveNote'), false);
    assert.equal(JSON.stringify(event).includes('fractions'), false);
  }
});
