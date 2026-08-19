import { randomUUID } from 'node:crypto';
import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';
import { ProgressAdapterError } from './progress-adapter.mjs';

export class PendingProgressError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'PendingProgressError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new PendingProgressError(code, message, metadata); }

function createInMemoryPendingStorage() {
  let record = null;
  return Object.freeze({
    write: (next) => { record = next; },
    read: () => record,
    clear: () => { record = null; },
  });
}

function fingerprintOf(identity) {
  return `${identity.learnerId}::${identity.appId}::${identity.releaseId}::${identity.sessionId}`;
}

function isRecoverableCheckpointFailure(error) {
  return error instanceof ProgressAdapterError && error.code === 'PROGRESS_SAVE_FAILED';
}

// Pending progress is client-side, non-authoritative, exact-scope-bound retry state only.
// Every retry replays through the normal PA-001 checkpoint() handoff — this module never
// writes progress itself and never promotes local state to durable authority.
export function createProgressRecoveryAdapter({ runtimeBinding, progressAdapter, storage = createInMemoryPendingStorage(), onTelemetry = () => {} }) {
  if (!progressAdapter || typeof progressAdapter.checkpoint !== 'function') {
    fail('PENDING_PROGRESS_STORAGE_FAILED', 'A PA-001 progress adapter is required to create a recovery adapter.');
  }
  const identity = getRuntimeContext(runtimeBinding);
  const scope = fingerprintOf(identity);

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      sessionId: identity.sessionId,
      correlationId: identity.correlationId,
      ...extra,
    }));
  }

  function safeRead() {
    try {
      return storage.read();
    } catch {
      return null;
    }
  }

  function stage(appProgress, metadata, idempotencyKey) {
    const record = Object.freeze({
      scope,
      learnerId: identity.learnerId,
      appId: identity.appId,
      releaseId: identity.releaseId,
      sessionId: identity.sessionId,
      appProgress: Object.freeze({ ...appProgress }),
      metadata: Object.freeze({ ...metadata }),
      idempotencyKey,
      stagedAt: Date.now(),
    });
    try {
      storage.write(record);
    } catch (error) {
      emit('pending_progress_storage_failed');
      fail('PENDING_PROGRESS_STORAGE_FAILED', 'The pending checkpoint could not be staged for recovery.', { cause: error?.message });
    }
    emit('pending_progress_staged');
    return record;
  }

  function clear(reason) {
    if (!safeRead()) return;
    try {
      storage.clear();
    } catch {
      /* best-effort cleanup; nothing further to reconcile if the store cannot clear itself */
    }
    emit('pending_progress_cleared', { reason });
  }

  function getPendingForBoundSession() {
    const record = safeRead();
    if (!record || record.scope !== scope) return null;
    return record;
  }

  async function checkpointWithRecovery(appProgress, metadata = {}) {
    const idempotencyKey = randomUUID();
    try {
      const result = await progressAdapter.checkpoint(appProgress, { ...metadata, idempotencyKey });
      clear(result.acknowledged ? 'ACKNOWLEDGED' : (result.conflict ? 'CONFLICT' : 'REJECTED'));
      return result;
    } catch (error) {
      if (!isRecoverableCheckpointFailure(error)) throw error;
      stage(appProgress, metadata, idempotencyKey);
      return Object.freeze({ acknowledged: false, pending: true, progressVersion: null });
    }
  }

  async function retryPending() {
    const record = getPendingForBoundSession();
    if (!record) {
      const foreign = safeRead();
      if (foreign) {
        clear('SCOPE_MISMATCH');
        emit('pending_progress_rejected', { reason: 'PENDING_PROGRESS_SCOPE_MISMATCH' });
      }
      return Object.freeze({ retried: false, reason: 'NO_PENDING_RECORD' });
    }

    emit('pending_progress_retry_started');
    try {
      const result = await progressAdapter.checkpoint(record.appProgress, { ...record.metadata, idempotencyKey: record.idempotencyKey });
      if (result.acknowledged) {
        clear('ACKNOWLEDGED');
        emit('pending_progress_acknowledged', { progressVersion: result.progressVersion });
      } else {
        clear(result.conflict ? 'CONFLICT' : 'REJECTED');
        emit('pending_progress_rejected', { reason: result.conflict ? 'PENDING_PROGRESS_CONFLICT' : 'PENDING_PROGRESS_REJECTED' });
      }
      return Object.freeze({ retried: true, ...result });
    } catch (error) {
      if (isRecoverableCheckpointFailure(error)) {
        emit('pending_progress_retry_failed', { reason: 'PROGRESS_SAVE_FAILED' });
        return Object.freeze({ retried: false, reason: 'PROGRESS_SAVE_FAILED' });
      }
      clear('REJECTED');
      emit('pending_progress_rejected', { reason: error?.code ?? 'UNKNOWN' });
      throw error;
    }
  }

  return Object.freeze({
    checkpointWithRecovery,
    retryPending,
    getPendingForBoundSession,
    clearPending: clear,
  });
}
