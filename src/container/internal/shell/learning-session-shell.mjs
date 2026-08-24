import { getRuntimeContext } from '../runtime/authorized-runtime-identity.mjs';

export class LearningSessionShellError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'LearningSessionShellError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new LearningSessionShellError(code, message, metadata); }

const CONNECTIVITY_STATES = new Set(['ONLINE', 'OFFLINE']);
const MOUNTED_SHELLS = new WeakMap();

// The shared shell standardizes only runtime-level presentation (status, connectivity,
// common exit/end). Whatever the app hands in as learningView is opaque and unowned by
// the shell — it is never inspected, validated, or laid out here.
export function mountLearningSessionShell({
  readiness,
  runtimeBinding,
  lifecycle,
  completion,
  connectedTime = null,
  learningView = null,
  onTelemetry = () => {},
}) {
  if (!readiness || readiness.ok !== true || readiness.phase !== 'READY') {
    fail('SHELL_RUNTIME_NOT_READY', 'The shared learning session shell cannot mount before container bootstrap reaches READY.');
  }
  if (!lifecycle || typeof lifecycle.signal !== 'function') {
    fail('SHELL_CONTRACT_INVALID', 'A session lifecycle facade is required to mount the shared shell.');
  }
  if (!completion || typeof completion.complete !== 'function') {
    fail('SHELL_CONTRACT_INVALID', 'An SR-004 completion handler is required to mount the shared shell.');
  }

  const existing = MOUNTED_SHELLS.get(runtimeBinding);
  if (existing) return existing;

  const identity = getRuntimeContext(runtimeBinding);

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({
      event,
      sessionId: identity.sessionId,
      correlationId: identity.correlationId,
      ...extra,
    }));
  }

  let currentView = learningView;
  let connectivity = 'ONLINE';

  function status() {
    return Object.freeze({
      lifecycleState: lifecycle.state,
      connectedSeconds: connectedTime ? connectedTime.connectedSeconds() : null,
      connectivity,
      ended: lifecycle.state === 'ENDED',
    });
  }

  function getLearningView() { return currentView; }
  function setLearningView(nextView) { currentView = nextView; }

  function setConnectivity(nextState) {
    if (!CONNECTIVITY_STATES.has(nextState)) {
      fail('SHELL_INVALID_CONNECTIVITY_STATE', 'Connectivity state must be "ONLINE" or "OFFLINE".', { requested: nextState });
    }
    if (nextState === connectivity) return { changed: false };
    connectivity = nextState;
    emit(nextState === 'OFFLINE' ? 'shell_connectivity_lost' : 'shell_connectivity_restored');
    return { changed: true };
  }

  async function requestExit(domainPayload = {}) {
    emit('shell_common_control_activated', { action: 'exit' });
    try {
      return await completion.complete(domainPayload);
    } catch (error) {
      emit('shell_common_control_failed', { action: 'exit', category: error?.code ?? 'UNKNOWN' });
      throw error;
    }
  }

  const shell = Object.freeze({
    status,
    getLearningView,
    setLearningView,
    connectivityState: () => connectivity,
    setConnectivity,
    requestExit,
  });

  MOUNTED_SHELLS.set(runtimeBinding, shell);
  emit('shell_mounted');
  return shell;
}
