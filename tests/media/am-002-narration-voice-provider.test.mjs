import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createAudioRuntime } from '../../src/container/internal/media/audio-runtime.mjs';
import { createNarrationVoiceProvider, createProductionNarrationVoiceProvider, NarrationVoiceError } from '../../src/container/internal/media/narration-voice-provider.mjs';
import { VOICE_PACKAGE_REGISTRY } from '../../src/container/internal/governance/voice-package-registry.mjs';

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

function playerFactory() { return { pause() {}, resume() {}, stop() {}, onEnded() {}, onError() {} }; }

async function harness({ voicePackage, ...rest } = {}) {
  const binding = await boundRuntime();
  const audioRuntime = createAudioRuntime({ runtimeBinding: binding, playerFactory });
  const provider = createNarrationVoiceProvider({
    runtimeBinding: binding,
    audioRuntime,
    voicePackage: voicePackage ?? { id: 'babysteps-standard-voice', version: '1.0.0' },
    ...rest,
  });
  return { binding, audioRuntime, provider };
}

test('AM-002-AC01 required narration uses the approved packaged voice, not an arbitrary installed voice', async () => {
  const { provider } = await harness();
  const result = await provider.narrate('Great job!');
  assert.equal(result.voiceId, 'babysteps-standard-voice');
});

test('AM-002-AC02 the packaged voice remains the primary source without depending on an installed OS/browser voice', async () => {
  const { provider } = await harness({
    loadVoiceEngine: async (pkg) => ({ engineFor: pkg.id }),
  });
  const result = await provider.narrate('Read this number.');
  assert.equal(result.voiceId, 'babysteps-standard-voice');
});

test('AM-002-AC03 the same approved voice identity/version is used consistently across environments', async () => {
  const { provider: providerA } = await harness();
  const { provider: providerB } = await harness();
  const resultA = await providerA.narrate('Same text');
  const resultB = await providerB.narrate('Same text');
  assert.equal(resultA.voiceVersion, resultB.voiceVersion);
  assert.equal(resultA.voiceId, resultB.voiceId);
});

test('AM-002-AC04 app-specific code cannot select an arbitrary OS/browser voice identifier for standard narration', async () => {
  const { provider } = await harness();
  await assert.rejects(
    () => provider.narrate('Text', { voiceId: 'com.apple.speech.some-voice' }),
    (e) => e instanceof NarrationVoiceError && e.code === 'NARRATION_VOICE_SELECTION_DENIED'
  );
});

test('AM-002-AC05 a missing/corrupt packaged voice fails explicitly instead of silently substituting a device voice', async () => {
  const { provider } = await harness({
    loadVoiceEngine: async () => { throw new Error('asset missing'); },
  });
  await assert.rejects(
    () => provider.narrate('Text'),
    (e) => e instanceof NarrationVoiceError && e.code === 'NARRATION_VOICE_UNAVAILABLE'
  );
});

test('AM-002-AC06 an incompatible voice package version fails safely or uses only an explicitly approved fallback', async () => {
  const incompatible = { id: 'legacy-voice', version: '0.1.0', compatibleReleaseIds: ['some-other-release'] };
  const strict = await harness({ voicePackage: incompatible });
  await assert.rejects(
    () => strict.provider.narrate('Text'),
    (e) => e.code === 'NARRATION_VOICE_INCOMPATIBLE'
  );

  const withFallback = await harness({
    voicePackage: incompatible,
    approvedFallbackVoices: { INCOMPATIBLE_RELEASE: { id: 'approved-fallback', version: '1.0.0' } },
  });
  const result = await withFallback.provider.narrate('Text');
  assert.equal(result.voiceId, 'approved-fallback');
});

test('AM-002-AC07 the voice package version is tied to the release and can be swapped/tested independently', async () => {
  const { provider: v1 } = await harness({ voicePackage: { id: 'standard', version: '1.0.0' } });
  const { provider: v2 } = await harness({ voicePackage: { id: 'standard', version: '2.0.0' } });
  const r1 = await v1.narrate('Hello');
  const r2 = await v2.narrate('Hello');
  assert.notEqual(r1.voiceVersion, r2.voiceVersion);
});

