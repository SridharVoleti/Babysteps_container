import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';

export class ContentRuntimeError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ContentRuntimeError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new ContentRuntimeError(code, message, metadata); }

const RUNTIME_CACHES = new WeakMap();

function cacheKeyFor(appId, releaseId, contentVersion) {
  return `${appId}::${releaseId}::${contentVersion}`;
}

export function createContentRuntime({ runtimeBinding, loader, onTelemetry = () => {} }) {
  if (typeof loader !== 'function') {
    fail('CONTENT_LOAD_FAILED', 'A technical content loader function is required.');
  }
  const identity = getRuntimeContext(runtimeBinding);

  let cache = RUNTIME_CACHES.get(runtimeBinding);
  if (!cache) { cache = new Map(); RUNTIME_CACHES.set(runtimeBinding, cache); }

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      appId: identity.appId,
      releaseId: identity.releaseId,
      correlationId: identity.correlationId,
      ...extra,
    }));
  }

  async function resolve(descriptor = {}) {
    if (!descriptor || typeof descriptor !== 'object') {
      fail('CONTENT_LOAD_FAILED', 'A content descriptor is required to resolve content.');
    }
    const { appId, releaseId, contentVersion } = descriptor;
    if (typeof appId !== 'string' || appId.trim() === '') {
      fail('CONTENT_LOAD_FAILED', 'descriptor.appId is required.');
    }
    if (typeof contentVersion !== 'string' || contentVersion.trim() === '') {
      fail('CONTENT_LOAD_FAILED', 'descriptor.contentVersion is required.');
    }

    if (appId !== identity.appId) {
      emit('content_load_failed', { reason: 'CONTENT_APP_MISMATCH' });
      fail('CONTENT_APP_MISMATCH', `Content belongs to app "${appId}", not the authorized app "${identity.appId}".`, { appId });
    }
    if (releaseId !== undefined && releaseId !== identity.releaseId) {
      emit('content_load_failed', { reason: 'CONTENT_VERSION_INCOMPATIBLE' });
      fail('CONTENT_VERSION_INCOMPATIBLE', `Content release "${releaseId}" is not compatible with the authorized release "${identity.releaseId}".`, { releaseId });
    }

    const key = cacheKeyFor(identity.appId, identity.releaseId, contentVersion);
    if (cache.has(key)) {
      emit('content_cache_hit', { contentVersion });
      return cache.get(key);
    }

    let content;
    try {
      content = await loader(Object.freeze({ appId: identity.appId, releaseId: identity.releaseId, contentVersion }));
    } catch (error) {
      emit('content_load_failed', { reason: 'CONTENT_LOAD_FAILED' });
      fail('CONTENT_LOAD_FAILED', 'Content failed to load.', { cause: error?.message ?? String(error) });
    }
    if (content === undefined || content === null) {
      emit('content_load_failed', { reason: 'CONTENT_NOT_FOUND' });
      fail('CONTENT_NOT_FOUND', `No content was found for version "${contentVersion}".`, { contentVersion });
    }

    const frozenContent = Object.freeze(content);
    cache.set(key, frozenContent);
    emit('content_loaded', { contentVersion });
    return frozenContent;
  }

  async function resolveAsset(assetRef, resolver) {
    if (typeof resolver !== 'function') {
      fail('CONTENT_ASSET_UNAVAILABLE', 'An asset resolver function is required.', { assetRef });
    }
    let asset;
    try {
      asset = await resolver(assetRef);
    } catch (error) {
      emit('content_load_failed', { reason: 'CONTENT_ASSET_UNAVAILABLE' });
      fail('CONTENT_ASSET_UNAVAILABLE', `Asset "${assetRef}" failed to resolve.`, { assetRef, cause: error?.message ?? String(error) });
    }
    if (asset === undefined || asset === null) {
      emit('content_load_failed', { reason: 'CONTENT_ASSET_UNAVAILABLE' });
      fail('CONTENT_ASSET_UNAVAILABLE', `Asset "${assetRef}" is unavailable.`, { assetRef });
    }
    emit('content_asset_resolved', { assetRef });
    return asset;
  }

  return Object.freeze({ resolve, resolveAsset });
}
