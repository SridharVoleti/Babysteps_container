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
  createResumeCoordinator,
  SessionResumeError,
} from '../../src/container/internal/session/session-interruption.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

const manifest = Object.freeze({ appId: 'magical-math' });
const baseClaims = Object.freeze({
  learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1'
});
const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
const envelope = (claims = baseClaims) => ({ claims: structuredClone(claims), proof: proof(claims) });
const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });
const launchOpts = { manifest, expectedReleaseId: 'release-1', expectedSessionId: 'session-1', verifier, now: () => new Date('2026-08-18T00:10:00.000Z') };

async function boundRuntime() {
  const runtimeContext = await validateLaunchContext({ launchContext: envelope(), ...launchOpts });
  return bindAuthorizedRuntime(runtimeContext);
}

const operations = Object.freeze({
  'session.resume': {
    method: 'POST', path: '/v1/session/resume', authorityFields: ['learnerId', 'sessionId'],
    parseResponse: (body) => (body && typeof body.authorized === 'boolean') ? { ok: true, data: { authorized: body.authorized } } : { ok: false },
  },
});

async function buildHarness({ transport, recoveryAdapter } = {}) {
  const binding = await boundRuntime();
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
  const resumeClient = createProtectedApiClient({ apiClient, authContext, runtimeBinding: binding });

  const sessionIdentity = getRuntimeContext(binding);
  const lifecycle = createSessionLifecycle({ sessionIdentity });
  await lifecycle.signal('activity-ready');

  const events = [];
  const coordinator = createResumeCoordinator({ sessionIdentity, lifecycle, resumeClient, recoveryAdapter, onTelemetry: (e) => events.push(e) });

  return { binding, sessionIdentity, lifecycle, coordinator, calls, events };
}

function resumeCalls(calls) { return calls.filter((c) => c.url.endsWith('/v1/session/resume')); }

test('SR-005-AC01 an interruption from page refresh is treated as the existing session flow, not a new session', async () => {
  const { sessionIdentity, lifecycle, coordinator } = await buildHarness({
    transport: async () => ({ status: 200, body: { authorized: true } }),
  });
  await coordinator.interrupt('PAGE_REFRESH');
  assert.equal(lifecycle.state, 'RECOVERING');
  const result = await coordinator.resume();
  assert.equal(result.authorized, true);
  assert.deepEqual(result.sessionIdentity, sessionIdentity);
  assert.equal(lifecycle.state, 'ACTIVE');
});

test('SR-005-AC02 resume eligibility is obtained through the approved resume contract before learning continues', async () => {
  let resolvedBeforeActive = null;
  const { lifecycle, coordinator } = await buildHarness({
    transport: async () => { resolvedBeforeActive = lifecycle.state; return { status: 200, body: { authorized: true } }; },
  });
  await coordinator.interrupt('APP_CLOSED');
  await coordinator.resume();
  assert.equal(resolvedBeforeActive, 'RECOVERING');
  assert.equal(lifecycle.state, 'ACTIVE');
});

test('SR-005-AC03 suspension resumes the same session only when Babysteps permits it, never a replacement session', async () => {
  const { sessionIdentity, lifecycle, coordinator } = await buildHarness({
    transport: async () => ({ status: 200, body: { authorized: false } }),
  });
  await coordinator.interrupt('BROWSER_SUSPENDED');
  await assert.rejects(() => coordinator.resume(), (e) => e instanceof SessionResumeError && e.code === 'SESSION_RESUME_DENIED');
  assert.equal(lifecycle.state, 'ENDED');
  assert.equal(sessionIdentity.sessionId, 'session-1');
});

test('SR-005-AC04 connectivity loss/restore does not create a replacement session and follows the resume path', async () => {
  const { lifecycle, coordinator } = await buildHarness({
    transport: async () => ({ status: 200, body: { authorized: true } }),
  });
  await coordinator.interrupt('CONNECTIVITY_LOST');
  const result = await coordinator.resume();
  assert.equal(result.authorized, true);
  assert.equal(lifecycle.state, 'ACTIVE');
});

