import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { runAtomicBootstrap, bootstrapReadyApp, BootstrapError } from '../../src/container/internal/bootstrap/atomic-bootstrap.mjs';
import { RuntimeBindingError } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';

function manifestFixture(overrides = {}) {
  return {
    appId: 'magical-math',
    appVersion: '1.0.0',
    containerContractVersion: '1.0',
    contentVersion: '1.0.0',
    progressSchemaVersion: '1.0',
    requiredCapabilities: ['progress'],
    optionalCapabilities: ['audio'],
    entryPoint: './index.mjs',
    ...overrides,
  };
}

const manifestOptions = Object.freeze({ supportedContractVersions: ['1.0'], approvedExtensionPoints: [] });

const baseClaims = Object.freeze({
  learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1'
});
const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
const envelope = (claims = baseClaims) => ({ claims: structuredClone(claims), proof: proof(claims) });
const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });
const launchOptions = Object.freeze({ expectedReleaseId: 'release-1', expectedSessionId: 'session-1', verifier, now: () => new Date('2026-08-18T00:10:00.000Z') });

const progressAdapter = Object.freeze({ progress: { version: '1.0', write: async () => 'ok' } });
const allCapabilityAdapters = Object.freeze({ progress: { version: '1.0', write: async () => 'ok' }, audio: { version: '1.0', play: async () => 'ok' } });

function baseOptions(overrides = {}) {
  return {
    manifestInput: manifestFixture(),
    manifestOptions,
    launchContext: envelope(),
    launchOptions,
    capabilityAdapters: progressAdapter,
    coreServices: [],
    ...overrides,
  };
}

test('SB-003-AC01 all mandatory dependencies valid reaches READY and only then executes the app entry point', async () => {
  let executed = false;
  const { readiness, app } = await bootstrapReadyApp({ ...baseOptions({ capabilityAdapters: allCapabilityAdapters }), loadApp: async (r) => { executed = true; assert.equal(r.phase, 'READY'); return 'loaded'; } });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.phase, 'READY');
  assert.equal(executed, true);
  assert.equal(app, 'loaded');
});

test('SB-003-AC02 invalid/incompatible app manifest fails closed before any app-specific execution', async () => {
  let executed = false;
  await assert.rejects(
    () => bootstrapReadyApp({ ...baseOptions({ manifestInput: manifestFixture({ containerContractVersion: '9.9' }) }), loadApp: async () => { executed = true; } }),
    (e) => e instanceof BootstrapError && e.code === 'BOOTSTRAP_INCOMPATIBLE' && e.phase === 'LOAD_MANIFEST'
  );
  assert.equal(executed, false);
});

test('SB-003-AC03 authorized launch-context validation failure fails closed before app execution', async () => {
  let executed = false;
  const expiredClaims = { ...baseClaims, expiresAt: '2026-08-18T00:05:00.000Z' };
  await assert.rejects(
    () => bootstrapReadyApp({ ...baseOptions({ launchContext: envelope(expiredClaims) }), loadApp: async () => { executed = true; } }),
    (e) => e instanceof BootstrapError && e.code === 'BOOTSTRAP_REQUIRED_DEPENDENCY_FAILED' && e.phase === 'VALIDATE_LAUNCH' && e.metadata.category === 'LAUNCH_CONTEXT_EXPIRED'
  );
  assert.equal(executed, false);
});

test('SB-003-AC04 runtime that cannot be bound fails readiness without exposing a partial runtime', async () => {
  let executed = false;
  const bindRuntime = () => { throw new RuntimeBindingError('RUNTIME_CONTEXT_INVALID', 'cannot bind'); };
  await assert.rejects(
    () => bootstrapReadyApp({ ...baseOptions({ bindRuntime }), loadApp: async () => { executed = true; } }),
    (e) => e instanceof BootstrapError && e.code === 'BOOTSTRAP_REQUIRED_DEPENDENCY_FAILED' && e.phase === 'BIND_RUNTIME'
  );
  assert.equal(executed, false);
});

test('SB-003-AC05 unavailable required capability blocks launch with a normalized error', async () => {
  let executed = false;
  await assert.rejects(
    () => bootstrapReadyApp({ ...baseOptions({ capabilityAdapters: {} }), loadApp: async () => { executed = true; } }),
    (e) => e instanceof BootstrapError && e.code === 'BOOTSTRAP_CAPABILITY_UNAVAILABLE' && e.phase === 'RESOLVE_CAPABILITIES' && e.metadata.capability === 'progress' && e.metadata.required === true
  );
  assert.equal(executed, false);
});

test('SB-003-AC06 unavailable optional capability with an approved fallback continues and records degradation', async () => {
  const { readiness } = await bootstrapReadyApp({ ...baseOptions({ approvedFallbacks: { audio: { mode: 'silent' } } }), loadApp: async (r) => r });
  assert.equal(readiness.ok, true);
  assert.deepEqual(readiness.degradedCapabilities, ['audio']);
});

test('SB-003-AC07 unavailable optional capability with no approved fallback fails bootstrap', async () => {
  let executed = false;
  await assert.rejects(
    () => bootstrapReadyApp({ ...baseOptions(), loadApp: async () => { executed = true; } }),
    (e) => e instanceof BootstrapError && e.code === 'BOOTSTRAP_CAPABILITY_UNAVAILABLE' && e.phase === 'RESOLVE_CAPABILITIES' && e.metadata.capability === 'audio' && e.metadata.required === false
  );
  assert.equal(executed, false);
});

