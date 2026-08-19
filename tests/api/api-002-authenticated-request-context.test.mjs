import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { createAuthenticatedRequestContext, createProtectedApiClient, AuthContextError } from '../../src/container/internal/api/authenticated-request-context.mjs';

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
  'progress.save': {
    method: 'POST', path: '/v1/progress', authorityFields: ['learnerId', 'sessionId'],
    parseResponse: (body) => (body && typeof body.saved === 'boolean') ? { ok: true, data: { saved: body.saved } } : { ok: false },
  },
});

function makeAuthContext({ resolveToken, refreshToken, now }) {
  return createAuthenticatedRequestContext({ resolveToken, refreshToken, now });
}

function makeProtectedClient({ transport, authContext, binding, onTelemetry = () => {} }) {
  const apiClient = createBabystepsApiClient({
    baseUrl: 'https://staging.api.babysteps.com',
    contractVersion: '2024-01',
    transport,
    authProvider: authContext.getToken,
    runtimeBinding: binding,
    operations,
  });
  return createProtectedApiClient({ apiClient, authContext, runtimeBinding: binding, onTelemetry });
}

test('API-002-AC01 protected call injects container-controlled auth and executes under the bound authorized runtime', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  const authContext = makeAuthContext({ resolveToken: async () => ({ token: 'fresh-token', expiresAt: Date.now() + 60000 }), refreshToken: async () => ({ token: 'refreshed', expiresAt: Date.now() + 60000 }) });
  const client = makeProtectedClient({ transport, authContext, binding });

  const result = await client.call('progress.save', { value: 1 });
  assert.equal(result.saved, true);
  assert.equal(calls[0].headers.Authorization, 'Bearer fresh-token');
  assert.equal(calls[0].body.learnerId, 'learner-1');
});

test('API-002-AC02 no raw auth token/credential/refresh mechanism is exposed through the public client surface', async () => {
  const binding = await boundRuntime();
  const transport = async () => ({ status: 200, body: { saved: true } });
  const authContext = makeAuthContext({ resolveToken: async () => ({ token: 'top-secret', expiresAt: Date.now() + 60000 }), refreshToken: async () => ({ token: 'top-secret-2', expiresAt: Date.now() + 60000 }) });
  const client = makeProtectedClient({ transport, authContext, binding });

  assert.deepEqual(Object.keys(client), ['call']);
  assert.equal(client.authContext, undefined);
  assert.equal(client.getToken, undefined);
  assert.equal(client.token, undefined);
  assert.deepEqual(Object.keys(authContext).sort(), ['getToken', 'invalidate', 'terminate']);
});

test('API-002-AC03 an app-supplied authentication credential in the payload is rejected, not accepted', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  const authContext = makeAuthContext({ resolveToken: async () => ({ token: 'fresh-token', expiresAt: Date.now() + 60000 }), refreshToken: async () => ({ token: 'x', expiresAt: Date.now() + 60000 }) });
  const client = makeProtectedClient({ transport, authContext, binding });

  await assert.rejects(() => client.call('progress.save', { value: 1, accessToken: 'attacker-supplied' }), (e) => e instanceof AuthContextError && e.code === 'AUTH_CONTEXT_INVALID');
  assert.equal(calls.length, 0);
});

test('API-002-AC04 authoritative scope is derived from the bound SB-002 runtime, not app-supplied identifiers', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  const authContext = makeAuthContext({ resolveToken: async () => ({ token: 'fresh-token', expiresAt: Date.now() + 60000 }), refreshToken: async () => ({ token: 'x', expiresAt: Date.now() + 60000 }) });
  const client = makeProtectedClient({ transport, authContext, binding });

  await client.call('progress.save', { value: 1 });
  assert.equal(calls[0].body.learnerId, 'learner-1');
  assert.equal(calls[0].body.sessionId, 'session-1');
});

test('API-002-AC05 a mismatched learnerId/sessionId in the domain payload is rejected; no cross-learner/session operation occurs', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  const authContext = makeAuthContext({ resolveToken: async () => ({ token: 'fresh-token', expiresAt: Date.now() + 60000 }), refreshToken: async () => ({ token: 'x', expiresAt: Date.now() + 60000 }) });
  const client = makeProtectedClient({ transport, authContext, binding });

  await assert.rejects(() => client.call('progress.save', { value: 1, sessionId: 'session-evil' }));
  assert.equal(calls.length, 0);
});

test('API-002-AC06 missing authentication fails the protected operation safely before any success', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  const authContext = makeAuthContext({ resolveToken: async () => { throw new Error('no session cookie'); }, refreshToken: async () => ({ token: 'x', expiresAt: Date.now() + 60000 }) });
  const client = makeProtectedClient({ transport, authContext, binding });

  await assert.rejects(() => client.call('progress.save', { value: 1 }), (e) => e instanceof AuthContextError && e.code === 'AUTH_CONTEXT_MISSING');
  assert.equal(calls.length, 0);
});

