export class ProgressAdapterError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ProgressAdapterError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new ProgressAdapterError(code, message, metadata); }

function assertPlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message);
}

function classifyTransportFailure(error) {
  const category = error?.metadata?.category;
  if (category === 'CONFLICT') return 'PROGRESS_CONFLICT';
  if (category === 'AUTH' || category === 'AUTHORIZATION' || error?.code === 'REAUTH_REQUIRED' || error?.code === 'AUTHORIZATION_DENIED') return 'PROGRESS_AUTH_DENIED';
  if (category === 'VALIDATION') return 'PROGRESS_VALIDATION_FAILED';
  return 'PROGRESS_SAVE_FAILED';
}

// App-specific learning code submits its own progress payload through this adapter; the shared
// framework never interprets checkpoint meaning, it only handles the platform handoff and the
// authoritative acknowledgement (see CR-001 for the equivalent boundary on content).
export function createProgressAdapter({ sessionIdentity = {}, progressClient, onTelemetry = () => {} }) {
  if (!progressClient || typeof progressClient.call !== 'function') {
    fail('PROGRESS_SAVE_FAILED', 'A progress API client is required to create the progress adapter.');
  }

  let lastAcknowledged = null;

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      sessionId: sessionIdentity.sessionId,
      correlationId: sessionIdentity.correlationId,
      ...extra,
    }));
  }

  async function checkpoint(appProgress, metadata = {}) {
    assertPlainObject(appProgress, 'PROGRESS_VALIDATION_FAILED', 'Progress checkpoint payload must be an object.');
    assertPlainObject(metadata, 'PROGRESS_VALIDATION_FAILED', 'Progress checkpoint metadata must be an object.');

    let response;
    try {
      response = await progressClient.call('progress.checkpoint', { appProgress, ...metadata });
    } catch (error) {
      const code = classifyTransportFailure(error);
      emit('progress_checkpoint_failed', { reason: code });
      fail(code, 'The progress checkpoint could not be submitted.', { cause: error?.code });
    }

    if (!response || typeof response.acknowledged !== 'boolean') {
      emit('progress_checkpoint_failed', { reason: 'PROGRESS_RESPONSE_INVALID' });
      fail('PROGRESS_RESPONSE_INVALID', 'Babysteps returned an invalid progress acknowledgement.');
    }

    if (!response.acknowledged) {
      emit('progress_checkpoint_unacknowledged', { progressVersion: response.progressVersion, conflict: response.conflict === true });
      return Object.freeze({ ...response });
    }

    lastAcknowledged = Object.freeze({ ...response });
    emit('progress_checkpoint_acknowledged', { progressVersion: response.progressVersion });
    return lastAcknowledged;
  }

  return Object.freeze({
    checkpoint,
    get latestAcknowledged() { return lastAcknowledged; },
  });
}
