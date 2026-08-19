import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { createAuthenticatedRequestContext, createProtectedApiClient } from '../../src/container/internal/api/authenticated-request-context.mjs';
import { createSessionLifecycle } from '../../src/container/internal/session/session-lifecycle.mjs';
import { createSessionCompletion, createFinalizationAdapter } from '../../src/container/internal/session/session-completion.mjs';
import { createActivityLifecycleManager, ActivityLifecycleError } from '../../src/container/internal/activities/activity-lifecycle-manager.mjs';

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

async function buildCompletionHarness({ transport, claims = baseClaims } = {}) {
  const binding = await boundRuntime(claims);
  const calls = [];
  const spiedTransport = async (req) => { calls.push(req); return transport(req); };
  const operations = Object.freeze({
    'progress.save': {
      method: 'POST', path: '/v1/progress', authorityFields: ['learnerId', 'sessionId'],
      parseResponse: (body) => (body && typeof body.saved === 'boolean') ? { ok: true, data: { saved: body.saved } } : { ok: false },
    },
    'session.finalize': {
      method: 'POST', path: '/v1/session/finalize', authorityFields: ['learnerId', 'sessionId'], idempotent: true,
      parseResponse: (body) => (body && typeof body.finalStatus === 'string') ? { ok: true, data: { finalStatus: body.finalStatus } } : { ok: false },
    },
  });
  const authContext = createAuthenticatedRequestContext({
    resolveToken: async () => ({ token: 'container-controlled-token', expiresAt: Date.now() + 60000 }),
    refreshToken: async () => ({ token: 'refreshed-token', expiresAt: Date.now() + 60000 }),
  });
  const apiClient = createBabystepsApiClient({
    baseUrl: 'https://staging.api.babysteps.com', contractVersion: '2024-01', transport: spiedTransport,
    authProvider: authContext.getToken, runtimeBinding: binding, operations,
  });
  const protectedClient = createProtectedApiClient({ apiClient, authContext, runtimeBinding: binding });

  const finalizationAdapter = createFinalizationAdapter({ progressClient: protectedClient, finalizationClient: protectedClient });
  const lifecycle = createSessionLifecycle({ sessionIdentity: getRuntimeContext(binding), sessionAdapter: finalizationAdapter });
  const completion = createSessionCompletion({ sessionIdentity: getRuntimeContext(binding), lifecycle });

  return { binding, lifecycle, completion, calls };
}

test('AH-002-AC01 a valid logical activity is created and activated as the exactly-one active instance', async () => {
  const binding = await boundRuntime();
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  const activity = Object.freeze({ activityId: 'math-activity', create: () => ({ kind: 'math' }) });

  const handle = manager.activate(activity);
  assert.equal(manager.state, 'ACTIVE');
  assert.equal(manager.current, handle);
  await handle.context.events.ready();
});

test('AH-002-AC02 transitioning from Activity A to Activity B deactivates/disposes A and releases its resources before B becomes active', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-2' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  const order = [];
  const activityA = Object.freeze({
    activityId: 'activity-a',
    create: (context) => {
      context.resources.register(() => order.push('A-resource-released'));
      return Object.freeze({ dispose: () => order.push('A-disposed') });
    },
  });
  const activityB = Object.freeze({ activityId: 'activity-b', create: () => { order.push('B-created'); } });

  manager.activate(activityA);
  manager.activate(activityB);

  assert.deepEqual(order, ['A-resource-released', 'A-disposed', 'B-created']);
  assert.equal(manager.current.activityId, 'activity-b');
});

test('AH-002-AC03 a disposed activity firing a delayed callback cannot modify progress, session lifecycle, or platform state', async () => {
  const { binding, lifecycle, completion } = await buildCompletionHarness({
    transport: async () => ({ status: 200, body: { finalStatus: 'completed' } }),
  });
  await lifecycle.signal('activity-ready');
  const manager = createActivityLifecycleManager({ runtimeBinding: binding, lifecycle, completion });

  const handleA = manager.activate(Object.freeze({ activityId: 'activity-a', create: () => {} }));
  const staleCompleted = handleA.context.events.completed;

  manager.activate(Object.freeze({ activityId: 'activity-b', create: () => {} }));

  await assert.rejects(
    () => staleCompleted({ finalScore: 99 }),
    (e) => e instanceof ActivityLifecycleError && e.code === 'ACTIVITY_ALREADY_DISPOSED'
  );
  assert.equal(lifecycle.state, 'ACTIVE');
});

test('AH-002-AC04 host-managed timers/listeners/subscriptions registered by an activity are released on disposal', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-4' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  let timerCleared = false;
  let listenerRemoved = false;
  const activity = Object.freeze({
    activityId: 'resourceful-activity',
    create: (context) => {
      context.resources.register(() => { timerCleared = true; });
      context.resources.register(() => { listenerRemoved = true; });
    },
  });

  manager.activate(activity);
  manager.deactivateCurrent('MANUAL');

  assert.equal(timerCleared, true);
  assert.equal(listenerRemoved, true);
});

test('AH-002-AC05 disposing the same activity instance more than once is safe and does not duplicate side effects or reactivate it', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-5' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  let disposeCalls = 0;
  manager.activate(Object.freeze({ activityId: 'activity-a', create: () => Object.freeze({ dispose: () => { disposeCalls += 1; } }) }));

  manager.deactivateCurrent('FIRST');
  manager.deactivateCurrent('SECOND');
  manager.deactivateCurrent('THIRD');

  assert.equal(disposeCalls, 1);
  assert.equal(manager.state, 'DISPOSED');
});

