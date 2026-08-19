import { randomUUID } from 'node:crypto';
import { scopeAuthorityRequest, getRuntimeContext, RuntimeBindingError } from '../runtime/authorized-runtime-identity.mjs';

const AUTHORITY_FIELDS = ['learnerId', 'appId', 'releaseId', 'sessionId'];

export class ApiClientError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.metadata = Object.freeze({ ...metadata });
    Object.freeze(this);
  }
}

function categorizeStatus(status) {
  if (status === 401) return 'AUTH';
  if (status === 403) return 'AUTHORIZATION';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'SERVER';
  return 'VALIDATION';
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Babysteps platform request timed out.'), { isTimeout: true })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sendWithPolicy(transport, requestEnvelope, operation) {
  const maxAttempts = Math.max(1, operation.retry?.maxAttempts ?? 1);
  const timeoutMs = operation.retry?.timeoutMs ?? 5000;
  const retryableStatuses = new Set(operation.retry?.retryableStatuses ?? []);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await withTimeout(transport(requestEnvelope), timeoutMs);
    } catch {
      if (attempt < maxAttempts) continue;
      throw new ApiClientError('API_REQUEST_TIMEOUT', 'Babysteps platform request timed out.', { category: 'TIMEOUT' });
    }

    if (response.status >= 400) {
      if (retryableStatuses.has(response.status) && attempt < maxAttempts) continue;
      const category = categorizeStatus(response.status);
      throw new ApiClientError(`API_${category}_ERROR`, 'Babysteps platform returned an error response.', { category, status: response.status });
    }

    return response;
  }

  throw new ApiClientError('API_REQUEST_TIMEOUT', 'Babysteps platform request timed out.', { category: 'TIMEOUT' });
}

export function createBabystepsApiClient({
  baseUrl,
  contractVersion,
  transport,
  authProvider,
  runtimeBinding,
  operations,
  onTelemetry = () => {},
  clock = () => Date.now(),
}) {
  if (typeof transport !== 'function') throw new TypeError('A transport function is required to create the Babysteps API client.');
  if (typeof authProvider !== 'function') throw new TypeError('An authProvider function is required to create the Babysteps API client.');

  async function call(operationName, payload = {}) {
    const startedAt = clock();
    const identity = getRuntimeContext(runtimeBinding);

    const operation = operations?.[operationName];
    if (!operation) {
      throw new ApiClientError('API_OPERATION_NOT_ALLOWED', `Babysteps API operation is not allowed: ${operationName}`, { category: 'VALIDATION' });
    }

    let scoped;
    try {
      scoped = scopeAuthorityRequest(runtimeBinding, payload);
    } catch (error) {
      const category = error instanceof RuntimeBindingError ? error.code : 'RUNTIME_CONTEXT_INVALID';
      throw new ApiClientError('API_AUTHORITY_MISMATCH', 'Caller-supplied authoritative identifiers do not match the bound runtime.', { category: 'VALIDATION', cause: category });
    }

    const authorityFields = operation.authorityFields ?? [];
    const body = { ...payload };
    for (const field of AUTHORITY_FIELDS) delete body[field];
    for (const field of authorityFields) body[field] = scoped[field];

    const requestId = randomUUID();
    const headers = {
      'X-Babysteps-Contract-Version': contractVersion,
      'X-Request-Id': requestId,
      'X-Correlation-Id': identity.correlationId,
      Authorization: `Bearer ${await authProvider()}`,
      ...(operation.idempotent ? { 'Idempotency-Key': requestId } : {}),
    };

    const requestEnvelope = Object.freeze({
      method: operation.method,
      url: `${baseUrl}${operation.path}`,
      headers: Object.freeze(headers),
      body: Object.freeze(body),
    });

    const emitTelemetry = (category) => onTelemetry(Object.freeze({
      event: category === 'SUCCESS' ? 'api_request_completed' : 'api_request_failed',
      operation: operationName,
      correlationId: identity.correlationId,
      requestId,
      durationMs: clock() - startedAt,
      category,
    }));

    let response;
    try {
      response = await sendWithPolicy(transport, requestEnvelope, operation);
    } catch (error) {
      emitTelemetry(error instanceof ApiClientError ? error.metadata.category : 'UNKNOWN');
      throw error;
    }

    let parsed;
    try {
      parsed = operation.parseResponse(response.body);
    } catch (error) {
      emitTelemetry(error?.metadata?.category ?? 'VALIDATION');
      throw error;
    }
    if (!parsed || parsed.ok !== true) {
      emitTelemetry('VALIDATION');
      throw new ApiClientError('API_RESPONSE_INVALID', 'Babysteps platform response failed contract validation.', { category: 'VALIDATION' });
    }

    emitTelemetry('SUCCESS');
    return parsed.data;
  }

  return Object.freeze({ call });
}
