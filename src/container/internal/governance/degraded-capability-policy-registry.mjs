// SB-003/DR-001: container-owned, version-controlled list of runtime capabilities that may
// continue in an approved degraded state when actually unavailable in the browser, each
// traceable to a governance decision. A caller (capability-service/atomic-bootstrap caller)
// may still request that a specific optional capability be treated as degradable, but that
// request only takes effect when the capability is already recorded here - a caller-supplied
// name/object can never grant approval on its own.
export const APPROVED_DEGRADED_CAPABILITIES_REGISTRY = Object.freeze({
  audio: Object.freeze({ governanceDecisionId: 'GOV-SB003-AUDIO-DEGRADE-001' }),
  'local-recovery-storage': Object.freeze({ governanceDecisionId: 'GOV-DR001-LOCAL-RECOVERY-STORAGE-DEGRADE-001' }),
  notifications: Object.freeze({ governanceDecisionId: 'GOV-SP001-NOTIFICATIONS-DEGRADE-001' }),
});

export function isApprovedDegradedCapability(name) {
  return Object.prototype.hasOwnProperty.call(APPROVED_DEGRADED_CAPABILITIES_REGISTRY, name);
}
