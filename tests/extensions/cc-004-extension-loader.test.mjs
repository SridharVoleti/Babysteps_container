import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadApprovedExtensionModule,
  registerApprovedExtension,
  createExtensionManager,
  ExtensionError,
} from '../../src/container/internal/extensions/index.mjs';

const fixtureUrl = (query) => `${new URL('../fixtures/extensions/side-effect-extension.mjs', import.meta.url).href}?case=${query}`;

function importCount() {
  return globalThis.__CC004_SIDE_EFFECT_EXTENSION_IMPORT_COUNT__ ?? 0;
}

test('CC-004-AC09 an unapproved/unknown extension type is rejected before the module is imported', async () => {
  const before = importCount();
  await assert.rejects(
    () => loadApprovedExtensionModule({ type: 'rogue-extension', version: '1.0', moduleSpecifier: fixtureUrl('denied-type') }),
    (e) => e instanceof ExtensionError && e.code === 'EXTENSION_NOT_APPROVED'
  );
  assert.equal(importCount(), before, 'the module must not have been imported');
});

test('CC-004-AC10 an unsupported extension version is rejected before the module is imported', async () => {
  const before = importCount();
  await assert.rejects(
    () => loadApprovedExtensionModule({ type: 'activity-renderer', version: '9.9', moduleSpecifier: fixtureUrl('denied-version') }),
    (e) => e instanceof ExtensionError && e.code === 'EXTENSION_VERSION_UNSUPPORTED'
  );
  assert.equal(importCount(), before, 'the module must not have been imported');
});

test('CC-004-AC11 an approved type/version loads the module only after validation succeeds', async () => {
  const before = importCount();
  const extension = await loadApprovedExtensionModule({ type: 'activity-renderer', version: '1.0', moduleSpecifier: fixtureUrl('approved') });
  assert.equal(importCount(), before + 1, 'the module must have been imported exactly once');
  assert.equal(extension.type, 'activity-renderer');
  assert.equal(extension.version, '1.0');
});

test('CC-004-AC12 successful approved extensions still initialize idempotently through the manager', async () => {
  const manifest = Object.freeze({ appId: 'magical-math', extensionPoints: ['activity-renderer'] });
  const manager = createExtensionManager({ manifest });
  const args = { type: 'activity-renderer', version: '1.0', moduleSpecifier: fixtureUrl('idempotent') };

  const first = await registerApprovedExtension(manager, args);
  const second = await registerApprovedExtension(manager, args);
  assert.equal(first.ok, true);
  assert.equal(first.alreadyInitialized, false);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyInitialized, true);
  assert.equal(manager.list().length, 1);
});

test('CC-004-AC09 a module that does not actually match its claimed type/version fails closed', async () => {
  await assert.rejects(
    () => loadApprovedExtensionModule({
      type: 'activity-renderer',
      version: '1.0',
      moduleSpecifier: 'ignored',
      loadModule: async () => ({ default: { type: 'activity-renderer', version: '2.0', id: 'x', initialize: async () => {} } }),
    }),
    (e) => e instanceof ExtensionError && e.code === 'EXTENSION_INVALID'
  );
});
