import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient, ApiClientError } from '../../src/container/internal/api/babysteps-api-client.mjs';
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
  const runtimeContext = await validateLaunchContext({ launchContext: envelope(claims), ...launchOpts });
  return bindAuthorizedRuntime(runtimeContext);
}

const operations = Object.freeze({
  'progress.save': {
    method: 'POST', path: '/v1/progress', authorityFields: ['learnerId', 'sessionId'],
    parseResponse: (body) => (body && typeof body.saved === 'boolean') ? { ok: true, data: { saved: body.saved } } : { ok: false },
  },
  'entitlement.check': {
    method: 'GET', path: '/v1/entitlement', authorityFields: ['learnerId'],
    parseResponse: (body) => (body && typeof body === 'object') ? { ok: true, data: body } : { ok: false },
  },
  'session.retryable': {
    method: 'POST', path: '/v1/session/complete', authorityFields: ['learnerId', 'sessionId'], idempotent: true,
    retry: { maxAttempts: 3, retryableStatuses: [503], timeoutMs: 30 },
    parseResponse: (body) => (body && body.completed === true) ? { ok: true, data: body } : { ok: false },
  },
});

function makeClient({ transport, onTelemetry, binding, baseUrl = 'https://staging.api.babysteps.com', contractVersion = '2024-01' }) {
  return createBabystepsApiClient({
    baseUrl, contractVersion, transport,
    authProvider: async () => 'super-secret-token',
    runtimeBinding: binding,
    operations,
    onTelemetry,
  });
}

test('API-001-AC01 platform communication from a container capability goes only through the centralized client', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  const client = makeClient({ transport, binding });
  const progressCapability = { save: (payload) => client.call('progress.save', payload) };
  const result = await progressCapability.save({ value: 42 });
  assert.equal(result.saved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://staging.api.babysteps.com/v1/progress');
});

test('API-001-AC02 direct fetch/HTTP calls to Babysteps endpoints from app code fail architecture CI', () => {
  const violation = inspectSource('apps/demo/rogue.mjs', "fetch('https://api.babysteps.com/v1/progress', { method: 'POST' });");
  assert.equal(violation.some((v) => v.code === 'DIRECT_BABYSTEPS_API_CALL'), true);
  const clean = inspectSource('apps/demo/ok.mjs', "fetch('https://example.com/health');");
  assert.equal(clean.some((v) => v.code === 'DIRECT_BABYSTEPS_API_CALL'), false);
});

test('API-001-AC03 authoritative identifiers are injected from the bound runtime, never trusted from app substitutes', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  const client = makeClient({ transport, binding });

  await assert.rejects(() => client.call('progress.save', { learnerId: 'attacker', value: 1 }), (e) => e instanceof ApiClientError && e.code === 'API_AUTHORITY_MISMATCH');
  assert.equal(calls.length, 0);

  await client.call('progress.save', { value: 1 });
  assert.equal(calls[0].body.learnerId, 'learner-1');
  assert.equal(calls[0].body.sessionId, 'session-1');
});

test('API-001-AC04 environment/base URL configuration changes centrally without app code changes', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  const staging = makeClient({ transport, binding, baseUrl: 'https://staging.api.babysteps.com' });
  const prod = makeClient({ transport, binding, baseUrl: 'https://api.babysteps.com' });
  await staging.call('progress.save', { value: 1 });
  await prod.call('progress.save', { value: 1 });
  assert.equal(calls[0].url, 'https://staging.api.babysteps.com/v1/progress');
  assert.equal(calls[1].url, 'https://api.babysteps.com/v1/progress');
});

test('API-001-AC05 approved API contract/version metadata is applied consistently', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  const client = makeClient({ transport, binding, contractVersion: '2026-08-01' });
  await client.call('progress.save', { value: 1 });
  await client.call('entitlement.check', {});
  for (const req of calls) assert.equal(req.headers['X-Babysteps-Contract-Version'], '2026-08-01');
});

