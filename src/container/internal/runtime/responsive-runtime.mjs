export class ResponsiveRuntimeError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ResponsiveRuntimeError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new ResponsiveRuntimeError(code, message, metadata); }

function classifyViewport(width) {
  if (typeof width !== 'number' || !Number.isFinite(width)) return 'UNKNOWN';
  if (width < 600) return 'MOBILE';
  if (width < 1024) return 'TABLET';
  return 'DESKTOP';
}

// DR-002: normalizes technical viewport/orientation/safe-area/input-capability signals only.
// This module never touches SR session state, AH activity identity, AM media runtime or
// progress - responsive changes must never restart, reset or duplicate any of those, so this
// module simply has no reference to them and exposes read-only state instead.
export function createResponsiveRuntime({
  subscribe,
  readViewport,
  readOrientation = () => null,
  readSafeArea = () => null,
  readInputCapability = () => ({}),
  onTelemetry = () => {},
}) {
  if (typeof readViewport !== 'function') {
    fail('RESPONSIVE_RUNTIME_INVALID', 'readViewport is required to create the responsive runtime.');
  }

  let subscribed = false;
  let unsubscribe = null;

  function computeState() {
    const viewport = Object.freeze({ ...readViewport() });
    return Object.freeze({
      viewport,
      viewportClass: classifyViewport(viewport.width),
      orientation: readOrientation() ?? null,
      safeArea: readSafeArea() ? Object.freeze({ ...readSafeArea() }) : null,
      input: Object.freeze({ ...readInputCapability() }),
    });
  }

  let state = computeState();

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({ event, ...extra }));
  }

  function handleChange(reason) {
    state = computeState();
    emit('responsive_state_changed', { reason, viewportClass: state.viewportClass, orientation: state.orientation });
  }

  function start() {
    if (subscribed) return { alreadyStarted: true };
    subscribed = true;
    unsubscribe = typeof subscribe === 'function' ? subscribe((reason = 'RUNTIME_EVENT') => handleChange(reason)) ?? null : null;
    emit('responsive_runtime_started');
    return { started: true };
  }

  function stop() {
    if (!subscribed) return { alreadyStopped: true };
    subscribed = false;
    try {
      unsubscribe?.();
    } catch {
      /* best-effort listener teardown */
    }
    unsubscribe = null;
    emit('responsive_runtime_stopped');
    return { stopped: true };
  }

  return Object.freeze({
    start,
    stop,
    getState: () => state,
    refresh: () => handleChange('MANUAL_REFRESH'),
    isSubscribed: () => subscribed,
  });
}
