import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootstrapLearningApp, BootstrapError } from '../../src/container/internal/bootstrap/atomic-bootstrap.mjs';
import { defineLearningApp } from '../../src/container/public/index.mjs';

function manifestFixture(overrides = {}) {
  return {
    appId: 'magical-math',
    appVersion: '1.0.0',
    containerContractVersion: '1.0',
    contentVersion: '1.0.0',
    progressSchemaVersion: '1.0',
    requiredCapabilities: ['progress'],
    optionalCapabilities: [],
    entryPoint: './index.mjs',
    ...overrides,
  };
}

const manifestOptions = Object.freeze({ supportedContractVersions: ['1.0'], approvedExtensionPoints: [] });

const baseClaims = Object.freeze({
  learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1'
});
const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
const envelope = (claims = baseClaims) => ({ claims: structuredClone(claims), proof: proof(claims) });
const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });
const launchOptions = Object.freeze({ expectedReleaseId: 'release-1', expectedSessionId: 'session-1', verifier, now: () => new Date('2026-08-18T00:10:00.000Z') });

const progressAdapter = Object.freeze({ progress: { version: '1.0', write: async () => 'ok' } });

function baseOptions(overrides = {}) {
  return {
    manifestPath: '/tmp/apps/magical-math/app.manifest.json',
    readManifestText: async () => JSON.stringify(manifestFixture()),
    manifestOptions,
    launchContext: envelope(),
    launchOptions,
    capabilityAdapters: progressAdapter,
    coreServices: [],
    ...overrides,
  };
}

function loadModuleTracker(appId = 'magical-math') {
  let executed = false;
  const loadModule = async () => { executed = true; return { default: defineLearningApp({ id: appId }) }; };
  return { loadModule, wasExecuted: () => executed };
}

test('SB-001-P0 the valid authorized path launches end to end and returns the bound app definition', async () => {
  const { loadModule, wasExecuted } = loadModuleTracker();
  const { readiness, appDefinition } = await bootstrapLearningApp({ ...baseOptions(), loadModule });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.phase, 'READY');
  assert.equal(appDefinition.id, 'magical-math');
  assert.equal(wasExecuted(), true);
});

test('SB-001-P0 missing/invalid authorization prevents any observable app-module import', async () => {
  const { loadModule, wasExecuted } = loadModuleTracker();
  const expiredClaims = { ...baseClaims, expiresAt: '2026-08-18T00:05:00.000Z' };
  await assert.rejects(
    () => bootstrapLearningApp({ ...baseOptions({ launchContext: envelope(expiredClaims) }), loadModule }),
    (e) => e instanceof BootstrapError && e.phase === 'VALIDATE_LAUNCH' && e.metadata.category === 'LAUNCH_CONTEXT_EXPIRED'
  );
  assert.equal(wasExecuted(), false);
});

test('SB-001-P0 an incompatible manifest prevents any observable app-module import', async () => {
  const { loadModule, wasExecuted } = loadModuleTracker();
  await assert.rejects(
    () => bootstrapLearningApp({
      ...baseOptions({ readManifestText: async () => JSON.stringify(manifestFixture({ containerContractVersion: '9.9' })) }),
      loadModule,
    }),
    (e) => e instanceof BootstrapError && e.phase === 'LOAD_MANIFEST'
  );
  assert.equal(wasExecuted(), false);
});

test('SB-001-P0 an unavailable required capability prevents any observable app-module import', async () => {
  const { loadModule, wasExecuted } = loadModuleTracker();
  await assert.rejects(
    () => bootstrapLearningApp({ ...baseOptions({ capabilityAdapters: {} }), loadModule }),
    (e) => e instanceof BootstrapError && e.phase === 'RESOLVE_CAPABILITIES'
  );
  assert.equal(wasExecuted(), false);
});

test('SB-001-P0 an app module whose identity does not match the authorized manifest fails closed', async () => {
  const { loadModule } = loadModuleTracker('a-different-app');
  await assert.rejects(
    () => bootstrapLearningApp({ ...baseOptions(), loadModule }),
    (e) => e instanceof BootstrapError && e.phase === 'LOAD_APP_PACKAGE' && e.metadata.category === 'APP_IDENTITY_MISMATCH'
  );
});

test('CC-003/SP-001/SP-003-P0 bootstrapLearningApp applies the structural closed-runtime lockdown before app code ever imports', async () => {
  const { loadModule } = loadModuleTracker();
  const lockdownTarget = {
    fetch: () => 'real-fetch',
    open: () => 'real-open',
    navigator: { mediaDevices: {}, geolocation: { getCurrentPosition: () => {} } },
  };
  let observedAtImportTime = null;
  const observingLoadModule = async () => {
    observedAtImportTime = {
      fetchDenied: (() => { try { lockdownTarget.fetch(); return false; } catch { return true; } })(),
      geolocationDenied: lockdownTarget.navigator.geolocation === undefined,
    };
    return loadModule();
  };

  const { readiness } = await bootstrapLearningApp({ ...baseOptions(), loadModule: observingLoadModule, lockdownTarget });
  assert.equal(readiness.ok, true);
  assert.equal(observedAtImportTime.fetchDenied, true);
  assert.equal(observedAtImportTime.geolocationDenied, true);
});

test('SB-001-P0 loadAppPackage cannot be reached to import app code without an authorized runtime binding, even if called directly', async () => {
  const { loadAppPackage } = await import('../../src/container/internal/manifest/load-app-package.mjs');
  let executed = false;
  const result = await loadAppPackage('/tmp/apps/magical-math/app.manifest.json', manifestOptions, {
    readText: async () => JSON.stringify(manifestFixture()),
    loadModule: async () => { executed = true; return { default: defineLearningApp({ id: 'magical-math' }) }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTHORIZATION_REQUIRED');
  assert.equal(executed, false);
});
