import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityFacade, CapabilityError } from '../../src/container/internal/capabilities/index.mjs';
import { getCapability } from '../../src/container/public/capabilities.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

const manifest = Object.freeze({
  appId: 'magical-math',
  appVersion: '1.0.0',
  requiredCapabilities: ['progress'],
  optionalCapabilities: ['audio'],
});

function adapterSet(overrides = {}) {
  return {
    progress: Object.freeze({
      version: '1.0',
      save: async (payload) => ({ ok: true, payload }),
    }),
    audio: Object.freeze({ version: '1.0', play: async () => ({ ok: true }) }),
    ...overrides,
  };
}

test('CC-003-AC01 approved declared capability is supplied through public typed contract', async () => {
  const facade = createCapabilityFacade({ manifest, adapters: adapterSet() });
  const progress = getCapability(facade, 'progress');
  assert.equal(progress.version, '1.0');
  assert.deepEqual(await progress.save({ checkpoint: 3 }), { ok: true, payload: { checkpoint: 3 } });
});

test('CC-003-AC02 undeclared or unapproved capability is denied with normalized error', () => {
  const facade = createCapabilityFacade({ manifest, adapters: adapterSet({ billing: { charge() {} } }) });
  assert.throws(() => getCapability(facade, 'billing'), (error) => {
    assert.equal(error instanceof CapabilityError, true);
    assert.equal(error.code, 'CAPABILITY_NOT_DECLARED');
    return true;
  });
});

test('CC-003-AC03 private platform endpoints/imports fail architecture validation', () => {
  const directFetch = inspectSource('apps/magical-math/index.mjs', "fetch('https://api.babysteps.in/internal/billing')");
  const privateImport = inspectSource('apps/magical-math/index.mjs', "import x from '../../src/platform-client/private.mjs'");
  assert.equal(directFetch.some((x) => x.code === 'DIRECT_PLATFORM_PRIVATE_ENDPOINT'), true);
  assert.equal(privateImport.some((x) => x.code === 'DIRECT_PLATFORM_DATA_ACCESS'), true);
});

test('CC-003-AC04 adapter failures are normalized and never provide direct-access fallback', async () => {
  const facade = createCapabilityFacade({
    manifest,
    adapters: adapterSet({ progress: { version: '1.0', save: async () => { throw new Error('db host details'); } } }),
  });
  await assert.rejects(() => getCapability(facade, 'progress').save({ checkpoint: 1 }), (error) => {
    assert.equal(error instanceof CapabilityError, true);
    assert.equal(error.code, 'CAPABILITY_OPERATION_FAILED');
    assert.equal(String(error.message).includes('db host details'), false);
    assert.equal('fallback' in error, false);
    return true;
  });
});

test('CC-003-AC05 app-facing capability boundary exposes no privileged credentials/internals', () => {
  const facade = createCapabilityFacade({
    manifest,
    adapters: adapterSet(),
    privilegedContext: {
      serviceRoleKey: 'secret-service-role',
      rawAccessToken: 'secret-token',
      billingInternal: { providerKey: 'secret-billing' },
      dbCredential: 'postgres://secret',
    },
  });
  const serialized = JSON.stringify(facade);
  assert.equal(serialized.includes('secret-service-role'), false);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('secret-billing'), false);
  assert.equal(serialized.includes('postgres://secret'), false);
  assert.deepEqual(Object.keys(facade), ['get', 'has', 'list']);
});