test('SB-003-P1 a caller-supplied fallback for a capability the governance registry has not approved still blocks READY', async () => {
  // "narration" is an approved manifest capability (CC-002) so it survives manifest
  // resolution as a real optional capability, but it is not in the trusted
  // degraded-capability governance registry - a caller-supplied fallback for it must not
  // be able to grant its own degradation approval.
  let executed = false;
  await assert.rejects(
    () => bootstrapReadyApp({
      ...baseOptions({ manifestInput: manifestFixture({ optionalCapabilities: ['narration'] }), approvedFallbacks: { narration: { mode: 'silent' } } }),
      loadApp: async () => { executed = true; },
    }),
    (e) => e instanceof BootstrapError && e.code === 'BOOTSTRAP_CAPABILITY_UNAVAILABLE' && e.metadata.capability === 'narration' && e.metadata.required === false
  );
  assert.equal(executed, false);
});

test('SB-003-AC08 mandatory container service init failure blocks launch and never enters a partial runtime', async () => {
  let executed = false;
  const coreServices = [{ name: 'sessionRegistration', init: async () => { throw new Error('database credentials leaked here'); } }];
  await assert.rejects(
    () => bootstrapReadyApp({ ...baseOptions({ approvedFallbacks: { audio: {} }, coreServices }), loadApp: async () => { executed = true; } }),
    (e) => {
      assert.equal(e instanceof BootstrapError, true);
      assert.equal(e.code, 'BOOTSTRAP_SERVICE_INIT_FAILED');
      assert.equal(e.phase, 'INIT_CORE_SERVICES');
      assert.equal(e.metadata.service, 'sessionRegistration');
      assert.equal(e.message.includes('database credentials'), false);
      return true;
    }
  );
  assert.equal(executed, false);
});

test('SB-003-AC09 retry after a transient failure creates no duplicate session/credit/authoritative write', async () => {
  const writesLog = [];
  const ledger = new Map();
  let shouldFailSessionService = true;
  const coreServices = [
    { name: 'progressSync', init: async () => { writesLog.push('progressSync'); } },
    { name: 'sessionRegistration', init: async () => { if (shouldFailSessionService) throw new Error('transient'); writesLog.push('sessionRegistration'); } },
  ];
  const options = baseOptions({ approvedFallbacks: { audio: {} }, coreServices, idempotencyKey: 'learner-1:session-1', ledger });

  await assert.rejects(() => runAtomicBootstrap(options), (e) => e.code === 'BOOTSTRAP_SERVICE_INIT_FAILED');
  assert.deepEqual(writesLog, ['progressSync']);

  shouldFailSessionService = false;
  const readiness = await runAtomicBootstrap(options);
  assert.equal(readiness.ok, true);
  assert.deepEqual(writesLog, ['progressSync', 'sessionRegistration']);
  assert.deepEqual(readiness.services, ['progressSync', 'sessionRegistration']);
});

test('SB-003-AC10 retried initialization leaves no duplicate event handlers/listeners/timers active', async () => {
  const ledger = new Map();
  let activeListeners = 0;
  let shouldFailSecondService = true;
  const coreServices = [
    { name: 'eventBus', init: async () => { activeListeners += 1; return () => { activeListeners -= 1; }; } },
    { name: 'downstream', init: async () => { if (shouldFailSecondService) throw new Error('transient'); } },
  ];
  const options = baseOptions({ approvedFallbacks: { audio: {} }, coreServices, idempotencyKey: 'learner-1:session-1', ledger });

  await assert.rejects(() => runAtomicBootstrap(options), (e) => e.code === 'BOOTSTRAP_SERVICE_INIT_FAILED');
  assert.equal(activeListeners, 0);

  shouldFailSecondService = false;
  const readiness = await runAtomicBootstrap(options);
  assert.equal(readiness.ok, true);
  assert.equal(activeListeners, 1);
});

test('SB-001-P0 the mandatory bootstrap path uses the production Babysteps verifier by default when none is supplied', async (t) => {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  delete publicJwk.d;
  const kid = 'key-2026-08';

  const priorKeys = process.env.BABYSTEPS_LAUNCH_PUBLIC_KEYS;
  process.env.BABYSTEPS_LAUNCH_PUBLIC_KEYS = JSON.stringify({ [kid]: publicJwk });
  t.after(() => {
    if (priorKeys === undefined) delete process.env.BABYSTEPS_LAUNCH_PUBLIC_KEYS;
    else process.env.BABYSTEPS_LAUNCH_PUBLIC_KEYS = priorKeys;
  });

  const sign = async (claims) => {
    const data = new TextEncoder().encode(JSON.stringify(claims, Object.keys(claims).sort()));
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, data);
    return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const productionEnvelope = { claims: structuredClone(baseClaims), proof: await sign(baseClaims), kid };

  const { verifier: _ignoredTestVerifier, ...launchOptionsWithoutVerifier } = launchOptions;
  void _ignoredTestVerifier;

  const readiness = await runAtomicBootstrap(baseOptions({
    launchContext: productionEnvelope,
    launchOptions: launchOptionsWithoutVerifier,
    approvedFallbacks: { audio: {} },
  }));
  assert.equal(readiness.ok, true);
});

test('SB-003-AC11 bootstrap failure telemetry identifies phase/category without exposing learner data', async () => {
  const coreServices = [{ name: 'sessionRegistration', init: async () => { throw new Error('boom'); } }];
  let caught;
  try {
    await runAtomicBootstrap(baseOptions({ approvedFallbacks: { audio: {} }, coreServices }));
  } catch (e) {
    caught = e;
  }
  assert.equal(caught.phase, 'INIT_CORE_SERVICES');
  assert.equal(caught.code, 'BOOTSTRAP_SERVICE_INIT_FAILED');
  assert.equal(caught.metadata.correlationId, 'corr-1');
  assert.equal(typeof caught.metadata.durationMs, 'number');
  const serialized = JSON.stringify(caught).toLowerCase();
  for (const forbidden of ['learner-1', 'parent', 'payment', 'billing', 'subscription']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
