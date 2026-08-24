// SP-001: container-owned, version-controlled source of truth for the closed learner
// runtime's approved external-navigation destination classes and notification purposes.
// A caller (learner-safety-policy construction) may still request against this registry,
// but a caller-supplied array/object can never itself grant approval - only an entry
// already recorded here can.
export const APPROVED_NAVIGATION_DESTINATION_CLASSES = Object.freeze([
  'babysteps-help-center',
]);

export const APPROVED_NOTIFICATION_PURPOSES = Object.freeze([
  'session-reminder-30-min',
]);
