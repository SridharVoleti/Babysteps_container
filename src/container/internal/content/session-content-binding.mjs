import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';
import { resolveApprovedResumeContentVersion } from '../governance/content-compatibility-registry.mjs';

export class SessionContentBindingError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'SessionContentBindingError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new SessionContentBindingError(code, message, metadata); }

const SESSION_BINDINGS = new WeakMap();

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function emitEvent(onTelemetry, identity, event, extra = {}) {
  onTelemetry(Object.freeze({
    event,
    appId: identity.appId,
    releaseId: identity.releaseId,
    sessionId: identity.sessionId,
    correlationId: identity.correlationId,
    ...extra,
  }));
}

// CR-001/CR-002: the only source of truth for "what content version is this app/release
// approved for" is the resolved CC-002 manifest - never a value supplied directly by a
// runtime caller. A manifest that does not belong to the authorized app, or that has no
// approved content version, fails closed instead of falling back to caller input.
function authoritativeContentVersion(manifest, identity) {
  if (!manifest || typeof manifest !== 'object') {
    fail('CONTENT_VERSION_REQUIRED', 'The resolved CC-002 manifest is required to derive an approved session content version.');
  }
  if (manifest.appId !== identity.appId) {
    fail('CONTENT_VERSION_REQUIRED', 'The supplied manifest does not belong to the authorized app.', { appId: manifest.appId });
  }
  if (!isNonEmptyString(manifest.contentVersion)) {
    fail('CONTENT_VERSION_REQUIRED', 'The resolved manifest does not declare an approved content version.');
  }
  return manifest.contentVersion;
}

export function pinSessionContentVersion({ runtimeBinding, manifest, integrity = null, onTelemetry = () => {} }) {
  const identity = getRuntimeContext(runtimeBinding);
  const contentVersion = authoritativeContentVersion(manifest, identity);

  const existing = SESSION_BINDINGS.get(runtimeBinding);
  if (existing) {
    if (existing.contentVersion !== contentVersion) {
      emitEvent(onTelemetry, identity, 'content_version_pin_rejected', { pinned: existing.contentVersion, requested: contentVersion });
      fail('CONTENT_VERSION_MISMATCH', `This session is already pinned to content version "${existing.contentVersion}" and cannot re-pin to "${contentVersion}".`, { pinned: existing.contentVersion, requested: contentVersion });
    }
    return existing.binding;
  }

  const binding = Object.freeze({
    appId: identity.appId,
    releaseId: identity.releaseId,
    sessionId: identity.sessionId,
    contentVersion,
    integrity,
  });
  SESSION_BINDINGS.set(runtimeBinding, { contentVersion, binding });
  emitEvent(onTelemetry, identity, 'content_version_pinned', { contentVersion });
  return binding;
}

export function getSessionContentBinding(runtimeBinding) {
  const entry = SESSION_BINDINGS.get(runtimeBinding);
  if (!entry) {
    fail('CONTENT_VERSION_REQUIRED', 'No content version has been pinned for this authorized runtime.');
  }
  return entry.binding;
}

// CR-002-P0: resumedContentVersion is untrusted persisted data describing what the session
// used to be bound to - it is evidence, not authorization. Whether it may resume into the
// currently approved content version is decided only by the trusted, version-controlled
// governance/content-compatibility-registry.mjs mapping; there is no caller-suppliable
// compatibility function anymore.
export function restoreSessionContentBinding({ runtimeBinding, manifest, resumedContentVersion, onTelemetry = () => {} }) {
  if (!isNonEmptyString(resumedContentVersion)) {
    fail('CONTENT_VERSION_REQUIRED', 'A resumedContentVersion is required to restore the session content binding.');
  }
  const identity = getRuntimeContext(runtimeBinding);
  const currentContentVersion = authoritativeContentVersion(manifest, identity);

  const existing = SESSION_BINDINGS.get(runtimeBinding);
  const targetContentVersion = existing ? existing.contentVersion : currentContentVersion;
  const approved = resolveApprovedResumeContentVersion(identity.appId, resumedContentVersion, targetContentVersion);
  if (!approved) {
    emitEvent(onTelemetry, identity, 'content_resume_version_mismatch', { bound: targetContentVersion, resumed: resumedContentVersion });
    fail('CONTENT_RESUME_VERSION_MISMATCH', `Resumed session content version "${resumedContentVersion}" is not an approved match for the currently authorized content version "${targetContentVersion}".`, { bound: targetContentVersion, resumed: resumedContentVersion });
  }
  if (existing) return existing.binding;

  return pinSessionContentVersion({ runtimeBinding, manifest, onTelemetry });
}

export function createSessionPinnedContentLoader({ runtimeBinding, contentRuntime, onTelemetry = () => {} }) {
  if (!contentRuntime || typeof contentRuntime.resolve !== 'function') {
    fail('CONTENT_VERSION_REQUIRED', 'A content runtime with a resolve() method is required to build a pinned content loader.');
  }

  async function resolve(request = {}) {
    const binding = getSessionContentBinding(runtimeBinding);
    const identity = getRuntimeContext(runtimeBinding);

    if ('contentVersion' in request && request.contentVersion !== undefined && request.contentVersion !== binding.contentVersion) {
      emitEvent(onTelemetry, identity, 'content_version_substitution_rejected', { pinned: binding.contentVersion, requested: request.contentVersion });
      fail('CONTENT_VERSION_MISMATCH', `Content version "${request.contentVersion}" does not match the session-pinned version "${binding.contentVersion}".`, { pinned: binding.contentVersion, requested: request.contentVersion });
    }

    try {
      return await contentRuntime.resolve({ appId: binding.appId, releaseId: binding.releaseId, contentVersion: binding.contentVersion });
    } catch (error) {
      emitEvent(onTelemetry, identity, 'content_pinned_version_unavailable', { contentVersion: binding.contentVersion, cause: error?.code });
      fail('CONTENT_PINNED_VERSION_UNAVAILABLE', `The session-pinned content version "${binding.contentVersion}" could not be loaded.`, { contentVersion: binding.contentVersion, cause: error?.code });
    }
  }

  return Object.freeze({ resolve, binding: () => getSessionContentBinding(runtimeBinding) });
}
