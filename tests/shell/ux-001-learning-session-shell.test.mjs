import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { createAuthenticatedRequestContext, createProtectedApiClient } from '../../src/container/internal/api/authenticated-request-context.mjs';
import { defineApiContract } from '../../src/container/internal/api/contract-validation.mjs';
import { createSessionLifecycle } from '../../src/container/internal/session/session-lifecycle.mjs';
import { createSessionCompletion, createFinalizationAdapter, SessionCompletionError } from '../../src/container/internal/session/session-completion.mjs';
import { createConnectedTimeTracker } from '../../src/container/internal/session/session-connected-time.mjs';
import { mountLearningSessionShell, LearningSessionShellError } from '../../src/container/internal/shell/learning-session-shell.mjs';

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

const finalizeContract = defineApiContract({
  operation: 'session.finalize',
  supportedVersions: ['1.0'],
  fields: {
    finalStatus: { required: true, type: 'enum', enum: ['completed', 'partial'] },
    sessionId: { required: true, type: 'string' },
  },
  mapToDomain: (raw) => ({ finalStatus: raw.finalStatus, sessionId: raw.sessionId }),
});

const operations = Object.freeze({
  'progress.save': {
    method: 'POST', path: '/v1/progress', authorityFields: ['learnerId', 'sessionId'],
    parseResponse: (body) => (body && typeof body.saved === 'boolean') ? { ok: true, data: { saved: body.saved } } : { ok: false },
  },
  'session.finalize': {
    method: 'POST', path: '/v1/session/finalize', authorityFields: ['learnerId', 'sessionId'], idempotent: true,
    parseResponse: finalizeContract.parseResponse,
  },
});

const READY = Object.freeze({ ok: true, phase: 'READY' });

async function buildHarness({ transport, claims = baseClaims, withConnectedTime = false } = {}) {
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
  const protectedClient = createProtectedApiClient({ apiClient, authContext, runtimeBinding: binding });

  const sessionIdentity = getRuntimeContext(binding);
  const finalizationAdapter = createFinalizationAdapter({ progressClient: protectedClient, finalizationClient: protectedClient });
  const lifecycle = createSessionLifecycle({ sessionIdentity, sessionAdapter: finalizationAdapter });
  const completion = createSessionCompletion({ sessionIdentity, lifecycle });
  const connectedTime = withConnectedTime
    ? createConnectedTimeTracker({ sessionIdentity, monotonicNow: () => 0 })
    : null;

  const events = [];
  return { binding, sessionIdentity, lifecycle, completion, connectedTime, calls, events, onTelemetry: (e) => events.push(e) };
}

function finalizeCalls(calls) { return calls.filter((c) => c.url.endsWith('/v1/session/finalize')); }
const successTransport = async () => ({ status: 200, body: { contractVersion: '1.0', finalStatus: 'completed', sessionId: 'session-1' } });

test('UX-001-AC01 a valid READY runtime mounts the shared shell hosting the app-specific learning view', async () => {
  const h = await buildHarness({ transport: successTransport });
  const learningView = Object.freeze({ kind: 'board', pieces: ['e4'] });
  const shell = mountLearningSessionShell({
    readiness: READY, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion, onTelemetry: h.onTelemetry, learningView,
  });
  assert.equal(shell.getLearningView(), learningView);
  assert.equal(shell.status().lifecycleState, 'INITIALIZING');

  assert.throws(
    () => mountLearningSessionShell({ readiness: { ok: false }, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion }),
    (e) => e instanceof LearningSessionShellError
  );
});

test('UX-001-AC02 structurally different learning UIs are hosted without adopting a common educational layout', async () => {
  const chess = await buildHarness({ transport: successTransport, claims: { ...baseClaims, appId: 'chess-master' } });
  const reading = await buildHarness({ transport: successTransport, claims: { ...baseClaims, appId: 'reading-quest' } });

  const chessView = Object.freeze({ kind: 'board', squares: 64, onMove: () => 'e4e5' });
  const readingView = Object.freeze({ kind: 'passage', paragraphs: ['Once upon a time...'], wordCount: 4 });

  const chessShell = mountLearningSessionShell({ readiness: READY, runtimeBinding: chess.binding, lifecycle: chess.lifecycle, completion: chess.completion, learningView: chessView });
  const readingShell = mountLearningSessionShell({ readiness: READY, runtimeBinding: reading.binding, lifecycle: reading.lifecycle, completion: reading.completion, learningView: readingView });

  assert.equal(chessShell.getLearningView(), chessView);
  assert.equal(readingShell.getLearningView(), readingView);
  assert.notDeepEqual(Object.keys(chessShell.getLearningView()), Object.keys(readingShell.getLearningView()));
});

test('UX-001-AC03 displayed session status is derived from shared session services, not app-supplied values', async () => {
  const h = await buildHarness({ transport: successTransport, withConnectedTime: true });
  const shell = mountLearningSessionShell({
    readiness: READY, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion, connectedTime: h.connectedTime,
  });

  assert.equal(shell.status().lifecycleState, 'INITIALIZING');
  assert.equal(shell.status().connectedSeconds, 0);

  await h.lifecycle.signal('activity-ready');
  assert.equal(shell.status().lifecycleState, 'ACTIVE');

  // status() accepts no input; there is no way for app code to override the authoritative value it reports.
  assert.equal(typeof shell.status, 'function');
  assert.equal(shell.status.length, 0);
});

