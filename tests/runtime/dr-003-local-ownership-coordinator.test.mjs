import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createLocalOwnershipCoordinator, createInMemoryLockAdapter, LocalOwnershipError } from '../../src/container/internal/runtime/local-ownership-coordinator.mjs';

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

test('DR-003-AC01 the same authorized session opened in two tabs yields exactly one owner', async () => {
  const bindingA = await boundRuntime();
  const bindingB = await boundRuntime();
  const lockAdapter = createInMemoryLockAdapter();
  const tabA = createLocalOwnershipCoordinator({ runtimeBinding: bindingA, lockAdapter });
  const tabB = createLocalOwnershipCoordinator({ runtimeBinding: bindingB, lockAdapter });

  await tabA.acquire();
  await assert.rejects(() => tabB.acquire(), (e) => e instanceof LocalOwnershipError && e.code === 'LOCAL_RUNTIME_ALREADY_ACTIVE');

  assert.equal(tabA.state, 'OWNING');
  assert.equal(tabB.state, 'NON_OWNING');
});

test('DR-003-AC02 only the owning tab may proceed past the session-affecting guard', async () => {
  const bindingA = await boundRuntime();
  const bindingB = await boundRuntime();
  const lockAdapter = createInMemoryLockAdapter();
  const tabA = createLocalOwnershipCoordinator({ runtimeBinding: bindingA, lockAdapter });
  const tabB = createLocalOwnershipCoordinator({ runtimeBinding: bindingB, lockAdapter });
  await tabA.acquire();
  await tabB.acquire().catch(() => {});

  assert.doesNotThrow(() => tabA.guard('connected-time-accumulate'));
  assert.throws(() => tabB.guard('connected-time-accumulate'), (e) => e.code === 'LOCAL_RUNTIME_ALREADY_ACTIVE');
});

test('DR-003-AC03 a non-owning duplicate tab cannot reach actionable progress/activity/finalization', async () => {
  const bindingA = await boundRuntime();
  const bindingB = await boundRuntime();
  const lockAdapter = createInMemoryLockAdapter();
  const tabA = createLocalOwnershipCoordinator({ runtimeBinding: bindingA, lockAdapter });
  const tabB = createLocalOwnershipCoordinator({ runtimeBinding: bindingB, lockAdapter });
  await tabA.acquire();
  await tabB.acquire().catch(() => {});

  for (const action of ['activity-progress', 'progress-checkpoint', 'session-finalize']) {
    assert.throws(() => tabB.guard(action), (e) => e.code === 'LOCAL_RUNTIME_ALREADY_ACTIVE');
  }
});

test('DR-003-AC04 a waiting context may acquire ownership after the owner closes only once resume is validated', async () => {
  const bindingA = await boundRuntime();
  const bindingB = await boundRuntime();
  const lockAdapter = createInMemoryLockAdapter();
  const tabA = createLocalOwnershipCoordinator({ runtimeBinding: bindingA, lockAdapter });
  const tabB = createLocalOwnershipCoordinator({ runtimeBinding: bindingB, lockAdapter });
  await tabA.acquire();
  tabA.release('TAB_CLOSED');

  const result = await tabB.attemptTakeover({ validateResumable: async () => ({ authorized: true }) });
  assert.equal(result.owning, true);
  assert.equal(tabB.state, 'OWNING');
});

test('DR-003-AC05 Babysteps denying resume during takeover keeps the waiting context inactive', async () => {
  const bindingA = await boundRuntime();
  const bindingB = await boundRuntime();
  const lockAdapter = createInMemoryLockAdapter();
  const tabA = createLocalOwnershipCoordinator({ runtimeBinding: bindingA, lockAdapter });
  const tabB = createLocalOwnershipCoordinator({ runtimeBinding: bindingB, lockAdapter });
  await tabA.acquire();
  tabA.release('TAB_CLOSED');

  await assert.rejects(
    () => tabB.attemptTakeover({ validateResumable: async () => ({ authorized: false }) }),
    (e) => e.code === 'LOCAL_TAKEOVER_DENIED'
  );
  assert.notEqual(tabB.state, 'OWNING');
});

