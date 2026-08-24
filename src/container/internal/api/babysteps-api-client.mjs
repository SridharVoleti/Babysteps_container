import { scopeAuthorityRequest, getRuntimeContext, RuntimeBindingError } from '../runtime/authorized-runtime-identity.mjs';
import { createRetryPolicy } from '../runtime/connectivity-service.mjs';

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
    timer = setTimeout(() => reject(new ApiClientError('API_REQUEST_TIMEOUT', 'Babysteps platform request timed out.', { category: 'TIMEOUT' })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ER-002-P1: transport retry/backoff/failure-classification has exactly one implementation
// in production runtime - ER-002's createRetryPolicy/classifyRetry (connectivity-service.mjs).
// This module has no competing retry loop of its own; it only decides per-call timeout and
// whether an operation is retryable at all. `inFlightKey` is unique per call (not just per
// operation name) so unrelated concurrent calls to the same operation are never coalesced
// into one shared attempt by the policy's in-flight dedup - only repeated attempts of the
// very same call join the same retry loop.
async function sendWithPolicy(transport, requestEnvelope, operation, retryPolicy, inFlightKey) {
  const timeoutMs = operation.retry?.timeoutMs ?? 5000;
  const retryable = Boolean(operation.retry);

  async function attempt() {
    const response = await withTimeout(transport(requestEnvelope), timeoutMs);
    if (response.status >= 400) {
      const category = categorizeStatus(response.status);
      throw new ApiClientError(`API_${category}_ERROR`, 'Babysteps platform returned an error response.', { category, status: response.status });
    }
    return response;
  }

  return retryPolicy.executeWithRetry({ operation: inFlightKey, retryable }, attempt);
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
  // ER-002-P1: the single authoritative transport retry policy this client delegates to.
  // A caller may inject its own (e.g. to share one policy/teardown across several
  // container services), but by default each client owns a private instance so unrelated
  // clients never dedupe/coalesce each other's in-flight attempts.
  retryPolicy = createRetryPolicy({ sleep: () => Promise.resolve() }),
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

    // ER-002/PA-003: X-Request-Id identifies this exact HTTP attempt (always fresh, purely
    // for tracing). The Idempotency-Key header is the platform's retry identity and must
    // stay the same across every attempt/retry/recovery of the same logical checkpoint - so
    // when the caller (e.g. PA-003's recovery adapter) supplies a stable logical
    // idempotencyKey on the payload, that value becomes the transport header verbatim
    // instead of a fresh UUID being generated per call.
    const requestId = crypto.randomUUID();
    const logicalIdempotencyKey = typeof payload.idempotencyKey === 'string' && payload.idempotencyKey.trim() !== ''
      ? payload.idempotencyKey
      : requestId;
    const headers = {
      'X-Babysteps-Contract-Version': contractVersion,
      'X-Request-Id': requestId,
      'X-Correlation-Id': identity.correlationId,
      Authorization: `Bearer ${await authProvider()}`,
      ...(operation.idempotent ? { 'Idempotency-Key': logicalIdempotencyKey } : {}),
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
      response = await sendWithPolicy(transport, requestEnvelope, operation, retryPolicy, `${operationName}:${requestId}`);
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
