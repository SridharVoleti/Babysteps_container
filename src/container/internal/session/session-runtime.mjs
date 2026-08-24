import { getRuntimeContext, scopeAuthorityRequest, isRuntimeActive } from '../runtime/authorized-runtime-identity.mjs';

export class SessionRuntimeError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'SessionRuntimeError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new SessionRuntimeError(code, message, metadata); }

const RUNTIME_SESSIONS = new WeakMap();

function createFacade(sessionIdentity, runtimeBinding, stateBox) {
  return Object.freeze({
    sessionId: sessionIdentity.sessionId,
    learnerId: sessionIdentity.learnerId,
    appId: sessionIdentity.appId,
    releaseId: sessionIdentity.releaseId,
    isActive: () => stateBox.active && isRuntimeActive(runtimeBinding),
  });
}

export async function initializeSessionRuntime({ readiness, runtimeBinding, sessionAdapter = {} }) {
  if (!readiness || readiness.ok !== true || readiness.phase !== 'READY') {
    fail('SESSION_RUNTIME_NOT_READY', 'Learning-session runtime cannot start before container bootstrap reaches READY.');
  }

  const existing = RUNTIME_SESSIONS.get(runtimeBinding);
  if (existing?.runtime) return existing.runtime;
  if (existing?.promise) return existing.promise;

  const entry = {};
  RUNTIME_SESSIONS.set(runtimeBinding, entry);

  entry.promise = (async () => {
    const identity = getRuntimeContext(runtimeBinding);
    const sessionIdentity = Object.freeze({
      sessionId: identity.sessionId,
      learnerId: identity.learnerId,
      appId: identity.appId,
      releaseId: identity.releaseId,
      correlationId: identity.correlationId,
    });

    if (typeof sessionAdapter.attach === 'function') {
      await sessionAdapter.attach(sessionIdentity);
    }

    const stateBox = { active: true };
    const runtime = createFacade(sessionIdentity, runtimeBinding, stateBox);
    Object.assign(entry, { runtime, stateBox, sessionIdentity });
    return runtime;
  })();

  try {
    return await entry.promise;
  } catch (error) {
    RUNTIME_SESSIONS.delete(runtimeBinding);
    throw error;
  }
}

export function scopeToSessionRuntime(runtimeBinding, payload) {
  return scopeAuthorityRequest(runtimeBinding, payload);
}

export async function deactivateSessionRuntime(runtimeBinding, { reason, sessionAdapter = {} } = {}) {
  const entry = RUNTIME_SESSIONS.get(runtimeBinding);
  if (!entry?.stateBox || !entry.stateBox.active) return;

  entry.stateBox.active = false;
  if (typeof sessionAdapter.detach === 'function') {
    await sessionAdapter.detach(Object.freeze({ ...entry.sessionIdentity, reason }));
  }
}
