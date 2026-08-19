import { isApprovedExtensionType, isSupportedExtensionVersion, isTrustedGovernanceDecision } from '../governance/extension-registry.mjs';

export class ExtensionError extends Error {
  constructor(code, message) { super(message); this.name = 'ExtensionError'; this.code = code; Object.freeze(this); }
}

function fail(code, message) { throw new ExtensionError(code, message); }

// approvedExtensionContracts is intentionally not a caller-supplied parameter: approval
// and supported-version authority live only in the container-owned governance registry
// (CC-004), so no caller/app can supply or override which extension types/versions pass.
export function createExtensionManager({ manifest, runtimeContext = undefined }) {
  const active = new Map();
  const declared = new Set(manifest?.extensionPoints ?? []);

  return Object.freeze({
    async register(extension) {
      if (!extension || typeof extension !== 'object' || !extension.id || !extension.type || !extension.version || typeof extension.initialize !== 'function') {
        fail('EXTENSION_INVALID', 'Extension registration is invalid.');
      }
      if (!declared.has(extension.type) || !isApprovedExtensionType(extension.type)) {
        fail('EXTENSION_NOT_APPROVED', 'Extension type is not approved for this app.');
      }
      if (!isSupportedExtensionVersion(extension.type, extension.version)) {
        fail('EXTENSION_VERSION_UNSUPPORTED', 'Extension contract version is unsupported.');
      }
      const key = `${extension.type}:${extension.id}`;
      if (active.has(key)) return Object.freeze({ ok: true, alreadyInitialized: true });
      try {
        const lifecycle = await extension.initialize(Object.freeze({
          extensionType: extension.type,
          contractVersion: extension.version,
          ...(runtimeContext !== undefined ? { runtimeContext } : {}),
        }));
        active.set(key, Object.freeze({ id: extension.id, type: extension.type, version: extension.version, lifecycle: lifecycle ?? null }));
        return Object.freeze({ ok: true, alreadyInitialized: false });
      } catch {
        fail('EXTENSION_INITIALIZATION_FAILED', 'Extension initialization failed safely.');
      }
    },
    list() { return [...active.values()].map(({ lifecycle, ...safe }) => Object.freeze(safe)); },
  });
}

// Validates type/version against the governance registry BEFORE importing the extension
// module. In JavaScript, importing a module executes its top-level code as a side effect,
// so validating an already-constructed extension object (as register() does) is too late
// to guarantee an unapproved/incompatible module never executes. This loader guarantees
// ordering: approval check first, dynamic import only on success.
export async function loadApprovedExtensionModule({ type, version, moduleSpecifier, loadModule = (specifier) => import(specifier) }) {
  if (typeof type !== 'string' || type.trim() === '' || typeof version !== 'string' || version.trim() === '') {
    fail('EXTENSION_INVALID', 'A type and version are required to load an extension module.');
  }
  if (!isApprovedExtensionType(type)) {
    fail('EXTENSION_NOT_APPROVED', 'Extension type is not approved for this app.');
  }
  if (!isSupportedExtensionVersion(type, version)) {
    fail('EXTENSION_VERSION_UNSUPPORTED', 'Extension contract version is unsupported.');
  }

  let module;
  try {
    module = await loadModule(moduleSpecifier);
  } catch {
    fail('EXTENSION_MODULE_LOAD_FAILED', 'The approved extension module could not be loaded.');
  }

  const extension = module?.default ?? module;
  if (!extension || extension.type !== type || extension.version !== version) {
    fail('EXTENSION_INVALID', 'The loaded extension module does not match the validated type/version.');
  }
  return extension;
}

export async function registerApprovedExtension(manager, { type, version, moduleSpecifier, loadModule } = {}) {
  const extension = await loadApprovedExtensionModule({ type, version, moduleSpecifier, loadModule });
  return manager.register(extension);
}

// approval.approvedBy/decisionId are request metadata only, never a source of authority:
// a caller/app cannot self-assert approval. The decisionId must already exist in the
// container-owned governance registry, tied to the classification it was actually
// granted for; forged or mismatched decision references resolve as unapproved.
export function evaluateExtensionNeed({ need, classification, approval } = {}) {
  if (!need || !['app-specific', 'reusable-container-capability'].includes(classification)) {
    return Object.freeze({ approved: false, action: 'CLASSIFY_NEED' });
  }
  const deniedAction = classification === 'app-specific' ? 'REQUEST_EXTENSION_POINT_APPROVAL' : 'REQUEST_CONTAINER_CAPABILITY_APPROVAL';
  const decisionId = approval?.decisionId;
  if (!decisionId || !isTrustedGovernanceDecision(decisionId, classification)) {
    return Object.freeze({ approved: false, action: deniedAction });
  }
  return Object.freeze({ approved: true, action: classification === 'app-specific' ? 'ADD_APPROVED_EXTENSION_POINT' : 'ADD_APPROVED_CONTAINER_CAPABILITY', decisionId });
}
