import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import {
  bindAuthorizedRuntime,
  getRuntimeContext,
  isRuntimeActive,
  terminateRuntime,
  requestAuthorityChange,
  scopeAuthorityRequest,
  createScopedPlatformAdapter,
  RuntimeBindingError,
} from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createExtensionManager } from '../../src/container/internal/extensions/index.mjs';

const manifest = Object.freeze({ appId: 'magical-math' });
const baseClaims = Object.freeze({
  learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1'
});
const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
const envelope = (claims = baseClaims) => ({ claims: structuredClone(claims), proof: proof(claims) });
const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });
const launchOpts = { manifest, expectedReleaseId: 'release-1', expectedSessionId: 'session-1', verifier, now: () => new Date('2026-08-18T00:10:00.000Z') };

async function boundRuntime(claims = baseClaims) {
  const opts = { ...launchOpts, expectedReleaseId: claims.releaseId, expectedSessionId: claims.sessionId };
  const runtimeContext = await validateLaunchContext({ launchContext: envelope(claims), ...opts });
  return bindAuthorizedRuntime(runtimeContext);
}

test('SB-002-AC01 valid SB-001 launch binds learner/app/release/session as immutable authoritative identity', async () => {
  const binding = await boundRuntime();
  const identity = getRuntimeContext(binding);
  assert.deepEqual(
    { learnerId: identity.learnerId, appId: identity.appId, releaseId: identity.releaseId, sessionId: identity.sessionId },
    { learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1' }
  );
  assert.equal(Object.isFrozen(identity), true);
  assert.throws(() => { identity.learnerId = 'attacker'; }, TypeError);
});

test('SB-002-AC02 protected service call with a substituted learnerId is rejected and never executes', async () => {
  const binding = await boundRuntime();
  let executed = false;
  const adapter = createScopedPlatformAdapter(binding, { checkpoint: async () => { executed = true; return 'ok'; } });
  await assert.rejects(() => adapter.checkpoint({ learnerId: 'attacker', progress: 42 }), e => e instanceof RuntimeBindingError && e.code === 'RUNTIME_CONTEXT_MISMATCH');
  assert.equal(executed, false);
});

test('SB-002-AC03 attempting to change appId / launch another app inside the runtime is rejected', async () => {
  const binding = await boundRuntime();
  assert.throws(() => requestAuthorityChange(binding, { appId: 'chess-master' }), e => e instanceof RuntimeBindingError && e.code === 'RUNTIME_CONTEXT_MUTATION_DENIED');
  assert.equal(getRuntimeContext(binding).appId, 'magical-math');
});

test('SB-002-AC04 substituted releaseId never becomes authoritative for a platform-facing operation', async () => {
  const binding = await boundRuntime();
  let seenRelease = null;
  const adapter = createScopedPlatformAdapter(binding, { sync: async (req) => { seenRelease = req.releaseId; return 'ok'; } });
  await assert.rejects(() => adapter.sync({ releaseId: 'release-9' }), e => e.code === 'RUNTIME_CONTEXT_MISMATCH');
  assert.equal(seenRelease, null);
});

test('SB-002-AC05 substituted sessionId never receives a progress/session write', async () => {
  const binding = await boundRuntime();
  const store = new Map();
  const adapter = createScopedPlatformAdapter(binding, { writeProgress: async (req) => { store.set(req.sessionId, req.progress); return 'ok'; } });
  await assert.rejects(() => adapter.writeProgress({ sessionId: 'session-evil', progress: 100 }), e => e.code === 'RUNTIME_CONTEXT_MISMATCH');
  assert.equal(store.has('session-evil'), false);
  assert.equal(store.size, 0);
});

test('SB-002-AC06 extension receives only read-only runtime context and cannot mutate authoritative identity', async () => {
  const binding = await boundRuntime();
  const runtimeContext = getRuntimeContext(binding);
  const manifestWithExtension = Object.freeze({ appId: 'magical-math', extensionPoints: ['activity-renderer'] });
  const manager = createExtensionManager({ manifest: manifestWithExtension, runtimeContext });

  let received;
  await manager.register({
    type: 'activity-renderer', version: '1.0', id: 'vedic-card',
    initialize: async (ctx) => { received = ctx.runtimeContext; return {}; }
  });

  assert.equal(received.learnerId, 'learner-1');
  assert.equal(Object.isFrozen(received), true);
  assert.throws(() => { received.learnerId = 'attacker'; }, TypeError);
  assert.equal(typeof received.terminate, 'undefined');
});

test('SB-002-AC07 caller-supplied learnerId on a progress/checkpoint request is ignored and no cross-learner write occurs', async () => {
  const binding = await boundRuntime();
  const store = new Map();
  const adapter = createScopedPlatformAdapter(binding, { checkpoint: async (req) => { store.set(req.learnerId, req.value); return 'ok'; } });
  await assert.rejects(() => adapter.checkpoint({ learnerId: 'other-learner', value: 7 }), e => e.code === 'RUNTIME_CONTEXT_MISMATCH');
  assert.equal(store.has('other-learner'), false);

  await adapter.checkpoint({ value: 7 });
  assert.equal(store.get('learner-1'), 7);
});

test('SB-002-AC08 session completion is automatically scoped to the bound session, not app-selected', async () => {
  const binding = await boundRuntime();
  let usedSessionId = null;
  const adapter = createScopedPlatformAdapter(binding, { complete: async (req) => { usedSessionId = req.sessionId; return 'ok'; } });
  await adapter.complete({});
  assert.equal(usedSessionId, 'session-1');
});

test('SB-002-AC09 switching learner/app/release/session requires terminating the runtime and a new authorized launch', async () => {
  const binding = await boundRuntime();
  assert.throws(() => requestAuthorityChange(binding, { learnerId: 'learner-2' }), e => e.code === 'RUNTIME_CONTEXT_MUTATION_DENIED');

  const termination = terminateRuntime(binding);
  assert.equal(termination.ok, true);
  assert.equal(isRuntimeActive(binding), false);
  assert.throws(() => getRuntimeContext(binding), e => e.code === 'RUNTIME_CONTEXT_INACTIVE');
  assert.throws(() => scopeAuthorityRequest(binding, {}), e => e.code === 'RUNTIME_CONTEXT_INACTIVE');

  const newClaims = { ...baseClaims, learnerId: 'learner-2', sessionId: 'session-2', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z' };
  const newBinding = await boundRuntime(newClaims);
  assert.equal(isRuntimeActive(newBinding), true);
  assert.equal(getRuntimeContext(newBinding).learnerId, 'learner-2');
});

test('SB-002-AC10 no progress/learning state leaks or mixes across learners after a rejected mismatch attempt', async () => {
  const bindingA = await boundRuntime();
  const claimsB = { ...baseClaims, learnerId: 'learner-2', sessionId: 'session-2' };
  const bindingB = await boundRuntime(claimsB);

  const sharedStore = new Map();
  const adapterFor = (binding) => createScopedPlatformAdapter(binding, {
    save: async (req) => { sharedStore.set(req.learnerId, req.value); return 'ok'; }
  });

  await adapterFor(bindingA).save({ value: 'A-progress' });
  assert.equal(sharedStore.get('learner-1'), 'A-progress');
  assert.equal(sharedStore.has('learner-2'), false);

  await assert.rejects(() => adapterFor(bindingA).save({ learnerId: 'learner-2', value: 'stolen' }), e => e.code === 'RUNTIME_CONTEXT_MISMATCH');
  assert.equal(sharedStore.has('learner-2'), false);
  assert.equal(sharedStore.get('learner-1'), 'A-progress');

  await adapterFor(bindingB).save({ value: 'B-progress' });
  assert.equal(sharedStore.get('learner-2'), 'B-progress');
  assert.equal(sharedStore.get('learner-1'), 'A-progress');
});