test('DR-003-AC06 two tabs with different sessions/learners do not block each other', async () => {
  const bindingA = await boundRuntime({ ...baseClaims, sessionId: 'session-a' });
  const bindingB = await boundRuntime({ ...baseClaims, learnerId: 'learner-2', sessionId: 'session-b' });
  const lockAdapter = createInMemoryLockAdapter();
  const coordinatorA = createLocalOwnershipCoordinator({ runtimeBinding: bindingA, lockAdapter });
  const coordinatorB = createLocalOwnershipCoordinator({ runtimeBinding: bindingB, lockAdapter });

  await coordinatorA.acquire();
  await coordinatorB.acquire();

  assert.equal(coordinatorA.state, 'OWNING');
  assert.equal(coordinatorB.state, 'OWNING');
});

test('DR-003-AC07 repeated ownership acquisition attempts are idempotent', async () => {
  const binding = await boundRuntime();
  const lockAdapter = createInMemoryLockAdapter();
  const coordinator = createLocalOwnershipCoordinator({ runtimeBinding: binding, lockAdapter });
  const first = await coordinator.acquire();
  const second = await coordinator.acquire();
  const third = await coordinator.acquire();
  assert.equal(first.owning, true);
  assert.equal(second.alreadyOwning, true);
  assert.equal(third.alreadyOwning, true);
});

test('DR-003-AC08 a missing preferred lock primitive uses a tested fallback or fails safely', async () => {
  const binding = await boundRuntime();
  const alwaysUnavailable = async () => null;
  const fallback = createInMemoryLockAdapter();
  const withFallback = createLocalOwnershipCoordinator({ runtimeBinding: binding, lockAdapter: alwaysUnavailable, fallbackLockAdapter: fallback });
  const result = await withFallback.acquire();
  assert.equal(result.owning, true);

  const bindingNoAdapters = await boundRuntime({ ...baseClaims, sessionId: 'session-no-adapters' });
  const withoutAnyAdapter = createLocalOwnershipCoordinator({ runtimeBinding: bindingNoAdapters });
  await assert.rejects(() => withoutAnyAdapter.acquire(), (e) => e.code === 'LOCAL_OWNERSHIP_UNAVAILABLE');
});

test('DR-003-AC09 local ownership does not override an authoritative session-inactive result', async () => {
  const binding = await boundRuntime();
  const lockAdapter = createInMemoryLockAdapter();
  const coordinator = createLocalOwnershipCoordinator({ runtimeBinding: binding, lockAdapter });
  await coordinator.acquire();
  coordinator.reportAuthoritativeSessionState('inactive');
  assert.throws(() => coordinator.guard('connected-time-accumulate'), (e) => e.code === 'LOCAL_RUNTIME_ALREADY_ACTIVE');
});

test('DR-003-AC10 no recurring server heartbeat is introduced while multiple tabs remain open', async () => {
  const bindingA = await boundRuntime();
  const bindingB = await boundRuntime();
  const lockAdapter = createInMemoryLockAdapter();
  const events = [];
  const tabA = createLocalOwnershipCoordinator({ runtimeBinding: bindingA, lockAdapter, onTelemetry: (e) => events.push(e) });
  const tabB = createLocalOwnershipCoordinator({ runtimeBinding: bindingB, lockAdapter, onTelemetry: (e) => events.push(e) });
  await tabA.acquire();
  await tabB.acquire().catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 30));
  const countAfterSettle = events.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events.length, countAfterSettle);
});

test('DR-003-AC11 only coarse ownership telemetry is emitted, without detailed learner identifiers', async () => {
  const binding = await boundRuntime();
  const events = [];
  const lockAdapter = createInMemoryLockAdapter();
  const coordinator = createLocalOwnershipCoordinator({ runtimeBinding: binding, lockAdapter, onTelemetry: (e) => events.push(e) });
  await coordinator.acquire();
  coordinator.release('MANUAL_RELEASE');
  assert.ok(events.length >= 2);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'correlationId', 'key', 'reason', 'usedFallback', 'callSite', 'state'].includes(k)));
    assert.equal(event.key.includes(baseClaims.learnerId), false);
    assert.equal(event.key.includes(baseClaims.sessionId), false);
  }
  assert.equal(coordinator.ownershipKey.includes(baseClaims.learnerId), false);
});
