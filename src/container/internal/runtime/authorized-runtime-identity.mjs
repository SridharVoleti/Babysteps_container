const AUTHORITY_FIELDS = ['learnerId', 'appId', 'releaseId', 'sessionId'];

export class RuntimeBindingError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'RuntimeBindingError';
    this.code = code;
    this.metadata = Object.freeze({ ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new RuntimeBindingError(code, message, metadata); }

const RUNTIME_STATE = new WeakMap();

export function bindAuthorizedRuntime(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== 'object') {
    fail('RUNTIME_CONTEXT_INVALID', 'A validated runtime context is required to bind runtime authority.');
  }
  for (const field of AUTHORITY_FIELDS) {
    if (typeof runtimeContext[field] !== 'string' || runtimeContext[field].trim() === '') {
      fail('RUNTIME_CONTEXT_INVALID', `Runtime context is missing authoritative field: ${field}`);
    }
  }

  const identity = Object.freeze({
    learnerId: runtimeContext.learnerId,
    appId: runtimeContext.appId,
    releaseId: runtimeContext.releaseId,
    sessionId: runtimeContext.sessionId,
    launchMode: runtimeContext.launchMode,
    correlationId: runtimeContext.correlationId,
  });

  const binding = Object.freeze({ identity });
  RUNTIME_STATE.set(binding, { active: true });
  return binding;
}

function stateOf(binding) {
  const state = RUNTIME_STATE.get(binding);
  if (!state) fail('RUNTIME_CONTEXT_INVALID', 'Runtime binding is not recognized by this container instance.');
  return state;
}

export function isRuntimeActive(binding) {
  return RUNTIME_STATE.get(binding)?.active === true;
}

function assertActive(binding) {
  const state = stateOf(binding);
  if (!state.active) fail('RUNTIME_CONTEXT_INACTIVE', 'Runtime binding has been terminated and can no longer be used.');
  return state;
}

export function getRuntimeContext(binding) {
  assertActive(binding);
  return binding.identity;
}

export function terminateRuntime(binding) {
  const state = stateOf(binding);
  state.active = false;
  return Object.freeze({ ok: true, terminatedAt: new Date().toISOString() });
}

export function requestAuthorityChange(binding, requestedChange = {}) {
  assertActive(binding);
  fail(
    'RUNTIME_CONTEXT_MUTATION_DENIED',
    'Authorized runtime identity cannot be changed in place. Terminate the runtime and obtain a new Babysteps-authorized launch context.',
    { requestedChange: { ...requestedChange } }
  );
}

export function scopeAuthorityRequest(binding, request = {}) {
  const state = assertActive(binding);
  void state;
  if (!request || typeof request !== 'object') {
    fail('RUNTIME_CONTEXT_INVALID', 'Platform-facing request payload must be an object.');
  }

  const { identity } = binding;
  for (const field of AUTHORITY_FIELDS) {
    if (field in request && request[field] !== undefined && request[field] !== identity[field]) {
      fail('RUNTIME_CONTEXT_MISMATCH', `Caller-supplied ${field} does not match the bound runtime authority.`, { field });
    }
  }

  const { learnerId, appId, releaseId, sessionId, ...rest } = request;
  return Object.freeze({
    learnerId: identity.learnerId,
    appId: identity.appId,
    releaseId: identity.releaseId,
    sessionId: identity.sessionId,
    ...rest,
  });
}

export function createScopedPlatformAdapter(binding, adapter) {
  if (!adapter || typeof adapter !== 'object') {
    fail('RUNTIME_CONTEXT_INVALID', 'A platform adapter is required to create a scoped adapter.');
  }

  const scoped = {};
  for (const [operation, handler] of Object.entries(adapter)) {
    if (typeof handler !== 'function') continue;
    scoped[operation] = async (request = {}) => {
      const scopedRequest = scopeAuthorityRequest(binding, request);
      return handler(scopedRequest);
    };
  }
  return Object.freeze(scoped);
}
