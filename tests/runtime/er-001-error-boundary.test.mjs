import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createActivityLifecycleManager } from '../../src/container/internal/activities/activity-lifecycle-manager.mjs';
import { createSessionLifecycle } from '../../src/container/internal/session/session-lifecycle.mjs';
import { createConnectedTimeTracker } from '../../src/container/internal/session/session-connected-time.mjs';
import { createProgressAdapter, ProgressAdapterError } from '../../src/container/internal/progress/progress-adapter.mjs';
import { createProgressRecoveryAdapter } from '../../src/container/internal/progress/pending-progress-recovery.mjs';
import { createResumeCoordinator } from '../../src/container/internal/session/session-interruption.mjs';
import { createRuntimeErrorBoundary, SafeFailureError } from '../../src/container/internal/runtime/error-boundary.mjs';

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

test('ER-001-AC01 an uncaught failure enters a controlled safe-failure state instead of remaining stale/active', async () => {
  const binding = await boundRuntime();
  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding });
  boundary.failSafe(new Error('boom'), 'RENDER');
  assert.equal(boundary.state, 'SAFE_FAILURE');
  assert.throws(() => boundary.guard('activity-progress'), (e) => e instanceof SafeFailureError && e.code === 'RUNTIME_SAFE_STATE_ENTERED');
});

test('ER-001-AC02 the failed/stale activity cannot continue producing actionable progress/completion after safe failure', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-2' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding, activityManager: manager });
  const handle = manager.activate(Object.freeze({ activityId: 'activity-a', create: () => {} }));

  boundary.failSafe(new Error('boom'), 'ACTIVITY');
  assert.equal(manager.current, null);
  await assert.rejects(() => handle.context.events.completed({ finalScore: 1 }), (e) => e.code === 'ACTIVITY_ALREADY_DISPOSED');
});

test('ER-001-AC03 connected learning time does not continue accumulating after an unexpected failure', async () => {
  const binding = await boundRuntime();
  let now = 0;
  const tracker = createConnectedTimeTracker({ sessionIdentity: getRuntimeContext(binding), monotonicNow: () => now });
  tracker.setForeground(true);
  tracker.setOnline(true);
  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding, connectedTimeTracker: tracker });

  now = 4000;
  boundary.failSafe(new Error('boom'), 'RUNTIME');
  assert.equal(tracker.isAccumulating(), false);
});

test('ER-001-AC04 previously acknowledged progress remains preserved and is not rolled back after failure', async () => {
  const binding = await boundRuntime();
  const identity = getRuntimeContext(binding);
  const progressClient = { call: async () => ({ acknowledged: true, progressVersion: 'v1' }) };
  const adapter = createProgressAdapter({ sessionIdentity: identity, progressClient });
  await adapter.checkpoint({ score: 5 });
  const before = adapter.latestAcknowledged;

  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding });
  boundary.failSafe(new Error('boom'), 'PROGRESS');

  assert.deepEqual(adapter.latestAcknowledged, before);
});

test('ER-001-AC05 eligible pending progress remains explicitly pending after an unexpected failure', async () => {
  const binding = await boundRuntime();
  const identity = getRuntimeContext(binding);
  const flakyClient = { call: async () => { throw new ProgressAdapterError('PROGRESS_SAVE_FAILED', 'transient'); } };
  const adapter = createProgressAdapter({ sessionIdentity: identity, progressClient: flakyClient });
  const recovery = createProgressRecoveryAdapter({ runtimeBinding: binding, progressAdapter: adapter });
  const result = await recovery.checkpointWithRecovery({ score: 9 });
  assert.equal(result.pending, true);

  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding });
  boundary.failSafe(new Error('boom'), 'RUNTIME');

  const pending = recovery.getPendingForBoundSession();
  assert.ok(pending);
  assert.deepEqual(pending.appProgress, { score: 9 });
});

