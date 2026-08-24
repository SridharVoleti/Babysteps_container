import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { createAuthenticatedRequestContext, createProtectedApiClient } from '../../src/container/internal/api/authenticated-request-context.mjs';
import { defineApiContract } from '../../src/container/internal/api/contract-validation.mjs';
import { createSessionLifecycle } from '../../src/container/internal/session/session-lifecycle.mjs';
import {
  createSessionCompletion,
  createFinalizationAdapter,
  SessionCompletionError,
} from '../../src/container/internal/session/session-completion.mjs';
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

async function boundRuntime(claims = baseClaims) {
  const opts = { ...launchOpts, expectedReleaseId: claims.releaseId, expectedSessionId: claims.sessionId, manifest: Object.freeze({ appId: claims.appId }) };
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
    retry: { maxAttempts: 3, retryableStatuses: [503], timeoutMs: 30 },
    parseResponse: finalizeContract.parseResponse,
  },
});

async function buildHarness({ transport, claims = baseClaims } = {}) {
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
  const completionEvents = [];
  const completion = createSessionCompletion({ sessionIdentity, lifecycle, onTelemetry: (e) => completionEvents.push(e) });

  return { binding, sessionIdentity, lifecycle, completion, calls, completionEvents };
}

function finalizeCalls(calls) { return calls.filter((c) => c.url.endsWith('/v1/session/finalize')); }
function progressCalls(calls) { return calls.filter((c) => c.url.endsWith('/v1/progress')); }

test('SR-004-AC01 an app completion signal begins the standard completion handoff for the bound session', async () => {
  const { lifecycle, completion } = await buildHarness({
    transport: async () => ({ status: 200, body: { contractVersion: '1.0', finalStatus: 'completed', sessionId: 'session-1' } }),
  });
  await lifecycle.signal('activity-ready');
  const result = await completion.complete({});
  assert.equal(result.finalStatus, 'completed');
  assert.equal(lifecycle.state, 'ENDED');
});

test('SR-004-AC02 eligible final progress is submitted through the approved shared progress path', async () => {
  const { lifecycle, completion, calls } = await buildHarness({
    transport: async (req) => req.url.endsWith('/v1/progress')
      ? { status: 200, body: { saved: true } }
      : { status: 200, body: { contractVersion: '1.0', finalStatus: 'completed', sessionId: 'session-1' } },
  });
  await lifecycle.signal('activity-ready');
  await completion.complete({ score: 95, streak: 3 });

  assert.equal(progressCalls(calls).length, 1);
  assert.equal(progressCalls(calls)[0].body.score, 95);
  assert.equal(progressCalls(calls)[0].body.learnerId, 'learner-1');
  assert.equal(finalizeCalls(calls).length, 1);
});

test('SR-004-AC03 finalization is invoked using the bound authorized session context and container-controlled authentication', async () => {
  const { lifecycle, completion, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { contractVersion: '1.0', finalStatus: 'completed', sessionId: 'session-1' } }),
  });
  await lifecycle.signal('activity-ready');
  await completion.complete({});

  const [finalizeReq] = finalizeCalls(calls);
  assert.equal(finalizeReq.body.learnerId, 'learner-1');
  assert.equal(finalizeReq.body.sessionId, 'session-1');
  assert.equal(finalizeReq.headers.Authorization, 'Bearer container-controlled-token');
});

test('SR-004-AC04 app-specific code cannot call the Babysteps finalization endpoint directly', () => {
  const violations = inspectSource('apps/demo/rogue-finalize.mjs', "fetch('https://api.babysteps.com/v1/session/finalize', { method: 'POST' });");
  assert.equal(violations.some((v) => v.code === 'DIRECT_BABYSTEPS_API_CALL'), true);

  const privateImport = inspectSource('apps/demo/rogue-import.mjs', "import { createSessionCompletion } from '../../src/container/internal/session/session-completion.mjs';");
  assert.equal(privateImport.some((v) => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);
});

test('SR-004-AC05 the authoritative finalization result is used and the lifecycle transitions consistently with SR-002', async () => {
  const { lifecycle, completion } = await buildHarness({
    transport: async () => ({ status: 200, body: { contractVersion: '1.0', finalStatus: 'partial', sessionId: 'session-1' } }),
  });
  await lifecycle.signal('activity-ready');
  const result = await completion.complete({});
  assert.deepEqual(result, { finalStatus: 'partial', sessionId: 'session-1' });
  assert.equal(lifecycle.state, 'ENDED');
});

test('SR-004-AC06 no local credit/duration/entitlement/final-status calculation exists in the completion module', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/session/session-completion.mjs');
  const source = readFileSync(filePath, 'utf8');
  const forbidden = /\b(?:function|const|let|var)\s+(?:decide|determine|validate|check|calculate|compute|consume|override)(?:LearnerOwnership|Entitlement|Subscription|SessionEligibility|SessionCredit|CreditEligibility|WeeklyEligibility|Concurrency|SessionStatus|SessionDuration|FinalStatus)\b/i;
  assert.equal(forbidden.test(source), false);
});

