export class RuntimeCapabilityError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'RuntimeCapabilityError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new RuntimeCapabilityError(code, message, metadata); }

const VALID_STATUSES = new Set(['AVAILABLE', 'UNAVAILABLE', 'DEGRADED', 'UNKNOWN']);

// AM-003/DR-001: microphone/speech-input is a baseline required capability for every final
// Babysteps app, independent of any app-declared requiredCapabilities.
export const BASELINE_REQUIRED_CAPABILITY = 'microphone-stt';

// DR-001: Microsoft Edge is the reference browser, but readiness is decided by probing
// actual technical capability - never by trusting browser-name identity alone. Probes are
// injected so browser/OS differences stay isolated behind adapters instead of being
// hard-coded per app (DR-001-AC05/AC06).
export function createRuntimeCapabilityService({
  probes = {},
  requiredCapabilities = [],
  optionalCapabilities = [],
  approvedDegradedCapabilities = [],
  onTelemetry = () => {},
}) {
  const required = Object.freeze([...new Set([BASELINE_REQUIRED_CAPABILITY, ...requiredCapabilities])]);
  const optional = Object.freeze([...new Set(optionalCapabilities)]);
  let evaluation = null;

  function emit(event, extra = {}) {
    onTelemetry(Object.freeze({ event, ...extra }));
  }

  async function probeOne(name) {
    const probe = probes[name];
    if (typeof probe !== 'function') {
      emit('capability_probe_failed', { capability: name, reason: 'NO_PROBE_CONFIGURED' });
      return Object.freeze({ status: 'UNKNOWN', reason: 'NO_PROBE_CONFIGURED' });
    }
    let result;
    try {
      result = await probe();
    } catch (error) {
      emit('capability_probe_failed', { capability: name, reason: 'CAPABILITY_PROBE_FAILED' });
      return Object.freeze({ status: 'UNKNOWN', reason: 'CAPABILITY_PROBE_FAILED', cause: error?.message });
    }
    if (!result || !VALID_STATUSES.has(result.status)) {
      emit('capability_probe_failed', { capability: name, reason: 'CAPABILITY_PROBE_FAILED' });
      return Object.freeze({ status: 'UNKNOWN', reason: 'CAPABILITY_PROBE_FAILED' });
    }
    emit('capability_probe_result', { capability: name, status: result.status });
    return Object.freeze({ status: result.status, reason: result.reason ?? null });
  }

  async function evaluate() {
    if (evaluation) return evaluation;

    const names = [...new Set([...required, ...optional])];
    const results = new Map();
    for (const name of names) {
      results.set(name, await probeOne(name));
    }

    const missingRequired = required.filter((name) => results.get(name)?.status !== 'AVAILABLE');
    const degradedOptional = optional.filter((name) => results.get(name)?.status !== 'AVAILABLE');
    const unapprovedDegraded = degradedOptional.filter((name) => !approvedDegradedCapabilities.includes(name));

    evaluation = Object.freeze({
      results,
      missingRequired: Object.freeze(missingRequired),
      degradedOptional: Object.freeze(degradedOptional),
      unapprovedDegraded: Object.freeze(unapprovedDegraded),
    });
    return evaluation;
  }

  async function ready() {
    const result = await evaluate();
    if (result.missingRequired.length > 0) {
      fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'A required runtime capability is unavailable in this environment.', {
        capabilities: result.missingRequired,
      });
    }
    if (result.unapprovedDegraded.length > 0) {
      fail('OPTIONAL_CAPABILITY_DEGRADED', 'An optional capability is unavailable and has no approved degraded behavior.', {
        capabilities: result.unapprovedDegraded,
      });
    }
    return Object.freeze({ ok: true, degradedCapabilities: result.degradedOptional });
  }

  function statusOf(name) {
    if (!evaluation) fail('CAPABILITY_PROBE_FAILED', 'Capabilities must be evaluated before they can be queried.');
    return evaluation.results.get(name)?.status ?? 'UNKNOWN';
  }

  function isAvailable(name) {
    return statusOf(name) === 'AVAILABLE';
  }

  function require(name) {
    if (!isAvailable(name)) {
      fail('REQUIRED_CAPABILITY_UNAVAILABLE', `Required runtime capability is unavailable: ${name}`, { capabilities: [name] });
    }
    return true;
  }

  return Object.freeze({
    evaluate,
    ready,
    require,
    isAvailable,
    statusOf,
    requiredCapabilities: required,
    optionalCapabilities: optional,
  });
}

// SB-003 bootstrap integration: usable as a `coreServices` entry for runAtomicBootstrap so
// capability readiness is enforced as part of the mandatory bootstrap path, not an optional
// step apps might skip.
export function createRuntimeCapabilityBootstrapService(serviceOptions) {
  const service = createRuntimeCapabilityService(serviceOptions);
  return {
    name: 'runtime-capability-probe',
    async init() {
      await service.ready();
      return undefined;
    },
    service,
  };
}
