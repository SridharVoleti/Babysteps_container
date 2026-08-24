import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createSessionLifecycle,
  createLifecyclePublicFacade,
  SessionLifecycleError,
} from '../../src/container/internal/session/session-lifecycle.mjs';

const sessionIdentity = Object.freeze({ sessionId: 'session-1', learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', correlationId: 'corr-1' });

function makeLifecycle(overrides = {}) {
  return createSessionLifecycle({ sessionIdentity, ...overrides });
}

test('SR-002-AC01 SR-001 initialization enters the approved initial state through the state machine only', () => {
  const lifecycle = makeLifecycle();
  assert.equal(lifecycle.state, 'INITIALIZING');
  const descriptor = Object.getOwnPropertyDescriptor(lifecycle, 'state');
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(descriptor.set, undefined);
});

test('SR-002-AC02 a permitted lifecycle intent moves the runtime only to a transition allowed by the transition table', async () => {
  const lifecycle = makeLifecycle();
  await lifecycle.signal('activity-ready');
  assert.equal(lifecycle.state, 'ACTIVE');
  const result = await lifecycle.signal('recover-requested');
  assert.equal(result.to, 'RECOVERING');
  assert.equal(lifecycle.state, 'RECOVERING');
});

test('SR-002-AC03 app code cannot directly assign or skip lifecycle state; only typed signals are available', async () => {
  const lifecycle = makeLifecycle();
  const facade = createLifecyclePublicFacade(lifecycle);
  assert.throws(() => { facade.state = 'ENDED'; }, TypeError);
  assert.deepEqual(Object.keys(facade).sort(), ['signal', 'state']);
  await lifecycle.signal('activity-ready');
  assert.equal(facade.state, 'ACTIVE');
});

test('SR-002-AC04 an invalid lifecycle transition is rejected atomically and the state remains unchanged', async () => {
  const lifecycle = makeLifecycle();
  assert.equal(lifecycle.state, 'INITIALIZING');
  await assert.rejects(() => lifecycle.signal('complete-requested'), (e) => e instanceof SessionLifecycleError && e.code === 'SESSION_TRANSITION_INVALID');
  assert.equal(lifecycle.state, 'INITIALIZING');
});

test('SR-002-AC05 a terminal/inactive platform result forces local ENDED and cannot be locally reversed', async () => {
  const lifecycle = makeLifecycle();
  await lifecycle.signal('activity-ready');
  assert.equal(lifecycle.state, 'ACTIVE');
  const result = lifecycle.reconcilePlatformState({ status: 'terminal' });
  assert.equal(result.to, 'ENDED');
  assert.equal(lifecycle.state, 'ENDED');
});

test('SR-002-AC06 an app request to reactivate after platform termination is rejected', async () => {
  const lifecycle = makeLifecycle();
  await lifecycle.signal('activity-ready');
  lifecycle.reconcilePlatformState({ status: 'terminal' });
  await assert.rejects(() => lifecycle.signal('recover-requested'), (e) => e instanceof SessionLifecycleError && e.code === 'SESSION_PLATFORM_STATE_TERMINAL');
  assert.equal(lifecycle.state, 'ENDED');
});

test('SR-002-AC07 the same lifecycle signal delivered multiple times converges to one state without duplicate transitions', async () => {
  const lifecycle = makeLifecycle();
  await lifecycle.signal('activity-ready');
  await lifecycle.signal('recover-requested');
  assert.equal(lifecycle.state, 'RECOVERING');
  const second = await lifecycle.signal('recover-requested');
  assert.equal(second.idempotent, true);
  assert.equal(lifecycle.state, 'RECOVERING');
});

test('SR-002-AC08 multiple completion signals produce at most one finalize call and one terminal transition', async () => {
  let finalizeCalls = 0;
  const lifecycle = makeLifecycle({ sessionAdapter: { finalize: async () => { finalizeCalls += 1; } } });
  await lifecycle.signal('activity-ready');
  const [r1, r2] = await Promise.all([lifecycle.signal('complete-requested'), lifecycle.signal('complete-requested')]);
  assert.equal(lifecycle.state, 'ENDED');
  assert.equal(finalizeCalls, 1);
  assert.equal(r1.to, 'ENDED');
  assert.equal(r2.to, 'ENDED');

  const third = await lifecycle.signal('complete-requested');
  assert.equal(third.idempotent, true);
  assert.equal(finalizeCalls, 1);
});

test('SR-002-AC09 the session lifecycle module contains no local eligibility, credit, entitlement, concurrency, or session-status authority logic', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/session/session-lifecycle.mjs');
  const source = readFileSync(filePath, 'utf8');
  const forbidden = /\b(?:function|const|let|var)\s+(?:decide|determine|validate|check|calculate|compute|consume|override)(?:LearnerOwnership|Entitlement|Subscription|SessionEligibility|SessionCredit|CreditEligibility|WeeklyEligibility|Concurrency|SessionStatus)\b/i;
  assert.equal(forbidden.test(source), false);
});

test('SR-002-AC10 a transition failing due to platform-terminal conflict returns a stable normalized error with no partial success', async () => {
  const lifecycle = makeLifecycle();
  await lifecycle.signal('activity-ready');
  lifecycle.reconcilePlatformState({ status: 'terminal' });
  await assert.rejects(() => lifecycle.signal('activity-ready'), (e) => {
    assert.equal(e instanceof SessionLifecycleError, true);
    assert.equal(e.code, 'SESSION_ALREADY_ENDED');
    return true;
  });
  assert.equal(lifecycle.state, 'ENDED');
});

test('SR-002-AC11 lifecycle transition telemetry is safe: from/to/category/correlation only, no behavioral history', async () => {
  const events = [];
  const lifecycle = makeLifecycle({ onTelemetry: (e) => events.push(e) });
  await lifecycle.signal('activity-ready');
  await assert.rejects(() => lifecycle.signal('complete-requested').then(() => lifecycle.signal('activity-ready')), (e) => e.code === 'SESSION_ALREADY_ENDED');

  assert.equal(events.length, 3);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['category', 'correlationId', 'event', 'fromState', 'sessionId', 'timestamp', 'toState']);
    assert.equal(event.correlationId, 'corr-1');
    assert.equal(event.sessionId, 'session-1');
    assert.equal(typeof event.timestamp, 'number');
    const serialized = JSON.stringify(event).toLowerCase();
    for (const forbidden of ['learner-1', 'answer', 'score', 'content']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  }
});
