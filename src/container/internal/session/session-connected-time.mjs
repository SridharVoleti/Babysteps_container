export class ConnectedTimeError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ConnectedTimeError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new ConnectedTimeError(code, message, metadata); }

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function createConnectedTimeTracker({
  sessionIdentity = {},
  lifecycle,
  monotonicNow = () => performance.now(),
  onTelemetry = () => {},
  seedSeconds = 0,
  maxConnectedSeconds = null,
}) {
  if (!isFiniteNonNegative(seedSeconds)) {
    fail('CONNECTED_TIME_INVALID_SEED', 'A non-negative seed connected-seconds value is required.');
  }
  if (maxConnectedSeconds !== null && !isFiniteNonNegative(maxConnectedSeconds)) {
    fail('CONNECTED_TIME_INVALID_BOUNDARY', 'maxConnectedSeconds must be a non-negative number or null.');
  }

  let accumulated = seedSeconds;
  let foreground = false;
  let online = true;
  let segmentStart = null;
  let boundaryReached = false;
  let boundaryPromise = null;

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      sessionId: sessionIdentity.sessionId,
      correlationId: sessionIdentity.correlationId,
      ...extra,
    }));
  }

  function isEligible() {
    return foreground && online && !boundaryReached;
  }

  function flushSegment() {
    if (segmentStart === null) return;
    accumulated += Math.max(0, (monotonicNow() - segmentStart) / 1000);
    segmentStart = null;
  }

  function connectedSecondsNow() {
    if (segmentStart === null) return accumulated;
    return accumulated + Math.max(0, (monotonicNow() - segmentStart) / 1000);
  }

  function triggerBoundary() {
    if (boundaryReached) return { alreadyReached: true, endingPromise: boundaryPromise };
    flushSegment();
    boundaryReached = true;
    emit('connected_time_boundary_reached', { connectedSeconds: accumulated });
    boundaryPromise = (lifecycle && typeof lifecycle.signal === 'function')
      ? lifecycle.signal('complete-requested').catch(() => {})
      : Promise.resolve();
    return { triggered: true, endingPromise: boundaryPromise };
  }

  function reconcileEligibility(previouslyEligible) {
    const nowEligible = isEligible();
    if (nowEligible === previouslyEligible) return;
    if (nowEligible) {
      segmentStart = monotonicNow();
      emit('connected_time_resumed', { connectedSeconds: accumulated });
    } else {
      flushSegment();
      emit('connected_time_paused', { connectedSeconds: accumulated });
    }
  }

  function setState(field, next) {
    if (typeof next !== 'boolean') {
      fail('CONNECTED_TIME_INVALID_STATE', `${field} state must be a boolean.`);
    }
    const current = field === 'foreground' ? foreground : online;
    if (next === current) return { changed: false };

    const previouslyEligible = isEligible();
    if (field === 'foreground') foreground = next; else online = next;
    reconcileEligibility(previouslyEligible);
    return { changed: true };
  }

  function checkBoundary() {
    if (!boundaryReached && maxConnectedSeconds !== null && connectedSecondsNow() >= maxConnectedSeconds) {
      return triggerBoundary();
    }
    return { reached: boundaryReached, endingPromise: boundaryPromise };
  }

  return Object.freeze({
    setForeground: (next) => setState('foreground', next),
    setOnline: (next) => setState('online', next),
    checkBoundary,
    connectedSeconds: () => connectedSecondsNow(),
    isAccumulating: () => segmentStart !== null,
    isBoundaryReached: () => boundaryReached,
  });
}

export function createConnectedTimePublicFacade(tracker) {
  return Object.freeze({
    connectedSeconds: () => tracker.connectedSeconds(),
    isAccumulating: () => tracker.isAccumulating(),
  });
}

export function reportConnectedSeconds(tracker, domainPayload = {}) {
  return Object.freeze({ ...domainPayload, connectedSeconds: tracker.connectedSeconds() });
}
