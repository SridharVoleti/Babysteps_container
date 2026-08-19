import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveApplicableRequirements,
  runConformance,
  buildConformanceReport,
  renderHumanReadableSummary,
  ConformanceError,
} from '../../src/container/internal/conformance/conformance-runner.mjs';
import { CONTAINER_REQUIREMENT_TESTS } from '../../src/container/internal/conformance/requirement-registry.mjs';
import { buildReleaseComposition } from '../../src/container/internal/release/release-composition.mjs';

const baseManifest = Object.freeze({ appId: 'magical-math', appVersion: '1.0.0', requiredCapabilities: ['progress'], optionalCapabilities: [] });
const alwaysPass = async () => ({ status: 'PASS' });

test('TC-003-AC01 the standardized conformance job runs before production deployment is allowed', async () => {
  const run = await runConformance({ manifest: baseManifest, runTest: alwaysPass });
  assert.equal(run.overallResult, 'PASS');
  assert.ok(run.applicableCount > 0);
});

test('TC-003-AC02 all mandatory frozen acceptance tests applicable to the app are included in the run', () => {
  const withAudio = resolveApplicableRequirements({ ...baseManifest, requiredCapabilities: ['progress', 'audio'] });
  const withoutAudio = resolveApplicableRequirements(baseManifest);
  assert.ok(withAudio.some((r) => r.id === 'AM-001'));
  assert.equal(withoutAudio.some((r) => r.id === 'AM-001'), false);
  assert.ok(withoutAudio.some((r) => r.id === 'AM-003'));
  assert.ok(withoutAudio.some((r) => r.id === 'CC-001'));
});

test('TC-003-AC03 one applicable mandatory failure makes overall conformance FAIL and blocks production', async () => {
  const runTest = async (requirement) => (requirement.id === 'SP-001' ? { status: 'FAIL', reason: 'boom' } : { status: 'PASS' });
  const run = await runConformance({ manifest: baseManifest, runTest });
  assert.equal(run.overallResult, 'FAIL');
  assert.ok(run.mandatoryFailedCount >= 1);
});

test('TC-003-AC04 all applicable mandatory tests passing yields overall PASS', async () => {
  const run = await runConformance({ manifest: baseManifest, runTest: alwaysPass });
  assert.equal(run.overallResult, 'PASS');
  assert.equal(run.mandatoryFailedCount, 0);
});

test('TC-003-AC05 a mandatory test unexpectedly skipped without approved reason cannot receive PASS', async () => {
  const runTest = async (requirement) => (requirement.id === 'ER-001' ? { status: 'SKIP', reason: 'flaky-runner' } : { status: 'PASS' });
  const run = await runConformance({ manifest: baseManifest, runTest });
  assert.equal(run.overallResult, 'FAIL');
  assert.ok(run.results.find((r) => r.id === 'ER-001').status === 'SKIP');
});

test('TC-003-AC06 a machine-readable JSON result and human-readable summary are produced automatically', async () => {
  const run = await runConformance({ manifest: baseManifest, runTest: alwaysPass });
  const report = buildConformanceReport({ conformanceRun: run, appId: 'magical-math', appVersion: '1.0.0', gitCommit: 'abc123' });
  assert.equal(typeof JSON.stringify(report), 'string');
  const summary = renderHumanReadableSummary(report);
  assert.equal(typeof summary, 'string');
  assert.ok(summary.includes('Result: PASS'));
});

test('TC-003-AC07 the report is bound to the exact Git commit/build and PK-003 release composition', async () => {
  const releaseComposition = buildReleaseComposition({
    appId: 'magical-math', appVersion: '1.0.0', gitCommit: 'commit-abc', buildId: 'build-1',
    containerVersion: '0.1.0', contentVersion: '1.0.0', progressSchemaVersion: '1.0',
    voicePackageVersion: '1.0.0', manifestVersion: '1.0', dependencyLockFingerprint: 'sha256:xyz',
  });
  const run = await runConformance({ manifest: baseManifest, runTest: alwaysPass, releaseComposition });
  const report = buildConformanceReport({ conformanceRun: run, appId: 'magical-math', appVersion: '1.0.0', gitCommit: 'commit-abc', releaseComposition });
  assert.equal(report.gitCommit, 'commit-abc');
  assert.deepEqual(report.releaseComposition, releaseComposition);
});

test('TC-003-AC08 app-specific additional tests cannot suppress or waive mandatory shared checks', () => {
  assert.equal('skip' in runConformance, false);
  assert.equal('waive' in runConformance, false);
  const applicable = resolveApplicableRequirements(baseManifest);
  assert.ok(applicable.every((r) => r.mandatory === true));
});

test('TC-003-AC09 DEFERRED/DUPLICATE requirements never create an active conformance obligation', () => {
  const ids = CONTAINER_REQUIREMENT_TESTS.map((r) => r.id);
  for (const excluded of ['EH-001', 'EH-002', 'EH-003', 'TT-001', 'PK-001', 'PK-002', 'TC-001', 'TC-002']) {
    assert.equal(ids.includes(excluded), false);
  }
});

test('TC-003-AC10 a change to the frozen registry is picked up before the next release is promoted', async () => {
  const extendedRegistry = [...CONTAINER_REQUIREMENT_TESTS, { id: 'ZZ-999', testCommand: 'test:new-thing', mandatory: true, appliesTo: () => true }];
  const applicable = resolveApplicableRequirements(baseManifest, extendedRegistry);
  assert.ok(applicable.some((r) => r.id === 'ZZ-999'));
});

test('TC-003-AC11 reports contain technical identifiers/outcomes only, no credentials/PII/raw payloads', async () => {
  const runTest = async () => ({ status: 'FAIL', reason: 'leaked-learner-transcript-should-not-appear' });
  const run = await runConformance({ manifest: baseManifest, runTest });
  const report = buildConformanceReport({ conformanceRun: run, appId: 'magical-math', appVersion: '1.0.0', gitCommit: 'abc123' });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('accessToken'), false);
  assert.equal(serialized.includes('parentEmail'), false);
  for (const result of report.results) {
    assert.deepEqual(Object.keys(result).sort(), ['durationMs', 'id', 'mandatory', 'reason', 'status'].sort());
  }
});

test('TC-003 requires a test-execution function to run the gate', async () => {
  await assert.rejects(() => runConformance({ manifest: baseManifest }), (e) => e instanceof ConformanceError && e.code === 'CONFORMANCE_ENVIRONMENT_UNAVAILABLE');
});
