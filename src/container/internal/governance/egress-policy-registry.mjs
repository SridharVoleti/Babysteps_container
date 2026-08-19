// SP-003: container-owned, version-controlled source of truth for approved third-party
// egress. Each entry is a Babysteps-governed exception scoped to exactly one app + one
// purpose + one provider/destination + a minimum data contract, traceable to a governance
// decision. Runtime callers can request use of an approved integration, but only an entry
// already recorded here can grant it - a caller-supplied override object is never approval.
export const APPROVED_EGRESS_POLICY_REGISTRY = Object.freeze([
  Object.freeze({
    appId: 'speed-reading',
    purposeId: 'pronunciation-scoring',
    providerId: 'approved-speech-processor',
    destinations: Object.freeze(['https://speech.approved-vendor.example/v1/transcribe']),
    allowedFields: Object.freeze(['audioSampleRef', 'language']),
    governanceDecisionId: 'GOV-SP003-SPEED-READING-PRONUNCIATION-SCORING-001',
  }),
]);