test('SR-004-AC07 duplicate completion events (double-click) produce only one logical completion/finalization sequence', async () => {
  const { lifecycle, completion, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { contractVersion: '1.0', finalStatus: 'completed', sessionId: 'session-1' } }),
  });
  await lifecycle.signal('activity-ready');
  const [r1, r2] = await Promise.all([completion.complete({}), completion.complete({})]);
  assert.deepEqual(r1, r2);
  assert.equal(finalizeCalls(calls).length, 1);
  assert.equal(lifecycle.state, 'ENDED');
});

test('SR-004-AC08 a finalization request retried by the approved API policy after a timeout causes no duplicate effects', async () => {
  let attempt = 0;
  const { lifecycle, completion, calls } = await buildHarness({
    transport: async () => {
      attempt += 1;
      if (attempt === 1) return new Promise(() => {});
      return { status: 200, body: { contractVersion: '1.0', finalStatus: 'completed', sessionId: 'session-1' } };
    },
  });
  await lifecycle.signal('activity-ready');
  const result = await completion.complete({});
  assert.equal(result.finalStatus, 'completed');

  const finalizeAttempts = finalizeCalls(calls);
  assert.equal(finalizeAttempts.length, 2);
  assert.equal(finalizeAttempts[0].headers['Idempotency-Key'], finalizeAttempts[1].headers['Idempotency-Key']);
  assert.equal(lifecycle.state, 'ENDED');
});

test('SR-004-AC09 a failed/unconfirmed finalization does not report authoritative completion and can be safely retried', async () => {
  let shouldFail = true;
  const { lifecycle, completion } = await buildHarness({
    transport: async () => shouldFail
      ? { status: 500, body: {} }
      : { status: 200, body: { contractVersion: '1.0', finalStatus: 'completed', sessionId: 'session-1' } },
  });
  await lifecycle.signal('activity-ready');

  await assert.rejects(() => completion.complete({}));
  assert.equal(lifecycle.state, 'ACTIVE');

  shouldFail = false;
  const result = await completion.complete({});
  assert.equal(result.finalStatus, 'completed');
  assert.equal(lifecycle.state, 'ENDED');
});

test('SR-004-AC10 a completion attempt with a substituted sessionId is rejected; the bound session is used', async () => {
  const { lifecycle, completion, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { contractVersion: '1.0', finalStatus: 'completed', sessionId: 'session-1' } }),
  });
  await lifecycle.signal('activity-ready');
  await assert.rejects(
    () => completion.complete({ sessionId: 'session-evil', score: 1 }),
    (e) => e instanceof SessionCompletionError && e.code === 'SESSION_COMPLETION_IDENTITY_MISMATCH'
  );
  assert.equal(calls.length, 0);
  assert.equal(lifecycle.state, 'ACTIVE');
});

test('SR-004-AC11 Chess Master, Magical Math, and another app reuse the exact same shared completion implementation', async () => {
  const apps = [
    { ...baseClaims, appId: 'chess-master' },
    { ...baseClaims, appId: 'magical-math' },
    { ...baseClaims, appId: 'reading-quest' },
  ];
  for (const claims of apps) {
    const { lifecycle, completion } = await buildHarness({
      claims,
      transport: async () => ({ status: 200, body: { contractVersion: '1.0', finalStatus: 'completed', sessionId: 'session-1' } }),
    });
    await lifecycle.signal('activity-ready');
    const result = await completion.complete({});
    assert.equal(result.finalStatus, 'completed');
    assert.equal(lifecycle.state, 'ENDED');
  }
});
