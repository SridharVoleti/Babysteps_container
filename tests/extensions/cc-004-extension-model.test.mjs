import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionManager, ExtensionError, evaluateExtensionNeed } from '../../src/container/internal/extensions/index.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

const manifest = Object.freeze({ appId: 'magical-math', extensionPoints: ['activity-renderer'] });
const approved = Object.freeze({ 'activity-renderer': ['1.0'] });

function extension(overrides = {}) {
  return { type: 'activity-renderer', version: '1.0', id: 'vedic-card', initialize: async () => ({ dispose() {} }), ...overrides };
}

test('CC-004-AC01 approved compatible extension loads through lifecycle', async () => {
  const manager = createExtensionManager({ manifest, approvedExtensionContracts: approved });
  const result = await manager.register(extension());
  assert.equal(result.ok, true);
  assert.equal(manager.list().length, 1);
});

test('CC-004-AC02 unknown or unapproved extension type is rejected before execution', async () => {
  let executed = false;
  const manager = createExtensionManager({ manifest, approvedExtensionContracts: approved });
  await assert.rejects(() => manager.register(extension({ type: 'unknown', initialize: async () => { executed = true; } })), e => e.code === 'EXTENSION_NOT_APPROVED');
  assert.equal(executed, false);
});

test('CC-004-AC03 incompatible extension contract version is rejected stably', async () => {
  const manager = createExtensionManager({ manifest, approvedExtensionContracts: approved });
  await assert.rejects(() => manager.register(extension({ version: '9.9' })), e => e.code === 'EXTENSION_VERSION_UNSUPPORTED');
});

test('CC-004-AC04 private container import fails extension boundary validation', () => {
  const violations = inspectSource('apps/magical-math/extensions/card.mjs', "import '../../src/container/internal/extensions/index.mjs'");
  assert.equal(violations.some(v => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);
});

test('CC-004-AC05 repeated initialization is idempotent', async () => {
  let count = 0;
  const manager = createExtensionManager({ manifest, approvedExtensionContracts: approved });
  const ext = extension({ initialize: async () => { count += 1; return {}; } });
  await manager.register(ext); await manager.register(ext);
  assert.equal(count, 1);
  assert.equal(manager.list().length, 1);
});

test('CC-004-AC06 runtime error is contained and normalized without corrupting manager', async () => {
  const manager = createExtensionManager({ manifest, approvedExtensionContracts: approved });
  await assert.rejects(() => manager.register(extension({ initialize: async () => { throw new Error('private db details'); } })), e => {
    assert.equal(e instanceof ExtensionError, true);
    assert.equal(e.code, 'EXTENSION_INITIALIZATION_FAILED');
    assert.equal(e.message.includes('private db details'), false);
    return true;
  });
  assert.deepEqual(manager.list(), []);
});

test('CC-004-AC07 unsupported need requires explicit governance approval and never recommends fork', () => {
  const denied = evaluateExtensionNeed({ need: 'new visualization', classification: 'app-specific' });
  assert.equal(denied.approved, false);
  assert.equal(denied.action, 'REQUEST_EXTENSION_POINT_APPROVAL');
  assert.equal(JSON.stringify(denied).toLowerCase().includes('fork'), false);
  const approvedNeed = evaluateExtensionNeed({ need: 'new visualization', classification: 'app-specific', approval: { approvedBy: 'architecture-board', decisionId: 'EXT-001' } });
  assert.equal(approvedNeed.approved, true);
});
