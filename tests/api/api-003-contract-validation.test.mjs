import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createBabystepsApiClient } from '../../src/container/internal/api/babysteps-api-client.mjs';
import { defineApiContract, ContractValidationError } from '../../src/container/internal/api/contract-validation.mjs';
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

function makeContract(overrides = {}) {
  return defineApiContract({
    operation: 'progress.save',
    supportedVersions: ['1.0', '1.1'],
    fields: {
      saved: { required: true, type: 'boolean' },
      status: { required: true, type: 'enum', enum: ['completed', 'partial'] },
      learnerId: { required: true, type: 'string' },
    },
    mapToDomain: (raw) => ({ saved: raw.saved, status: raw.status, learnerId: raw.learnerId }),
    ...overrides,
  });
}

test('API-003-AC01 a response matching the supported contract version produces a typed container-domain result', () => {
  const contract = makeContract();
  const result = contract.parseResponse({ contractVersion: '1.0', saved: true, status: 'completed', learnerId: 'learner-1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { saved: true, status: 'completed', learnerId: 'learner-1' });
});

test('API-003-AC02 malformed response data is rejected as a contract failure, never a successful result', () => {
  const contract = makeContract();
  assert.throws(() => contract.parseResponse(null), (e) => e instanceof ContractValidationError && e.code === 'API_RESPONSE_MALFORMED');
  assert.throws(() => contract.parseResponse('not-an-object'), (e) => e instanceof ContractValidationError && e.code === 'API_RESPONSE_MALFORMED');
});

test('API-003-AC03 a missing mandatory field fails with a stable required-field error and no guessed value', () => {
  const contract = makeContract();
  assert.throws(
    () => contract.parseResponse({ contractVersion: '1.0', status: 'completed', learnerId: 'learner-1' }),
    (e) => e instanceof ContractValidationError && e.code === 'API_RESPONSE_REQUIRED_FIELD_MISSING' && e.metadata.field === 'saved'
  );
});

test('API-003-AC04 an invalid enum value outside the approved contract is rejected', () => {
  const contract = makeContract();
  assert.throws(
    () => contract.parseResponse({ contractVersion: '1.0', saved: true, status: 'made-up-status', learnerId: 'learner-1' }),
    (e) => e instanceof ContractValidationError && e.code === 'API_CONTRACT_INVALID' && e.metadata.field === 'status'
  );
  const valid = contract.parseResponse({ contractVersion: '1.0', saved: true, status: 'partial', learnerId: 'learner-1' });
  assert.equal(valid.data.status, 'partial');
});

test('API-003-AC05 a supported backward-compatible addition continues without app code parsing the new raw field', () => {
  const contract = makeContract();
  const v1 = contract.parseResponse({ contractVersion: '1.0', saved: true, status: 'completed', learnerId: 'learner-1' });
  const v1_1 = contract.parseResponse({ contractVersion: '1.1', saved: true, status: 'completed', learnerId: 'learner-1', bonusPoints: 50, theme: 'space' });
  assert.deepEqual(v1_1.data, v1.data);
  assert.equal('bonusPoints' in v1_1.data, false);
  assert.equal('theme' in v1_1.data, false);
});

test('API-003-AC06 an unsupported breaking contract version fails safely without heuristic interpretation', () => {
  let mapCalls = 0;
  const contract = makeContract({ mapToDomain: (raw) => { mapCalls += 1; return raw; } });
  assert.throws(
    () => contract.parseResponse({ contractVersion: '2.0', saved: true, status: 'completed', learnerId: 'learner-1' }),
    (e) => e instanceof ContractValidationError && e.code === 'API_CONTRACT_VERSION_UNSUPPORTED'
  );
  assert.equal(mapCalls, 0);
});

test('API-003-AC07 a malformed/absent security-sensitive field fails closed with no permissive default', () => {
  let mapCalls = 0;
  const contract = makeContract({ mapToDomain: (raw) => { mapCalls += 1; return raw; } });
  assert.throws(
    () => contract.parseResponse({ contractVersion: '1.0', saved: true, status: 'completed' }),
    (e) => e instanceof ContractValidationError && e.code === 'API_RESPONSE_REQUIRED_FIELD_MISSING' && e.metadata.field === 'learnerId'
  );
  assert.equal(mapCalls, 0);
});

test('API-003-AC08 app/plugin/content code cannot depend directly on raw Babysteps contract/validator internals', () => {
  const violations = inspectSource('apps/demo/progress-widget.mjs', "import { defineApiContract } from '../../src/container/internal/api/contract-validation.mjs';");
  assert.equal(violations.some((v) => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);
});

test('API-003-AC09 a contract validation failure emits safe operation/version/category/correlation telemetry, never raw payloads', async () => {
  const binding = await boundRuntime();
  const contract = makeContract();
  const events = [];
  const client = createBabystepsApiClient({
    baseUrl: 'https://staging.api.babysteps.com',
    contractVersion: '2024-01',
    transport: async () => ({ status: 200, body: { contractVersion: '1.0', saved: true, status: 'completed', learnerRealName: 'Priya Sharma' } }),
    authProvider: async () => 'token',
    runtimeBinding: binding,
    operations: { 'progress.save': { method: 'POST', path: '/v1/progress', authorityFields: ['learnerId', 'sessionId'], parseResponse: contract.parseResponse } },
    onTelemetry: (e) => events.push(e),
  });

  await assert.rejects(() => client.call('progress.save', {}), (e) => e instanceof ContractValidationError && e.code === 'API_RESPONSE_REQUIRED_FIELD_MISSING');

  assert.equal(events.length, 1);
  assert.equal(events[0].category, 'API_RESPONSE_REQUIRED_FIELD_MISSING');
  assert.equal(typeof events[0].correlationId, 'string');
  assert.equal(typeof events[0].durationMs, 'number');
  const serialized = JSON.stringify(events[0]).toLowerCase();
  assert.equal(serialized.includes('priya'), false);
});

test('API-003-AC10 the contract-fixture regression suite passes compatible changes and fails breaking ones', () => {
  const contract = makeContract();
  const fixtures = [
    { name: 'v1.0 baseline', body: { contractVersion: '1.0', saved: true, status: 'completed', learnerId: 'learner-1' }, expectOk: true },
    { name: 'v1.1 additive field', body: { contractVersion: '1.1', saved: true, status: 'partial', learnerId: 'learner-1', newOptionalField: 'x' }, expectOk: true },
    { name: 'v2.0 breaking version', body: { contractVersion: '2.0', saved: true, status: 'completed', learnerId: 'learner-1' }, expectOk: false },
    { name: 'renamed mandatory field', body: { contractVersion: '1.0', wasSaved: true, status: 'completed', learnerId: 'learner-1' }, expectOk: false },
  ];
  for (const fixture of fixtures) {
    const result = contract.validate(fixture.body);
    assert.equal(result.ok, fixture.expectOk, fixture.name);
  }
});

test('API-003-AC11 validation and mapping are deterministic and side-effect free', () => {
  const contract = makeContract();
  const rawBody = Object.freeze({ contractVersion: '1.0', saved: true, status: 'completed', learnerId: 'learner-1' });
  const first = contract.validate(rawBody);
  const second = contract.validate(rawBody);
  assert.deepEqual(first, second);
  assert.deepEqual(rawBody, { contractVersion: '1.0', saved: true, status: 'completed', learnerId: 'learner-1' });
});
