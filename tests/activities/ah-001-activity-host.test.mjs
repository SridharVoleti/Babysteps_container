import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { createAuthenticatedRequestContext, createProtectedApiClient } from '../../src/container/internal/api/authenticated-request-context.mjs';
import { createSessionLifecycle } from '../../src/container/internal/session/session-lifecycle.mjs';
import { createSessionCompletion, createFinalizationAdapter } from '../../src/container/internal/session/session-completion.mjs';
import { mountActivity, ActivityContractError } from '../../src/container/internal/activities/activity-host.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

const manifest = Object.freeze({ appId: 'magical-math' });
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

const mathActivity = Object.freeze({
  activityId: 'magical-math-activity',
  requiredServices: ['progressStore'],
  create: (context) => {
    context.events.ready();
    return Object.freeze({ kind: 'math', solve: (a, b) => a + b });
  },
});

const chessActivity = Object.freeze({
  activityId: 'chess-master-activity',
  requiredServices: [],
  create: () => {
    let board = 'initial-position';
    return Object.freeze({ kind: 'chess', movePiece: (move) => { board = move; return board; } });
  },
});

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

test('AH-001-AC01 a valid app-specific activity receives the standard ActivityContext and approved shared services', async () => {
  const binding = await boundRuntime();
  const progressStore = { save: () => {} };
  const handle = mountActivity({
    activityDefinition: mathActivity,
    runtimeBinding: binding,
    content: Object.freeze({ level: 3 }),
    approvedServices: { progressStore, telemetry: {} },
  });

  assert.equal(handle.context.runtime.learnerId, 'learner-1');
  assert.deepEqual(handle.context.content, { level: 3 });
  assert.equal(handle.context.services.progressStore, progressStore);
  assert.equal(handle.context.services.telemetry, undefined);
  assert.equal(handle.implementation.solve(2, 3), 5);
});

test('AH-001-AC02 structurally different Magical Math and Chess activities operate through the same shared activity contract', async () => {
  const mathBinding = await boundRuntime();
  const chessBinding = await boundRuntime({ ...baseClaims, appId: 'chess-master', sessionId: 'session-2' });

  const mathHandle = mountActivity({
    activityDefinition: mathActivity,
    runtimeBinding: mathBinding,
    approvedServices: { progressStore: {} },
  });
  const chessHandle = mountActivity({
    activityDefinition: chessActivity,
    runtimeBinding: chessBinding,
    approvedServices: {},
  });

  assert.equal(mathHandle.implementation.kind, 'math');
  assert.equal(chessHandle.implementation.kind, 'chess');
  assert.equal(chessHandle.implementation.movePiece('e4'), 'e4');
});

test('AH-001-AC03 an activity emitting readiness signals the shared host without mutating session state directly', async () => {
  const binding = await boundRuntime();
  const lifecycle = createSessionLifecycle({ sessionIdentity: getRuntimeContext(binding) });
  let receivedContext = null;
  const handle = mountActivity({
    activityDefinition: { activityId: 'ready-probe', create: (context) => { receivedContext = context; } },
    runtimeBinding: binding,
    lifecycle,
  });
  assert.deepEqual(Object.keys(receivedContext).sort(), ['content', 'events', 'runtime', 'services']);

  await handle.context.events.ready();
  assert.equal(lifecycle.state, 'ACTIVE');
});

test('AH-001-AC04 meaningful progress is passed to the shared progress/session integration path, not called by the activity directly', async () => {
  const binding = await boundRuntime();
  const received = [];
  const handle = mountActivity({
    activityDefinition: { activityId: 'progress-probe', create: () => {} },
    runtimeBinding: binding,
    onMeaningfulProgress: (payload, runtime) => { received.push({ payload, runtime }); },
  });

  await handle.context.events.meaningfulProgress({ questionsSolved: 4 });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].payload, { questionsSolved: 4 });
  assert.equal(received[0].runtime.sessionId, 'session-1');
});

test('AH-001-AC05 activity completion is handled through the standard SR-004 completion path', async () => {
  const { binding, lifecycle, completion, calls } = await buildCompletionHarness({
    transport: async (req) => req.url.endsWith('/v1/progress')
      ? { status: 200, body: { saved: true } }
      : { status: 200, body: { finalStatus: 'completed' } },
  });
  await lifecycle.signal('activity-ready');
  const handle = mountActivity({
    activityDefinition: { activityId: 'completion-probe', create: () => {} },
    runtimeBinding: binding,
    completion,
  });

  const result = await handle.context.events.completed({ finalScore: 42 });
  assert.equal(result.finalStatus, 'completed');
  assert.equal(lifecycle.state, 'ENDED');
  const progressCall = calls.find((c) => c.url.endsWith('/v1/progress'));
  assert.equal(progressCall.body.finalScore, 42);
});

