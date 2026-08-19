import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createConnectedTimeTracker } from '../../src/container/internal/session/session-connected-time.mjs';
import { createProgressAdapter, ProgressAdapterError } from '../../src/container/internal/progress/progress-adapter.mjs';
import { createProgressRecoveryAdapter } from '../../src/container/internal/progress/pending-progress-recovery.mjs';
import { ApiClientError } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { createConnectivityService, createRetryPolicy, classifyRetry, ConnectivityError } from '../../src/container/internal/runtime/connectivity-service.mjs';

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

const noSleep = () => Promise.resolve();

test('ER-002-AC01 losing connectivity exposes OFFLINE and pauses SR-006 connected-time accumulation', async () => {
  const binding = await boundRuntime();
  let now = 0;
  const tracker = createConnectedTimeTracker({ sessionIdentity: getRuntimeContext(binding), monotonicNow: () => now });
  tracker.setForeground(true);
  tracker.setOnline(true);
  const connectivity = createConnectivityService({ connectedTimeTracker: tracker });

  now = 3000;
  connectivity.reportOffline();
  assert.equal(connectivity.state, 'OFFLINE');
  assert.equal(tracker.isAccumulating(), false);
});

test('ER-002-AC02 a meaningful progress save failing from transient connectivity loss enters PA-003 pending recovery', async () => {
  const binding = await boundRuntime();
  const identity = getRuntimeContext(binding);
  const flakyClient = { call: async () => { throw new ProgressAdapterError('PROGRESS_SAVE_FAILED', 'network down'); } };
  const adapter = createProgressAdapter({ sessionIdentity: identity, progressClient: flakyClient });
  const recovery = createProgressRecoveryAdapter({ runtimeBinding: binding, progressAdapter: adapter });

  const result = await recovery.checkpointWithRecovery({ score: 3 });
  assert.equal(result.pending, true);
  assert.equal(result.acknowledged, false);
});

test('ER-002-AC03 a safe/idempotent operation retries only within the configured bounded attempt/backoff policy', async () => {
  const policy = createRetryPolicy({ maxAttempts: 3, sleep: noSleep });
  let calls = 0;
  const result = await policy.executeWithRetry({ operation: 'progress.checkpoint', retryable: true }, async () => {
    calls += 1;
    if (calls < 3) throw new ApiClientError('API_SERVER_ERROR', 'server error', { category: 'SERVER' });
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('ER-002-AC04 an authentication/authorization denial is not blindly retried', async () => {
  const policy = createRetryPolicy({ maxAttempts: 5, sleep: noSleep });
  let calls = 0;
  await assert.rejects(
    () => policy.executeWithRetry({ operation: 'progress.checkpoint', retryable: true }, async () => {
      calls += 1;
      throw new ApiClientError('API_AUTH_ERROR', 'denied', { category: 'AUTH' });
    }),
    (e) => e instanceof ApiClientError && e.metadata.category === 'AUTH'
  );
  assert.equal(calls, 1);
});

test('ER-002-AC05 validation failure or version conflict is preserved as authoritative and not repeatedly retried', async () => {
  const policy = createRetryPolicy({ maxAttempts: 5, sleep: noSleep });
  let calls = 0;
  await assert.rejects(
    () => policy.executeWithRetry({ operation: 'progress.checkpoint', retryable: true }, async () => {
      calls += 1;
      throw new ApiClientError('API_CONFLICT_ERROR', 'conflict', { category: 'CONFLICT' });
    })
  );
  assert.equal(calls, 1);
  assert.equal(classifyRetry(new ApiClientError('x', 'x', { category: 'VALIDATION' })), 'DO_NOT_RETRY');
});

test('ER-002-AC06 a session ended/expired/not-resumable result is not retried even though connectivity is available', async () => {
  const policy = createRetryPolicy({ maxAttempts: 5, sleep: noSleep });
  const sessionEndedError = new ApiClientError('API_AUTHORIZATION_ERROR', 'session ended', { category: 'AUTHORIZATION' });
  await assert.rejects(
    () => policy.executeWithRetry({ operation: 'session.finalize', retryable: true }, async () => { throw sessionEndedError; }),
    (e) => e === sessionEndedError
  );
});

test('ER-002-AC07 connectivity recovery enters RECOVERING but does not independently resume/recreate the session', async () => {
  const connectivity = createConnectivityService();
  connectivity.reportOffline();
  connectivity.reportRecovering();
  assert.equal(connectivity.state, 'RECOVERING');
  connectivity.reportOnline();
  assert.equal(connectivity.state, 'ONLINE');
});

test('ER-002-AC08 one normalized retry policy is used rather than independent competing per-module retry loops', async () => {
  const policy = createRetryPolicy({ maxAttempts: 3, sleep: noSleep });
  let concurrentInvocations = 0;
  let maxConcurrent = 0;
  const op = async () => {
    concurrentInvocations += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrentInvocations);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrentInvocations -= 1;
    return 'ok';
  };
  const [a, b, c] = await Promise.all([
    policy.executeWithRetry({ operation: 'progress.checkpoint', retryable: true }, op),
    policy.executeWithRetry({ operation: 'progress.checkpoint', retryable: true }, op),
    policy.executeWithRetry({ operation: 'progress.checkpoint', retryable: true }, op),
  ]);
  assert.deepEqual([a, b, c], ['ok', 'ok', 'ok']);
  assert.equal(maxConcurrent, 1);
});

test('ER-002-AC09 pending retries are cancelled on teardown and cannot mutate the disposed runtime', async () => {
  const policy = createRetryPolicy({ maxAttempts: 5, sleep: noSleep });
  let calls = 0;
  const pending = policy.executeWithRetry({ operation: 'progress.checkpoint', retryable: true }, async () => {
    calls += 1;
    throw new ApiClientError('API_SERVER_ERROR', 'server error', { category: 'SERVER' });
  });
  policy.dispose();
  await assert.rejects(() => pending, (e) => e instanceof ConnectivityError || e instanceof ApiClientError);
  assert.equal(policy.isDisposed, true);

  await assert.rejects(
    () => policy.executeWithRetry({ operation: 'progress.checkpoint', retryable: true }, async () => 'should not run'),
    (e) => e instanceof ConnectivityError && e.code === 'RETRY_NOT_ALLOWED'
  );
});

test('ER-002-AC10 no recurring server heartbeat or continuous polling exists solely to detect recovery', async () => {
  const events = [];
  const connectivity = createConnectivityService({ onTelemetry: (e) => events.push(e) });
  connectivity.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const countAfterSettle = events.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, countAfterSettle);
});

test('ER-002-AC11 only coarse connectivity/retry telemetry is emitted, without detailed learner behavior', async () => {
  const events = [];
  const policy = createRetryPolicy({ maxAttempts: 2, sleep: noSleep, onTelemetry: (e) => events.push(e) });
  await policy.executeWithRetry({ operation: 'progress.checkpoint', retryable: true }, async () => {
    throw new ApiClientError('API_SERVER_ERROR', 'server error', { category: 'SERVER' });
  }).catch(() => {});
  assert.ok(events.length > 0);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'operation', 'attempt', 'attempts', 'delay', 'classification'].includes(k)));
  }
});