test('SR-005-AC05 an authorized resume restores the exact same learnerId, appId, releaseId and sessionId', async () => {
  const { sessionIdentity, coordinator } = await buildHarness({
    transport: async () => ({ status: 200, body: { authorized: true } }),
  });
  await coordinator.interrupt('APP_CLOSED');
  const result = await coordinator.resume();
  assert.equal(result.sessionIdentity.learnerId, sessionIdentity.learnerId);
  assert.equal(result.sessionIdentity.appId, sessionIdentity.appId);
  assert.equal(result.sessionIdentity.releaseId, sessionIdentity.releaseId);
  assert.equal(result.sessionIdentity.sessionId, sessionIdentity.sessionId);
});

test('SR-005-AC06 a denied/expired resume is never recreated, extended, substituted, or locally reactivated', async () => {
  const { lifecycle, coordinator } = await buildHarness({
    transport: async () => ({ status: 200, body: { authorized: false } }),
  });
  await coordinator.interrupt('APP_CLOSED');
  await assert.rejects(() => coordinator.resume(), (e) => e.code === 'SESSION_RESUME_DENIED');
  assert.equal(lifecycle.state, 'ENDED');

  await assert.rejects(() => coordinator.resume(), (e) => e instanceof SessionResumeError && e.code === 'SESSION_RESUME_DENIED' && e.metadata.idempotent === true);
  assert.equal(lifecycle.state, 'ENDED');
});

test('SR-005-AC07 no local elapsed-time or hard-coded resume-window eligibility logic exists in the coordinator', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/session/session-interruption.mjs');
  const source = readFileSync(filePath, 'utf8');
  const forbidden = /\b(?:function|const|let|var)\s+(?:decide|determine|validate|check|calculate|compute|consume|override)(?:LearnerOwnership|Entitlement|Subscription|SessionEligibility|SessionCredit|CreditEligibility|WeeklyEligibility|Concurrency|SessionStatus|ResumeEligibility|ResumeWindow)\b/i;
  assert.equal(forbidden.test(source), false);
  assert.equal(/elapsed/i.test(source), false);
  assert.equal(/Date\.now\(\)/.test(source), false);
});

test('SR-005-AC08 resuming with a different learner/session identifier is rejected; no cross-learner/session runtime is created', async () => {
  const { coordinator, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { authorized: true } }),
  });
  await coordinator.interrupt('APP_CLOSED');
  await assert.rejects(
    () => coordinator.resume({ sessionId: 'session-evil' }),
    (e) => e instanceof SessionResumeError && e.code === 'SESSION_RESUME_CONTEXT_MISMATCH'
  );
  assert.equal(resumeCalls(calls).length, 0);
});

test('SR-005-AC09 concurrent/duplicate resume requests converge to at most one logical resumed runtime', async () => {
  const { lifecycle, coordinator, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { authorized: true } }),
  });
  await coordinator.interrupt('APP_CLOSED');
  const [r1, r2] = await Promise.all([coordinator.resume(), coordinator.resume()]);
  assert.deepEqual(r1.sessionIdentity, r2.sessionIdentity);
  assert.equal(resumeCalls(calls).length, 1);
  assert.equal(lifecycle.state, 'ACTIVE');
});

test('SR-005-AC10 repeated resume handling causes no additional session-start, credit, or duplicated progress effect', async () => {
  let restoreCalls = 0;
  const { coordinator, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { authorized: true } }),
    recoveryAdapter: { restore: async () => { restoreCalls += 1; return { checkpoint: 'lesson-3' }; } },
  });
  await coordinator.interrupt('APP_CLOSED');
  await coordinator.resume();
  await coordinator.resume();
  await coordinator.resume();

  assert.equal(resumeCalls(calls).length, 1);
  assert.equal(restoreCalls, 1);
});

test('SR-005-AC11 checkpoint/state restoration is delegated to the approved Progress & Recovery Adapter, not implemented locally', async () => {
  const recoveredPayload = Object.freeze({ checkpoint: 'lesson-5', position: 42 });
  let receivedIdentity = null;
  const { sessionIdentity, coordinator } = await buildHarness({
    transport: async () => ({ status: 200, body: { authorized: true } }),
    recoveryAdapter: { restore: async (identity) => { receivedIdentity = identity; return recoveredPayload; } },
  });
  await coordinator.interrupt('APP_CLOSED');
  const result = await coordinator.resume();
  assert.deepEqual(result.recoveredState, recoveredPayload);
  assert.equal(receivedIdentity.sessionId, sessionIdentity.sessionId);
});
