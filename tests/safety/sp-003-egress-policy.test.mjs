import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovedEgressPolicy, EgressPolicyError } from '../../src/container/internal/safety/egress-policy.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

function speechProcessorOverride(overrides = {}) {
  return {
    appId: 'speed-reading',
    purposeId: 'pronunciation-scoring',
    providerId: 'approved-speech-processor',
    destinations: ['https://speech.approved-vendor.example/v1/transcribe'],
    allowedFields: ['audioSampleRef', 'language'],
    ...overrides,
  };
}

test('SP-003-AC01 a direct external call without an approved shared integration is denied', () => {
  const violation = inspectSource('apps/demo/network.mjs', "fetch('https://example.com/track');");
  assert.ok(violation.some((v) => v.code === 'DIRECT_NETWORK_ACCESS_DENIED'));
});

test('SP-003-AC02 Babysteps platform data is reached only through the approved shared API client', () => {
  const violation = inspectSource('apps/demo/platform.mjs', "fetch('https://api.babysteps.com/v1/progress');");
  assert.ok(violation.some((v) => v.code === 'DIRECT_BABYSTEPS_API_CALL'));
});

test('SP-003-AC03 an approved app/provider/purpose call succeeds only when identity, provider and purpose all match', async () => {
  const policy = createApprovedEgressPolicy({ approvedOverrides: [speechProcessorOverride()] });
  const result = await policy.callApprovedProvider({
    appId: 'speed-reading', purposeId: 'pronunciation-scoring', providerId: 'approved-speech-processor',
    destination: 'https://speech.approved-vendor.example/v1/transcribe', data: { audioSampleRef: 'ref-1', language: 'en' },
    invoke: async (data) => ({ transcript: 'ok', ...data }),
  });
  assert.equal(result.transcript, 'ok');
});

test('SP-003-AC04 App A\'s approved provider override does not relax App B\'s policy', async () => {
  const policy = createApprovedEgressPolicy({ approvedOverrides: [speechProcessorOverride({ appId: 'speed-reading' })] });
  await assert.rejects(
    () => policy.callApprovedProvider({
      appId: 'magical-math', purposeId: 'pronunciation-scoring', providerId: 'approved-speech-processor',
      destination: 'https://speech.approved-vendor.example/v1/transcribe', data: {}, invoke: async () => ({}),
    }),
    (e) => e instanceof EgressPolicyError && e.code === 'PROVIDER_NOT_APPROVED'
  );
});

test('SP-003-AC05 approval for one purpose does not extend to an unapproved purpose on the same provider', async () => {
  const policy = createApprovedEgressPolicy({ approvedOverrides: [speechProcessorOverride()] });
  await assert.rejects(
    () => policy.callApprovedProvider({
      appId: 'speed-reading', purposeId: 'engagement-analytics', providerId: 'approved-speech-processor',
      destination: 'https://speech.approved-vendor.example/v1/transcribe', data: {}, invoke: async () => ({}),
    }),
    (e) => e.code === 'PURPOSE_NOT_APPROVED'
  );
});

test('SP-003-AC06 fields outside the minimum approved data contract are rejected', async () => {
  const policy = createApprovedEgressPolicy({ approvedOverrides: [speechProcessorOverride()] });
  await assert.rejects(
    () => policy.callApprovedProvider({
      appId: 'speed-reading', purposeId: 'pronunciation-scoring', providerId: 'approved-speech-processor',
      destination: 'https://speech.approved-vendor.example/v1/transcribe',
      data: { audioSampleRef: 'ref-1', language: 'en', parentEmail: 'leak@example.com' },
      invoke: async () => ({}),
    }),
    (e) => e.code === 'DATA_CONTRACT_VIOLATION'
  );
});

test('SP-003-AC07 an unapproved analytics/tracking SDK import fails CI/architecture checks', () => {
  const violation = inspectSource('apps/demo/analytics.mjs', "import mixpanel from 'mixpanel-browser';");
  assert.ok(violation.some((v) => v.code === 'UNAPPROVED_NETWORK_SDK_IMPORT'));
});

test('SP-003-AC08 an approved provider outage follows the configured degradation path without silent provider substitution', async () => {
  const policy = createApprovedEgressPolicy({ approvedOverrides: [speechProcessorOverride()] });
  await assert.rejects(
    () => policy.callApprovedProvider({
      appId: 'speed-reading', purposeId: 'pronunciation-scoring', providerId: 'approved-speech-processor',
      destination: 'https://speech.approved-vendor.example/v1/transcribe', data: { audioSampleRef: 'ref-1', language: 'en' },
      invoke: async () => { throw new Error('vendor outage'); },
    }),
    (e) => e.code === 'PROVIDER_UNAVAILABLE'
  );
  await assert.rejects(
    () => policy.callApprovedProvider({
      appId: 'speed-reading', purposeId: 'pronunciation-scoring', providerId: 'unapproved-fallback-vendor',
      destination: 'https://fallback.example/v1', data: {}, invoke: async () => ({}),
    }),
    (e) => e.code === 'PROVIDER_NOT_APPROVED'
  );
});

test('SP-003-AC09 provider credentials remain inside the approved shared adapter, not exposed to callers', async () => {
  const policy = createApprovedEgressPolicy({ approvedOverrides: [speechProcessorOverride()] });
  let observedData = null;
  await policy.callApprovedProvider({
    appId: 'speed-reading', purposeId: 'pronunciation-scoring', providerId: 'approved-speech-processor',
    destination: 'https://speech.approved-vendor.example/v1/transcribe', data: { audioSampleRef: 'ref-1', language: 'en' },
    invoke: async (data) => { observedData = data; return { ok: true }; },
  });
  assert.equal('apiKey' in observedData, false);
  assert.equal('secret' in observedData, false);
});

test('SP-003-AC10 an unknown/wildcard/unapproved destination fails closed', async () => {
  const policy = createApprovedEgressPolicy({ approvedOverrides: [speechProcessorOverride()] });
  await assert.rejects(
    () => policy.callApprovedProvider({
      appId: 'speed-reading', purposeId: 'pronunciation-scoring', providerId: 'approved-speech-processor',
      destination: 'https://attacker-controlled.example/exfil', data: { audioSampleRef: 'ref-1', language: 'en' },
      invoke: async () => ({}),
    }),
    (e) => e.code === 'EGRESS_DENIED'
  );
});

test('SP-003-AC11 only coarse provider/purpose/outcome telemetry is emitted, without sensitive payloads', async () => {
  const events = [];
  const policy = createApprovedEgressPolicy({ approvedOverrides: [speechProcessorOverride()], onTelemetry: (e) => events.push(e) });
  await policy.callApprovedProvider({
    appId: 'speed-reading', purposeId: 'pronunciation-scoring', providerId: 'approved-speech-processor',
    destination: 'https://speech.approved-vendor.example/v1/transcribe', data: { audioSampleRef: 'ref-1', language: 'en' },
    invoke: async () => ({ transcript: 'the secret spoken transcript' }),
  });
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(JSON.stringify(event).includes('the secret spoken transcript'), false);
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'appId', 'providerId', 'purposeId', 'reason', 'destination'].includes(k)));
  }
});
