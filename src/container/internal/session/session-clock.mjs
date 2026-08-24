export class SessionTimeError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'SessionTimeError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new SessionTimeError(code, message, metadata); }

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function createSessionClock({ sessionIdentity = {}, lifecycle, monotonicNow = () => performance.now(), onTelemetry = () => {} }) {
  let authoritative = null;
  let monotonicBaseline = null;
  let expired = false;
  let expiredPromise = null;

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      sessionId: sessionIdentity.sessionId,
      correlationId: sessionIdentity.correlationId,
      ...extra,
    }));
  }

  function remainingSecondsNow() {
    if (!authoritative) return 0;
    const elapsedSinceSync = (monotonicNow() - monotonicBaseline) / 1000;
    return Math.max(0, authoritative.remainingSeconds - elapsedSinceSync);
  }

  function triggerExpiry(reason) {
    if (expired) return { alreadyExpired: true, endingPromise: expiredPromise };
    expired = true;
    emit('session_time_expiry_detected', { reason });
    expiredPromise = (lifecycle && typeof lifecycle.signal === 'function')
      ? lifecycle.signal('complete-requested').catch(() => {})
      : Promise.resolve();
    return { triggered: true, endingPromise: expiredPromise };
  }

  function reconcile(rawSnapshot) {
    if (!rawSnapshot || typeof rawSnapshot !== 'object') {
      fail('SESSION_TIME_UNAVAILABLE', 'Authoritative session timing is unavailable.');
    }
    if (rawSnapshot.sessionId !== undefined && rawSnapshot.sessionId !== sessionIdentity.sessionId) {
      fail('SESSION_TIME_MISMATCH', 'Authoritative timing snapshot does not match the bound session.', { field: 'sessionId' });
    }
    if (!isFiniteNonNegative(rawSnapshot.remainingSeconds)) {
      fail('SESSION_TIME_INVALID', 'Authoritative remaining session time is missing or invalid.');
    }
    if (rawSnapshot.startedAt !== undefined || rawSnapshot.expiresAt !== undefined) {
      const startedAt = Date.parse(rawSnapshot.startedAt);
      const expiresAt = Date.parse(rawSnapshot.expiresAt);
      if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt) || expiresAt <= startedAt) {
        fail('SESSION_TIME_INVALID', 'Authoritative session timing window is malformed.');
      }
    }

    authoritative = Object.freeze({
      remainingSeconds: rawSnapshot.remainingSeconds,
      startedAt: rawSnapshot.startedAt ?? null,
      expiresAt: rawSnapshot.expiresAt ?? null,
    });
    monotonicBaseline = monotonicNow();
    emit('session_time_reconciled', { remainingSeconds: authoritative.remainingSeconds });

    if (remainingSecondsNow() <= 0) {
      return { remainingSeconds: 0, ...triggerExpiry('AUTHORITATIVE_ZERO') };
    }
    return { remainingSeconds: remainingSecondsNow() };
  }

  function checkExpiry() {
    if (!expired && remainingSecondsNow() <= 0) {
      return { expired: true, ...triggerExpiry('TICK_EXPIRED') };
    }
    return { expired, endingPromise: expiredPromise };
  }

  function assertCanStartActivity() {
    if (expired) {
      fail('SESSION_TIME_EXPIRED', 'The authorized session time has expired; new learning activities cannot start.');
    }
  }

  return Object.freeze({
    reconcile,
    checkExpiry,
    remainingSeconds: () => remainingSecondsNow(),
    isExpired: () => expired,
    assertCanStartActivity,
  });
}

export function createSessionClockPublicFacade(clock) {
  return Object.freeze({
    remainingSeconds: () => clock.remainingSeconds(),
    isExpired: () => clock.isExpired(),
    canStartActivity: () => !clock.isExpired(),
  });
}
