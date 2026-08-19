import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';
import { sanitizeCause } from '../telemetry/sanitize-cause.mjs';

export class AudioRuntimeError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'AudioRuntimeError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new AudioRuntimeError(code, message, metadata); }

function defaultPlayerFactory() {
  const endedCallbacks = [];
  const errorCallbacks = [];
  return {
    pause() {},
    resume() {},
    stop() {},
    onEnded: (cb) => { endedCallbacks.push(cb); },
    onError: (cb) => { errorCallbacks.push(cb); },
  };
}

// AM-001: technical playback lifecycle only. This module never inspects or interprets
// `source`/`options` for educational meaning - narration scripts, sound-effect timing and
// pedagogy remain entirely app-owned (AM-001-AC02/AC09).
export function createAudioRuntime({
  runtimeBinding,
  playerFactory = defaultPlayerFactory,
  onTelemetry = () => {},
}) {
  const identity = getRuntimeContext(runtimeBinding);
  let sequence = 0;
  let activeGeneration = 0;
  let eligible = true;
  const handles = new Map();

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      appId: identity.appId,
      correlationId: identity.correlationId,
      ...extra,
    }));
  }

  function bindActivityGeneration(generation) {
    if (typeof generation !== 'number') {
      fail('AUDIO_RUNTIME_INVALID', 'bindActivityGeneration requires a numeric generation.');
    }
    activeGeneration = generation;
  }

  function stopEntry(entry, reason) {
    handles.delete(entry.id);
    entry.state = 'STOPPED';
    try {
      entry.player.stop();
    } catch (error) {
      emit('audio_resource_cleanup_failed', { handleId: entry.id, generation: entry.generation, cause: sanitizeCause(error) });
      fail('AUDIO_RESOURCE_CLEANUP_FAILED', 'Releasing an audio playback resource failed.', { handleId: entry.id, cause: error?.message });
    }
    emit('audio_playback_stopped', { handleId: entry.id, generation: entry.generation, reason });
  }

  function stop(handle, reason = 'MANUAL_STOP') {
    if (!handle || typeof handle.id !== 'number') return { alreadyStopped: true };
    const entry = handles.get(handle.id);
    if (!entry) return { alreadyStopped: true };
    stopEntry(entry, reason);
    return { stopped: true };
  }

  function stopMatching(predicate, reason) {
    const targets = [...handles.values()].filter(predicate);
    for (const entry of targets) stopEntry(entry, reason);
    return Object.freeze({ stoppedCount: targets.length });
  }

  function stopAllForCurrentActivity(reason = 'ACTIVITY_LIFECYCLE') {
    return stopMatching((entry) => entry.generation === activeGeneration, reason);
  }

  function releaseGeneration(generation, reason = 'ACTIVITY_DISPOSED') {
    return stopMatching((entry) => entry.generation === generation, reason);
  }

  function disposeAll(reason = 'RUNTIME_INELIGIBLE') {
    return stopMatching(() => true, reason);
  }

  function setEligible(next) {
    if (typeof next !== 'boolean') fail('AUDIO_RUNTIME_INVALID', 'setEligible requires a boolean.');
    if (eligible === next) return { changed: false };
    eligible = next;
    if (!next) disposeAll('RUNTIME_INELIGIBLE');
    return { changed: true };
  }

  function guardHandle(handle, callSite) {
    if (!handle || typeof handle.id !== 'number') {
      fail('AUDIO_HANDLE_STALE', `"${callSite}" requires a valid audio handle.`, { callSite });
    }
    const entry = handles.get(handle.id);
    if (!entry || entry.generation !== activeGeneration) {
      emit('audio_stale_callback_rejected', { handleId: handle.id, callSite });
      fail('AUDIO_HANDLE_STALE', `"${callSite}" was rejected because the audio handle is stale or unknown.`, { callSite });
    }
    return entry;
  }

  function play(source, options = {}) {
    if (!eligible) {
      fail('AUDIO_RUNTIME_INELIGIBLE', 'The shared audio runtime is not eligible for playback in the current lifecycle state.');
    }
    if (typeof source !== 'string' || source.trim() === '') {
      fail('AUDIO_SOURCE_UNAVAILABLE', 'A valid audio source reference is required.');
    }

    const generation = typeof options.generation === 'number' ? options.generation : activeGeneration;
    if (!options.allowOverlap) {
      stopMatching((entry) => entry.generation === generation, 'REPLACED');
    }

    let player;
    try {
      player = playerFactory(source, options);
    } catch (error) {
      // `source` is never emitted - it is app-supplied and may encode narration/content
      // references (AM-001-AC11).
      emit('audio_playback_failed', { cause: sanitizeCause(error) });
      fail('AUDIO_PLAYBACK_FAILED', 'The audio player failed to initialize for the requested source.', { cause: error?.message });
    }

    const id = ++sequence;
    const entry = { id, generation, source, player, state: 'PLAYING' };
    handles.set(id, entry);
    emit('audio_playback_started', { handleId: id, generation });

    const finish = (event, extra = {}) => {
      const current = handles.get(id);
      if (!current || current.generation !== activeGeneration) {
        emit('audio_stale_callback_rejected', { handleId: id, generation, callSite: event });
        return { ignored: true };
      }
      handles.delete(id);
      emit(event, { handleId: id, generation, ...extra });
      return { ignored: false };
    };

    if (typeof player.onEnded === 'function') player.onEnded(() => finish('audio_playback_completed'));
    if (typeof player.onError === 'function') player.onError((error) => finish('audio_playback_failed', { cause: sanitizeCause(error) }));

    return Object.freeze({ id, generation, source });
  }

  function pause(handle) {
    const entry = guardHandle(handle, 'pause');
    entry.player.pause();
    entry.state = 'PAUSED';
    emit('audio_playback_paused', { handleId: entry.id, generation: entry.generation });
    return { paused: true };
  }

  function resume(handle) {
    const entry = guardHandle(handle, 'resume');
    entry.player.resume();
    entry.state = 'PLAYING';
    emit('audio_playback_resumed', { handleId: entry.id, generation: entry.generation });
    return { resumed: true };
  }

  return Object.freeze({
    bindActivityGeneration,
    play,
    pause,
    resume,
    stop,
    stopAllForCurrentActivity,
    releaseGeneration,
    disposeAll,
    setEligible,
    isEligible: () => eligible,
    activeHandleCount: () => handles.size,
  });
}
