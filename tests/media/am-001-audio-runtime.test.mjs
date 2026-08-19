import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createActivityLifecycleManager } from '../../src/container/internal/activities/activity-lifecycle-manager.mjs';
import { createAudioRuntime, AudioRuntimeError } from '../../src/container/internal/media/audio-runtime.mjs';

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

function fakePlayerFactory() {
  const calls = [];
  const endedCbs = [];
  const errorCbs = [];
  const factory = (source, options) => {
    calls.push({ source, options });
    return {
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
      stop: () => calls.push('stop'),
      onEnded: (cb) => endedCbs.push(cb),
      onError: (cb) => errorCbs.push(cb),
    };
  };
  factory.calls = calls;
  factory.endedCbs = endedCbs;
  factory.errorCbs = errorCbs;
  return factory;
}

test('AM-001-AC01 an active activity plays approved audio through the shared technical facade', async () => {
  const binding = await boundRuntime();
  const factory = fakePlayerFactory();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: factory });
  const handle = runtime.play('spoken-feedback.mp3', { purpose: 'app-defined-only' });
  assert.equal(typeof handle.id, 'number');
  assert.equal(factory.calls[0].source, 'spoken-feedback.mp3');
});

test('AM-001-AC02 different apps can use entirely different audio content without shared scripting', async () => {
  const binding = await boundRuntime();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: fakePlayerFactory() });
  const mathAudio = runtime.play('math-narration.mp3', { allowOverlap: true });
  const chessAudio = runtime.play('chess-move-sound.mp3', { allowOverlap: true });
  assert.notEqual(mathAudio.source, chessAudio.source);
});

test('AM-001-AC03 pause/resume changes state without creating a duplicate player', async () => {
  const binding = await boundRuntime();
  const factory = fakePlayerFactory();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: factory });
  const handle = runtime.play('a.mp3');
  runtime.pause(handle);
  runtime.resume(handle);
  assert.equal(factory.calls.filter((c) => typeof c === 'object').length, 1);
  assert.deepEqual(factory.calls.filter((c) => typeof c === 'string'), ['pause', 'resume']);
});

test('AM-001-AC04 replacing current playback stops the outgoing playback first unless overlap is approved', async () => {
  const binding = await boundRuntime();
  const factory = fakePlayerFactory();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: factory });
  runtime.play('first.mp3');
  runtime.play('second.mp3');
  assert.equal(runtime.activeHandleCount(), 1);
  assert.ok(factory.calls.includes('stop'));
});

test('AM-001-AC05 disposing the owning activity stops/releases its audio and cannot affect the new activity', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-5' });
  const manager = createActivityLifecycleManager({ runtimeBinding: binding });
  const factory = fakePlayerFactory();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: factory });

  const activityA = Object.freeze({
    activityId: 'activity-a',
    create: (context) => {
      runtime.bindActivityGeneration(1);
      const handle = runtime.play('a-audio.mp3', { generation: 1 });
      context.resources.register(() => runtime.releaseGeneration(1, 'ACTIVITY_DISPOSED'));
      return { handle };
    },
  });
  manager.activate(activityA);
  assert.equal(runtime.activeHandleCount(), 1);

  manager.activate(Object.freeze({ activityId: 'activity-b', create: () => {} }));
  assert.equal(runtime.activeHandleCount(), 0);
  assert.ok(factory.calls.includes('stop'));
});

test('AM-001-AC06 playback is stopped through the common runtime path when the session ends', async () => {
  const binding = await boundRuntime();
  const factory = fakePlayerFactory();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: factory });
  runtime.play('a.mp3');
  runtime.disposeAll('SESSION_ENDED');
  assert.equal(runtime.activeHandleCount(), 0);
});

test('AM-001-AC07 becoming playback-ineligible stops/releases audio and blocks new unmanaged playback', async () => {
  const binding = await boundRuntime();
  const factory = fakePlayerFactory();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: factory });
  runtime.play('a.mp3');
  runtime.setEligible(false);
  assert.equal(runtime.activeHandleCount(), 0);
  assert.throws(() => runtime.play('b.mp3'), (e) => e instanceof AudioRuntimeError && e.code === 'AUDIO_RUNTIME_INELIGIBLE');
});

test('AM-001-AC08 a delayed completion callback from disposed/obsolete playback is ignored', async () => {
  const binding = await boundRuntime();
  const factory = fakePlayerFactory();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: factory });
  runtime.play('a.mp3', { generation: 1 });
  runtime.bindActivityGeneration(1);
  runtime.releaseGeneration(1, 'REPLACED');
  const staleEnded = factory.endedCbs[0];
  assert.doesNotThrow(() => staleEnded());
  assert.equal(runtime.activeHandleCount(), 0);
});

test('AM-001-AC09 repeated stop/dispose of the same handle is safe and does not duplicate effects', async () => {
  const binding = await boundRuntime();
  const factory = fakePlayerFactory();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: factory });
  const handle = runtime.play('a.mp3');
  const first = runtime.stop(handle);
  const second = runtime.stop(handle);
  const third = runtime.stop(handle);
  assert.equal(first.stopped, true);
  assert.equal(second.alreadyStopped, true);
  assert.equal(third.alreadyStopped, true);
  assert.equal(factory.calls.filter((c) => c === 'stop').length, 1);
});

test('AM-001-AC10 an invalid/unavailable audio source returns a normalized technical failure', async () => {
  const binding = await boundRuntime();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: fakePlayerFactory() });
  assert.throws(() => runtime.play(''), (e) => e instanceof AudioRuntimeError && e.code === 'AUDIO_SOURCE_UNAVAILABLE');
  assert.throws(() => runtime.play(null), (e) => e.code === 'AUDIO_SOURCE_UNAVAILABLE');
});

test('AM-001-AC11 only coarse technical playback telemetry is emitted, not spoken content or listening history', async () => {
  const binding = await boundRuntime();
  const events = [];
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: fakePlayerFactory(), onTelemetry: (e) => events.push(e) });
  const handle = runtime.play('secret-narration-text-should-not-appear.mp3');
  runtime.stop(handle);
  assert.ok(events.length >= 2);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'appId', 'correlationId', 'handleId', 'generation', 'reason', 'source', 'cause', 'callSite'].includes(k)));
    assert.equal(JSON.stringify(event).includes('secret-narration-text'), false);
  }
});

test('AM-001-P1 telemetry never includes a raw player-adapter exception message or the app-supplied source reference', async () => {
  const binding = await boundRuntime();
  const events = [];
  const throwingPlayerFactory = () => { throw new Error('leaked-narration-transcript-should-not-appear'); };
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: throwingPlayerFactory, onTelemetry: (e) => events.push(e) });

  assert.throws(
    () => runtime.play('secret-narration-source-ref.mp3'),
    (e) => e instanceof AudioRuntimeError && e.code === 'AUDIO_PLAYBACK_FAILED'
  );

  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(JSON.stringify(event).includes('leaked-narration-transcript'), false);
    assert.equal(JSON.stringify(event).includes('secret-narration-source-ref'), false);
    assert.equal('source' in event, false);
  }
});

test('AM-001 a stale handle cannot be paused/resumed after replacement', async () => {
  const binding = await boundRuntime();
  const runtime = createAudioRuntime({ runtimeBinding: binding, playerFactory: fakePlayerFactory() });
  const first = runtime.play('a.mp3');
  runtime.play('b.mp3');
  assert.throws(() => runtime.pause(first), (e) => e instanceof AudioRuntimeError && e.code === 'AUDIO_HANDLE_STALE');
});
