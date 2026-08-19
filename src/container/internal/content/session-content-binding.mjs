import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';

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

export function pinSessionContentVersion({ runtimeBinding, contentVersion, integrity = null, onTelemetry = () => {} }) {
  if (typeof contentVersion !== 'string' || contentVersion.trim() === '') {
    fail('CONTENT_VERSION_REQUIRED', 'A contentVersion is required to pin the session content binding.');
  }
  const identity = getRuntimeContext(runtimeBinding);

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

export function restoreSessionContentBinding({ runtimeBinding, resumedContentVersion, compatibilityMap, onTelemetry = () => {} }) {
  if (typeof resumedContentVersion !== 'string' || resumedContentVersion.trim() === '') {
    fail('CONTENT_VERSION_REQUIRED', 'A resumedContentVersion is required to restore the session content binding.');
  }
  const identity = getRuntimeContext(runtimeBinding);
  const targetVersion = typeof compatibilityMap === 'function'
    ? (compatibilityMap(resumedContentVersion) ?? resumedContentVersion)
    : resumedContentVersion;

  const existing = SESSION_BINDINGS.get(runtimeBinding);
  if (existing) {
    if (existing.contentVersion !== targetVersion) {
      emitEvent(onTelemetry, identity, 'content_resume_version_mismatch', { bound: existing.contentVersion, resumed: targetVersion });
      fail('CONTENT_RESUME_VERSION_MISMATCH', `Resumed session content version "${targetVersion}" does not match the currently bound version "${existing.contentVersion}".`, { bound: existing.contentVersion, resumed: targetVersion });
    }
    return existing.binding;
  }
  return pinSessionContentVersion({ runtimeBinding, contentVersion: targetVersion, onTelemetry });
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
