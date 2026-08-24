import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource } from '../../scripts/architecture-rules.mjs';
import { evaluateExtensionNeed } from '../../src/container/internal/extensions/index.mjs';

const clean = "import { defineLearningApp } from '../../src/container/public/index.mjs';\nexport default defineLearningApp({ id: 'demo' });";

test('CC-001-AC01 allows app use of public container interfaces', () => {
  assert.deepEqual(inspectSource('apps/demo/index.mjs', clean), []);
});

test('CC-001-AC02 rejects imports from container-private modules', () => {
  const violations = inspectSource('apps/demo/index.mjs', "import '../../src/container/internal/index.mjs';");
  assert.equal(violations[0]?.code, 'CONTAINER_PRIVATE_IMPORT');
});

test('CC-001-AC03 rejects direct Supabase/database clients in app code', () => {
  const violations = inspectSource('apps/demo/index.mjs', "import { createClient } from '@supabase/supabase-js';");
  assert.equal(violations[0]?.code, 'DIRECT_PLATFORM_DATA_ACCESS');
});

test('CC-001-AC04 rejects app-side platform authority decisions', () => {
  const source = "export function decideEntitlement(subscriptionStatus) { return subscriptionStatus === 'active'; }";
  const violations = inspectSource('apps/demo/entitlement.mjs', source);
  assert.equal(violations[0]?.code, 'PLATFORM_AUTHORITY_REIMPLEMENTATION');
});

test('CC-001-P1 a class method or object-literal method under a matching name cannot bypass detection by declaration style alone', () => {
  const classMethod = inspectSource(
    'apps/demo/entitlement-class.mjs',
    "export class Foo { decideEntitlement(subscriptionStatus) { return subscriptionStatus === 'active'; } }"
  );
  assert.ok(classMethod.some((v) => v.code === 'PLATFORM_AUTHORITY_REIMPLEMENTATION'));

  const objectMethod = inspectSource(
    'apps/demo/entitlement-object.mjs',
    "export default { decideEntitlement(subscriptionStatus) { return subscriptionStatus === 'active'; } };"
  );
  assert.ok(objectMethod.some((v) => v.code === 'PLATFORM_AUTHORITY_REIMPLEMENTATION'));

  const arrowProperty = inspectSource(
    'apps/demo/entitlement-arrow.mjs',
    "export const helpers = { decideEntitlement: (subscriptionStatus) => subscriptionStatus === 'active' };"
  );
  assert.ok(arrowProperty.some((v) => v.code === 'PLATFORM_AUTHORITY_REIMPLEMENTATION'));
});

test('CC-001-P1 renaming the wrapping function to unrelated vocabulary (canStartLearning, allowedNow) does not evade detection when it still reads raw entitlement/credit state', () => {
  const renamed = inspectSource(
    'apps/demo/can-start-learning.mjs',
    "export function canStartLearning(user) { return user.subscriptionStatus === 'active' && user.creditsRemaining > 0; }"
  );
  assert.ok(renamed.some((v) => v.code === 'PLATFORM_AUTHORITY_RAW_STATE_ACCESS'));

  const renamedArrow = inspectSource(
    'apps/demo/allowed-now.mjs',
    "export const allowedNow = (session) => session.sessionCreditBalance >= 1;"
  );
  assert.ok(renamedArrow.some((v) => v.code === 'PLATFORM_AUTHORITY_RAW_STATE_ACCESS'));
});

test('CC-001-P1 consuming an already-computed container decision (not raw state) is not flagged', () => {
  const clean = inspectSource(
    'apps/demo/uses-decision.mjs',
    "export function renderLesson(entitled) { if (entitled) { return 'lesson'; } return 'locked'; }"
  );
  assert.equal(clean.some((v) => v.code === 'PLATFORM_AUTHORITY_RAW_STATE_ACCESS'), false);
  assert.equal(clean.some((v) => v.code === 'PLATFORM_AUTHORITY_REIMPLEMENTATION'), false);
});

test('CC-001 boundary checks do not inspect container-owned implementation as app code', () => {
  const source = "export function decideEntitlement(subscriptionStatus) { return subscriptionStatus === 'active'; }";
  assert.deepEqual(inspectSource('src/container/internal/entitlement.mjs', source), []);
});

test('CC-001-AC05 an unsupported reusable container need resolves to the approved governance request path, not a private workaround', () => {
  const reusable = evaluateExtensionNeed({ need: 'shared retry/backoff policy', classification: 'reusable-container-capability' });
  assert.equal(reusable.approved, false);
  assert.equal(reusable.action, 'REQUEST_CONTAINER_CAPABILITY_APPROVAL');
});

test('CC-001-AC05 an app-specific need resolves only to an approved extension mechanism or an approval request, never a fork', () => {
  const unapproved = evaluateExtensionNeed({ need: 'custom scoring visualization', classification: 'app-specific' });
  assert.equal(unapproved.approved, false);
  assert.equal(unapproved.action, 'REQUEST_EXTENSION_POINT_APPROVAL');
  assert.equal(JSON.stringify(unapproved).toLowerCase().includes('fork'), false);
});

test('CC-001-AC05 fork/copy/monkey-patch workarounds require reaching container-private modules and are rejected by the architecture gate', () => {
  const forkAttempt = inspectSource(
    'apps/demo/forked-core.mjs',
    "import { createSessionLifecycle } from '../../src/container/internal/session/session-lifecycle.mjs';\n" +
      "// copied/forked container core to monkey-patch around an unsupported need instead of requesting approval\n" +
      'createSessionLifecycle.prototype.hack = () => {};'
  );
  assert.equal(forkAttempt.some((v) => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);
});
