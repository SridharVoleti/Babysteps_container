import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { createAuthenticatedRequestContext, createProtectedApiClient } from '../../src/container/internal/api/authenticated-request-context.mjs';
import { createSessionLifecycle } from '../../src/container/internal/session/session-lifecycle.mjs';
import {
  createConnectedTimeTracker,
  createConnectedTimePublicFacade,
  reportConnectedSeconds,
  ConnectedTimeError,
} from '../../src/container/internal/session/session-connected-time.mjs';
import {
  createSessionCompletion,
  createFinalizationAdapter,
} from '../../src/container/internal/session/session-completion.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

const sessionIdentity = Object.freeze({ sessionId: 'session-1', learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', correlationId: 'corr-1' });

function makeMonotonic(start = 0) {
  let value = start;
  const now = () => value;
  now.advance = (deltaSeconds) => { value += deltaSeconds * 1000; };
  return now;
}

test('SR-006-AC01 foreground, online and session-active connected time increases using monotonic elapsed time', () => {
  const monotonicNow = makeMonotonic();
  const tracker = createConnectedTimeTracker({ sessionIdentity, monotonicNow });
  tracker.setOnline(true);
  tracker.setForeground(true);
  monotonicNow.advance(10);
  assert.equal(tracker.connectedSeconds(), 10);
  assert.equal(tracker.isAccumulating(), true);
});

test('SR-006-AC02 backgrounding the app stops connected time from accumulating', () => {
  const monotonicNow = makeMonotonic();
  const tracker = createConnectedTimeTracker({ sessionIdentity, monotonicNow });
  tracker.setForeground(true);
  monotonicNow.advance(5);
  tracker.setForeground(false);
  const afterPause = tracker.connectedSeconds();
  monotonicNow.advance(20);
  assert.equal(tracker.connectedSeconds(), afterPause);
  assert.equal(tracker.isAccumulating(), false);
});

test('SR-006-AC03 losing network connectivity stops connected time from accumulating', () => {
  const monotonicNow = makeMonotonic();
  const tracker = createConnectedTimeTracker({ sessionIdentity, monotonicNow });
  tracker.setForeground(true);
  monotonicNow.advance(5);
  tracker.setOnline(false);
  const afterOffline = tracker.connectedSeconds();
  monotonicNow.advance(20);
  assert.equal(tracker.connectedSeconds(), afterOffline);
});

test('SR-006-AC04 returning to foreground and online resumes accumulation from the prior value', () => {
  const monotonicNow = makeMonotonic();
  const tracker = createConnectedTimeTracker({ sessionIdentity, monotonicNow });
  tracker.setForeground(true);
  monotonicNow.advance(5);
  tracker.setForeground(false);
  monotonicNow.advance(50);
  assert.equal(tracker.connectedSeconds(), 5);

  tracker.setForeground(true);
  monotonicNow.advance(5);
  assert.equal(tracker.connectedSeconds(), 10);
});

test('SR-006-AC05 a refresh/reinitialization that legitimately resumes the session continues from the prior connected-time value', () => {
  const monotonicNow1 = makeMonotonic();
  const beforeRefresh = createConnectedTimeTracker({ sessionIdentity, monotonicNow: monotonicNow1 });
  beforeRefresh.setForeground(true);
  monotonicNow1.advance(42);
  const seed = beforeRefresh.connectedSeconds();

  const monotonicNow2 = makeMonotonic();
  const afterRefresh = createConnectedTimeTracker({ sessionIdentity, monotonicNow: monotonicNow2, seedSeconds: seed });
  assert.equal(afterRefresh.connectedSeconds(), 42);
  afterRefresh.setForeground(true);
  monotonicNow2.advance(8);
  assert.equal(afterRefresh.connectedSeconds(), 50);
});

test('SR-006-AC06 a new Babysteps-authorized session receives independent connected-time state', () => {
  const monotonicNow1 = makeMonotonic();
  const previousSession = createConnectedTimeTracker({ sessionIdentity, monotonicNow: monotonicNow1 });
  previousSession.setForeground(true);
  monotonicNow1.advance(100);
  assert.equal(previousSession.connectedSeconds(), 100);

  const newSessionIdentity = Object.freeze({ ...sessionIdentity, sessionId: 'session-2' });
  const newSession = createConnectedTimeTracker({ sessionIdentity: newSessionIdentity, monotonicNow: makeMonotonic() });
  assert.equal(newSession.connectedSeconds(), 0);
});

test('SR-006-AC07 device wall-clock manipulation cannot inflate or reduce measured connected seconds', () => {
  const realDateNow = Date.now;
  try {
    const monotonicNow = makeMonotonic();
    const tracker = createConnectedTimeTracker({ sessionIdentity, monotonicNow });
    tracker.setForeground(true);

    Date.now = () => realDateNow() + 365 * 24 * 60 * 60 * 1000;
    monotonicNow.advance(15);
    assert.equal(tracker.connectedSeconds(), 15);
  } finally {
    Date.now = realDateNow;
  }
});

test('SR-006-AC08 reaching the platform-supplied maximum stops accumulation and triggers the approved SR-003/SR-004 end path', async () => {
  const lifecycle = createSessionLifecycle({ sessionIdentity });
  await lifecycle.signal('activity-ready');
  const monotonicNow = makeMonotonic();
  const tracker = createConnectedTimeTracker({ sessionIdentity, lifecycle, monotonicNow, maxConnectedSeconds: 60 });
  tracker.setForeground(true);
  monotonicNow.advance(90);

  const result = tracker.checkBoundary();
  await result.endingPromise;

  assert.equal(tracker.isBoundaryReached(), true);
  assert.equal(lifecycle.state, 'ENDED');
  const cappedValue = tracker.connectedSeconds();
  monotonicNow.advance(30);
  assert.equal(tracker.connectedSeconds(), cappedValue);
});

test('SR-006-AC09 repeated equivalent visibility/network/boundary signals do not create duplicate segments or double transitions', async () => {
  const monotonicNow = makeMonotonic();
  const tracker = createConnectedTimeTracker({ sessionIdentity, monotonicNow });
  tracker.setForeground(true);
  assert.deepEqual(tracker.setForeground(true), { changed: false });
  monotonicNow.advance(10);
  assert.equal(tracker.connectedSeconds(), 10);

  let signalCalls = 0;
  const lifecycle = createSessionLifecycle({ sessionIdentity });
  await lifecycle.signal('activity-ready');
  const originalSignal = lifecycle.signal;
  const spiedLifecycle = { signal: (event) => { signalCalls += 1; return originalSignal(event); } };
  const boundedTracker = createConnectedTimeTracker({ sessionIdentity, lifecycle: spiedLifecycle, monotonicNow, maxConnectedSeconds: 5 });
  boundedTracker.setForeground(true);
  monotonicNow.advance(20);

  const first = boundedTracker.checkBoundary();
  const second = boundedTracker.checkBoundary();
  const third = boundedTracker.checkBoundary();
  await Promise.all([first.endingPromise, second.endingPromise, third.endingPromise]);
  assert.equal(signalCalls, 1);
});

test('SR-006-AC10 no recurring heartbeat, timer-tick API call, or periodic database write exists solely to track connected seconds', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/session/session-connected-time.mjs');
  const source = readFileSync(filePath, 'utf8');
  assert.equal(/setInterval|setTimeout|requestAnimationFrame/.test(source), false);
  assert.equal(/fetch\s*\(|\.call\s*\(/.test(source), false);
});

test('SR-006-AC11 locally measured connected seconds are supplied through the approved finalization contract', async () => {
  const manifest = Object.freeze({ appId: 'magical-math' });
  const baseClaims = Object.freeze({
    learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
    launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1'
  });
  const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
  const envelope = (claims = baseClaims) => ({ claims: structuredClone(claims), proof: proof(claims) });
  const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });
  const launchOpts = { manifest, expectedReleaseId: 'release-1', expectedSessionId: 'session-1', verifier, now: () => new Date('2026-08-18T00:10:00.000Z') };
  const runtimeContext = await validateLaunchContext({ launchContext: envelope(), ...launchOpts });
  const binding = bindAuthorizedRuntime(runtimeContext);

  const calls = [];
  const operations = Object.freeze({
    'progress.save': {
      method: 'POST', path: '/v1/progress', authorityFields: ['learnerId', 'sessionId'],
      parseResponse: (body) => (body && typeof body.saved === 'boolean') ? { ok: true, data: { saved: body.saved } } : { ok: false },
    },
    'session.finalize': {
      method: 'POST', path: '/v1/session/finalize', authorityFields: ['learnerId', 'sessionId'], idempotent: true,
      parseResponse: (body) => (body && typeof body.finalStatus === 'string') ? { ok: true, data: { finalStatus: body.finalStatus, acceptedConnectedSeconds: body.acceptedConnectedSeconds } } : { ok: false },
    },
  });
  const transport = async (req) => {
    calls.push(req);
    if (req.url.endsWith('/v1/progress')) return { status: 200, body: { saved: true } };
    return { status: 200, body: { finalStatus: 'completed', acceptedConnectedSeconds: 58 } };
  };
  const authContext = createAuthenticatedRequestContext({
    resolveToken: async () => ({ token: 'container-controlled-token', expiresAt: Date.now() + 60000 }),
    refreshToken: async () => ({ token: 'refreshed-token', expiresAt: Date.now() + 60000 }),
  });
  const apiClient = createBabystepsApiClient({
    baseUrl: 'https://staging.api.babysteps.com', contractVersion: '2024-01', transport,
    authProvider: authContext.getToken, runtimeBinding: binding, operations,
  });
  const protectedClient = createProtectedApiClient({ apiClient, authContext, runtimeBinding: binding });

  const boundSessionIdentity = getRuntimeContext(binding);
  const finalizationAdapter = createFinalizationAdapter({ progressClient: protectedClient, finalizationClient: protectedClient });
  const lifecycle = createSessionLifecycle({ sessionIdentity: boundSessionIdentity, sessionAdapter: finalizationAdapter });
  await lifecycle.signal('activity-ready');
  const completion = createSessionCompletion({ sessionIdentity: boundSessionIdentity, lifecycle });

  const monotonicNow = makeMonotonic();
  const tracker = createConnectedTimeTracker({ sessionIdentity: boundSessionIdentity, monotonicNow });
  tracker.setForeground(true);
  monotonicNow.advance(58);

  const result = await completion.complete(reportConnectedSeconds(tracker, { score: 10 }));

  const progressCall = calls.find((c) => c.url.endsWith('/v1/progress'));
  assert.equal(progressCall.body.connectedSeconds, 58);
  assert.equal(result.finalStatus, 'completed');

  // SR-006-AC12 the final app uses Babysteps' authoritative returned outcome rather than treating its own
  // local measurement as authoritative: the accepted value comes from the finalization response, not from
  // re-deriving/overriding it via the tracker.
  assert.equal(result.acceptedConnectedSeconds, 58);
  assert.equal('connectedSeconds' in result, false);
});

test('SR-006-AC13 app-specific code has no capability to reset, extend, or directly set connected time', () => {
  const violations = inspectSource('apps/demo/rogue-time.mjs', "import { createConnectedTimeTracker } from '../../src/container/internal/session/session-connected-time.mjs';");
  assert.equal(violations.some((v) => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);

  const tracker = createConnectedTimeTracker({ sessionIdentity, monotonicNow: makeMonotonic() });
  const facade = createConnectedTimePublicFacade(tracker);
  assert.deepEqual(Object.keys(facade).sort(), ['connectedSeconds', 'isAccumulating']);
  assert.equal(facade.setForeground, undefined);
  assert.equal(facade.setOnline, undefined);
  assert.equal(facade.reset, undefined);
  assert.equal(Object.isFrozen(facade), true);
});

test('SR-006-AC14 the module does not implement independent duplicate-tab ownership authority', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/session/session-connected-time.mjs');
  const source = readFileSync(filePath, 'utf8');
  assert.equal(/\btab(Id|Owner|Leader)?\b/i.test(source), false);
});

test('SR-006 invalid seed/boundary configuration is rejected', () => {
  assert.throws(() => createConnectedTimeTracker({ sessionIdentity, seedSeconds: -1 }), (e) => e instanceof ConnectedTimeError && e.code === 'CONNECTED_TIME_INVALID_SEED');
  assert.throws(() => createConnectedTimeTracker({ sessionIdentity, maxConnectedSeconds: -1 }), (e) => e instanceof ConnectedTimeError && e.code === 'CONNECTED_TIME_INVALID_BOUNDARY');
  const tracker = createConnectedTimeTracker({ sessionIdentity, monotonicNow: makeMonotonic() });
  assert.throws(() => tracker.setForeground('yes'), (e) => e instanceof ConnectedTimeError && e.code === 'CONNECTED_TIME_INVALID_STATE');
});