test('API-002-AC07 locally expired authentication triggers re-auth; failed recovery yields REAUTH_REQUIRED without stale reuse', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  let clock = Date.now();
  const authContext = makeAuthContext({
    resolveToken: async () => ({ token: 'stale-token', expiresAt: clock - 1 }),
    refreshToken: async () => { throw new Error('refresh endpoint down'); },
    now: () => clock,
  });
  const client = makeProtectedClient({ transport, authContext, binding });

  await assert.rejects(() => client.call('progress.save', { value: 1 }), (e) => e instanceof AuthContextError && e.code === 'REAUTH_REQUIRED');
  assert.equal(calls.length, 0);
});

test('API-002-AC08 invalid/revoked authentication does not continue under stale identity or allow substitution', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 401, body: {} }; };
  let refreshCount = 0;
  const authContext = makeAuthContext({
    resolveToken: async () => ({ token: 'token-1', expiresAt: Date.now() + 60000 }),
    refreshToken: async () => { refreshCount += 1; return { token: `token-${refreshCount + 1}`, expiresAt: Date.now() + 60000 }; },
  });
  const client = makeProtectedClient({ transport, authContext, binding });

  await assert.rejects(() => client.call('progress.save', { value: 1 }), (e) => e instanceof AuthContextError && e.code === 'AUTHORIZATION_DENIED');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, 'Bearer token-1');
  assert.equal(calls[1].headers.Authorization, 'Bearer token-2');
});

test('API-002-AC09 concurrent auth-expiry recovery is coordinated with no duplicate refresh or duplicate writes', async () => {
  const binding = await boundRuntime();
  const calls = [];
  let refreshCount = 0;
  const transport = async (req) => {
    calls.push(req);
    if (req.headers.Authorization === 'Bearer token-1') return { status: 401, body: {} };
    return { status: 200, body: { saved: true } };
  };
  const authContext = makeAuthContext({
    resolveToken: async () => ({ token: 'token-1', expiresAt: Date.now() + 60000 }),
    refreshToken: async () => { refreshCount += 1; await new Promise((r) => setTimeout(r, 5)); return { token: 'token-2', expiresAt: Date.now() + 60000 }; },
  });
  const client = makeProtectedClient({ transport, authContext, binding });

  const [r1, r2] = await Promise.all([client.call('progress.save', { value: 1 }), client.call('progress.save', { value: 2 })]);
  assert.equal(r1.saved, true);
  assert.equal(r2.saved, true);
  assert.equal(refreshCount, 1);
});

test('API-002-AC10 termination clears auth-derived material so it cannot be reused', async () => {
  const binding = await boundRuntime();
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, body: { saved: true } }; };
  const authContext = makeAuthContext({ resolveToken: async () => ({ token: 'fresh-token', expiresAt: Date.now() + 60000 }), refreshToken: async () => ({ token: 'x', expiresAt: Date.now() + 60000 }) });
  const client = makeProtectedClient({ transport, authContext, binding });

  await client.call('progress.save', { value: 1 });
  authContext.terminate();
  await assert.rejects(() => client.call('progress.save', { value: 1 }), (e) => e instanceof AuthContextError && e.code === 'AUTH_CONTEXT_INVALID');
  assert.equal(calls.length, 1);
});

test('API-002-AC11 auth failure/recovery telemetry is safe: category/correlation/duration only, never tokens or credentials', async () => {
  const binding = await boundRuntime();
  const events = [];
  const onTelemetry = (e) => events.push(e);
  const transport = async () => ({ status: 200, body: { saved: true } });

  const missingAuthContext = makeAuthContext({ resolveToken: async () => { throw new Error('no session'); }, refreshToken: async () => ({ token: 'x', expiresAt: Date.now() + 60000 }) });
  const missingClient = makeProtectedClient({ transport, authContext: missingAuthContext, binding, onTelemetry });
  await assert.rejects(() => missingClient.call('progress.save', { value: 1 }));

  const okAuthContext = makeAuthContext({ resolveToken: async () => ({ token: 'super-secret-value', expiresAt: Date.now() + 60000 }), refreshToken: async () => ({ token: 'x', expiresAt: Date.now() + 60000 }) });
  const okClient = makeProtectedClient({ transport, authContext: okAuthContext, binding, onTelemetry });
  await okClient.call('progress.save', { value: 1 });

  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(typeof event.operation, 'string');
    assert.equal(typeof event.correlationId, 'string');
    assert.equal(typeof event.durationMs, 'number');
    assert.equal(typeof event.category, 'string');
    const serialized = JSON.stringify(event).toLowerCase();
    for (const forbidden of ['super-secret-value', 'bearer', 'authorization', 'no session']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  }
});
