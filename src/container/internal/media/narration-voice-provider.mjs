import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';

export class NarrationVoiceError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'NarrationVoiceError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new NarrationVoiceError(code, message, metadata); }

const FORBIDDEN_OPTION_KEYS = new Set(['voiceId', 'systemVoiceId', 'voiceName', 'osVoice']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// AM-002: exposes the Babysteps-approved packaged narration voice as one technical
// narration capability behind AM-001. App-specific code supplies text/timing intent
// only; it cannot select an arbitrary OS/browser voice for standard narration.
export function createNarrationVoiceProvider({
  runtimeBinding,
  audioRuntime,
  voicePackage,
  loadVoiceEngine,
  synthesize,
  approvedFallbackVoices = {},
  onTelemetry = () => {},
}) {
  if (!audioRuntime || typeof audioRuntime.play !== 'function') {
    fail('NARRATION_VOICE_UNAVAILABLE', 'An AM-001 audio runtime is required to create a narration voice provider.');
  }
  if (!voicePackage || !isNonEmptyString(voicePackage.id) || !isNonEmptyString(voicePackage.version)) {
    fail('NARRATION_VOICE_UNAVAILABLE', 'A packaged voice id/version is required to create a narration voice provider.');
  }

  const identity = getRuntimeContext(runtimeBinding);
  let engine = null;
  let activeVoicePackage = voicePackage;

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      appId: identity.appId,
      correlationId: identity.correlationId,
      voiceId: activeVoicePackage.id,
      voiceVersion: activeVoicePackage.version,
      ...extra,
    }));
  }

  function isCompatible(pkg) {
    if (!Array.isArray(pkg.compatibleReleaseIds)) return true;
    return pkg.compatibleReleaseIds.includes(identity.releaseId);
  }

  async function loadPackage(pkg, reason) {
    try {
      engine = typeof loadVoiceEngine === 'function' ? await loadVoiceEngine(pkg) : { pkg };
      activeVoicePackage = pkg;
      emit('narration_voice_initialized', { reason });
      return engine;
    } catch (error) {
      emit('narration_voice_load_failed', { reason, cause: error?.message });
      return null;
    }
  }

  async function ensureEngine() {
    if (engine) return engine;

    if (!isCompatible(voicePackage)) {
      const fallback = approvedFallbackVoices.INCOMPATIBLE_RELEASE;
      if (!fallback) {
        fail('NARRATION_VOICE_INCOMPATIBLE', 'The packaged voice version is incompatible with the current app/runtime release and no approved fallback is configured.');
      }
      const loaded = await loadPackage(fallback, 'INCOMPATIBLE_RELEASE_FALLBACK');
      if (!loaded) fail('NARRATION_VOICE_UNAVAILABLE', 'The approved fallback narration voice could not be loaded.');
      return loaded;
    }

    const loaded = await loadPackage(voicePackage, 'PRIMARY');
    if (loaded) return loaded;

    const fallback = approvedFallbackVoices.LOAD_FAILED;
    if (!fallback) {
      fail('NARRATION_VOICE_UNAVAILABLE', 'The packaged narration voice is missing or corrupt and no approved fallback is configured.');
    }
    const fallbackLoaded = await loadPackage(fallback, 'LOAD_FAILED_FALLBACK');
    if (!fallbackLoaded) fail('NARRATION_VOICE_UNAVAILABLE', 'The approved fallback narration voice could not be loaded.');
    return fallbackLoaded;
  }

  async function narrate(text, options = {}) {
    if (!isNonEmptyString(text)) {
      fail('NARRATION_SYNTHESIS_FAILED', 'Narration text must be a non-empty string.');
    }
    for (const key of Object.keys(options)) {
      if (FORBIDDEN_OPTION_KEYS.has(key)) {
        fail('NARRATION_VOICE_SELECTION_DENIED', `Narration options must not select an arbitrary device voice ("${key}" is not permitted).`, { key });
      }
    }

    const loadedEngine = await ensureEngine();

    let sourceRef;
    try {
      sourceRef = typeof synthesize === 'function'
        ? await synthesize(text, loadedEngine, options)
        : `narration://${activeVoicePackage.id}@${activeVoicePackage.version}`;
    } catch (error) {
      emit('narration_synthesis_failed', { cause: error?.message });
      fail('NARRATION_SYNTHESIS_FAILED', 'Narration synthesis failed for the requested text.', { cause: error?.message });
    }

    const handle = audioRuntime.play(sourceRef, { generation: options.generation, allowOverlap: options.allowOverlap });
    emit('narration_playback_started', { handleId: handle.id });
    return Object.freeze({ handle, voiceId: activeVoicePackage.id, voiceVersion: activeVoicePackage.version });
  }

  return Object.freeze({
    narrate,
    get activeVoiceId() { return activeVoicePackage.id; },
    get activeVoiceVersion() { return activeVoicePackage.version; },
  });
}
