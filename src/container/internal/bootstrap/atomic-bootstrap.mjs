import { APPROVED_CAPABILITIES, createCapabilityFacade } from '../capabilities/index.mjs';
import { resolveManifest } from '../manifest/index.mjs';
import { validateLaunchContext, LaunchContextError } from './launch-context.mjs';
import { bindAuthorizedRuntime, getRuntimeContext, RuntimeBindingError } from '../runtime/authorized-runtime-identity.mjs';

export class BootstrapError extends Error {
  constructor(code, message, { phase, ...metadata } = {}) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
    this.phase = phase;
    this.metadata = Object.freeze({ ...metadata });
    Object.freeze(this);
  }
}

async function disposeAll(initialized) {
  for (const entry of [...initialized].reverse()) {
    if (typeof entry.dispose === 'function') {
      try { await entry.dispose(); } catch { /* best-effort transient cleanup */ }
    }
  }
}

export async function runAtomicBootstrap({
  manifestInput,
  manifestOptions = {},
  launchContext,
  launchOptions = {},
  capabilityAdapters = {},
  approvedFallbacks = {},
  coreServices = [],
  idempotencyKey = null,
  ledger = new Map(),
  bindRuntime = bindAuthorizedRuntime,
  clock = () => Date.now(),
}) {
  const startedAt = clock();
  let correlationId = null;
  const fail = (code, message, metadata = {}) => {
    throw new BootstrapError(code, message, { ...metadata, correlationId, durationMs: clock() - startedAt });
  };

  const manifestResolution = resolveManifest(manifestInput, {
    ...manifestOptions,
    availableCapabilities: manifestOptions.availableCapabilities ?? APPROVED_CAPABILITIES,
  });
  if (!manifestResolution.ok) {
    const code = manifestResolution.error.code === 'CONTAINER_VERSION_UNSUPPORTED' ? 'BOOTSTRAP_INCOMPATIBLE' : 'BOOTSTRAP_REQUIRED_DEPENDENCY_FAILED';
    fail(code, 'Bootstrap could not load a valid app manifest.', { phase: 'LOAD_MANIFEST', category: manifestResolution.error.code });
  }
  const manifest = manifestResolution.manifest;

  let runtimeContext;
  try {
    runtimeContext = await validateLaunchContext({ launchContext, manifest, ...launchOptions });
  } catch (error) {
    const category = error instanceof LaunchContextError ? error.code : 'LAUNCH_CONTEXT_INVALID';
    fail('BOOTSTRAP_REQUIRED_DEPENDENCY_FAILED', 'Bootstrap could not validate the authorized launch context.', { phase: 'VALIDATE_LAUNCH', category });
  }
  correlationId = runtimeContext.correlationId;

  let binding;
  try {
    binding = bindRuntime(runtimeContext);
  } catch (error) {
    const category = error instanceof RuntimeBindingError ? error.code : 'RUNTIME_CONTEXT_INVALID';
    fail('BOOTSTRAP_REQUIRED_DEPENDENCY_FAILED', 'Bootstrap could not bind the authorized runtime.', { phase: 'BIND_RUNTIME', category });
  }

  const facade = createCapabilityFacade({ manifest, adapters: capabilityAdapters });
  for (const name of manifest.requiredCapabilities) {
    if (!facade.has(name)) {
      fail('BOOTSTRAP_CAPABILITY_UNAVAILABLE', `Required capability unavailable: ${name}`, { phase: 'RESOLVE_CAPABILITIES', capability: name, required: true });
    }
  }
  const degradedCapabilities = [];
  for (const name of manifest.optionalCapabilities) {
    if (facade.has(name)) continue;
    if (name in approvedFallbacks) {
      degradedCapabilities.push(name);
      continue;
    }
    fail('BOOTSTRAP_CAPABILITY_UNAVAILABLE', `Optional capability unavailable with no approved fallback: ${name}`, { phase: 'RESOLVE_CAPABILITIES', capability: name, required: false });
  }

  const initializedThisAttempt = [];
  const activeServices = [];
  try {
    for (const service of coreServices) {
      const ledgerKey = idempotencyKey ? `${idempotencyKey}:${service.name}` : null;
      if (ledgerKey && ledger.get(ledgerKey)?.done) {
        activeServices.push(service.name);
        continue;
      }
      let dispose;
      try {
        dispose = await service.init({ manifest, runtime: getRuntimeContext(binding), capabilities: facade });
      } catch {
        fail('BOOTSTRAP_SERVICE_INIT_FAILED', `Mandatory container service failed to initialize: ${service.name}`, { phase: 'INIT_CORE_SERVICES', service: service.name });
      }
      initializedThisAttempt.push({ name: service.name, dispose });
      activeServices.push(service.name);
      if (ledgerKey && typeof dispose !== 'function') {
        ledger.set(ledgerKey, { done: true });
      }
    }
  } catch (error) {
    await disposeAll(initializedThisAttempt);
    throw error;
  }

  return Object.freeze({
    ok: true,
    phase: 'READY',
    manifest,
    runtime: binding,
    capabilities: facade,
    degradedCapabilities: Object.freeze(degradedCapabilities),
    services: Object.freeze(activeServices),
    correlationId,
    durationMs: clock() - startedAt,
  });
}

export async function bootstrapReadyApp({ loadApp, ...bootstrapOptions }) {
  const readiness = await runAtomicBootstrap(bootstrapOptions);
  if (typeof loadApp !== 'function') {
    throw new BootstrapError('BOOTSTRAP_REQUIRED_DEPENDENCY_FAILED', 'Application loader is unavailable.', { phase: 'READY', correlationId: readiness.correlationId, durationMs: readiness.durationMs });
  }
  const app = await loadApp(readiness);
  return Object.freeze({ readiness, app });
}
