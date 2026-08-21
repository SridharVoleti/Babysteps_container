import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { CURRENT_VOICE_PACKAGE_VERSION } from '../../src/container/internal/governance/voice-package-registry.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts', 'run-container-conformance.mjs');

async function runScript(outDir) {
  return execFileAsync(process.execPath, [scriptPath, 'apps/example', outDir], { cwd: repoRoot });
}

// PK-003/TC-003-P0: this is the real production conformance script - not a simulation of
// it - so these tests prove the actual release-gate binary fails closed, not just the
// underlying library functions it calls.
test('PK-003/TC-003 the real conformance script fails closed (non-zero) when the dependency lockfile is missing/unpinned', async () => {
  const lockPath = join(repoRoot, 'package-lock.json');
  const movedPath = join(repoRoot, 'package-lock.json.pk003-test-moved');
  const outDir = await mkdtemp(join(tmpdir(), 'pk003-'));
  await rename(lockPath, movedPath);
  try {
    await assert.rejects(() => runScript(outDir));
  } finally {
    await rename(movedPath, lockPath);
    await rm(outDir, { recursive: true, force: true });
  }
});

test('PK-003/TC-003 the real conformance script derives real (non-placeholder) release composition and passes for apps/example', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'pk003-'));
  try {
    const { stdout } = await runScript(outDir);
    assert.match(stdout, /Result: PASS/);

    const report = JSON.parse(await readFile(join(outDir, 'conformance-report.json'), 'utf8'));
    assert.equal(report.overallResult, 'PASS');
    const composition = report.releaseComposition;
    assert.ok(composition);
    assert.notEqual(composition.dependencyLockFingerprint, 'unpinned-local-dev');
    assert.match(composition.dependencyLockFingerprint, /^sha256:[0-9a-f]{64}$/);

    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(composition.containerVersion, packageJson.version);
    assert.equal(composition.voicePackageVersion, CURRENT_VOICE_PACKAGE_VERSION);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
