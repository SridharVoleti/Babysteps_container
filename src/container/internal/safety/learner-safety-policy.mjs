import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';
import { sanitizeCause } from '../telemetry/sanitize-cause.mjs';
import { APPROVED_NAVIGATION_DESTINATION_CLASSES, APPROVED_NOTIFICATION_PURPOSES } from '../governance/navigation-policy-registry.mjs';

export class LearnerSafetyError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'LearnerSafetyError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new LearnerSafetyError(code, message, metadata); }

// SP-001: the complete learner-runtime device/behavior capability policy. Anything not
// listed here is DENIED by default - a future capability must be explicitly added to this
// registry (and separately frozen/approved) before it can ever become available.
const CAPABILITY_STATUS = Object.freeze({
  'microphone-stt': 'REQUIRED_BASELINE',
  notifications: 'APPROVED_PURPOSE_BOUND',
});

const PROHIBITED_BEHAVIORS = Object.freeze([
  'advertising',
  'public-learner-identity',
  'learner-to-learner-messaging',
  'generative-ai',
  'contacts',
  'camera',
  'location',
  'files',
]);

// SP-001: sits at the learner-runtime boundary. App-specific code consumes microphone/STT
// only through AM-003 and notifications only through this policy's guarded registration path;
// every other device capability and every closed-runtime behavior (ads, public identity,
// learner-to-learner comms, open-ended AI, arbitrary external navigation) is deny-by-default.
// SP-001-P0: approved navigation destinations and notification purposes are read only from
// the trusted, version-controlled governance/navigation-policy-registry.mjs - there is no
// constructor parameter for either any more, so a caller can never self-approve a new
// destination/purpose by passing its own array.
export function createLearnerSafetyPolicy({
  runtimeBinding,
  notificationAdapter,
  onTelemetry = () => {},
}) {
  const identity = getRuntimeContext(runtimeBinding);
  const purposeAllowlist = new Set(APPROVED_NOTIFICATION_PURPOSES);
  const navigationAllowlist = new Set(APPROVED_NAVIGATION_DESTINATION_CLASSES);

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      appId: identity.appId,
      correlationId: identity.correlationId,
      ...extra,
    }));
  }

  function capabilityStatus(name) {
    return CAPABILITY_STATUS[name] ?? 'DENIED';
  }

  function requestCapability(name) {
    const status = capabilityStatus(name);
    if (status === 'DENIED') {
      emit('capability_denied', { capability: name });
      fail('CAPABILITY_DENIED', `Device capability is not approved for the learner runtime: ${name}`, { capability: name });
    }
    emit('capability_status_resolved', { capability: name, status });
    return status;
  }

  function guardProhibitedBehavior(behavior) {
    if (!PROHIBITED_BEHAVIORS.includes(behavior)) return { evaluated: false };
    emit('learner_runtime_policy_violation', { behavior });
    fail('LEARNER_RUNTIME_POLICY_VIOLATION', `Behavior is prohibited in the closed learner runtime: ${behavior}`, { behavior });
  }

  async function registerNotification(purposeId, payload = {}) {
    if (!purposeAllowlist.has(purposeId)) {
      emit('notification_purpose_rejected', { purposeId });
      fail('NOTIFICATION_PURPOSE_NOT_APPROVED', `Notification purpose is not approved: ${purposeId}`, { purposeId });
    }
    if (!notificationAdapter || typeof notificationAdapter.register !== 'function') {
      fail('CAPABILITY_DENIED', 'A notification adapter is required to register an approved purpose-bound notification.');
    }

    let result;
    try {
      result = await notificationAdapter.register(purposeId, payload);
    } catch (error) {
      emit('notification_permission_denied', { purposeId, cause: sanitizeCause(error) });
      return Object.freeze({ registered: false, reason: 'NOTIFICATION_PERMISSION_DENIED' });
    }
    if (!result?.granted) {
      emit('notification_permission_denied', { purposeId });
      return Object.freeze({ registered: false, reason: 'NOTIFICATION_PERMISSION_DENIED' });
    }
    emit('notification_registered', { purposeId });
    return Object.freeze({ registered: true });
  }

  function guardNavigation(destinationClass) {
    if (!navigationAllowlist.has(destinationClass)) {
      emit('navigation_blocked', { destinationClass });
      fail('NAVIGATION_BLOCKED', `External navigation is blocked for this destination class: ${destinationClass}`, { destinationClass });
    }
    emit('navigation_approved', { destinationClass });
    return { allowed: true };
  }

  return Object.freeze({
    capabilityStatus,
    requestCapability,
    guardProhibitedBehavior,
    registerNotification,
    guardNavigation,
  });
}

export { PROHIBITED_BEHAVIORS };
