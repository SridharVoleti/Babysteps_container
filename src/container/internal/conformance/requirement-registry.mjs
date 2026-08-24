// TC-003: the single authoritative list of frozen, non-deferred, non-duplicate Consumer App
// Container requirements and the npm test script that owns each requirement's acceptance
// criteria. Only requirements actually frozen in the requirements workbook appear here - a
// requirement marked DEFERRED (e.g. EH-001..003) or DUPLICATE/COVERED (e.g. TT-001, PK-001,
// PK-002, TC-001, TC-002) is never added, so it can never create a conformance obligation.
// `appliesTo(manifest)` decides applicability per final app; every entry is mandatory once
// applicable - there is no per-app waiver mechanism.
export const CONTAINER_REQUIREMENT_TESTS = Object.freeze([
  { id: 'CC-001', testCommand: 'test:architecture', mandatory: true, appliesTo: () => true },
  { id: 'CC-002', testCommand: 'test:manifest', mandatory: true, appliesTo: () => true },
  { id: 'CC-003', testCommand: 'test:capabilities', mandatory: true, appliesTo: () => true },
  { id: 'CC-004', testCommand: 'test:extensions', mandatory: true, appliesTo: () => true },
  { id: 'SB-001', testCommand: 'test:launch-context', mandatory: true, appliesTo: () => true },
  { id: 'SB-002', testCommand: 'test:runtime-binding', mandatory: true, appliesTo: () => true },
  { id: 'SB-003', testCommand: 'test:atomic-bootstrap', mandatory: true, appliesTo: () => true },
  { id: 'API-001', testCommand: 'test:api-client', mandatory: true, appliesTo: () => true },
  { id: 'API-002', testCommand: 'test:auth-context', mandatory: true, appliesTo: () => true },
  { id: 'API-003', testCommand: 'test:contract-validation', mandatory: true, appliesTo: () => true },
  { id: 'SR-001', testCommand: 'test:session-runtime', mandatory: true, appliesTo: () => true },
  { id: 'SR-002', testCommand: 'test:session-lifecycle', mandatory: true, appliesTo: () => true },
  { id: 'SR-003', testCommand: 'test:session-clock', mandatory: true, appliesTo: () => true },
  { id: 'SR-004', testCommand: 'test:session-completion', mandatory: true, appliesTo: () => true },
  { id: 'SR-005', testCommand: 'test:session-interruption', mandatory: true, appliesTo: () => true },
  { id: 'SR-006', testCommand: 'test:connected-time', mandatory: true, appliesTo: () => true },
  { id: 'AH-001', testCommand: 'test:activity-host', mandatory: true, appliesTo: () => true },
  { id: 'AH-002', testCommand: 'test:activity-lifecycle', mandatory: true, appliesTo: () => true },
  { id: 'CR-001', testCommand: 'test:content-runtime', mandatory: true, appliesTo: () => true },
  { id: 'CR-002', testCommand: 'test:session-content-binding', mandatory: true, appliesTo: () => true },
  { id: 'PA-001', testCommand: 'test:progress-adapter', mandatory: true, appliesTo: () => true },
  { id: 'PA-002', testCommand: 'test:progress-restore', mandatory: true, appliesTo: () => true },
  { id: 'PA-003', testCommand: 'test:pending-progress-recovery', mandatory: true, appliesTo: () => true },
  { id: 'UX-001', testCommand: 'test:learning-session-shell', mandatory: true, appliesTo: () => true },
  // AM-003 (microphone/STT) is a baseline capability required for every final app; AM-001
  // (audio playback) and AM-002 (packaged narration) only apply to apps that declare the
  // corresponding capability.
  {
    id: 'AM-001',
    testCommand: 'test:audio-runtime',
    mandatory: true,
    appliesTo: (manifest) => [...(manifest?.requiredCapabilities ?? []), ...(manifest?.optionalCapabilities ?? [])].includes('audio'),
  },
  {
    id: 'AM-002',
    testCommand: 'test:narration-voice',
    mandatory: true,
    appliesTo: (manifest) => [...(manifest?.requiredCapabilities ?? []), ...(manifest?.optionalCapabilities ?? [])].includes('narration'),
  },
  { id: 'AM-003', testCommand: 'test:speech-input', mandatory: true, appliesTo: () => true },
  { id: 'DR-001', testCommand: 'test:capability-service', mandatory: true, appliesTo: () => true },
  { id: 'DR-002', testCommand: 'test:responsive-runtime', mandatory: true, appliesTo: () => true },
  { id: 'DR-003', testCommand: 'test:local-ownership', mandatory: true, appliesTo: () => true },
  { id: 'ER-001', testCommand: 'test:error-boundary', mandatory: true, appliesTo: () => true },
  { id: 'ER-002', testCommand: 'test:connectivity-retry', mandatory: true, appliesTo: () => true },
  { id: 'SP-001', testCommand: 'test:learner-safety-policy', mandatory: true, appliesTo: () => true },
  { id: 'SP-002', testCommand: 'test:data-projection', mandatory: true, appliesTo: () => true },
  { id: 'SP-003', testCommand: 'test:egress-policy', mandatory: true, appliesTo: () => true },
  { id: 'PK-003', testCommand: 'test:release-composition', mandatory: true, appliesTo: () => true },
]);