test('AM-002-AC08 voice engine resources are reused across repeated narration calls', async () => {
  let initCount = 0;
  const { provider } = await harness({
    loadVoiceEngine: async (pkg) => { initCount += 1; return { pkg }; },
  });
  await provider.narrate('One');
  await provider.narrate('Two');
  await provider.narrate('Three');
  assert.equal(initCount, 1);
});

test('AM-002-AC09 the shared runtime speaks app-provided text for different apps without interpreting content', async () => {
  const { provider: mathProvider } = await harness();
  const { provider: chessProvider } = await harness();
  const mathResult = await mathProvider.narrate('Two plus two equals four.');
  const chessResult = await chessProvider.narrate('The knight moves to f3.');
  assert.equal(mathResult.voiceId, chessResult.voiceId);
});

test('AM-002-AC10 only coarse voice package/version/lifecycle telemetry is emitted, not narration text', async () => {
  const events = [];
  const { provider } = await harness({ onTelemetry: (e) => events.push(e) });
  await provider.narrate('This exact sentence must not appear in telemetry.');
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(JSON.stringify(event).includes('This exact sentence'), false);
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'appId', 'correlationId', 'voiceId', 'voiceVersion', 'reason', 'cause', 'handleId'].includes(k)));
  }
});

test('AM-002-P1 telemetry never includes a raw voice-engine/synthesis exception message', async () => {
  const events = [];
  const loadFailure = await harness({
    onTelemetry: (e) => events.push(e),
    loadVoiceEngine: async () => { throw new Error('leaked-narration-transcript-load-failure'); },
  });
  await assert.rejects(() => loadFailure.provider.narrate('Text'));

  const synthesisFailure = await harness({
    onTelemetry: (e) => events.push(e),
    synthesize: async () => { throw new Error('leaked-narration-transcript-synthesis-failure'); },
  });
  await assert.rejects(() => synthesisFailure.provider.narrate('Text'));

  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(JSON.stringify(event).includes('leaked-narration-transcript'), false);
  }
});

test('AM-002-AC11 a fallback voice is used only when explicitly approved, never an arbitrary local selection', async () => {
  const { provider } = await harness({
    loadVoiceEngine: async (pkg) => { if (pkg.id === 'babysteps-standard-voice') throw new Error('missing'); return { pkg }; },
    approvedFallbackVoices: { LOAD_FAILED: { id: 'accessibility-fallback', version: '1.0.0' } },
  });
  const result = await provider.narrate('Text');
  assert.equal(result.voiceId, 'accessibility-fallback');
});

test('AM-002-P1 production narration resolves the primary/fallback voice packages from the trusted PK-003-keyed registry, not caller input', async () => {
  const binding = await boundRuntime();
  const audioRuntime = createAudioRuntime({ runtimeBinding: binding, playerFactory });
  const registryEntry = VOICE_PACKAGE_REGISTRY['1.0.0'];

  const provider = createProductionNarrationVoiceProvider({
    runtimeBinding: binding,
    audioRuntime,
    releaseComposition: { voicePackageVersion: '1.0.0' },
  });
  const result = await provider.narrate('Great job!');
  assert.equal(result.voiceId, registryEntry.voicePackage.id);
  assert.equal(result.voiceVersion, registryEntry.voicePackage.version);
});

test('AM-002-P1 an unregistered/forged voicePackageVersion is rejected instead of falling back to caller-supplied packages', async () => {
  const binding = await boundRuntime();
  const audioRuntime = createAudioRuntime({ runtimeBinding: binding, playerFactory });

  assert.throws(
    () => createProductionNarrationVoiceProvider({
      runtimeBinding: binding,
      audioRuntime,
      releaseComposition: { voicePackageVersion: 'forged-9.9.9' },
      // Even if a caller tried to smuggle a package in, createProductionNarrationVoiceProvider
      // never reads voicePackage/approvedFallbackVoices from its own arguments.
      voicePackage: { id: 'attacker-voice', version: '1.0.0' },
    }),
    (e) => e instanceof NarrationVoiceError && e.code === 'NARRATION_VOICE_UNAVAILABLE'
  );

  assert.throws(
    () => createProductionNarrationVoiceProvider({ runtimeBinding: binding, audioRuntime, releaseComposition: null }),
    (e) => e instanceof NarrationVoiceError && e.code === 'NARRATION_VOICE_UNAVAILABLE'
  );
});
