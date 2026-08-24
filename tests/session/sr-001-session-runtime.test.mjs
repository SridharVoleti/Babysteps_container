import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runAtomicBootstrap } from '../../src/container/internal/bootstrap/atomic-bootstrap.mjs';
import {
  initializeSessionRuntime,
  deactivateSessionRuntime,
  scopeToSessionRuntime,
  SessionRuntimeError,
} from '../../src/container/internal/session/session-runtime.mjs';
import { RuntimeBindingError } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

function manifestFixture(overrides = {}) {
  return {
    appId: 'magical-math', appVersion: '1.0.0', containerContractVersion: '1.0',
    contentVersion: '1.0.0', progressSchemaVersion: '1.0', entryPoint: './index.mjs',
    requiredCapabilities: [],
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

async function readyBootstrap() {
  return runAtomicBootstrap({
    manifestInput: manifestFixture(),
    manifestOptions,
    launchContext: envelope(),
    launchOptions,
    capabilityAdapters: {},
    coreServices: [],
  });
}

test('SR-001-AC01 SB-003 READY initializes exactly one learning-session runtime bound to the authorized session', async () => {
  const readiness = await readyBootstrap();
  const runtime = await initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime });
  assert.equal(runtime.sessionId, 'session-1');
  assert.equal(runtime.isActive(), true);
});

test('SR-001-AC02 initialization before READY is rejected and app learning execution does not begin', async () => {
  const readiness = await readyBootstrap();
  const notReady = { ok: false, phase: 'INIT_CORE_SERVICES' };
  await assert.rejects(
    () => initializeSessionRuntime({ readiness: notReady, runtimeBinding: readiness.runtime }),
    (e) => e instanceof SessionRuntimeError && e.code === 'SESSION_RUNTIME_NOT_READY'
  );
});

test('SR-001-AC03 app code cannot create a new Babysteps session directly; only the current-session interface is available', async () => {
  const violations = inspectSource('apps/demo/rogue.mjs', "import { initializeSessionRuntime } from '../../src/container/internal/session/session-runtime.mjs';");
  assert.equal(violations.some((v) => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);

  const readiness = await readyBootstrap();
  const runtime = await initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime });
  assert.deepEqual(Object.keys(runtime).sort(), ['appId', 'isActive', 'learnerId', 'releaseId', 'sessionId']);
});

test('SR-001-AC04 an app attempt to replace the bound sessionId is rejected; the authorized session remains authoritative', async () => {
  const readiness = await readyBootstrap();
  await initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime });
  assert.throws(
    () => scopeToSessionRuntime(readiness.runtime, { sessionId: 'session-evil', value: 1 }),
    (e) => e instanceof RuntimeBindingError && e.code === 'RUNTIME_CONTEXT_MISMATCH'
  );
});

test('SR-001-AC05 repeated initialization from rerender/retry reuses the same logical session runtime', async () => {
  const readiness = await readyBootstrap();
  const [a, b] = await Promise.all([
    initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime }),
    initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime }),
  ]);
  assert.equal(a, b);
  const c = await initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime });
  assert.equal(a, c);
});

test('SR-001-AC06 repeated initialization never duplicates the session-start platform side effect', async () => {
  const readiness = await readyBootstrap();
  let attachCalls = 0;
  const sessionAdapter = { attach: async () => { attachCalls += 1; } };
  await Promise.all([
    initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime, sessionAdapter }),
    initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime, sessionAdapter }),
  ]);
  await initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime, sessionAdapter });
  assert.equal(attachCalls, 1);
});

test('SR-001-AC07 the session runtime module contains no local weekly-eligibility, credit, entitlement, or concurrency-override logic', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/session/session-runtime.mjs');
  const source = readFileSync(filePath, 'utf8');
  const forbidden = /\b(?:function|const|let|var)\s+(?:decide|determine|validate|check|calculate|compute|consume|override)(?:LearnerOwnership|Entitlement|Subscription|SessionEligibility|SessionCredit|CreditEligibility|WeeklyEligibility|Concurrency)\b/i;
  assert.equal(forbidden.test(source), false);
});

test('SR-001-AC08 the public session facade exposes only approved read-only session-scoped information', async () => {
  const readiness = await readyBootstrap();
  const runtime = await initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime });
  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Object.keys(runtime).sort(), ['appId', 'isActive', 'learnerId', 'releaseId', 'sessionId']);
  assert.equal(typeof runtime.isActive, 'function');
  assert.throws(() => { runtime.sessionId = 'other'; }, TypeError);
});

test('SR-001-AC09 an upstream invalid/inactive session result does not cause local reactivation or replacement', async () => {
  const readiness = await readyBootstrap();
  const runtime = await initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime });
  assert.equal(runtime.isActive(), true);

  await deactivateSessionRuntime(readiness.runtime, { reason: 'PLATFORM_SESSION_INVALID' });
  assert.equal(runtime.isActive(), false);

  const same = await initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime });
  assert.equal(same, runtime);
  assert.equal(same.isActive(), false);
});

test('SR-001-AC10 controlled termination cleans up local resources only through an approved platform detach call', async () => {
  const readiness = await readyBootstrap();
  const detachCalls = [];
  const sessionAdapter = { detach: async (identity) => detachCalls.push(identity) };
  const runtime = await initializeSessionRuntime({ readiness, runtimeBinding: readiness.runtime, sessionAdapter });

  await deactivateSessionRuntime(readiness.runtime, { reason: 'CONTROLLED_EXIT', sessionAdapter });
  assert.equal(runtime.isActive(), false);
  assert.equal(detachCalls.length, 1);
  assert.equal(detachCalls[0].sessionId, 'session-1');
  assert.equal(detachCalls[0].reason, 'CONTROLLED_EXIT');

  await deactivateSessionRuntime(readiness.runtime, { reason: 'CONTROLLED_EXIT', sessionAdapter });
  assert.equal(detachCalls.length, 1);
});
