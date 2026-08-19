import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createSessionClock,
  createSessionClockPublicFacade,
  SessionTimeError,
} from '../../src/container/internal/session/session-clock.mjs';
import { createSessionLifecycle } from '../../src/container/internal/session/session-lifecycle.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

const sessionIdentity = Object.freeze({ sessionId: 'session-1', learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', correlationId: 'corr-1' });

function makeMonotonic(start = 0) {
  let value = start;
  const now = () => value;
  now.advance = (deltaSeconds) => { value += deltaSeconds * 1000; };
  return now;
}

test('SR-003-AC01 valid authoritative timing seeds local elapsed/remaining UX state', () => {
  const monotonicNow = makeMonotonic();
  const clock = createSessionClock({ sessionIdentity, monotonicNow });
  const result = clock.reconcile({ remainingSeconds: 900, startedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T00:15:00.000Z' });
  assert.equal(result.remainingSeconds, 900);
  assert.equal(clock.remainingSeconds(), 900);
  assert.equal(clock.isExpired(), false);
});

test('SR-003-AC02 no public capability permits app code to set/extend authoritative session duration', () => {
  const violations = inspectSource('apps/demo/rogue.mjs', "import { createSessionClock } from '../../src/container/internal/session/session-clock.mjs';");
  assert.equal(violations.some((v) => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);

  const clock = createSessionClock({ sessionIdentity, monotonicNow: makeMonotonic() });
  const facade = createSessionClockPublicFacade(clock);
  const keys = Object.keys(facade);
  assert.deepEqual(keys.sort(), ['canStartActivity', 'isExpired', 'remainingSeconds']);
  assert.equal(facade.extend, undefined);
  assert.equal(facade.reset, undefined);
  assert.equal(facade.setRemainingSeconds, undefined);
});

test('SR-003-AC03 a page refresh/reload reconciles to the platform-reported remaining time, not a fresh full session', () => {
  const monotonicNow1 = makeMonotonic();
  const clockBeforeRefresh = createSessionClock({ sessionIdentity, monotonicNow: monotonicNow1 });
  clockBeforeRefresh.reconcile({ remainingSeconds: 1000 });
  monotonicNow1.advance(100);
  assert.ok(clockBeforeRefresh.remainingSeconds() < 1000);

  const monotonicNow2 = makeMonotonic();
  const clockAfterRefresh = createSessionClock({ sessionIdentity, monotonicNow: monotonicNow2 });
  const result = clockAfterRefresh.reconcile({ remainingSeconds: 900 });
  assert.equal(result.remainingSeconds, 900);
  assert.notEqual(clockAfterRefresh.remainingSeconds(), 1000);
});

test('SR-003-AC04 resuming after suspension recalculates from authoritative timing rather than granting extra time', () => {
  const monotonicNow = makeMonotonic();
  const clock = createSessionClock({ sessionIdentity, monotonicNow });
  clock.reconcile({ remainingSeconds: 600 });
  monotonicNow.advance(500);
  const beforeResumeReconcile = clock.remainingSeconds();
  assert.ok(beforeResumeReconcile <= 100);

  const result = clock.reconcile({ remainingSeconds: 80 });
  assert.equal(result.remainingSeconds, 80);
  assert.ok(clock.remainingSeconds() <= 80);
});

test('SR-003-AC05 lost/restored connectivity never resets or increases authorized time beyond the platform value', () => {
  const monotonicNow = makeMonotonic();
  const clock = createSessionClock({ sessionIdentity, monotonicNow });
  clock.reconcile({ remainingSeconds: 300 });
  monotonicNow.advance(600);
  assert.equal(clock.remainingSeconds(), 0);

  const result = clock.reconcile({ remainingSeconds: 250 });
  assert.equal(result.remainingSeconds, 250);
  assert.ok(clock.remainingSeconds() <= 250);
});

test('SR-003-AC06 device wall-clock manipulation cannot extend the authoritative session', () => {
  const realDateNow = Date.now;
  try {
    const monotonicNow = makeMonotonic();
    const clock = createSessionClock({ sessionIdentity, monotonicNow });
    clock.reconcile({ remainingSeconds: 100 });

    Date.now = () => realDateNow() - 365 * 24 * 60 * 60 * 1000;
    monotonicNow.advance(30);
    const remaining = clock.remainingSeconds();
    assert.ok(remaining <= 70 && remaining >= 69);
  } finally {
    Date.now = realDateNow;
  }
});

test('SR-003-AC07 expiry blocks new learning activities and drives SR-002 through the approved ending path', async () => {
  const lifecycle = createSessionLifecycle({ sessionIdentity });
  await lifecycle.signal('activity-ready');
  const monotonicNow = makeMonotonic();
  const clock = createSessionClock({ sessionIdentity, lifecycle, monotonicNow });

  const result = clock.reconcile({ remainingSeconds: 0 });
  await result.endingPromise;

  assert.equal(clock.isExpired(), true);
  assert.equal(lifecycle.state, 'ENDED');
  assert.throws(() => clock.assertCanStartActivity(), (e) => e instanceof SessionTimeError && e.code === 'SESSION_TIME_EXPIRED');
});

test('SR-003-AC08 expiry detected across multiple ticks/responses produces only one end transition', async () => {
  let signalCalls = 0;
  const lifecycle = createSessionLifecycle({ sessionIdentity });
  await lifecycle.signal('activity-ready');
  const originalSignal = lifecycle.signal;
  const spiedLifecycle = { signal: (event) => { signalCalls += 1; return originalSignal(event); } };

  const monotonicNow = makeMonotonic();
  const clock = createSessionClock({ sessionIdentity, lifecycle: spiedLifecycle, monotonicNow });
  clock.reconcile({ remainingSeconds: 5 });
  monotonicNow.advance(10);

  const first = clock.checkExpiry();
  const second = clock.checkExpiry();
  const third = clock.checkExpiry();
  await Promise.all([first.endingPromise, second.endingPromise, third.endingPromise]);

  assert.equal(signalCalls, 1);
  assert.equal(lifecycle.state, 'ENDED');
});

test('SR-003-AC09 malformed/incompatible authoritative timing is rejected without inventing a duration', () => {
  const clock = createSessionClock({ sessionIdentity, monotonicNow: makeMonotonic() });
  assert.throws(() => clock.reconcile(null), (e) => e instanceof SessionTimeError && e.code === 'SESSION_TIME_UNAVAILABLE');
  assert.throws(() => clock.reconcile({ remainingSeconds: -5 }), (e) => e.code === 'SESSION_TIME_INVALID');
  assert.throws(() => clock.reconcile({ remainingSeconds: 'lots' }), (e) => e.code === 'SESSION_TIME_INVALID');
  assert.throws(() => clock.reconcile({ remainingSeconds: 100, startedAt: '2026-08-18T00:15:00.000Z', expiresAt: '2026-08-18T00:00:00.000Z' }), (e) => e.code === 'SESSION_TIME_INVALID');
  assert.throws(() => clock.reconcile({ remainingSeconds: 100, sessionId: 'other-session' }), (e) => e.code === 'SESSION_TIME_MISMATCH');
  assert.equal(clock.remainingSeconds(), 0);
});

test('SR-003-AC10 the public session-time facade exposes only approved read-only data; no authoritative setters exist', () => {
  const clock = createSessionClock({ sessionIdentity, monotonicNow: makeMonotonic() });
  clock.reconcile({ remainingSeconds: 120 });
  const facade = createSessionClockPublicFacade(clock);
  assert.equal(facade.remainingSeconds(), 120);
  assert.equal(facade.isExpired(), false);
  assert.equal(facade.canStartActivity(), true);
  assert.equal(Object.isFrozen(facade), true);
});

test('SR-003-AC11 the session clock module contains no local business-authority definition of session duration', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/session/session-clock.mjs');
  const source = readFileSync(filePath, 'utf8');
  const forbidden = /\b(?:function|const|let|var)\s+(?:decide|determine|validate|check|calculate|compute|consume|override)(?:LearnerOwnership|Entitlement|Subscription|SessionEligibility|SessionCredit|CreditEligibility|WeeklyEligibility|Concurrency|SessionStatus|SessionDuration)\b/i;
  assert.equal(forbidden.test(source), false);
  assert.equal(/2700\b/.test(source), false);
  assert.equal(/45\s*\*\s*60/.test(source), false);
});
