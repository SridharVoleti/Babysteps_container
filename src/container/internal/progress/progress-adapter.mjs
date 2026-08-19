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

function classifyRestoreFailure(error) {
  const category = error?.metadata?.category;
  if (category === 'VALIDATION') return 'PROGRESS_RESPONSE_INVALID';
  return 'PROGRESS_RESTORE_FAILED';
}

const SCOPE_FIELDS = ['learnerId', 'appId', 'releaseId'];

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

  // Authoritative restore is a read path only: it never consults or promotes local checkpoint
  // state (lastAcknowledged above) — every call re-fetches from Babysteps, and app-specific
  // interpretation of the returned payload happens entirely outside this module.
  async function restore({ expectedSchemaVersion } = {}) {
    let response;
    try {
      response = await progressClient.call('progress.restore', {});
    } catch (error) {
      const code = classifyRestoreFailure(error);
      emit('progress_restore_failed', { reason: code });
      fail(code, 'The authoritative progress restore could not be completed.', { cause: error?.code });
    }

    if (!response || typeof response.found !== 'boolean') {
      emit('progress_restore_failed', { reason: 'PROGRESS_RESPONSE_INVALID' });
      fail('PROGRESS_RESPONSE_INVALID', 'Babysteps returned an invalid progress restore response.');
    }

    if (!response.found) {
      emit('progress_restore_outcome', { found: false });
      return Object.freeze({ found: false, progressVersion: null, appProgressSchemaVersion: null, appProgress: null });
    }

    for (const field of SCOPE_FIELDS) {
      if (response[field] !== undefined && response[field] !== sessionIdentity[field]) {
        emit('progress_restore_failed', { reason: 'PROGRESS_SCOPE_MISMATCH' });
        fail('PROGRESS_SCOPE_MISMATCH', `Restored progress scope "${field}" does not match the bound runtime.`, { field });
      }
    }

    if (expectedSchemaVersion !== undefined && response.appProgressSchemaVersion !== undefined && response.appProgressSchemaVersion !== expectedSchemaVersion) {
      emit('progress_restore_failed', { reason: 'PROGRESS_SCHEMA_INCOMPATIBLE' });
      fail('PROGRESS_SCHEMA_INCOMPATIBLE', `Restored progress schema version "${response.appProgressSchemaVersion}" is incompatible with the expected version "${expectedSchemaVersion}".`, { found: response.appProgressSchemaVersion, expected: expectedSchemaVersion });
    }

    const result = Object.freeze({
      found: true,
      progressVersion: response.progressVersion,
      appProgressSchemaVersion: response.appProgressSchemaVersion ?? null,
      appProgress: Object.freeze({ ...(response.appProgress ?? {}) }),
    });
    emit('progress_restore_outcome', { found: true, progressVersion: result.progressVersion });
    return result;
  }

  return Object.freeze({
    checkpoint,
    restore,
    get latestAcknowledged() { return lastAcknowledged; },
  });
}
