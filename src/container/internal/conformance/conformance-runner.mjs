import { CONTAINER_REQUIREMENT_TESTS } from './requirement-registry.mjs';

export class ConformanceError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ConformanceError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function fail(code, message, metadata) { throw new ConformanceError(code, message, metadata); }

const VALID_STATUSES = new Set(['PASS', 'FAIL', 'SKIP']);

// TC-003: applicability is manifest-driven only. There is no per-requirement "skip"/"waive"
// parameter anywhere in this module - once a requirement is applicable it is mandatory.
export function resolveApplicableRequirements(manifest, registry = CONTAINER_REQUIREMENT_TESTS) {
  return registry.filter((requirement) => requirement.appliesTo(manifest ?? {}));
}

export async function runConformance({
  manifest,
  registry = CONTAINER_REQUIREMENT_TESTS,
  runTest,
  releaseComposition = null,
  clock = () => Date.now(),
}) {
  if (typeof runTest !== 'function') {
    fail('CONFORMANCE_ENVIRONMENT_UNAVAILABLE', 'A test-execution function is required to run the conformance gate.');
  }

  const applicable = resolveApplicableRequirements(manifest, registry);
  const results = [];

  for (const requirement of applicable) {
    const startedAt = clock();
    let outcome;
    try {
      outcome = await runTest(requirement);
    } catch (error) {
      outcome = { status: 'FAIL', reason: error?.message ?? 'CONFORMANCE_MANDATORY_TEST_FAILED' };
    }
    if (!outcome || !VALID_STATUSES.has(outcome.status)) {
      outcome = { status: 'FAIL', reason: 'CONFORMANCE_REQUIRED_TEST_MISSING' };
    }
    results.push(Object.freeze({
      id: requirement.id,
      mandatory: requirement.mandatory,
      status: outcome.status,
      reason: outcome.reason ?? null,
      durationMs: clock() - startedAt,
    }));
  }

  // A mandatory requirement resolved as applicable can only satisfy the gate with an explicit
  // PASS - SKIP (missing/unexpectedly skipped) counts as a mandatory failure, never a silent pass.
  const mandatoryFailed = results.filter((r) => r.mandatory && r.status !== 'PASS');
  const overallResult = mandatoryFailed.length === 0 ? 'PASS' : 'FAIL';

  return Object.freeze({
    overallResult,
    results: Object.freeze(results),
    applicableCount: applicable.length,
    passed: results.filter((r) => r.status === 'PASS').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
    skipped: results.filter((r) => r.status === 'SKIP').length,
    mandatoryFailedCount: mandatoryFailed.length,
    releaseComposition,
  });
}

export function buildConformanceReport({ conformanceRun, appId, appVersion, gitCommit, releaseComposition = null, generatedAt = () => new Date().toISOString() }) {
  if (!conformanceRun || typeof conformanceRun.overallResult !== 'string') {
    fail('CONFORMANCE_REPORT_INVALID', 'A completed conformance run is required to build a report.');
  }
  if (typeof appId !== 'string' || appId.trim() === '' || typeof gitCommit !== 'string' || gitCommit.trim() === '') {
    fail('CONFORMANCE_REPORT_INVALID', 'appId and gitCommit are required to bind a conformance report to a release.');
  }

  return Object.freeze({
    appId,
    appVersion,
    gitCommit,
    releaseComposition: releaseComposition ?? conformanceRun.releaseComposition ?? null,
    applicableCount: conformanceRun.applicableCount,
    passed: conformanceRun.passed,
    failed: conformanceRun.failed,
    skipped: conformanceRun.skipped,
    mandatoryFailedCount: conformanceRun.mandatoryFailedCount,
    overallResult: conformanceRun.overallResult,
    generatedAt: typeof generatedAt === 'function' ? generatedAt() : generatedAt,
    results: conformanceRun.results,
  });
}

export function renderHumanReadableSummary(report) {
  const lines = [
    `Container Conformance Report - ${report.appId}@${report.appVersion ?? 'unknown'}`,
    `Git commit: ${report.gitCommit}`,
    `Result: ${report.overallResult}`,
    `Applicable checks: ${report.applicableCount} (passed ${report.passed}, failed ${report.failed}, skipped ${report.skipped})`,
  ];
  const failedMandatory = report.results.filter((r) => r.mandatory && r.status !== 'PASS');
  if (failedMandatory.length > 0) {
    lines.push('Failed mandatory checks:');
    for (const r of failedMandatory) {
      lines.push(`  - ${r.id}: ${r.status} (${r.reason ?? 'unknown'})`);
    }
  }
  return lines.join('\n');
}
