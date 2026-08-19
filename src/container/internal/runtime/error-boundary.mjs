import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';

export class SafeFailureError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'SafeFailureError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new SafeFailureError(code, message, metadata); }

// ER-001: last-resort containment boundary. It never fabricates platform state, marks work
// completed, or grants time/credits - it only stops unsafe local execution and re-enters the
// already-approved recovery contracts (SR-005 resume, PA-002/PA-003 restore/pending) instead
// of reconstructing session authority locally. Explicitly opt-in only: expected errors handled
// by their owning module (API/audio/progress/etc.) never automatically escalate here.
export function createRuntimeErrorBoundary({
  runtimeBinding,
  activityManager = null,
  connectedTimeTracker = null,
  resumeCoordinator = null,
  onTelemetry = () => {},
}) {
  const identity = getRuntimeContext(runtimeBinding);
  let state = 'ACTIVE';
  let lastFailure = null;
  let recoveryPromise = null;

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      correlationId: identity.correlationId,
      ...extra,
    }));
  }

  function normalizeFailure(error, source) {
    return Object.freeze({
      category: 'RUNTIME_UNEXPECTED_FAILURE',
      message: 'An unexpected runtime failure occurred.',
      source,
      cause: error?.code ?? error?.message ?? 'UNKNOWN',
      correlationId: identity.correlationId,
      timestamp: Date.now(),
    });
  }

  function failSafe(error, source = 'UNKNOWN') {
    if (state === 'SAFE_FAILURE' || state === 'RECOVERING' || state === 'TERMINAL') {
      emit('runtime_safe_failure_duplicate', { source, state });
      return Object.freeze({ state, duplicate: true, failure: lastFailure });
    }

    lastFailure = normalizeFailure(error, source);
    state = 'SAFE_FAILURE';

    try { activityManager?.endSession?.('SAFE_FAILURE'); } catch { /* contained: activity teardown must not block safe-state entry */ }
    try { connectedTimeTracker?.setForeground?.(false); } catch { /* contained */ }

    emit('runtime_safe_state_entered', { source, cause: lastFailure.cause });
    return Object.freeze({ state, failure: lastFailure });
  }

  async function attemptRecovery() {
    if (state === 'RECOVERING' && recoveryPromise) return recoveryPromise;
    if (state !== 'SAFE_FAILURE') {
      fail('RUNTIME_RECOVERY_FAILED', 'Recovery can only be attempted from a safe-failure state.', { state });
    }

    state = 'RECOVERING';
    recoveryPromise = (async () => {
      try {
        if (!resumeCoordinator || typeof resumeCoordinator.resume !== 'function') {
          fail('RUNTIME_RECOVERY_FAILED', 'No approved recovery path is configured for this runtime.');
        }
        const result = await resumeCoordinator.resume();
        if (!result?.authorized) {
          state = 'TERMINAL';
          emit('runtime_terminal_failure', {});
          fail('RUNTIME_TERMINAL_FAILURE', 'Babysteps did not authorize recovery; the runtime remains terminal.');
        }
        state = 'ACTIVE';
        emit('runtime_recovered', {});
        return result;
      } catch (error) {
        state = 'TERMINAL';
        emit('runtime_recovery_failed', { cause: error?.code ?? 'UNKNOWN' });
        throw error;
      } finally {
        recoveryPromise = null;
      }
    })();
    return recoveryPromise;
  }

  function guard(callSite) {
    if (state !== 'ACTIVE') {
      fail('RUNTIME_SAFE_STATE_ENTERED', `"${callSite}" was rejected because the runtime is not in an active state.`, { callSite, state });
    }
  }

  return Object.freeze({
    failSafe,
    attemptRecovery,
    guard,
    get state() { return state; },
    get lastFailure() { return lastFailure; },
  });
}
