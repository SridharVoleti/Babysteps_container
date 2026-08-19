import { APPROVED_EXTENSION_POINTS } from '../governance/extension-registry.mjs';
import { APPROVED_CAPABILITIES } from '../capabilities/index.mjs';

export const manifestContract = Object.freeze({
  supportedContractVersions: Object.freeze(['1.0']),
  // CC-002/AM-002/TC-003: sourced from the same authoritative capability registry the
  // runtime capability facade and TC-003 applicability use, so a required/optional
  // capability (including narration) can never be validated as available by one and
  // rejected/misrepresented by another.
  availableCapabilities: APPROVED_CAPABILITIES,
  // Sourced from the same container-owned registry the extension manager validates
  // against (CC-004), so manifest validation and extension registration cannot drift.
  approvedExtensionPoints: APPROVED_EXTENSION_POINTS
});
