// Container-owned, version-controlled source of truth for CC-004 extension governance.
// Runtime callers (managers, extension modules, apps) can request against this data but
// can never supply, override, or extend it — approval and supported-version authority
// live here only, so manifest validation and extension registration share one source.

export const EXTENSION_CONTRACT_REGISTRY = Object.freeze({
  'activity-renderer': Object.freeze({
    supportedVersions: Object.freeze(['1.0']),
    governanceDecisionId: 'GOV-CC004-ACTIVITY-RENDERER-001',
  }),
});

export const APPROVED_EXTENSION_POINTS = Object.freeze(Object.keys(EXTENSION_CONTRACT_REGISTRY).sort());

export function isApprovedExtensionType(type) {
  return Object.prototype.hasOwnProperty.call(EXTENSION_CONTRACT_REGISTRY, type);
}

export function isSupportedExtensionVersion(type, version) {
  return isApprovedExtensionType(type) && EXTENSION_CONTRACT_REGISTRY[type].supportedVersions.includes(version);
}

// Trusted governance decisions (CC-004-P1): a caller-supplied {approvedBy, decisionId}
// cannot itself grant approval. Approval requires the decisionId to already exist here,
// tied to the classification it was actually granted for.
export const TRUSTED_GOVERNANCE_DECISIONS = Object.freeze({
  'GOV-CC004-ACTIVITY-RENDERER-001': Object.freeze({
    classification: 'app-specific',
    extensionType: 'activity-renderer',
    approvedBy: 'container-governance-board',
  }),
});

export function isTrustedGovernanceDecision(decisionId, classification) {
  const decision = TRUSTED_GOVERNANCE_DECISIONS[decisionId];
  return !!decision && decision.classification === classification;
}