test('AH-002-AC06 rerendering/remounting the same logical activity does not create a duplicate instance, listener set, or events', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-6' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  let createCalls = 0;
  const activity = Object.freeze({ activityId: 'rerender-activity', create: () => { createCalls += 1; return { instance: createCalls }; } });

  const first = manager.activate(activity);
  const second = manager.activate(activity);
  const third = manager.activate(activity);

  assert.equal(createCalls, 1);
  assert.equal(first, second);
  assert.equal(second, third);
});

test('AH-002-AC07 only the currently active instance\'s event is accepted when two logical instances attempt to emit at the same time', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-7' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  const handleA = manager.activate(Object.freeze({ activityId: 'activity-a', create: () => {} }), {});
  const staleProgress = handleA.context.events.meaningfulProgress;

  const handleB = manager.activate(Object.freeze({ activityId: 'activity-b', create: () => {} }));
  const activeProgress = handleB.context.events.meaningfulProgress;

  const [staleResult, activeResult] = await Promise.allSettled([
    staleProgress({ step: 1 }),
    activeProgress({ step: 1 }),
  ]);

  assert.equal(staleResult.status, 'rejected');
  assert.equal(staleResult.reason.code, 'ACTIVITY_ALREADY_DISPOSED');
  assert.equal(activeResult.status, 'fulfilled');
});

test('AH-002-AC08 the active activity is deactivated/disposed when the session ends and cannot emit post-session actionable events', async () => {
  const { binding, lifecycle, completion } = await buildCompletionHarness({
    transport: async () => ({ status: 200, body: { finalStatus: 'completed' } }),
  });
  await lifecycle.signal('activity-ready');
  const manager = createActivityLifecycleManager({ runtimeBinding: binding, lifecycle, completion });
  const handle = manager.activate(Object.freeze({ activityId: 'activity-a', create: () => {} }));

  manager.endSession('SESSION_ENDED');
  assert.equal(manager.current, null);

  await assert.rejects(
    () => handle.context.events.completed({ finalScore: 1 }),
    (e) => e instanceof ActivityLifecycleError && e.code === 'ACTIVITY_ALREADY_DISPOSED'
  );
});

test('AH-002-AC09 a failing activity cleanup hook is normalized/contained and does not let the disposed activity regain authority', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-9' });
  const events = [];
  const manager = createActivityLifecycleManager({ runtimeBinding: binding, onTelemetry: (e) => events.push(e) });
  const handle = manager.activate(Object.freeze({
    activityId: 'flaky-activity',
    create: (context) => {
      context.resources.register(() => { throw new Error('resource cleanup boom'); });
      return Object.freeze({ dispose: () => { throw new Error('dispose boom'); } });
    },
  }));

  assert.doesNotThrow(() => manager.deactivateCurrent('CLEANUP_TEST'));
  assert.equal(manager.state, 'DISPOSED');
  assert.equal(events.some((e) => e.event === 'activity_resource_cleanup_failed'), true);

  await assert.rejects(() => handle.context.events.ready(), (e) => e.code === 'ACTIVITY_ALREADY_DISPOSED');

  const next = manager.activate(Object.freeze({ activityId: 'next-activity', create: () => ({ ok: true }) }));
  assert.equal(next.activityId, 'next-activity');
});

test('AH-002-AC10 the host manages a many-component Chess activity and a single-input Math activity as one logical lifecycle each, without prescribing internal structure', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-10' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  const releasedResources = [];
  const chessActivity = Object.freeze({
    activityId: 'chess-activity',
    create: (context) => {
      for (const name of ['board', 'clock', 'moveHistory', 'captureTray', 'animationLoop']) {
        context.resources.register(() => releasedResources.push(name));
      }
      return Object.freeze({ kind: 'chess' });
    },
  });
  const mathActivity = Object.freeze({ activityId: 'math-activity', create: () => Object.freeze({ kind: 'math' }) });

  manager.activate(chessActivity);
  manager.deactivateCurrent('SWITCH');
  manager.activate(mathActivity);

  assert.deepEqual(releasedResources.sort(), ['animationLoop', 'board', 'captureTray', 'clock', 'moveHistory']);
  assert.equal(manager.current.activityId, 'math-activity');
});

test('AH-002-AC11 only coarse activity-lifecycle technical telemetry is emitted; detailed learner interactions are not captured', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-11' });
  const events = [];
  const manager = createActivityLifecycleManager({ runtimeBinding: binding, onTelemetry: (e) => events.push(e) });
  const handleA = manager.activate(Object.freeze({ activityId: 'activity-a', create: () => {} }));
  await handleA.context.events.ready().catch(() => {});
  const staleReady = handleA.context.events.ready;
  manager.activate(Object.freeze({ activityId: 'activity-b', create: () => {} }));
  await staleReady().catch(() => {});

  assert.ok(events.length >= 3);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'appId', 'activityId', 'generation', 'correlationId', 'reason', 'callSite', 'failureCount', 'failureCode'].includes(k)));
  }
});

test('AH-002 invalid lifecycle input is rejected', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-12' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  assert.throws(() => manager.activate(null), (e) => e instanceof ActivityLifecycleError && e.code === 'ACTIVITY_LIFECYCLE_INVALID');
  assert.throws(() => manager.activate({ activityId: 'no-create' }), (e) => e.code === 'ACTIVITY_LIFECYCLE_INVALID');
});
