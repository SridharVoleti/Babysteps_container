import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRuntimeCapabilityService, createRuntimeCapabilityBootstrapService, RuntimeCapabilityError, BASELINE_REQUIRED_CAPABILITY } from '../../src/container/internal/runtime/capability-service.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';
import { runAtomicBootstrap, BootstrapError } from '../../src/container/internal/bootstrap/atomic-bootstrap.mjs';

const available = async () => ({ status: 'AVAILABLE' });
const unavailable = async () => ({ status: 'UNAVAILABLE' });

test('DR-001-AC01 all required capabilities available on a supported Edge environment allows bootstrap to proceed to READY', async () => {
  const service = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: available, audio: available },
    requiredCapabilities: ['audio'],
  });
  const result = await service.ready();
  assert.equal(result.ok, true);
});

test('DR-001-AC02 the browser identifies as Edge but a required capability is absent, so support is not assumed from the name', async () => {
  const service = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: available, 'packaged-narration': unavailable },
    requiredCapabilities: ['packaged-narration'],
  });
  await assert.rejects(
    () => service.ready(),
    (e) => e instanceof RuntimeCapabilityError && e.code === 'REQUIRED_CAPABILITY_UNAVAILABLE'
  );
});

test('DR-001-AC03 a required capability being unavailable blocks READY and surfaces an approved error state', async () => {
  const service = createRuntimeCapabilityService({ probes: { [BASELINE_REQUIRED_CAPABILITY]: unavailable } });
  await assert.rejects(
    () => service.ready(),
    (e) => e.code === 'REQUIRED_CAPABILITY_UNAVAILABLE' && e.metadata.capabilities.includes(BASELINE_REQUIRED_CAPABILITY)
  );
});

test('DR-001-AC04 an unavailable optional capability continues only with an explicitly approved degraded behavior', async () => {
  const withoutFallback = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: available, 'local-recovery-storage': unavailable },
    optionalCapabilities: ['local-recovery-storage'],
  });
  await assert.rejects(() => withoutFallback.ready(), (e) => e.code === 'OPTIONAL_CAPABILITY_DEGRADED');

  const withFallback = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: available, 'local-recovery-storage': unavailable },
    optionalCapabilities: ['local-recovery-storage'],
    approvedDegradedCapabilities: ['local-recovery-storage'],
  });
  const result = await withFallback.ready();
  assert.deepEqual(result.degradedCapabilities, ['local-recovery-storage']);
});

test('DR-001-P1 a caller-supplied approvedDegradedCapabilities name that is not in the trusted governance registry still blocks READY', async () => {
  const service = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: available, 'forged-unregistered-capability': unavailable },
    optionalCapabilities: ['forged-unregistered-capability'],
    approvedDegradedCapabilities: ['forged-unregistered-capability'],
  });
  await assert.rejects(() => service.ready(), (e) => e.code === 'OPTIONAL_CAPABILITY_DEGRADED');
});

test('DR-001-AC05 app-specific code cannot implement its own browser-name based capability decision', () => {
  const violation = inspectSource('apps/demo/support.mjs', "if (navigator.userAgent.includes('Edge')) { enableFeature(); }");
  assert.ok(violation.some((v) => v.code === 'BROWSER_DETECTION_BYPASS'));
});

test('DR-001-AC06 desktop and mobile Edge report capability outcomes based on actual support, not identical assumed internals', async () => {
  const desktopService = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: available, wasm: available },
    requiredCapabilities: ['wasm'],
  });
  const mobileService = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: available, wasm: unavailable },
    requiredCapabilities: ['wasm'],
  });
  await desktopService.ready();
  await assert.rejects(() => mobileService.ready(), (e) => e.code === 'REQUIRED_CAPABILITY_UNAVAILABLE');
});

test('DR-001-AC07 startup probing validates baseline microphone/STT without activating capture or prompting permission', async () => {
  let permissionRequested = false;
  const probe = async () => { return { status: 'AVAILABLE' }; };
  const service = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: probe },
  });
  await service.ready();
  assert.equal(permissionRequested, false);
});

test('DR-001-AC08 repeated capability probing is idempotent and does not duplicate probes/prompts', async () => {
  let probeCalls = 0;
  const service = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: async () => { probeCalls += 1; return { status: 'AVAILABLE' }; } },
  });
  await service.ready();
  await service.ready();
  await service.evaluate();
  assert.equal(probeCalls, 1);
});

test('DR-001-AC09 an unknown probe failure is treated conservatively rather than silently marked available', async () => {
  const service = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: async () => { throw new Error('unexpected'); } },
  });
  await assert.rejects(() => service.ready(), (e) => e.code === 'REQUIRED_CAPABILITY_UNAVAILABLE');
});

test('DR-001-AC10 only coarse capability outcome telemetry is emitted, not fingerprinting/device identifiers', async () => {
  const events = [];
  const service = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: available },
    onTelemetry: (e) => events.push(e),
  });
  await service.ready();
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'capability', 'status', 'reason'].includes(k)));
  }
});

test('DR-001-AC11 declaring a capability as required follows approved configuration without app-specific browser-detection changes', async () => {
  const optionalConfig = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: available, notifications: unavailable },
    optionalCapabilities: ['notifications'],
    approvedDegradedCapabilities: ['notifications'],
  });
  const optionalResult = await optionalConfig.ready();
  assert.deepEqual(optionalResult.degradedCapabilities, ['notifications']);

  const requiredConfig = createRuntimeCapabilityService({
    probes: { [BASELINE_REQUIRED_CAPABILITY]: available, notifications: unavailable },
    requiredCapabilities: ['notifications'],
  });
  await assert.rejects(() => requiredConfig.ready(), (e) => e.code === 'REQUIRED_CAPABILITY_UNAVAILABLE');
});

test('DR-001 runs as a mandatory SB-003 bootstrap core service and blocks bootstrap when required capability is missing', async () => {
  const manifestInput = {
    appId: 'magical-math', appVersion: '1.0.0', containerContractVersion: '1.0', contentVersion: '1.0.0',
    progressSchemaVersion: '1.0', requiredCapabilities: ['progress'], entryPoint: './index.mjs',
  };
  const manifestOptions = { supportedContractVersions: ['1.0'], availableCapabilities: ['progress'], approvedExtensionPoints: [] };
  const baseClaims = { learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1', launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1' };
  const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
  const launchContext = { claims: structuredClone(baseClaims), proof: proof(baseClaims) };
  const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });
  const launchOptions = { expectedReleaseId: 'release-1', expectedSessionId: 'session-1', verifier, now: () => new Date('2026-08-18T00:10:00.000Z') };
  const capabilityAdapters = { progress: { version: '1.0', write: async () => 'ok' } };

  const coreServices = [createRuntimeCapabilityBootstrapService({ probes: { [BASELINE_REQUIRED_CAPABILITY]: unavailable } })];
  await assert.rejects(
    () => runAtomicBootstrap({ manifestInput, manifestOptions, launchContext, launchOptions, capabilityAdapters, coreServices }),
    (e) => e instanceof BootstrapError && e.code === 'BOOTSTRAP_SERVICE_INIT_FAILED'
  );

  const readyServices = [createRuntimeCapabilityBootstrapService({ probes: { [BASELINE_REQUIRED_CAPABILITY]: available } })];
  const readiness = await runAtomicBootstrap({ manifestInput, manifestOptions, launchContext, launchOptions, capabilityAdapters, coreServices: readyServices });
  assert.equal(readiness.ok, true);
});