test('AH-001-AC06 an unrecoverable local activity error is captured/normalized by the shared host, not the platform/session', async () => {
  const binding = await boundRuntime();
  const lifecycle = createSessionLifecycle({ sessionIdentity: getRuntimeContext(binding) });
  await lifecycle.signal('activity-ready');
  const failures = [];
  const handle = mountActivity({
    activityDefinition: { activityId: 'failure-probe', create: () => {} },
    runtimeBinding: binding,
    lifecycle,
    onFailure: (normalized) => failures.push(normalized),
  });

  const normalized = handle.context.events.failed({ code: 'BOARD_RENDER_CRASH', message: 'renderer threw' });
  assert.equal(normalized.code, 'BOARD_RENDER_CRASH');
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(failures.length, 1);
  assert.equal(lifecycle.state, 'ACTIVE');
});

test('AH-001-AC07 no direct Babysteps API client, database client, auth internals, or container-private module is importable by activity code', () => {
  const privateImport = inspectSource(
    'apps/demo/rogue-activity.mjs',
    "import { mountActivity } from '../../src/container/internal/activities/activity-host.mjs';"
  );
  assert.equal(privateImport.some((v) => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);

  const directDb = inspectSource('apps/demo/rogue-db.mjs', "import { createClient } from '@supabase/supabase-js';");
  assert.equal(directDb.some((v) => v.code === 'DIRECT_PLATFORM_DATA_ACCESS'), true);
});

test('AH-001-AC08 an activity requesting an unapproved capability is denied through the contract', async () => {
  const binding = await boundRuntime();
  assert.throws(
    () => mountActivity({
      activityDefinition: { activityId: 'capability-probe', requiredServices: ['premiumBoardRenderer'], create: () => {} },
      runtimeBinding: binding,
      approvedServices: { progressStore: {} },
    }),
    (e) => e instanceof ActivityContractError && e.code === 'ACTIVITY_CAPABILITY_DENIED'
  );

  const scopedBinding = await boundRuntime({ ...baseClaims, sessionId: 'session-3' });
  const handle = mountActivity({
    activityDefinition: { activityId: 'scoped-probe', requiredServices: ['progressStore'], create: () => {} },
    runtimeBinding: scopedBinding,
    approvedServices: { progressStore: {}, telemetry: {}, billing: {} },
  });
  assert.deepEqual(Object.keys(handle.context.services), ['progressStore']);
});

test('AH-001-AC09 activity code attempting to alter learnerId/sessionId/appId/releaseId is rejected', async () => {
  const binding = await boundRuntime();
  const handle = mountActivity({
    activityDefinition: { activityId: 'authority-probe', create: () => {} },
    runtimeBinding: binding,
  });

  await assert.rejects(
    () => handle.context.events.meaningfulProgress({ sessionId: 'session-evil' }),
    (e) => e instanceof ActivityContractError && e.code === 'ACTIVITY_CONTEXT_MISMATCH'
  );
  await assert.rejects(
    () => handle.context.events.completed({ learnerId: 'learner-evil' }),
    (e) => e instanceof ActivityContractError && e.code === 'ACTIVITY_CONTEXT_MISMATCH'
  );
});

test('AH-001-AC10 a novel educational interaction/visual design requires no change to shared pedagogy/UI rules', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-4' });
  let speedReadingState = { wordsPerMinute: 0 };
  const speedReadingActivity = Object.freeze({
    activityId: 'speed-reading-activity',
    create: () => Object.freeze({
      kind: 'speed-reading',
      tick: (wpm) => { speedReadingState = { wordsPerMinute: wpm }; return speedReadingState; },
    }),
  });
  const handle = mountActivity({ activityDefinition: speedReadingActivity, runtimeBinding: binding });
  assert.deepEqual(handle.implementation.tick(220), { wordsPerMinute: 220 });
});

test('AH-001-AC11 only coarse activity-host technical telemetry is emitted; detailed learner interaction data is not automatically collected', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-5' });
  const lifecycle = createSessionLifecycle({ sessionIdentity: getRuntimeContext(binding) });
  const events = [];
  const handle = mountActivity({
    activityDefinition: { activityId: 'telemetry-probe', create: () => {} },
    runtimeBinding: binding,
    lifecycle,
    onTelemetry: (e) => events.push(e),
  });
  await handle.context.events.ready();
  await handle.context.events.meaningfulProgress({ question: '2+2', answer: 4 });
  handle.context.events.failed({ code: 'X', message: 'sensitive learner detail here' });

  assert.ok(events.length >= 3);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'appId', 'activityId', 'correlationId', 'failureCode'].includes(k)));
    assert.equal(JSON.stringify(event).includes('question'), false);
    assert.equal(JSON.stringify(event).includes('sensitive learner detail'), false);
  }
});

test('AH-001 repeated mount of the same activity for the same runtime is idempotent and does not create a duplicate instance', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-6' });
  let createCalls = 0;
  const activityDefinition = Object.freeze({ activityId: 'idempotent-probe', create: () => { createCalls += 1; return { instance: createCalls }; } });

  const first = mountActivity({ activityDefinition, runtimeBinding: binding });
  const second = mountActivity({ activityDefinition, runtimeBinding: binding });

  assert.equal(createCalls, 1);
  assert.equal(first, second);
});
