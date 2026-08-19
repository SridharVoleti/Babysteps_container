export class SessionCompletionError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'SessionCompletionError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new SessionCompletionError(code, message, metadata); }

const AUTHORITY_FIELDS = ['sessionId', 'learnerId', 'appId', 'releaseId'];

export function createFinalizationAdapter({ progressClient, finalizationClient }) {
  if (typeof finalizationClient?.call !== 'function') {
    throw new TypeError('A finalizationClient with a call(operation, payload) method is required.');
  }
  return Object.freeze({
    finalize: async (sessionIdentity, finalProgress) => {
      if (progressClient && finalProgress && Object.keys(finalProgress).length > 0) {
        await progressClient.call('progress.save', finalProgress);
      }
      return finalizationClient.call('session.finalize', {});
    },
  });
}

export function createSessionCompletion({ sessionIdentity, lifecycle, onTelemetry = () => {} }) {
  async function complete(domainPayload = {}) {
    for (const field of AUTHORITY_FIELDS) {
      if (field in domainPayload && domainPayload[field] !== sessionIdentity[field]) {
        fail('SESSION_COMPLETION_IDENTITY_MISMATCH', `Caller-supplied ${field} does not match the bound session.`, { field });
      }
    }
    const { sessionId, learnerId, appId, releaseId, ...finalProgress } = domainPayload;

    try {
      const outcome = await lifecycle.signal('complete-requested', finalProgress);
      onTelemetry(Object.freeze({
        event: 'session_completion_outcome',
        sessionId: sessionIdentity.sessionId,
        correlationId: sessionIdentity.correlationId,
        category: outcome.idempotent ? 'IDEMPOTENT' : 'COMPLETED',
      }));
      return outcome.finalizationResult;
    } catch (error) {
      onTelemetry(Object.freeze({
        event: 'session_completion_outcome',
        sessionId: sessionIdentity.sessionId,
        correlationId: sessionIdentity.correlationId,
        category: error.code ?? 'UNKNOWN',
      }));
      throw error;
    }
  }

  return Object.freeze({ complete });
}
