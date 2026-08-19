import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';

export class ActivityContractError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ActivityContractError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new ActivityContractError(code, message, metadata); }

const AUTHORITY_FIELDS = ['learnerId', 'appId', 'releaseId', 'sessionId'];

function assertPlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message);
}

function rejectAuthorityOverride(payload, identity) {
  for (const field of AUTHORITY_FIELDS) {
    if (field in payload && payload[field] !== undefined && payload[field] !== identity[field]) {
      fail('ACTIVITY_CONTEXT_MISMATCH', `Activity payload attempted to override authoritative ${field}.`, { field });
    }
  }
}

const MOUNTED_ACTIVITIES = new WeakMap();

export function mountActivity({
  activityDefinition,
  runtimeBinding,
  content = {},
  approvedServices = {},
  lifecycle,
  completion,
  onMeaningfulProgress = () => {},
  onFailure = () => {},
  onTelemetry = () => {},
}) {
  if (!activityDefinition || typeof activityDefinition.activityId !== 'string' || activityDefinition.activityId.trim() === '') {
    fail('ACTIVITY_CONTRACT_INVALID', 'A valid activityDefinition with an activityId is required.');
  }
  if (typeof activityDefinition.create !== 'function') {
    fail('ACTIVITY_CONTRACT_INVALID', 'activityDefinition.create must be a function that builds the activity implementation.');
  }
  assertPlainObject(approvedServices, 'ACTIVITY_CONTRACT_INVALID', 'approvedServices must be an object of approved shared services.');

  const identity = getRuntimeContext(runtimeBinding);

  let registry = MOUNTED_ACTIVITIES.get(runtimeBinding);
  if (!registry) { registry = new Map(); MOUNTED_ACTIVITIES.set(runtimeBinding, registry); }

  const existing = registry.get(activityDefinition.activityId);
  if (existing) return existing;

  const requiredServices = activityDefinition.requiredServices ?? [];
  for (const capability of requiredServices) {
    if (!(capability in approvedServices)) {
      fail('ACTIVITY_CAPABILITY_DENIED', `Activity requires unapproved capability "${capability}".`, { capability });
    }
  }
  const services = Object.freeze(Object.fromEntries(requiredServices.map((name) => [name, approvedServices[name]])));

  const runtime = Object.freeze({
    learnerId: identity.learnerId,
    appId: identity.appId,
    releaseId: identity.releaseId,
    sessionId: identity.sessionId,
    correlationId: identity.correlationId,
  });

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      appId: runtime.appId,
      activityId: activityDefinition.activityId,
      correlationId: runtime.correlationId,
      ...extra,
    }));
  }

  const events = Object.freeze({
    ready: async () => {
      emit('activity_ready');
      if (lifecycle && typeof lifecycle.signal === 'function') {
        await lifecycle.signal('activity-ready');
      }
    },
    meaningfulProgress: async (payload = {}) => {
      assertPlainObject(payload, 'ACTIVITY_EVENT_INVALID', 'meaningfulProgress payload must be an object.');
      rejectAuthorityOverride(payload, runtime);
      emit('activity_meaningful_progress');
      await onMeaningfulProgress(payload, runtime);
    },
    completed: async (payload = {}) => {
      assertPlainObject(payload, 'ACTIVITY_EVENT_INVALID', 'completed payload must be an object.');
      rejectAuthorityOverride(payload, runtime);
      if (!completion || typeof completion.complete !== 'function') {
        fail('ACTIVITY_CONTRACT_INVALID', 'No SR-004 completion handler is bound to this activity host.');
      }
      emit('activity_completed');
      return completion.complete(payload);
    },
    failed: (payload = {}) => {
      const normalized = Object.freeze({
        code: typeof payload?.code === 'string' ? payload.code : 'ACTIVITY_FAILURE',
        message: typeof payload?.message === 'string' ? payload.message : 'The activity reported an unrecoverable local failure.',
      });
      emit('activity_failed', { failureCode: normalized.code });
      onFailure(normalized, runtime);
      return normalized;
    },
  });

  const context = Object.freeze({
    runtime,
    content: Object.freeze({ ...content }),
    services,
    events,
  });

  const implementation = activityDefinition.create(context) ?? null;
  emit('activity_mounted');

  const handle = Object.freeze({ activityId: activityDefinition.activityId, context, implementation });
  registry.set(activityDefinition.activityId, handle);
  return handle;
}
