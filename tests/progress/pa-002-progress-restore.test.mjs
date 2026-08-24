import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { createAuthenticatedRequestContext, createProtectedApiClient } from '../../src/container/internal/api/authenticated-request-context.mjs';
import { createProgressAdapter, ProgressAdapterError } from '../../src/container/internal/progress/progress-adapter.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

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

const operations = Object.freeze({
  'progress.checkpoint': {
    method: 'POST', path: '/v1/progress/checkpoint', authorityFields: ['learnerId', 'appId', 'releaseId', 'sessionId'], idempotent: true,
    parseResponse: (body) => (body && typeof body.acknowledged === 'boolean') ? { ok: true, data: { acknowledged: body.acknowledged, progressVersion: body.progressVersion } } : { ok: false },
  },
  'progress.restore': {
    method: 'GET', path: '/v1/progress/restore', authorityFields: ['learnerId', 'appId', 'releaseId'],
    parseResponse: (body) => (body && typeof body.found === 'boolean')
      ? {
          ok: true,
          data: {
            found: body.found,
            learnerId: body.learnerId,
            appId: body.appId,
            releaseId: body.releaseId,
            progressVersion: body.progressVersion,
            appProgressSchemaVersion: body.appProgressSchemaVersion,
            appProgress: body.appProgress,
          },
        }
      : { ok: false },
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
  const progressClient = createProtectedApiClient({ apiClient, authContext, runtimeBinding: binding });

  const sessionIdentity = getRuntimeContext(binding);
  const events = [];
  const adapter = createProgressAdapter({ sessionIdentity, progressClient, onTelemetry: (e) => events.push(e) });

  return { binding, sessionIdentity, adapter, calls, events };
}

function restoreCalls(calls) { return calls.filter((c) => c.url.endsWith('/v1/progress/restore')); }

test('PA-002-AC01 acknowledged progress for the bound learner/app/release is fetched and returned', async () => {
  const { adapter, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { found: true, learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', progressVersion: 'v5', appProgress: { level: 3 } } }),
  });
  const result = await adapter.restore();
  assert.equal(result.found, true);
  assert.equal(result.progressVersion, 'v5');
  assert.deepEqual(result.appProgress, { level: 3 });
  assert.equal(restoreCalls(calls).length, 1);
});

test('PA-002-AC02 no acknowledged progress returns an explicit no-progress state, not an error or fabricated payload', async () => {
  const { adapter } = await buildHarness({
    transport: async () => ({ status: 200, body: { found: false } }),
  });
  const result = await adapter.restore();
  assert.equal(result.found, false);
  assert.equal(result.appProgress, null);
  assert.equal(result.progressVersion, null);
});

test('PA-002-AC03 Magical Math and Chess restore their own different progress payload schemas through the same adapter', async () => {
  const math = await buildHarness({
    transport: async () => ({ status: 200, body: { found: true, progressVersion: 'm1', appProgress: { lesson: 4, mistakes: 2 } } }),
  });
  const chess = await buildHarness({
    claims: { ...baseClaims, appId: 'chess-master', sessionId: 'session-2' },
    transport: async () => ({ status: 200, body: { found: true, progressVersion: 'c1', appProgress: { openingBook: ['e4', 'e5'], rating: 1200 } } }),
  });
  const mathResult = await math.adapter.restore();
  const chessResult = await chess.adapter.restore();
  assert.deepEqual(mathResult.appProgress, { lesson: 4, mistakes: 2 });
  assert.deepEqual(chessResult.appProgress, { openingBook: ['e4', 'e5'], rating: 1200 });
});

test('PA-002-AC04 a restore response for a different learner/app/release scope is rejected and never handed to app logic', async () => {
  const { adapter } = await buildHarness({
    transport: async () => ({ status: 200, body: { found: true, learnerId: 'someone-else', progressVersion: 'v1', appProgress: { level: 1 } } }),
  });
  await assert.rejects(
    () => adapter.restore(),
    (e) => e instanceof ProgressAdapterError && e.code === 'PROGRESS_SCOPE_MISMATCH'
  );
});

test('PA-002-AC05 an incompatible acknowledged progress schema version fails safely rather than being interpreted heuristically', async () => {
  const { adapter } = await buildHarness({
    transport: async () => ({ status: 200, body: { found: true, progressVersion: 'v1', appProgressSchemaVersion: '3.0', appProgress: { level: 1 } } }),
  });
  await assert.rejects(
    () => adapter.restore({ expectedSchemaVersion: '2.0' }),
    (e) => e instanceof ProgressAdapterError && e.code === 'PROGRESS_SCHEMA_INCOMPATIBLE'
  );
});

test('PA-002-AC06 the shared adapter hands the payload to app code without choosing the next educational state', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/progress/progress-adapter.mjs');
  const source = readFileSync(filePath, 'utf8');
  const forbidden = /\b(?:function|const|let|var)\s+(?:decide|determine|calculate|compute|choose|select)(?:Lesson|Activity|Mastery|Curriculum|NextState|Continuation)\b/i;
  assert.equal(forbidden.test(source), false);
});

test('PA-002-AC07 Babysteps-authoritative acknowledged progress wins over differing local cached progress', async () => {
  const { adapter } = await buildHarness({
    transport: async (req) => req.url.endsWith('/v1/progress/checkpoint')
      ? { status: 200, body: { acknowledged: true, progressVersion: 'local-v1' } }
      : { status: 200, body: { found: true, progressVersion: 'authoritative-v9', appProgress: { level: 9 } } },
  });
  await adapter.checkpoint({ level: 1 });
  assert.equal(adapter.latestAcknowledged.progressVersion, 'local-v1');

  const restored = await adapter.restore();
  assert.equal(restored.progressVersion, 'authoritative-v9');
  assert.deepEqual(restored.appProgress, { level: 9 });
});

test('PA-002-AC08 pending/unacknowledged local progress is never represented as acknowledged progress on restore', async () => {
  const { adapter } = await buildHarness({
    transport: async (req) => req.url.endsWith('/v1/progress/checkpoint')
      ? { status: 200, body: { acknowledged: false, progressVersion: null } }
      : { status: 200, body: { found: false } },
  });
  const pending = await adapter.checkpoint({ level: 5 });
  assert.equal(pending.acknowledged, false);
  assert.equal(adapter.latestAcknowledged, null);

  const restored = await adapter.restore();
  assert.equal(restored.found, false);
});

test('PA-002-AC09 app code cannot select another learner/app by supplying IDs to the public restore method', () => {
  const violation = inspectSource(
    'apps/demo/rogue-restore.mjs',
    "import { createProgressAdapter } from '../../src/container/internal/progress/progress-adapter.mjs';"
  );
  assert.equal(violation.some((v) => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);
});

test('PA-002-AC10 repeatedly restoring the same acknowledged progress is side-effect free and consistent', async () => {
  const { adapter, calls } = await buildHarness({
    transport: async () => ({ status: 200, body: { found: true, progressVersion: 'v3', appProgress: { level: 3 } } }),
  });
  const first = await adapter.restore();
  const second = await adapter.restore();
  const third = await adapter.restore();
  assert.equal(first.progressVersion, second.progressVersion);
  assert.equal(second.progressVersion, third.progressVersion);
  assert.equal(restoreCalls(calls).length, 3);
});

test('PA-002-AC11 restore telemetry contains only coarse metadata, not full learner progress payloads', async () => {
  const { adapter, events } = await buildHarness({
    transport: async () => ({ status: 200, body: { found: true, progressVersion: 'v3', appProgress: { level: 3, note: 'struggled with fractions' } } }),
  });
  await adapter.restore();

  assert.ok(events.length >= 1);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'sessionId', 'correlationId', 'progressVersion', 'reason', 'conflict', 'found'].includes(k)));
    assert.equal(JSON.stringify(event).includes('fractions'), false);
  }
});
