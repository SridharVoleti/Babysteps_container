export class ExtensionError extends Error {
  constructor(code, message) { super(message); this.name = 'ExtensionError'; this.code = code; Object.freeze(this); }
}

function fail(code, message) { throw new ExtensionError(code, message); }

export function createExtensionManager({ manifest, approvedExtensionContracts = {} }) {
  const active = new Map();
  const declared = new Set(manifest?.extensionPoints ?? []);

  return Object.freeze({
    async register(extension) {
      if (!extension || typeof extension !== 'object' || !extension.id || !extension.type || !extension.version || typeof extension.initialize !== 'function') {
        fail('EXTENSION_INVALID', 'Extension registration is invalid.');
      }
      if (!declared.has(extension.type) || !(extension.type in approvedExtensionContracts)) {
        fail('EXTENSION_NOT_APPROVED', 'Extension type is not approved for this app.');
      }
      if (!(approvedExtensionContracts[extension.type] ?? []).includes(extension.version)) {
        fail('EXTENSION_VERSION_UNSUPPORTED', 'Extension contract version is unsupported.');
      }
      const key = `${extension.type}:${extension.id}`;
      if (active.has(key)) return Object.freeze({ ok: true, alreadyInitialized: true });
      try {
        const lifecycle = await extension.initialize(Object.freeze({ extensionType: extension.type, contractVersion: extension.version }));
        active.set(key, Object.freeze({ id: extension.id, type: extension.type, version: extension.version, lifecycle: lifecycle ?? null }));
        return Object.freeze({ ok: true, alreadyInitialized: false });
      } catch {
        fail('EXTENSION_INITIALIZATION_FAILED', 'Extension initialization failed safely.');
      }
    },
    list() { return [...active.values()].map(({ lifecycle, ...safe }) => Object.freeze(safe)); },
  });
}

export function evaluateExtensionNeed({ need, classification, approval } = {}) {
  if (!need || !['app-specific', 'reusable-container-capability'].includes(classification)) {
    return Object.freeze({ approved: false, action: 'CLASSIFY_NEED' });
  }
  if (!approval?.approvedBy || !approval?.decisionId) {
    return Object.freeze({ approved: false, action: classification === 'app-specific' ? 'REQUEST_EXTENSION_POINT_APPROVAL' : 'REQUEST_CONTAINER_CAPABILITY_APPROVAL' });
  }
  return Object.freeze({ approved: true, action: classification === 'app-specific' ? 'ADD_APPROVED_EXTENSION_POINT' : 'ADD_APPROVED_CONTAINER_CAPABILITY', decisionId: approval.decisionId });
}
