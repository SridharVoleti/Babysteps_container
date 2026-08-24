import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionManager, ExtensionError, evaluateExtensionNeed } from '../../src/container/internal/extensions/index.mjs';
import { EXTENSION_CONTRACT_REGISTRY, APPROVED_EXTENSION_POINTS } from '../../src/container/internal/governance/extension-registry.mjs';
import { manifestContract } from '../../src/container/internal/manifest/contract.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

const manifest = Object.freeze({ appId: 'magical-math', extensionPoints: ['activity-renderer'] });

function extension(overrides = {}) {
  return { type: 'activity-renderer', version: '1.0', id: 'vedic-card', initialize: async () => ({ dispose() {} }), ...overrides };
}

test('CC-004-AC01 approved compatible extension loads through lifecycle', async () => {
  const manager = createExtensionManager({ manifest });
  const result = await manager.register(extension());
  assert.equal(result.ok, true);
  assert.equal(manager.list().length, 1);
});

test('CC-004-AC02 unknown or unapproved extension type is rejected before execution', async () => {
  let executed = false;
  const manager = createExtensionManager({ manifest });
  await assert.rejects(() => manager.register(extension({ type: 'unknown', initialize: async () => { executed = true; } })), e => e.code === 'EXTENSION_NOT_APPROVED');
  assert.equal(executed, false);
});

test('CC-004-AC03 incompatible extension contract version is rejected stably', async () => {
  const manager = createExtensionManager({ manifest });
  await assert.rejects(() => manager.register(extension({ version: '9.9' })), e => e.code === 'EXTENSION_VERSION_UNSUPPORTED');
});

test('CC-004-AC04 private container import fails extension boundary validation', () => {
  const violations = inspectSource('apps/magical-math/extensions/card.mjs', "import '../../src/container/internal/extensions/index.mjs'");
  assert.equal(violations.some(v => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);
});

test('CC-004-AC05 repeated initialization is idempotent', async () => {
  let count = 0;
  const manager = createExtensionManager({ manifest });
  const ext = extension({ initialize: async () => { count += 1; return {}; } });
  await manager.register(ext); await manager.register(ext);
  assert.equal(count, 1);
  assert.equal(manager.list().length, 1);
});

test('CC-004-AC06 runtime error is contained and normalized without corrupting manager', async () => {
  const manager = createExtensionManager({ manifest });
  await assert.rejects(() => manager.register(extension({ initialize: async () => { throw new Error('private db details'); } })), e => {
    assert.equal(e instanceof ExtensionError, true);
    assert.equal(e.code, 'EXTENSION_INITIALIZATION_FAILED');
    assert.equal(e.message.includes('private db details'), false);
    return true;
  });
  assert.deepEqual(manager.list(), []);
});

test('CC-004-AC08 extension approval/version authority is the container-owned registry, not a caller-supplied argument', async () => {
  const manager = createExtensionManager({
    manifest,
    // A caller cannot smuggle in an unapproved type/version by supplying its own contract map:
    // createExtensionManager no longer even accepts one, so any such argument is silently ignored.
    approvedExtensionContracts: { 'activity-renderer': ['9.9'], 'rogue-extension': ['1.0'] },
  });
  await assert.rejects(() => manager.register(extension({ version: '9.9' })), (e) => e.code === 'EXTENSION_VERSION_UNSUPPORTED');
  await assert.rejects(
    () => manager.register(extension({ type: 'rogue-extension', version: '1.0' })),
    (e) => e.code === 'EXTENSION_NOT_APPROVED'
  );

  const result = await manager.register(extension());
  assert.equal(result.ok, true);
});

test('CC-004-AC08 manifest validation and extension registration derive approved extension points from the same registry', () => {
  assert.deepEqual(manifestContract.approvedExtensionPoints, APPROVED_EXTENSION_POINTS);
  assert.deepEqual(APPROVED_EXTENSION_POINTS, Object.keys(EXTENSION_CONTRACT_REGISTRY).sort());
});

test('CC-004-AC07 unsupported need requires explicit governance approval and never recommends fork', () => {
  const denied = evaluateExtensionNeed({ need: 'new visualization', classification: 'app-specific' });
  assert.equal(denied.approved, false);
  assert.equal(denied.action, 'REQUEST_EXTENSION_POINT_APPROVAL');
  assert.equal(JSON.stringify(denied).toLowerCase().includes('fork'), false);

  const approvedNeed = evaluateExtensionNeed({
    need: 'activity renderer extension point',
    classification: 'app-specific',
    approval: { approvedBy: 'container-governance-board', decisionId: 'GOV-CC004-ACTIVITY-RENDERER-001' },
  });
  assert.equal(approvedNeed.approved, true);
  assert.equal(approvedNeed.action, 'ADD_APPROVED_EXTENSION_POINT');
});

test('CC-004-AC13 caller-supplied approvedBy/decisionId cannot grant approval by themselves', () => {
  const forgedDecisionId = evaluateExtensionNeed({
    need: 'new visualization',
    classification: 'app-specific',
    approval: { approvedBy: 'container-governance-board', decisionId: 'FORGED-DECISION-999' },
  });
  assert.equal(forgedDecisionId.approved, false);
  assert.equal(forgedDecisionId.action, 'REQUEST_EXTENSION_POINT_APPROVAL');

  // approvedBy claims the trusted authority's name, but the decisionId itself is fabricated.
  const impersonatedApprover = evaluateExtensionNeed({
    need: 'new visualization',
    classification: 'app-specific',
    approval: { approvedBy: 'container-governance-board', decisionId: 'not-a-real-decision' },
  });
  assert.equal(impersonatedApprover.approved, false);
});

test('CC-004-AC13 a real trusted decision cannot be reused to approve a different classification than it was granted for', () => {
  const wrongClassification = evaluateExtensionNeed({
    need: 'shared retry policy',
    classification: 'reusable-container-capability',
    approval: { approvedBy: 'container-governance-board', decisionId: 'GOV-CC004-ACTIVITY-RENDERER-001' },
  });
  assert.equal(wrongClassification.approved, false);
  assert.equal(wrongClassification.action, 'REQUEST_CONTAINER_CAPABILITY_APPROVAL');
});

test('CC-004-AC13 the authoritative registry cannot be mutated at runtime, by an unapproved request or otherwise', () => {
  assert.equal(Object.isFrozen(EXTENSION_CONTRACT_REGISTRY), true);
  const before = Object.keys(EXTENSION_CONTRACT_REGISTRY).length;
  evaluateExtensionNeed({ need: 'x', classification: 'app-specific', approval: { approvedBy: 'attacker', decisionId: 'FAKE' } });
  assert.throws(() => { EXTENSION_CONTRACT_REGISTRY['attacker-type'] = { supportedVersions: ['1.0'] }; }, TypeError);
  assert.equal(Object.keys(EXTENSION_CONTRACT_REGISTRY).length, before);
});
