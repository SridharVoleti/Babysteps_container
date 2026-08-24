export class SessionLifecycleError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'SessionLifecycleError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new SessionLifecycleError(code, message, metadata); }

const TRANSITIONS = Object.freeze({
  INITIALIZING: Object.freeze({ 'activity-ready': 'ACTIVE' }),
  ACTIVE: Object.freeze({ 'recover-requested': 'RECOVERING', 'complete-requested': 'COMPLETING' }),
  RECOVERING: Object.freeze({ recovered: 'ACTIVE' }),
  COMPLETING: Object.freeze({ completed: 'ENDED' }),
  ENDED: Object.freeze({}),
});

const REDUNDANT_NOOP = Object.freeze({
  'activity-ready': 'ACTIVE',
  'recover-requested': 'RECOVERING',
});

export function createSessionLifecycle({ sessionIdentity = {}, sessionAdapter = {}, onTelemetry = () => {}, clock = () => Date.now() }) {
  let state = 'INITIALIZING';
  let pendingCompletion = null;
  let lastFinalizationResult = null;

  function emit(from, to, category) {
    onTelemetry(Object.freeze({
      event: 'session_lifecycle_transition',
      sessionId: sessionIdentity.sessionId,
      correlationId: sessionIdentity.correlationId,
      fromState: from,
      toState: to,
      category,
      timestamp: clock(),
    }));
  }

  function guardedTransition(event) {
    const from = state;
    if (from === 'ENDED') {
      if (event === 'recover-requested') {
        fail('SESSION_PLATFORM_STATE_TERMINAL', 'The authorized platform session has terminated; local reactivation is not permitted.', { fromState: from, event });
      }
      if (event === 'complete-requested') {
        return { from: 'ENDED', to: 'ENDED', idempotent: true };
      }
      fail('SESSION_ALREADY_ENDED', 'The learning-session lifecycle has already ended.', { fromState: from, event });
    }

    const to = TRANSITIONS[from]?.[event];
    if (!to) {
      fail('SESSION_TRANSITION_INVALID', `No approved transition for event "${event}" from state "${from}".`, { fromState: from, event });
    }
    state = to;
    return { from, to };
  }

  async function handleCompleteRequested(payload) {
    if (state === 'COMPLETING') {
      await pendingCompletion;
      return { from: 'COMPLETING', to: state, idempotent: true, finalizationResult: lastFinalizationResult };
    }

    const result = guardedTransition('complete-requested');
    if (result.idempotent) return { ...result, finalizationResult: lastFinalizationResult };

    pendingCompletion = (async () => {
      try {
        if (typeof sessionAdapter.finalize === 'function') {
          lastFinalizationResult = await sessionAdapter.finalize(sessionIdentity, payload);
        }
        guardedTransition('completed');
      } catch (error) {
        state = result.from;
        throw error;
      }
    })();

    try {
      await pendingCompletion;
    } finally {
      pendingCompletion = null;
    }
    return { from: result.from, to: state, finalizationResult: lastFinalizationResult };
  }

  async function signal(event, payload) {
    const before = state;
    try {
      let result;
      if (event === 'complete-requested') {
        result = await handleCompleteRequested(payload);
      } else if (REDUNDANT_NOOP[event] && state === REDUNDANT_NOOP[event]) {
        result = { from: state, to: state, idempotent: true };
      } else {
        result = guardedTransition(event);
      }
      emit(result.from, result.to, result.idempotent ? 'IDEMPOTENT' : 'TRANSITION');
      return result;
    } catch (error) {
      emit(before, before, error.code ?? 'UNKNOWN');
      throw error;
    }
  }

  function reconcilePlatformState(platformResult) {
    const before = state;
    const status = platformResult?.status;
    if (status !== 'terminal' && status !== 'inactive') {
      return { from: before, to: before, idempotent: true };
    }
    if (before === 'ENDED') {
      emit(before, before, 'IDEMPOTENT');
      return { from: 'ENDED', to: 'ENDED', idempotent: true };
    }
    state = 'ENDED';
    emit(before, 'ENDED', 'PLATFORM_TERMINAL');
    return { from: before, to: 'ENDED' };
  }

  return Object.freeze({
    get state() { return state; },
    signal,
    reconcilePlatformState,
  });
}

export function createLifecyclePublicFacade(manager) {
  return Object.freeze({
    get state() { return manager.state; },
    signal: (event, payload) => manager.signal(event, payload),
  });
}