test('UX-001-AC04 the common exit/end control routes through the approved shared session-runtime path', async () => {
  const h = await buildHarness({ transport: successTransport });
  const shell = mountLearningSessionShell({ readiness: READY, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion, onTelemetry: h.onTelemetry });
  await h.lifecycle.signal('activity-ready');

  const result = await shell.requestExit({});
  assert.equal(result.finalStatus, 'completed');
  assert.equal(finalizeCalls(h.calls).length, 1);
  assert.equal(h.lifecycle.state, 'ENDED');
  assert.equal(h.events.some((e) => e.event === 'shell_common_control_activated' && e.action === 'exit'), true);
});

test('UX-001-AC05 connectivity/runtime state changes are presented through shared shell state without app-owned plumbing', async () => {
  const h = await buildHarness({ transport: successTransport });
  const shell = mountLearningSessionShell({ readiness: READY, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion, onTelemetry: h.onTelemetry });

  assert.equal(shell.connectivityState(), 'ONLINE');
  shell.setConnectivity('OFFLINE');
  assert.equal(shell.connectivityState(), 'OFFLINE');
  assert.equal(shell.status().connectivity, 'OFFLINE');
  shell.setConnectivity('ONLINE');
  assert.equal(shell.connectivityState(), 'ONLINE');

  assert.equal(h.events.some((e) => e.event === 'shell_connectivity_lost'), true);
  assert.equal(h.events.some((e) => e.event === 'shell_connectivity_restored'), true);
});

test('UX-001-AC06 app-owned learning controls remain entirely unprescribed by the shared shell', async () => {
  const h = await buildHarness({ transport: successTransport });
  const learningView = Object.freeze({
    navigation: () => 'next-lesson',
    boardControls: Object.freeze({ drag: () => {}, drop: () => {} }),
    mathInput: Object.freeze({ onKeypad: () => {} }),
  });
  const shell = mountLearningSessionShell({ readiness: READY, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion, learningView });

  // The shell exposes only runtime-level surface; it has no method that inspects or drives app content.
  assert.deepEqual(Object.keys(shell).sort(), ['connectivityState', 'getLearningView', 'requestExit', 'setConnectivity', 'setLearningView', 'status'].sort());
  assert.equal(shell.getLearningView(), learningView);
});

test('UX-001-AC07 app-controlled authoritative session identity substitution is rejected by the shell', async () => {
  const h = await buildHarness({ transport: successTransport });
  const shell = mountLearningSessionShell({ readiness: READY, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion });
  await h.lifecycle.signal('activity-ready');

  await assert.rejects(
    () => shell.requestExit({ sessionId: 'session-evil', score: 1 }),
    (e) => e instanceof SessionCompletionError && e.code === 'SESSION_COMPLETION_IDENTITY_MISMATCH'
  );
  assert.equal(h.calls.length, 0);
  assert.equal(h.lifecycle.state, 'ACTIVE');
});

test('UX-001-AC08 repeated shell mount/rerender does not create duplicate shell instances or telemetry', async () => {
  const h = await buildHarness({ transport: successTransport });
  const args = { readiness: READY, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion, onTelemetry: h.onTelemetry };

  const first = mountLearningSessionShell(args);
  const second = mountLearningSessionShell(args);
  const third = mountLearningSessionShell({ ...args, learningView: Object.freeze({ ignored: true }) });

  assert.equal(first, second);
  assert.equal(first, third);
  assert.equal(h.events.filter((e) => e.event === 'shell_mounted').length, 1);
});

test('UX-001-AC09 repeated activation of the common exit/end control produces no duplicate platform/session effects', async () => {
  const h = await buildHarness({ transport: successTransport });
  const shell = mountLearningSessionShell({ readiness: READY, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion });
  await h.lifecycle.signal('activity-ready');

  const [r1, r2] = await Promise.all([shell.requestExit({}), shell.requestExit({})]);
  assert.deepEqual(r1, r2);
  assert.equal(finalizeCalls(h.calls).length, 1);

  const r3 = await shell.requestExit({});
  assert.deepEqual(r3, r1);
  assert.equal(finalizeCalls(h.calls).length, 1);
});

test('UX-001-AC10 a radically different app design reuses only common runtime-level shell behavior', async () => {
  const h = await buildHarness({ transport: successTransport, claims: { ...baseClaims, appId: 'speed-reading' } });
  class CustomAppComponent {
    constructor() { this.theme = 'brutalist'; }
    render() { return '<custom-markup/>'; }
  }
  const learningView = new CustomAppComponent();
  const shell = mountLearningSessionShell({ readiness: READY, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion, learningView });

  assert.equal(shell.getLearningView(), learningView);
  assert.equal(shell.getLearningView().render(), '<custom-markup/>');
  assert.equal(shell.status().lifecycleState, 'INITIALIZING');
});

test('UX-001-AC11 shell telemetry contains only coarse technical events, never app-specific interaction detail', async () => {
  const h = await buildHarness({ transport: successTransport });
  const learningView = Object.freeze({ secretLessonNote: 'learner struggled badly with fractions today' });
  const shell = mountLearningSessionShell({ readiness: READY, runtimeBinding: h.binding, lifecycle: h.lifecycle, completion: h.completion, onTelemetry: h.onTelemetry, learningView });
  await h.lifecycle.signal('activity-ready');

  shell.setConnectivity('OFFLINE');
  shell.setConnectivity('ONLINE');
  shell.setLearningView(Object.freeze({ secretLessonNote: 'now on fractions part 2' }));
  await shell.requestExit({});

  const allowedKeys = new Set(['event', 'sessionId', 'correlationId', 'action', 'category']);
  assert.ok(h.events.length > 0);
  for (const event of h.events) {
    for (const key of Object.keys(event)) {
      assert.equal(allowedKeys.has(key), true, `unexpected telemetry key: ${key}`);
    }
  }
  assert.equal(JSON.stringify(h.events).includes('fractions'), false);
});
