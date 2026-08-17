import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

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

test('CC-001 boundary checks do not inspect container-owned implementation as app code', () => {
  const source = "export function decideEntitlement(subscriptionStatus) { return subscriptionStatus === 'active'; }";
  assert.deepEqual(inspectSource('src/container/internal/entitlement.mjs', source), []);
});
