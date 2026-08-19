import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';

export class SpeechInputError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'SpeechInputError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new SpeechInputError(code, message, metadata); }

function defaultRecognizerFactory() {
  return {
    start() {},
    stop() {},
    cancel() {},
    onResult() {},
    onError() {},
  };
}

// AM-003: baseline microphone/STT capability. Actual capture starts only for an active
// spoken-response interaction (startListening) and stops immediately on completion,
// cancellation, activity disposal, session end or backgrounding. The shared runtime never
// interprets transcripts educationally, and raw audio never passes through this module -
// callers supply/receive only technical handles and transcript text via the recognizer.
export function createSpeechInputRuntime({
  runtimeBinding,
  recognizerFactory = defaultRecognizerFactory,
  requestPermission = async () => ({ granted: true }),
  onTelemetry = () => {},
}) {
  const identity = getRuntimeContext(runtimeBinding);
  let sequence = 0;
  let activeGeneration = 0;
  let eligible = true;
  let active = null; // { id, generation, recognizer, state }

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      appId: identity.appId,
      correlationId: identity.correlationId,
      ...extra,
    }));
  }

  function bindActivityGeneration(generation) {
    if (typeof generation !== 'number') fail('SPEECH_RUNTIME_INELIGIBLE', 'bindActivityGeneration requires a numeric generation.');
    activeGeneration = generation;
  }

  function releaseEntry(entry, reason) {
    if (active !== entry) return;
    active = null;
    try {
      entry.recognizer.stop();
    } catch {
      /* best-effort microphone release; the entry is already detached from `active` */
    }
    emit('speech_input_stopped', { handleId: entry.id, generation: entry.generation, reason });
  }

  function stop(handle, reason = 'RESPONSE_COMPLETED') {
    if (!handle || typeof handle.id !== 'number' || !active || active.id !== handle.id) return { alreadyStopped: true };
    releaseEntry(active, reason);
    return { stopped: true };
  }

  function cancel(handle) {
    if (!handle || typeof handle.id !== 'number' || !active || active.id !== handle.id) return { alreadyStopped: true };
    const entry = active;
    active = null;
    try {
      entry.recognizer.cancel();
    } catch {
      /* best-effort cancellation cleanup */
    }
    emit('speech_input_cancelled', { handleId: entry.id, generation: entry.generation });
    return { cancelled: true };
  }

  function releaseGeneration(generation, reason = 'ACTIVITY_DISPOSED') {
    if (active && active.generation === generation) {
      releaseEntry(active, reason);
      return { stoppedCount: 1 };
    }
    return { stoppedCount: 0 };
  }

  function disposeAll(reason = 'SESSION_ENDED') {
    if (!active) return { stoppedCount: 0 };
    releaseEntry(active, reason);
    return { stoppedCount: 1 };
  }

  function setEligible(next) {
    if (typeof next !== 'boolean') fail('SPEECH_RUNTIME_INELIGIBLE', 'setEligible requires a boolean.');
    if (eligible === next) return { changed: false };
    eligible = next;
    if (!next) disposeAll('RUNTIME_INELIGIBLE');
    return { changed: true };
  }

  async function startListening(options = {}) {
    if (!eligible) fail('SPEECH_RUNTIME_INELIGIBLE', 'The shared speech runtime is not eligible for capture in the current lifecycle state.');

    if (active) {
      if (!options.replace) fail('SPEECH_INPUT_ALREADY_ACTIVE', 'A speech-input listening session is already active for this runtime.');
      releaseEntry(active, 'REPLACED');
    }

    let permission;
    try {
      permission = await requestPermission();
    } catch (error) {
      emit('speech_permission_failed', { cause: error?.message });
      fail('SPEECH_PERMISSION_DENIED', 'Microphone permission could not be resolved.', { cause: error?.message });
    }
    if (!permission || permission.granted !== true) {
      emit('speech_permission_denied');
      fail('SPEECH_PERMISSION_DENIED', 'Microphone permission was denied for the requested spoken-response interaction.');
    }

    const generation = typeof options.generation === 'number' ? options.generation : activeGeneration;
    let recognizer;
    try {
      recognizer = recognizerFactory(options);
    } catch (error) {
      emit('speech_input_unavailable', { cause: error?.message });
      fail('SPEECH_INPUT_UNAVAILABLE', 'The speech-input capability could not be started.', { cause: error?.message });
    }

    const id = ++sequence;
    const entry = { id, generation, recognizer, state: 'LISTENING' };
    active = entry;
    emit('speech_input_started', { handleId: id, generation });

    const guardedDelivery = (kind, handler) => (payload) => {
      if (active !== entry || entry.generation !== activeGeneration) {
        emit('speech_stale_result_rejected', { handleId: id, generation: entry.generation, kind });
        return;
      }
      active = null;
      if (typeof handler === 'function') handler(payload);
    };

    if (typeof recognizer.onResult === 'function') {
      recognizer.onResult(guardedDelivery('result', (transcript) => {
        emit('speech_input_result_delivered', { handleId: id, generation });
        options.onResult?.(transcript);
      }));
    }
    if (typeof recognizer.onError === 'function') {
      recognizer.onError(guardedDelivery('error', (error) => {
        emit('speech_recognition_failed', { handleId: id, generation, cause: error?.message });
        options.onError?.(new SpeechInputError('SPEECH_RECOGNITION_FAILED', 'Speech recognition failed for the active request.', { cause: error?.message }));
      }));
    }

    try {
      recognizer.start();
    } catch (error) {
      active = null;
      emit('speech_input_unavailable', { cause: error?.message });
      fail('SPEECH_INPUT_UNAVAILABLE', 'The speech-input capability failed to start capture.', { cause: error?.message });
    }

    return Object.freeze({ id, generation });
  }

  return Object.freeze({
    bindActivityGeneration,
    startListening,
    stop,
    cancel,
    releaseGeneration,
    disposeAll,
    setEligible,
    isEligible: () => eligible,
    isListening: () => active !== null,
  });
}
