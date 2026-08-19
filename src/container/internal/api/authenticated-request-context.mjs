import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';

const CREDENTIAL_LIKE_KEYS = new Set([
  'token', 'accessToken', 'refreshToken', 'authToken', 'idToken',
  'credential', 'password', 'apiKey', 'secret', 'authorization',
]);

export class AuthContextError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'AuthContextError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function isValidTokenResult(result) {
  return !!result && typeof result.token === 'string' && result.token.length > 0 && typeof result.expiresAt === 'number';
}

export function createAuthenticatedRequestContext({ resolveToken, refreshToken, now = () => Date.now() }) {
  let state = null;
  let inFlight = null;
  let terminated = false;

  function isExpired(current) {
    return !current || current.expiresAt <= now();
  }

  async function getToken() {
    if (terminated) {
      throw new AuthContextError('AUTH_CONTEXT_INVALID', 'Authenticated request context has been terminated.');
    }

    if (!state) {
      let resolved;
      try {
        resolved = await resolveToken();
      } catch {
        throw new AuthContextError('AUTH_CONTEXT_MISSING', 'No authenticated platform context is available.');
      }
      if (!isValidTokenResult(resolved)) {
        throw new AuthContextError('AUTH_CONTEXT_MISSING', 'No authenticated platform context is available.');
      }
      state = resolved;
    }

    if (isExpired(state)) {
      if (!inFlight) {
        inFlight = (async () => {
          try {
            const fresh = await refreshToken();
            if (!isValidTokenResult(fresh)) {
              throw new AuthContextError('REAUTH_REQUIRED', 'Re-authentication is required.');
            }
            state = fresh;
            return fresh;
          } catch (error) {
            state = null;
            throw error instanceof AuthContextError ? error : new AuthContextError('REAUTH_REQUIRED', 'Re-authentication is required.');
          } finally {
            inFlight = null;
          }
        })();
      }
      await inFlight;
    }

    return state.token;
  }

  function invalidate() {
    if (state) state = { token: state.token, expiresAt: -Infinity };
  }

  function terminate() {
    terminated = true;
    state = null;
    inFlight = null;
  }

  return Object.freeze({ getToken, invalidate, terminate });
}

export function createProtectedApiClient({ apiClient, authContext, runtimeBinding, onTelemetry = () => {}, clock = () => Date.now() }) {
  async function call(operationName, payload = {}) {
    const startedAt = clock();
    const correlationId = getRuntimeContext(runtimeBinding).correlationId;
    const emit = (category) => onTelemetry(Object.freeze({
      event: 'auth_protected_call', operation: operationName, correlationId, durationMs: clock() - startedAt, category,
    }));

    for (const key of Object.keys(payload ?? {})) {
      if (CREDENTIAL_LIKE_KEYS.has(key)) {
        emit('AUTH_CONTEXT_INVALID');
        throw new AuthContextError('AUTH_CONTEXT_INVALID', 'Caller-supplied credential is not accepted by this operation.', { field: key });
      }
    }

    try {
      const result = await apiClient.call(operationName, payload);
      emit('SUCCESS');
      return result;
    } catch (error) {
      if (error?.metadata?.category === 'AUTH') {
        authContext.invalidate();
        try {
          await authContext.getToken();
        } catch {
          emit('REAUTH_REQUIRED');
          throw new AuthContextError('REAUTH_REQUIRED', 'Re-authentication is required to complete this operation.');
        }
        try {
          const result = await apiClient.call(operationName, payload);
          emit('SUCCESS');
          return result;
        } catch {
          emit('AUTHORIZATION_DENIED');
          throw new AuthContextError('AUTHORIZATION_DENIED', 'Babysteps platform denied the operation after re-authentication.');
        }
      }
      emit(error instanceof AuthContextError ? error.code : 'UNKNOWN');
      throw error;
    }
  }

  return Object.freeze({ call });
}
