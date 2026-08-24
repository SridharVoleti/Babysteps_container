import { APPROVED_EGRESS_POLICY_REGISTRY } from '../governance/egress-policy-registry.mjs';

export class EgressPolicyError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'EgressPolicyError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new EgressPolicyError(code, message, metadata); }

// SP-003: default-deny outbound egress. Every exception is a versioned, explicitly reviewed
// approval scoped to exactly one app + one purpose + one provider/destination + a minimum
// data contract - never a general allowlist. App A's approval never relaxes App B's policy,
// and approval for one purpose never implies approval for another purpose on the same
// provider.
export function createApprovedEgressPolicy({ approvedOverrides = [], onTelemetry = () => {} }) {
  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({ event, ...extra }));
  }

  function validateRequest({ appId, purposeId, providerId, destination, data = {} }) {
    const providerApprovals = approvedOverrides.filter((o) => o.appId === appId && o.providerId === providerId);
    if (providerApprovals.length === 0) {
      emit('egress_denied', { appId, providerId, reason: 'PROVIDER_NOT_APPROVED' });
      fail('PROVIDER_NOT_APPROVED', `Provider is not approved for this app: ${providerId}`, { appId, providerId });
    }

    const approval = providerApprovals.find((o) => o.purposeId === purposeId);
    if (!approval) {
      emit('egress_denied', { appId, providerId, purposeId, reason: 'PURPOSE_NOT_APPROVED' });
      fail('PURPOSE_NOT_APPROVED', `Purpose is not approved for this app/provider: ${purposeId}`, { appId, providerId, purposeId });
    }

    const destinations = approval.destinations ?? [];
    if (!destinations.includes(destination)) {
      emit('egress_denied', { appId, providerId, purposeId, reason: 'EGRESS_DENIED', destination });
      fail('EGRESS_DENIED', `Destination is not approved for this app/provider/purpose: ${destination}`, { destination });
    }

    const allowedFields = new Set(approval.allowedFields ?? []);
    const extraFields = Object.keys(data).filter((field) => !allowedFields.has(field));
    if (extraFields.length > 0) {
      emit('egress_denied', { appId, providerId, purposeId, reason: 'DATA_CONTRACT_VIOLATION' });
      fail('DATA_CONTRACT_VIOLATION', 'Outgoing request contains fields outside the minimum approved data contract.', { extraFields });
    }

    emit('egress_approved', { appId, providerId, purposeId });
    return approval;
  }

  async function callApprovedProvider({ appId, purposeId, providerId, destination, data = {}, invoke }) {
    validateRequest({ appId, purposeId, providerId, destination, data });
    if (typeof invoke !== 'function') {
      fail('PROVIDER_UNAVAILABLE', 'No provider adapter was supplied for this approved egress call.', { providerId });
    }
    try {
      return await invoke(data);
    } catch (error) {
      emit('provider_unavailable', { providerId, purposeId });
      fail('PROVIDER_UNAVAILABLE', `The approved external processor is unavailable: ${providerId}`, { providerId, cause: error?.message });
    }
  }

  return Object.freeze({ validateRequest, callApprovedProvider });
}

// SP-003-P0: the only production entry point for approved egress. Approval exceptions are
// resolved exclusively from the trusted, version-controlled
// governance/egress-policy-registry.mjs - a caller cannot self-authorize a new provider,
// destination, purpose or field set by constructing its own override objects.
export function createProductionEgressPolicy({ onTelemetry = () => {} } = {}) {
  return createApprovedEgressPolicy({ approvedOverrides: APPROVED_EGRESS_POLICY_REGISTRY, onTelemetry });
}
