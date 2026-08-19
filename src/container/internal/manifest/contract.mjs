import { APPROVED_EXTENSION_POINTS } from '../governance/extension-registry.mjs';

export const manifestContract = Object.freeze({
  supportedContractVersions: Object.freeze(['1.0']),
  availableCapabilities: Object.freeze(['progress', 'audio']),
  // Sourced from the same container-owned registry the extension manager validates
  // against (CC-004), so manifest validation and extension registration cannot drift.
  approvedExtensionPoints: APPROVED_EXTENSION_POINTS
});
