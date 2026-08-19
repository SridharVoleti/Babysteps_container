// CC-002/CC-003/AM-002/TC-003: the single authoritative registry of manifest-declarable
// app capability names. Manifest validation/resolution (CC-002), the runtime capability
// facade and TC-003 conformance applicability all import this set so they can never drift
// from one another - a capability is either approved here, or it does not exist anywhere
// in the system.
const APPROVED_CAPABILITY_NAMES = new Set(['progress', 'audio', 'narration']);

export class CapabilityError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.metadata = Object.freeze({ ...metadata });
  }
}

function normalizeOperationFailure(capability, operation) {
  return new CapabilityError(
    'CAPABILITY_OPERATION_FAILED',
    `Capability operation failed: ${capability}.${operation}`,
    { capability, operation },
  );
}

function wrapCapability(name, adapter) {
  const exposed = { version: adapter.version };
  for (const [key, value] of Object.entries(adapter)) {
    if (key === 'version' || typeof value !== 'function') continue;
    exposed[key] = async (...args) => {
      try {
        return await value(...args);
      } catch {
        throw normalizeOperationFailure(name, key);
      }
    };
  }
  return Object.freeze(exposed);
}

export function createCapabilityFacade({ manifest, adapters = {} }) {
  const declared = new Set([
    ...(manifest?.requiredCapabilities ?? []),
    ...(manifest?.optionalCapabilities ?? []),
  ]);

  const available = new Map();
  for (const name of declared) {
    if (!APPROVED_CAPABILITY_NAMES.has(name)) continue;
    const adapter = adapters[name];
    if (adapter && typeof adapter === 'object') available.set(name, wrapCapability(name, adapter));
  }

  const facade = {
    get(name) {
      if (!declared.has(name)) {
        throw new CapabilityError('CAPABILITY_NOT_DECLARED', `Capability not declared: ${name}`, { capability: name });
      }
      if (!APPROVED_CAPABILITY_NAMES.has(name)) {
        throw new CapabilityError('CAPABILITY_NOT_APPROVED', `Capability not approved: ${name}`, { capability: name });
      }
      if (!available.has(name)) {
        throw new CapabilityError('CAPABILITY_UNAVAILABLE', `Capability unavailable: ${name}`, { capability: name });
      }
      return available.get(name);
    },
    has(name) {
      return declared.has(name) && APPROVED_CAPABILITY_NAMES.has(name) && available.has(name);
    },
    list() {
      return Object.freeze([...available.keys()].sort());
    },
  };

  return Object.freeze(facade);
}

export const APPROVED_CAPABILITIES = Object.freeze([...APPROVED_CAPABILITY_NAMES].sort());