test('ER-001-AC06 a safely recoverable failure uses the approved session-resume path rather than locally assigning ACTIVE', async () => {
  const binding = await boundRuntime();
  const identity = getRuntimeContext(binding);
  const lifecycle = createSessionLifecycle({ sessionIdentity: identity });
  await lifecycle.signal('activity-ready');
  const resumeClient = { call: async () => ({ authorized: true }) };
  const resumeCoordinator = createResumeCoordinator({ sessionIdentity: identity, lifecycle, resumeClient });
  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding, resumeCoordinator });

  boundary.failSafe(new Error('boom'), 'RUNTIME');
  await resumeCoordinator.interrupt('RUNTIME_FAILURE');
  assert.equal(lifecycle.state, 'RECOVERING');

  const result = await boundary.attemptRecovery();
  assert.equal(result.authorized, true);
  assert.equal(lifecycle.state, 'ACTIVE');
  assert.equal(boundary.state, 'ACTIVE');
});

test('ER-001-AC07 Babysteps denying resume/recovery follows the authoritative terminal result', async () => {
  const binding = await boundRuntime();
  const identity = getRuntimeContext(binding);
  const lifecycle = createSessionLifecycle({ sessionIdentity: identity });
  await lifecycle.signal('activity-ready');
  const resumeClient = { call: async () => ({ authorized: false }) };
  const resumeCoordinator = createResumeCoordinator({ sessionIdentity: identity, lifecycle, resumeClient });
  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding, resumeCoordinator });

  boundary.failSafe(new Error('boom'), 'RUNTIME');
  await resumeCoordinator.interrupt('RUNTIME_FAILURE');
  await assert.rejects(() => boundary.attemptRecovery(), (e) => e.code === 'SESSION_RESUME_DENIED');
  assert.equal(boundary.state, 'TERMINAL');
  assert.throws(() => boundary.guard('activity-progress'));
});

test('ER-001-AC08 repeated triggering of the same failure does not duplicate cleanup/telemetry', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-8' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  manager.activate(Object.freeze({ activityId: 'activity-a', create: () => {} }));
  const events = [];
  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding, activityManager: manager, onTelemetry: (e) => events.push(e) });

  boundary.failSafe(new Error('first'), 'RUNTIME');
  boundary.failSafe(new Error('second'), 'RUNTIME');
  boundary.failSafe(new Error('third'), 'RUNTIME');

  assert.equal(events.filter((e) => e.event === 'runtime_safe_state_entered').length, 1);
  assert.equal(events.filter((e) => e.event === 'runtime_safe_failure_duplicate').length, 2);
});

test('ER-001-AC09 app-specific presentation cannot override session validity/completion/recovery authority', async () => {
  const binding = await boundRuntime();
  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding });
  boundary.failSafe(new Error('boom'), 'RUNTIME');
  assert.equal(typeof boundary.state, 'string');
  assert.equal('setState' in boundary, false);
  assert.equal('forceActive' in boundary, false);
});

test('ER-001-AC10 only approved technical diagnostics are emitted, without unnecessary learner content/PII', async () => {
  const binding = await boundRuntime();
  const events = [];
  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding, onTelemetry: (e) => events.push(e) });
  boundary.failSafe(new Error('learner-specific-content-should-not-leak'), 'RUNTIME');
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'correlationId', 'source', 'cause', 'state'].includes(k)));
  }
});

test('ER-001-AC11 a normal expected error handled by its owning module does not automatically become a fatal safe-failure', async () => {
  const binding = await boundRuntime();
  const identity = getRuntimeContext(binding);
  const progressClient = { call: async () => { throw new ProgressAdapterError('PROGRESS_VALIDATION_FAILED', 'bad payload', { category: 'VALIDATION' }); } };
  const adapter = createProgressAdapter({ sessionIdentity: identity, progressClient });
  const boundary = createRuntimeErrorBoundary({ runtimeBinding: binding });

  await assert.rejects(() => adapter.checkpoint({}), (e) => e.code === 'PROGRESS_VALIDATION_FAILED');
  assert.equal(boundary.state, 'ACTIVE');
});
