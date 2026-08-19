import { createHash } from 'node:crypto';
import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';

export class LocalOwnershipError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'LocalOwnershipError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new LocalOwnershipError(code, message, metadata); }

// Derived/hashed rather than the raw learner/app/release/session fingerprint, so local
// coordination (and its telemetry) never leaks a raw learner identifier across tabs/origins.
function ownershipKeyOf(identity) {
  const fingerprint = `${identity.learnerId}::${identity.appId}::${identity.releaseId}::${identity.sessionId}`;
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 32);
}

async function tryAdapter(adapter, key) {
  if (typeof adapter !== 'function') return null;
  try {
    return (await adapter(key)) ?? null;
  } catch {
    return null;
  }
}

// DR-003: coordinates exactly one active local browser/runtime owner per exact authorized
// session. This module owns ONLY same-origin local coordination - it never decides platform
// session validity/resume authority (that stays with SB-002/SR-005), and it introduces no
// server heartbeat: ownership is acquired/released through the injected lock primitive only.
export function createLocalOwnershipCoordinator({
  runtimeBinding,
  lockAdapter,
  fallbackLockAdapter,
  onTelemetry = () => {},
}) {
  const identity = getRuntimeContext(runtimeBinding);
  const key = ownershipKeyOf(identity);

  let state = 'NON_OWNING';
  let lease = null;
  let authoritativeDenied = false;

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      correlationId: identity.correlationId,
      ...extra,
    }));
  }

  async function acquire() {
    if (authoritativeDenied) {
      fail('LOCAL_TAKEOVER_DENIED', 'The authorized session was denied by Babysteps; local ownership cannot be acquired.');
    }
    if (state === 'OWNING') return { alreadyOwning: true };

    let acquired = await tryAdapter(lockAdapter, key);
    let usedFallback = false;
    if (!acquired) {
      acquired = await tryAdapter(fallbackLockAdapter, key);
      usedFallback = true;
    }

    if (!acquired) {
      if (!lockAdapter && !fallbackLockAdapter) {
        fail('LOCAL_OWNERSHIP_UNAVAILABLE', 'No local ownership coordination primitive is available.');
      }
      state = 'NON_OWNING';
      emit('local_ownership_blocked', { key });
      fail('LOCAL_RUNTIME_ALREADY_ACTIVE', 'Another local browser/runtime context already owns this exact authorized session.');
    }

    lease = acquired;
    state = 'OWNING';
    emit('local_ownership_acquired', { key, usedFallback });
    return { owning: true };
  }

  function release(reason = 'MANUAL_RELEASE') {
    if (state !== 'OWNING') return { alreadyReleased: true };
    state = 'NON_OWNING';
    try {
      lease?.release?.();
    } catch {
      /* best-effort local lease release */
    }
    lease = null;
    emit('local_ownership_released', { key, reason });
    return { released: true };
  }

  async function attemptTakeover({ validateResumable } = {}) {
    if (state === 'OWNING') return { owning: true, alreadyOwning: true };

    if (typeof validateResumable === 'function') {
      let decision;
      try {
        decision = await validateResumable();
      } catch {
        decision = { authorized: false };
      }
      if (!decision || decision.authorized !== true) {
        authoritativeDenied = true;
        emit('local_takeover_denied', { key });
        fail('LOCAL_TAKEOVER_DENIED', 'Babysteps did not authorize resuming this session; local ownership takeover is denied.');
      }
    }

    return acquire();
  }

  function reportAuthoritativeSessionState(status) {
    if (status !== 'terminal' && status !== 'inactive') return { ignored: true };
    authoritativeDenied = true;
    if (state === 'OWNING') {
      release('AUTHORITATIVE_DENIAL');
    }
    state = 'LOST';
    emit('local_ownership_lost', { key, reason: 'AUTHORITATIVE_DENIAL' });
    return { lost: true };
  }

  function guard(callSite) {
    if (authoritativeDenied || state !== 'OWNING') {
      emit('local_ownership_guard_rejected', { key, callSite, state });
      fail('LOCAL_RUNTIME_ALREADY_ACTIVE', `"${callSite}" was rejected because this local runtime does not own the authorized session.`, { callSite });
    }
  }

  return Object.freeze({
    acquire,
    release,
    attemptTakeover,
    reportAuthoritativeSessionState,
    guard,
    get state() { return state; },
    get ownershipKey() { return key; },
  });
}

// A minimal in-memory lock adapter usable as a fallback coordination mechanism (equivalent
// to a same-origin BroadcastChannel/local-storage lease) when the preferred browser Web
// Locks primitive is unavailable. Keyed exactly like the coordinator above.
export function createInMemoryLockAdapter() {
  const held = new Set();
  return async function acquire(key) {
    if (held.has(key)) return null;
    held.add(key);
    return { release: () => { held.delete(key); } };
  };
}
