import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createSpeechInputRuntime } from '../../src/container/internal/media/speech-input-runtime.mjs';
import { createLearnerSafetyPolicy, LearnerSafetyError } from '../../src/container/internal/safety/learner-safety-policy.mjs';
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

test('SP-001-AC01 the safety policy recognizes microphone/STT as required baseline and notifications as the only additional approved capability', async () => {
  const binding = await boundRuntime();
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding });
  assert.equal(policy.capabilityStatus('microphone-stt'), 'REQUIRED_BASELINE');
  assert.equal(policy.capabilityStatus('notifications'), 'APPROVED_PURPOSE_BOUND');
  assert.equal(policy.capabilityStatus('camera'), 'DENIED');
});

test('SP-001-AC02 microphone activation for a spoken response only occurs through AM-003', async () => {
  const binding = await boundRuntime();
  const recognizerFactory = () => ({ start() {}, stop() {}, cancel() {}, onResult() {}, onError() {} });
  const speech = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory });
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding });
  assert.equal(policy.requestCapability('microphone-stt'), 'REQUIRED_BASELINE');
  const handle = await speech.startListening({});
  assert.equal(typeof handle.id, 'number');
});

test('SP-001-AC03 an approved session-reminder notification may be registered when the user grants permission', async () => {
  const binding = await boundRuntime();
  const notificationAdapter = { register: async () => ({ granted: true }) };
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding, notificationAdapter });
  const result = await policy.registerNotification('session-reminder-30-min', {});
  assert.equal(result.registered, true);
});

test('SP-001-AC04 a denied notification permission does not block learning', async () => {
  const binding = await boundRuntime();
  const notificationAdapter = { register: async () => ({ granted: false }) };
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding, notificationAdapter });
  const result = await policy.registerNotification('session-reminder-30-min', {});
  assert.equal(result.registered, false);
  assert.equal(result.reason, 'NOTIFICATION_PERMISSION_DENIED');
});

test('SP-001-AC05 contacts/camera/location/files requests are denied and cannot bypass the shared policy', async () => {
  const binding = await boundRuntime();
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding });
  for (const capability of ['contacts', 'camera', 'location', 'files']) {
    assert.throws(() => policy.requestCapability(capability), (e) => e instanceof LearnerSafetyError && e.code === 'CAPABILITY_DENIED');
  }
  const violation = inspectSource('apps/demo/camera.mjs', "navigator.mediaDevices.getUserMedia({ video: true });");
  assert.ok(violation.some((v) => v.code === 'RESTRICTED_DEVICE_CAPABILITY_ACCESS'));
});

test('SP-001-AC06 an arbitrary external URL/deep link/popup/new browser context is blocked unless explicitly approved', async () => {
  const binding = await boundRuntime();
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding });
  assert.throws(() => policy.guardNavigation('arbitrary-external-site'), (e) => e.code === 'NAVIGATION_BLOCKED');
  assert.doesNotThrow(() => policy.guardNavigation('babysteps-help-center'));

  // A caller cannot self-approve a new destination class - createLearnerSafetyPolicy no
  // longer accepts an approvedNavigationDestinations parameter at all.
  const forged = createLearnerSafetyPolicy({ runtimeBinding: binding, approvedNavigationDestinations: ['arbitrary-external-site'] });
  assert.throws(() => forged.guardNavigation('arbitrary-external-site'), (e) => e.code === 'NAVIGATION_BLOCKED');
  const violation = inspectSource('apps/demo/popup.mjs', "window.open('https://example.com');");
  assert.ok(violation.some((v) => v.code === 'UNRESTRICTED_EXTERNAL_NAVIGATION'));
});

test('SP-001-AC07 advertising and public learner identity are prohibited in the learner runtime', async () => {
  const binding = await boundRuntime();
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding });
  assert.throws(() => policy.guardProhibitedBehavior('advertising'), (e) => e.code === 'LEARNER_RUNTIME_POLICY_VIOLATION');
  assert.throws(() => policy.guardProhibitedBehavior('public-learner-identity'), (e) => e.code === 'LEARNER_RUNTIME_POLICY_VIOLATION');
});

test('SP-001-AC08 learner-to-learner communication is prohibited in the closed learner environment', async () => {
  const binding = await boundRuntime();
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding });
  assert.throws(() => policy.guardProhibitedBehavior('learner-to-learner-messaging'), (e) => e.code === 'LEARNER_RUNTIME_POLICY_VIOLATION');
});

test('SP-001-AC09 generative/open-ended AI is unavailable unless a future frozen requirement changes policy', async () => {
  const binding = await boundRuntime();
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding });
  assert.throws(() => policy.guardProhibitedBehavior('generative-ai'), (e) => e.code === 'LEARNER_RUNTIME_POLICY_VIOLATION');
  const violation = inspectSource('apps/demo/ai.mjs', "import OpenAI from 'openai';");
  assert.ok(violation.some((v) => v.code === 'LEARNER_FACING_GENERATIVE_AI'));
});

test('SP-001-AC10 a notification request for an unapproved purpose is rejected', async () => {
  const binding = await boundRuntime();
  const notificationAdapter = { register: async () => ({ granted: true }) };
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding, notificationAdapter });
  await assert.rejects(
    () => policy.registerNotification('random-promotional-blast', {}),
    (e) => e instanceof LearnerSafetyError && e.code === 'NOTIFICATION_PURPOSE_NOT_APPROVED'
  );
});

test('SP-001-AC11 only coarse policy/capability/purpose telemetry is emitted, without sensitive content', async () => {
  const binding = await boundRuntime();
  const events = [];
  const notificationAdapter = { register: async () => ({ granted: true }) };
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding, notificationAdapter, onTelemetry: (e) => events.push(e) });
  await policy.registerNotification('session-reminder-30-min', { contactsSnapshot: 'should-not-appear' });
  policy.requestCapability('notifications');
  assert.ok(events.length > 0);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'appId', 'correlationId', 'capability', 'status', 'purposeId', 'behavior', 'destinationClass', 'cause'].includes(k)));
    assert.equal(JSON.stringify(event).includes('contactsSnapshot'), false);
  }
});

test('SP-001-P1 telemetry never includes a raw notification-adapter exception message', async () => {
  const binding = await boundRuntime();
  const events = [];
  const notificationAdapter = { register: async () => { throw new Error('leaked-notification-payload-detail'); } };
  const policy = createLearnerSafetyPolicy({ runtimeBinding: binding, notificationAdapter, onTelemetry: (e) => events.push(e) });
  const result = await policy.registerNotification('session-reminder-30-min', {});
  assert.equal(result.registered, false);
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(JSON.stringify(event).includes('leaked-notification-payload-detail'), false);
  }
});
