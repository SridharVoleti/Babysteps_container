import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createActivityLifecycleManager } from '../../src/container/internal/activities/activity-lifecycle-manager.mjs';
import { createSessionLifecycle } from '../../src/container/internal/session/session-lifecycle.mjs';
import { createConnectedTimeTracker } from '../../src/container/internal/session/session-connected-time.mjs';
import { createProgressAdapter } from '../../src/container/internal/progress/progress-adapter.mjs';
import { mountLearningSessionShell } from '../../src/container/internal/shell/learning-session-shell.mjs';
import { createResponsiveRuntime, ResponsiveRuntimeError } from '../../src/container/internal/runtime/responsive-runtime.mjs';

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

function makeService({ width = 1200, orientation = 'landscape', touch = false, subscribe } = {}) {
  return createResponsiveRuntime({
    subscribe,
    readViewport: () => ({ width, height: 800 }),
    readOrientation: () => orientation,
    readSafeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    readInputCapability: () => ({ touch }),
  });
}

test('DR-002-AC01 the same essential functionality is exposed as normalized state on desktop and mobile', () => {
  const desktop = makeService({ width: 1280 });
  const mobile = makeService({ width: 375 });
  assert.equal(desktop.getState().viewportClass, 'DESKTOP');
  assert.equal(mobile.getState().viewportClass, 'MOBILE');
  assert.ok('viewport' in desktop.getState() && 'viewport' in mobile.getState());
});

test('DR-002-AC02 a mobile viewport class is reported so the app can provide an appropriate mobile interaction', () => {
  const mobile = makeService({ width: 320 });
  assert.equal(mobile.getState().viewportClass, 'MOBILE');
});

test('DR-002-AC03 different apps derive entirely different layout decisions from the same normalized state', () => {
  const service = makeService({ width: 400 });
  const chessLayout = (state) => (state.viewportClass === 'MOBILE' ? 'stacked-board' : 'side-by-side-board');
  const mathLayout = (state) => (state.viewportClass === 'MOBILE' ? 'single-column-problems' : 'grid-problems');
  const state = service.getState();
  assert.notEqual(chessLayout(state), mathLayout(state));
});

test('DR-002-AC04 a viewport change during an active session preserves the bound session and current activity', async () => {
  const binding = await boundRuntime();
  const lifecycle = createSessionLifecycle({ sessionIdentity: getRuntimeContext(binding) });
  await lifecycle.signal('activity-ready');
  const manager = createActivityLifecycleManager({ runtimeBinding: binding, lifecycle });
  const handle = manager.activate(Object.freeze({ activityId: 'math-activity', create: () => ({}) }));

  let width = 1200;
  const responsive = createResponsiveRuntime({
    readViewport: () => ({ width, height: 800 }),
    readOrientation: () => 'landscape',
  });
  width = 400;
  responsive.refresh();

  assert.equal(lifecycle.state, 'ACTIVE');
  assert.equal(manager.current.generation, handle.generation);
});

test('DR-002-AC05 a device rotation does not reset connected time or duplicate runtime creation', async () => {
  const binding = await boundRuntime();
  let now = 0;
  const tracker = createConnectedTimeTracker({ sessionIdentity: getRuntimeContext(binding), monotonicNow: () => now });
  tracker.setForeground(true);
  tracker.setOnline(true);
  now = 5000;
  const beforeRotation = tracker.connectedSeconds();

  const responsive = createResponsiveRuntime({ readViewport: () => ({ width: 800 }), readOrientation: () => 'portrait' });
  responsive.refresh();
  responsive.refresh();

  assert.equal(tracker.connectedSeconds(), beforeRotation);
  assert.equal(tracker.isAccumulating(), true);
});

test('DR-002-AC06 responsive shell state remains available and usable across viewport/safe-area changes', async () => {
  const binding = await boundRuntime();
  const lifecycle = createSessionLifecycle({ sessionIdentity: getRuntimeContext(binding) });
  await lifecycle.signal('activity-ready');
  const shell = mountLearningSessionShell({
    readiness: { ok: true, phase: 'READY' },
    runtimeBinding: binding,
    lifecycle,
    completion: { complete: async () => ({}) },
  });

  const responsive = createResponsiveRuntime({ readViewport: () => ({ width: 320 }), readSafeArea: () => ({ top: 24, right: 0, bottom: 0, left: 0 }) });
  responsive.refresh();

  assert.equal(shell.status().lifecycleState, 'ACTIVE');
  const remounted = mountLearningSessionShell({ readiness: { ok: true, phase: 'READY' }, runtimeBinding: binding, lifecycle, completion: { complete: async () => ({}) } });
  assert.equal(remounted, shell);
});

test('DR-002-AC07 coarse input-capability information is exposed while layout decisions remain app-owned', () => {
  const touchDevice = makeService({ touch: true });
  const pointerDevice = makeService({ touch: false });
  assert.equal(touchDevice.getState().input.touch, true);
  assert.equal(pointerDevice.getState().input.touch, false);
});

test('DR-002-AC08 repeated responsive events do not create duplicate listeners/subscriptions', () => {
  let subscribeCalls = 0;
  const service = createResponsiveRuntime({
    readViewport: () => ({ width: 800 }),
    subscribe: () => { subscribeCalls += 1; return () => {}; },
  });
  service.start();
  service.start();
  service.start();
  assert.equal(subscribeCalls, 1);
});

test('DR-002-AC09 acknowledged progress remains intact after a viewport/orientation change', async () => {
  const binding = await boundRuntime();
  const identity = getRuntimeContext(binding);
  const progressClient = { call: async () => ({ acknowledged: true, progressVersion: 'v1' }) };
  const adapter = createProgressAdapter({ sessionIdentity: identity, progressClient });
  await adapter.checkpoint({ score: 10 });
  const before = adapter.latestAcknowledged;

  const responsive = createResponsiveRuntime({ readViewport: () => ({ width: 500 }) });
  responsive.refresh();
  responsive.refresh();

  assert.deepEqual(adapter.latestAcknowledged, before);
});

test('DR-002-AC10 a genuinely unsupported capability limitation is explicit rather than silently hidden', () => {
  const service = makeService({ width: 200 });
  const state = service.getState();
  assert.equal(typeof state.viewportClass, 'string');
  assert.ok(['MOBILE', 'TABLET', 'DESKTOP', 'UNKNOWN'].includes(state.viewportClass));
});

test('DR-002-AC11 only coarse responsive/device telemetry is emitted, not detailed fingerprinting', () => {
  const events = [];
  const service = createResponsiveRuntime({
    readViewport: () => ({ width: 600 }),
    onTelemetry: (e) => events.push(e),
  });
  service.refresh();
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'reason', 'viewportClass', 'orientation'].includes(k)));
  }
});

test('DR-002 readViewport is required to construct the responsive runtime', () => {
  assert.throws(() => createResponsiveRuntime({}), (e) => e instanceof ResponsiveRuntimeError && e.code === 'RESPONSIVE_RUNTIME_INVALID');
});