test('API-001-AC06 malformed response is rejected and never returned as a successful typed result', async () => {
  const binding = await boundRuntime();
  const transport = async () => ({ status: 200, body: { unexpected: 'shape' } });
  const client = makeClient({ transport, binding });
  await assert.rejects(() => client.call('progress.save', { value: 1 }), (e) => e instanceof ApiClientError && e.code === 'API_RESPONSE_INVALID');
});

test('API-001-AC07 platform error responses are normalized with a stable category and safe correlation metadata', async () => {
  const binding = await boundRuntime();
  const cases = [[401, 'AUTH'], [403, 'AUTHORIZATION'], [409, 'CONFLICT'], [429, 'RATE_LIMIT'], [500, 'SERVER']];
  for (const [status, category] of cases) {
    const transport = async () => ({ status, body: { message: 'raw platform detail' } });
    const client = makeClient({ transport, binding });
    await assert.rejects(() => client.call('progress.save', { value: 1 }), (e) => {
      assert.equal(e instanceof ApiClientError, true);
      assert.equal(e.metadata.category, category);
      assert.equal(e.message.includes('raw platform detail'), false);
      return true;
    });
  }
});

test('API-001-AC08 timeout/retry policy is centralized and the app performs no retry transport of its own', async () => {
  const binding = await boundRuntime();
  let calls = 0;
  const transport = async () => {
    calls += 1;
    if (calls === 1) return new Promise(() => {});
    return { status: 200, body: { completed: true } };
  };
  const client = makeClient({ transport, binding });
  const result = await client.call('session.retryable', { value: 1 });
  assert.equal(result.completed, true);
  assert.equal(calls, 2);
});

test('API-001-AC09 retried writes reuse one idempotency identifier to prevent duplicate authoritative writes', async () => {
  const binding = await boundRuntime();
  const seenKeys = [];
  let calls = 0;
  const transport = async (req) => {
    calls += 1;
    seenKeys.push(req.headers['Idempotency-Key']);
    if (calls === 1) return new Promise(() => {});
    return { status: 200, body: { completed: true } };
  };
  const client = makeClient({ transport, binding });
  await client.call('session.retryable', { value: 1 });
  assert.equal(calls, 2);
  assert.equal(typeof seenKeys[0], 'string');
  assert.equal(seenKeys[0], seenKeys[1]);
});

test('API-001-AC10 entitlement/subscription/credit results are transported and normalized but never recalculated', async () => {
  const binding = await boundRuntime();
  const platformResult = Object.freeze({ entitled: true, reason: 'active-subscription', creditsRemaining: 3 });
  const transport = async () => ({ status: 200, body: platformResult });
  const client = makeClient({ transport, binding });
  const result = await client.call('entitlement.check', {});
  assert.deepEqual(result, platformResult);
});

test('API-001-AC11 telemetry captures operation/correlation/duration/result category and excludes sensitive data', async () => {
  const binding = await boundRuntime();
  const events = [];
  const onTelemetry = (e) => events.push(e);

  const okTransport = async () => ({ status: 200, body: { saved: true } });
  await makeClient({ transport: okTransport, binding, onTelemetry }).call('progress.save', { value: 'secret-learning-detail' });

  const failTransport = async () => ({ status: 500, body: {} });
  await assert.rejects(() => makeClient({ transport: failTransport, binding, onTelemetry }).call('progress.save', { value: 1 }));

  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(typeof event.operation, 'string');
    assert.equal(typeof event.correlationId, 'string');
    assert.equal(typeof event.durationMs, 'number');
    assert.equal(typeof event.category, 'string');
    const serialized = JSON.stringify(event).toLowerCase();
    for (const forbidden of ['super-secret-token', 'secret-learning-detail', 'authorization', 'bearer']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  }
});

test('API-001-AC12 raw auth material and transport internals are not exposed through the public client surface', async () => {
  const binding = await boundRuntime();
  const transport = async () => ({ status: 200, body: { saved: true } });
  const client = makeClient({ transport, binding });
  assert.deepEqual(Object.keys(client), ['call']);
  assert.equal(client.authProvider, undefined);
  assert.equal(client.transport, undefined);
  assert.equal(client.headers, undefined);
});
