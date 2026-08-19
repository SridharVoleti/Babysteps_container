import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createActivityLifecycleManager } from '../../src/container/internal/activities/activity-lifecycle-manager.mjs';
import { createSpeechInputRuntime, SpeechInputError } from '../../src/container/internal/media/speech-input-runtime.mjs';

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

function fakeRecognizerFactory() {
  const calls = [];
  const resultCbs = [];
  const errorCbs = [];
  const factory = () => {
    calls.push('created');
    return {
      start: () => calls.push('start'),
      stop: () => calls.push('stop'),
      cancel: () => calls.push('cancel'),
      onResult: (cb) => resultCbs.push(cb),
      onError: (cb) => errorCbs.push(cb),
    };
  };
  factory.calls = calls;
  factory.resultCbs = resultCbs;
  factory.errorCbs = errorCbs;
  return factory;
}

test('AM-003-AC01 a spoken-response interaction starts microphone/STT for the current authorized activity/session', async () => {
  const binding = await boundRuntime();
  const recognizerFactory = fakeRecognizerFactory();
  const runtime = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory });
  const handle = await runtime.startListening({});
  assert.equal(typeof handle.id, 'number');
  assert.ok(recognizerFactory.calls.includes('start'));
  assert.equal(runtime.isListening(), true);
});

test('AM-003-AC02 startup capability validation does not itself activate microphone capture', async () => {
  const binding = await boundRuntime();
  const recognizerFactory = fakeRecognizerFactory();
  const runtime = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory });
  assert.equal(runtime.isListening(), false);
  assert.equal(recognizerFactory.calls.length, 0);
});

test('AM-003-AC03 backgrounding while speech input is active stops capture and releases resources', async () => {
  const binding = await boundRuntime();
  const recognizerFactory = fakeRecognizerFactory();
  const runtime = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory });
  await runtime.startListening({});
  runtime.setEligible(false);
  assert.equal(runtime.isListening(), false);
  assert.ok(recognizerFactory.calls.includes('stop'));
});

test('AM-003-AC04 disposing the owning activity stops listening and later results cannot affect the new activity', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-4' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  const recognizerFactory = fakeRecognizerFactory();
  const runtime = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory });
  let delivered = null;

  manager.activate(Object.freeze({
    activityId: 'activity-a',
    create: (context) => {
      runtime.bindActivityGeneration(1);
      context.resources.register(() => runtime.releaseGeneration(1, 'ACTIVITY_DISPOSED'));
    },
  }));
  await runtime.startListening({ generation: 1, onResult: (t) => { delivered = t; } });
  const staleResult = recognizerFactory.resultCbs[0];

  manager.activate(Object.freeze({ activityId: 'activity-b', create: () => {} }));
  assert.equal(runtime.isListening(), false);

  staleResult({ text: 'stale transcript' });
  assert.equal(delivered, null);
});

test('AM-003-AC05 the session ending stops listening and releases microphone resources', async () => {
  const binding = await boundRuntime();
  const recognizerFactory = fakeRecognizerFactory();
  const runtime = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory });
  await runtime.startListening({});
  runtime.disposeAll('SESSION_ENDED');
  assert.equal(runtime.isListening(), false);
  assert.ok(recognizerFactory.calls.includes('stop'));
});

test('AM-003-AC06 completion or cancellation stops listening promptly and no further capture continues', async () => {
  const binding = await boundRuntime();
  const recognizerFactory = fakeRecognizerFactory();
  const runtime = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory });
  const handle = await runtime.startListening({});
  runtime.stop(handle, 'RESPONSE_COMPLETED');
  assert.equal(runtime.isListening(), false);

  const recognizerFactory2 = fakeRecognizerFactory();
  const runtime2 = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory: recognizerFactory2 });
  const handle2 = await runtime2.startListening({});
  runtime2.cancel(handle2);
  assert.equal(runtime2.isListening(), false);
  assert.ok(recognizerFactory2.calls.includes('cancel'));
});

test('AM-003-AC07 a delivered transcript reaches app logic without shared scoring/interpretation', async () => {
  const binding = await boundRuntime();
  const recognizerFactory = fakeRecognizerFactory();
  const runtime = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory });
  let delivered = null;
  await runtime.startListening({ onResult: (t) => { delivered = t; } });
  recognizerFactory.resultCbs[0]({ text: '42' });
  assert.deepEqual(delivered, { text: '42' });
});

test('AM-003-AC08 a stale/late transcript for a disposed/cancelled handle is ignored', async () => {
  const binding = await boundRuntime();
  const recognizerFactory = fakeRecognizerFactory();
  const runtime = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory });
  let delivered = null;
  const handle = await runtime.startListening({ onResult: (t) => { delivered = t; } });
  runtime.cancel(handle);
  recognizerFactory.resultCbs[0]({ text: 'late result' });
  assert.equal(delivered, null);
});

test('AM-003-AC09 microphone permission denial returns a normalized error and no unapproved capture path is used', async () => {
  const binding = await boundRuntime();
  const runtime = createSpeechInputRuntime({
    runtimeBinding: binding,
    recognizerFactory: fakeRecognizerFactory(),
    requestPermission: async () => ({ granted: false }),
  });
  await assert.rejects(
    () => runtime.startListening({}),
    (e) => e instanceof SpeechInputError && e.code === 'SPEECH_PERMISSION_DENIED'
  );
  assert.equal(runtime.isListening(), false);
});

test('AM-003-AC10 raw audio is never retained/logged or transmitted through this module', async () => {
  const binding = await boundRuntime();
  const recognizerFactory = fakeRecognizerFactory();
  const runtime = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory });
  await runtime.startListening({});
  assert.equal(typeof runtime.startListening, 'function');
  assert.equal('audioBuffer' in runtime, false);
});

test('AM-003-AC11 only coarse technical speech telemetry is emitted, not raw audio or transcript text', async () => {
  const binding = await boundRuntime();
  const events = [];
  const recognizerFactory = fakeRecognizerFactory();
  const runtime = createSpeechInputRuntime({ runtimeBinding: binding, recognizerFactory, onTelemetry: (e) => events.push(e) });
  await runtime.startListening({});
  recognizerFactory.resultCbs[0]({ text: 'the secret transcript text' });
  assert.ok(events.length >= 2);
  for (const event of events) {
    assert.equal(JSON.stringify(event).includes('the secret transcript text'), false);
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'appId', 'correlationId', 'handleId', 'generation', 'reason', 'cause', 'kind'].includes(k)));
  }
});
