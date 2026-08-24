export class SessionResumeError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'SessionResumeError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new SessionResumeError(code, message, metadata); }

const AUTHORITY_FIELDS = ['sessionId', 'learnerId', 'appId', 'releaseId'];

export function createResumeCoordinator({ sessionIdentity, lifecycle, resumeClient, recoveryAdapter, onTelemetry = () => {} }) {
  let pendingResume = null;

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      sessionId: sessionIdentity.sessionId,
      correlationId: sessionIdentity.correlationId,
      ...extra,
    }));
  }

  async function interrupt(reason) {
    try {
      const result = await lifecycle.signal('recover-requested');
      emit('session_interrupted', { reason, category: result.idempotent ? 'IDEMPOTENT' : 'INTERRUPTED' });
      return result;
    } catch (error) {
      emit('session_interrupted', { reason, category: error.code ?? 'UNKNOWN' });
      throw error;
    }
  }

  async function resume(domainPayload = {}) {
    for (const field of AUTHORITY_FIELDS) {
      if (field in domainPayload && domainPayload[field] !== sessionIdentity[field]) {
        fail('SESSION_RESUME_CONTEXT_MISMATCH', `Caller-supplied ${field} does not match the bound session.`, { field });
      }
    }

    if (pendingResume) return pendingResume;

    if (lifecycle.state === 'ACTIVE') {
      return Object.freeze({ authorized: true, sessionIdentity, recoveredState: null, idempotent: true });
    }
    if (lifecycle.state === 'ENDED') {
      fail('SESSION_RESUME_DENIED', 'The session has already ended and cannot be resumed.', { idempotent: true });
    }

    pendingResume = (async () => {
      try {
        const decision = await resumeClient.call('session.resume', {});
        if (!decision || decision.authorized !== true) {
          lifecycle.reconcilePlatformState({ status: 'inactive', reason: 'RESUME_DENIED' });
          fail('SESSION_RESUME_DENIED', 'Babysteps did not authorize resuming the previous session.');
        }

        await lifecycle.signal('recovered');

        let recoveredState = null;
        if (typeof recoveryAdapter?.restore === 'function') {
          recoveredState = await recoveryAdapter.restore(sessionIdentity);
        }

        emit('session_resume_outcome', { category: 'AUTHORIZED' });
        return Object.freeze({ authorized: true, sessionIdentity, recoveredState });
      } catch (error) {
        emit('session_resume_outcome', { category: error.code ?? 'UNKNOWN' });
        throw error;
      } finally {
        pendingResume = null;
      }
    })();

    return pendingResume;
  }

  return Object.freeze({ interrupt, resume });
}
