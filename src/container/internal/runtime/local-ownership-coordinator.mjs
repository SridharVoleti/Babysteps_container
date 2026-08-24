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

// A fast, synchronous, browser-native string hash (FNV-1a) - not a cryptographic hash, and
// deliberately so: this key is only a local coordination/telemetry namespace, never a
// security boundary, so it avoids depending on any async-only (WebCrypto) or Node-only
// (node:crypto) primitive purely to stay synchronous at coordinator construction (DR-001).
function fnv1a(text, seed) {
  let hash = seed;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const HASH_SEEDS = Object.freeze([0x811c9dc5, 0x9e3779b9, 0x27d4eb2f, 0x165667b1]);

// Derived/hashed rather than the raw learner/app/release/session fingerprint, so local
// coordination (and its telemetry) never leaks a raw learner identifier across tabs/origins.
function ownershipKeyOf(identity) {
  const fingerprint = `${identity.learnerId}::${identity.appId}::${identity.releaseId}::${identity.sessionId}`;
  return HASH_SEEDS.map((seed) => fnv1a(fingerprint, seed)).join('');
}

async function tryAdapter(adapter, key) {
  if (typeof adapter !== 'function') return null;
  try {
    return (await adapter(key)) ?? null;
  } catch {
    return null;
  }
}

function randomOwnerId() {
  return (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// DR-003 preferred primitive: the Web Locks API (navigator.locks) is a genuine same-origin
// cross-tab/cross-context mutex provided by the browser itself - not process/module memory.
// A Web Locks request only holds the lock for the lifetime of its callback, so this adapter
// keeps the callback pending (via an internally-resolvable promise) until release() is
// called, translating that into the acquire()/release() shape this coordinator expects.
// Returns null (unavailable) when Web Locks is not supported, so callers fall back safely.
export function createWebLocksAdapter({ locks = (typeof navigator !== 'undefined' ? navigator.locks : undefined) } = {}) {
  if (!locks || typeof locks.request !== 'function') return null;

  return async function acquire(key) {
    let settleAcquired;
    let releaseHold;
    const acquired = new Promise((resolve) => { settleAcquired = resolve; });
    const held = new Promise((resolve) => { releaseHold = resolve; });

    const requestOutcome = locks.request(key, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        settleAcquired(false);
        return;
      }
      settleAcquired(true);
      await held;
    }).catch(() => { settleAcquired(false); });

    const gotLock = await acquired;
    if (!gotLock) {
      releaseHold();
      await requestOutcome.catch(() => {});
      return null;
    }
    return { release: () => releaseHold() };
  };
}

const BROADCAST_CLAIM_WINDOW_MS = 60;
const BROADCAST_CHANNEL_PREFIX = 'babysteps-dr003-lock::';

// DR-003 fallback primitive: when Web Locks is unsupported, coordinates via BroadcastChannel
// - a genuine same-origin cross-tab/cross-context browser message bus (also available as a
// built-in in Node), not process/module memory. Independent adapter instances (representing
// independent tabs) elect exactly one claimant per key using a short claim-broadcast window
// with a deterministic tie-break, then the holder answers later claim/query broadcasts with
// "held" until it releases. Returns null (unavailable) when BroadcastChannel doesn't exist.
export function createBroadcastLockAdapter({ ChannelImpl = (typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : undefined), windowMs = BROADCAST_CLAIM_WINDOW_MS } = {}) {
  if (typeof ChannelImpl !== 'function') return null;
  const ownerId = randomOwnerId();

  return async function acquire(key) {
    const channel = new ChannelImpl(`${BROADCAST_CHANNEL_PREFIX}${key}`);
    const claimId = `${ownerId}:${Math.random().toString(36).slice(2)}`;
    const seenClaims = new Set([claimId]);
    let heldByOther = false;

    const claimListener = (event) => {
      const msg = event?.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'held') heldByOther = true;
      if (msg.type === 'claim' && typeof msg.claimId === 'string') seenClaims.add(msg.claimId);
    };
    channel.addEventListener('message', claimListener);
    channel.postMessage({ type: 'claim', claimId });
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    channel.removeEventListener('message', claimListener);

    if (heldByOther || [...seenClaims].sort()[0] !== claimId) {
      channel.close();
      return null;
    }

    const holderListener = (event) => {
      const msg = event?.data;
      if (msg && (msg.type === 'claim' || msg.type === 'query')) channel.postMessage({ type: 'held', ownerId });
    };
    channel.addEventListener('message', holderListener);

    return {
      release: () => {
        channel.removeEventListener('message', holderListener);
        channel.close();
      },
    };
  };
}

// DR-003: coordinates exactly one active local browser/runtime owner per exact authorized
// session. This module owns ONLY same-origin local coordination - it never decides platform
// session validity/resume authority (that stays with SB-002/SR-005), and it introduces no
// server heartbeat: ownership is acquired/released through the injected lock primitive only.
// By default (no explicit adapters supplied) it uses the real preferred/fallback browser
// primitives above rather than an in-memory adapter, so two independent real tabs/contexts
// genuinely exclude each other.
export function createLocalOwnershipCoordinator({
  runtimeBinding,
  lockAdapter,
  fallbackLockAdapter,
  onTelemetry = () => {},
}) {
  const identity = getRuntimeContext(runtimeBinding);
  const key = ownershipKeyOf(identity);

  // Real production defaults are only wired in when the caller configures neither tier at
  // all - a caller that explicitly supplies one tier (e.g. a test double simulating a
  // specific primitive) keeps exactly what it asked for rather than silently gaining an
  // unrequested real fallback underneath it.
  const usingDefaultAdapters = lockAdapter === undefined && fallbackLockAdapter === undefined;
  if (usingDefaultAdapters) {
    lockAdapter = createWebLocksAdapter();
    fallbackLockAdapter = createBroadcastLockAdapter();
  }

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

// A minimal in-memory lock adapter. This is process/module memory only - it does NOT
// coordinate across real independent browser tabs/contexts (each has its own JS realm) and
// must never be relied on as the production default. It exists for unit tests that want to
// exercise the coordinator's own acquire/release/guard logic without depending on
// Web Locks/BroadcastChannel availability; DR-003 cross-tab guarantees are provided by
// createWebLocksAdapter()/createBroadcastLockAdapter() above, which back the coordinator's
// actual defaults.
export function createInMemoryLockAdapter() {
  const held = new Set();
  return async function acquire(key) {
    if (held.has(key)) return null;
    held.add(key);
    return { release: () => { held.delete(key); } };
  };
}
