export class ConnectivityError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ConnectivityError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new ConnectivityError(code, message, metadata); }

const RETRYABLE_CATEGORIES = new Set(['SERVER', 'RATE_LIMIT', 'TIMEOUT']);

// ER-002: classifies a failure as transient (safe to retry) versus an authoritative Babysteps
// business outcome that must never be blindly retried as though it were a network error.
export function classifyRetry(error) {
  const category = error?.metadata?.category ?? error?.category;
  if (category === 'AUTH') return 'REAUTH';
  if (category === 'CONFLICT') return 'CONFLICT';
  if (category === 'AUTHORIZATION' || category === 'VALIDATION') return 'DO_NOT_RETRY';
  if (RETRYABLE_CATEGORIES.has(category)) return 'SAFE_RETRY';
  return 'TERMINAL';
}

// ER-002: one normalized connectivity state shared across the final app. Loss immediately
// pauses SR-006 connected-time accumulation via the injected tracker; reconnect only reaches
// RECOVERING - callers must explicitly confirm ONLINE through an approved SR-005 revalidation,
// so connectivity restoration alone never resumes/recreates the Babysteps session.
export function createConnectivityService({
  isOnline = () => true,
  subscribe,
  connectedTimeTracker = null,
  onTelemetry = () => {},
} = {}) {
  let state = isOnline() ? 'ONLINE' : 'OFFLINE';
  let subscribed = false;
  let unsubscribe = null;

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({ event, ...extra }));
  }

  function setState(next) {
    if (next === state) return { changed: false };
    const from = state;
    state = next;
    if (next === 'OFFLINE') {
      try { connectedTimeTracker?.setOnline?.(false); } catch { /* best-effort pause */ }
    }
    if (next === 'ONLINE') {
      try { connectedTimeTracker?.setOnline?.(true); } catch { /* best-effort resume */ }
    }
    emit('connectivity_state_changed', { from, to: next });
    return { changed: true };
  }

  function reportOffline() { return setState('OFFLINE'); }
  function reportRecovering() { return state === 'OFFLINE' ? setState('RECOVERING') : { changed: false }; }
  function reportOnline() { return setState('ONLINE'); }

  function start() {
    if (subscribed) return { alreadyStarted: true };
    subscribed = true;
    unsubscribe = typeof subscribe === 'function'
      ? subscribe((nextOnline) => { nextOnline ? reportRecovering() : reportOffline(); }) ?? null
      : null;
    return { started: true };
  }

  function stop() {
    if (!subscribed) return { alreadyStopped: true };
    subscribed = false;
    try { unsubscribe?.(); } catch { /* best-effort listener teardown */ }
    unsubscribe = null;
    return { stopped: true };
  }

  return Object.freeze({
    start,
    stop,
    get state() { return state; },
    reportOffline,
    reportRecovering,
    reportOnline,
  });
}

// ER-002: bounded backoff retry, scoped to explicitly-marked-retryable operations only, with
// at most one retry loop active per logical operation (concurrent callers for the same
// operation join the same in-flight attempt rather than racing independent retry loops).
export function createRetryPolicy({
  maxAttempts = 3,
  baseDelayMs = 200,
  maxDelayMs = 2000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onTelemetry = () => {},
}) {
  const inFlight = new Map();
  let disposed = false;

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({ event, ...extra }));
  }

  async function runAttempts(operation, retryable, fn) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      if (disposed) fail('RETRY_NOT_ALLOWED', 'The retry loop was cancelled because the runtime was disposed.', { operation });
      try {
        const result = await fn();
        if (attempt > 1) emit('connectivity_retry_succeeded', { operation, attempt });
        return result;
      } catch (error) {
        const classification = classifyRetry(error);
        if (!retryable || classification !== 'SAFE_RETRY' || attempt >= maxAttempts) {
          if (retryable && classification === 'SAFE_RETRY') {
            emit('connectivity_retry_exhausted', { operation, attempts: attempt });
          } else {
            emit('connectivity_retry_not_allowed', { operation, classification });
          }
          throw error;
        }
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        emit('connectivity_retry_scheduled', { operation, attempt, delay });
        await sleep(delay);
        if (disposed) fail('RETRY_NOT_ALLOWED', 'The retry loop was cancelled because the runtime was disposed.', { operation });
      }
    }
  }

  async function executeWithRetry(operationMetadata, fn) {
    if (disposed) fail('RETRY_NOT_ALLOWED', 'The retry loop was cancelled because the runtime was disposed.', { operation: operationMetadata?.operation });
    const { operation = 'unknown', retryable = false } = operationMetadata ?? {};
    if (inFlight.has(operation)) return inFlight.get(operation);
    const promise = runAttempts(operation, retryable, fn).finally(() => inFlight.delete(operation));
    inFlight.set(operation, promise);
    return promise;
  }

  function dispose() {
    disposed = true;
    inFlight.clear();
  }

  return Object.freeze({ executeWithRetry, dispose, get isDisposed() { return disposed; } });
}
