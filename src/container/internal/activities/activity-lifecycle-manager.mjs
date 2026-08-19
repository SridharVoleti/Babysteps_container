import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';
import { createActivityEventChannel, resolveApprovedServices } from './activity-host.mjs';

export class ActivityLifecycleError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ActivityLifecycleError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new ActivityLifecycleError(code, message, metadata); }

let GENERATION_SEQUENCE = 0;

export function createActivityLifecycleManager({
  runtimeBinding,
  approvedServices = {},
  lifecycle,
  completion,
  onMeaningfulProgress = () => {},
  onFailure = () => {},
  onTelemetry = () => {},
}) {
  const identity = getRuntimeContext(runtimeBinding);
  let current = null;

  function emitFor(entry, event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      appId: identity.appId,
      activityId: entry?.activityId,
      generation: entry?.generation,
      correlationId: identity.correlationId,
      ...extra,
    }));
  }

  function cleanupResources(entry) {
    let failureCount = 0;
    for (const cleanup of entry.resources) {
      try { cleanup(); } catch { failureCount += 1; }
    }
    entry.resources.clear();
    if (failureCount > 0) {
      emitFor(entry, 'activity_resource_cleanup_failed', { failureCount });
    }
  }

  function disposeEntry(entry, reason) {
    if (entry.state === 'DISPOSED') return { alreadyDisposed: true };
    entry.state = 'DISPOSED';
    cleanupResources(entry);
    if (typeof entry.implementation?.dispose === 'function') {
      try {
        entry.implementation.dispose();
      } catch {
        // Contained: a failing teardown hook must not make a disposed activity authoritative again.
      }
    }
    emitFor(entry, 'activity_disposed', { reason });
    return { disposed: true };
  }

  function deactivate(reason) {
    if (!current || current.state === 'DISPOSED') return { noop: true };
    if (current.state === 'ACTIVE') {
      current.state = 'INACTIVE';
      emitFor(current, 'activity_deactivated', { reason });
    }
    return disposeEntry(current, reason);
  }

  function guard(entry, callSite) {
    if (entry.state === 'DISPOSED') {
      emitFor(entry, 'activity_stale_event_rejected', { callSite, reason: 'DISPOSED' });
      fail('ACTIVITY_ALREADY_DISPOSED', `"${callSite}" was rejected because the activity instance has already been disposed.`, { callSite });
    }
    if (current !== entry || entry.state !== 'ACTIVE') {
      emitFor(entry, 'activity_stale_event_rejected', { callSite, reason: 'STALE' });
      fail('ACTIVITY_INSTANCE_STALE', `"${callSite}" was rejected because the activity instance is no longer the active instance.`, { callSite });
    }
  }

  function activate(activityDefinition, { content = {} } = {}) {
    if (!activityDefinition || typeof activityDefinition.activityId !== 'string' || activityDefinition.activityId.trim() === '') {
      fail('ACTIVITY_LIFECYCLE_INVALID', 'A valid activityDefinition with an activityId is required to activate an activity.');
    }
    if (typeof activityDefinition.create !== 'function') {
      fail('ACTIVITY_LIFECYCLE_INVALID', 'activityDefinition.create must be a function that builds the activity implementation.');
    }

    if (current && current.state === 'ACTIVE' && current.activityId === activityDefinition.activityId) {
      return current.publicHandle;
    }

    if (current && current.state === 'ACTIVE') {
      deactivate('REPLACED');
    }

    const services = resolveApprovedServices(activityDefinition.requiredServices ?? [], approvedServices);
    const generation = ++GENERATION_SEQUENCE;
    const entry = { generation, activityId: activityDefinition.activityId, state: 'CREATED', resources: new Set(), implementation: null, publicHandle: null };

    const runtime = Object.freeze({
      learnerId: identity.learnerId,
      appId: identity.appId,
      releaseId: identity.releaseId,
      sessionId: identity.sessionId,
      correlationId: identity.correlationId,
    });

    const rawEvents = createActivityEventChannel({
      runtime,
      lifecycle,
      completion,
      onMeaningfulProgress,
      onFailure,
      emit: (event, extra) => emitFor(entry, event, extra),
    });
    const guardedEvents = Object.freeze({
      ready: async () => { guard(entry, 'ready'); return rawEvents.ready(); },
      meaningfulProgress: async (payload) => { guard(entry, 'meaningfulProgress'); return rawEvents.meaningfulProgress(payload); },
      completed: async (payload) => { guard(entry, 'completed'); return rawEvents.completed(payload); },
      failed: (payload) => { guard(entry, 'failed'); return rawEvents.failed(payload); },
    });

    const resources = Object.freeze({
      register: (cleanup) => {
        if (typeof cleanup !== 'function') {
          fail('ACTIVITY_LIFECYCLE_INVALID', 'resources.register requires a cleanup function.');
        }
        if (entry.state === 'DISPOSED') {
          try { cleanup(); } catch { /* contained */ }
          return () => {};
        }
        entry.resources.add(cleanup);
        return () => entry.resources.delete(cleanup);
      },
    });

    const context = Object.freeze({ runtime, content: Object.freeze({ ...content }), services, events: guardedEvents, resources });

    entry.implementation = activityDefinition.create(context) ?? null;
    entry.state = 'ACTIVE';
    current = entry;
    emitFor(entry, 'activity_activated');

    entry.publicHandle = Object.freeze({ activityId: entry.activityId, generation: entry.generation, context, implementation: entry.implementation });
    return entry.publicHandle;
  }

  function deactivateCurrent(reason = 'MANUAL_DEACTIVATE') {
    return deactivate(reason);
  }

  function endSession(reason = 'SESSION_ENDED') {
    return deactivate(reason);
  }

  return Object.freeze({
    activate,
    deactivateCurrent,
    endSession,
    get current() { return current && current.state === 'ACTIVE' ? current.publicHandle : null; },
    get state() { return current?.state ?? null; },
  });
}
