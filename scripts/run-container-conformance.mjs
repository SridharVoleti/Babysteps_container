import { readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, basename } from 'node:path';
import process from 'node:process';
import { resolveManifest } from '../src/container/internal/manifest/index.mjs';
import { manifestContract } from '../src/container/internal/manifest/contract.mjs';
import { runConformance, buildConformanceReport, renderHumanReadableSummary } from '../src/container/internal/conformance/conformance-runner.mjs';
import { buildReleaseComposition } from '../src/container/internal/release/release-composition.mjs';

const execFileAsync = promisify(execFile);

const appDir = process.argv[2] ?? 'apps/example';
const outDir = process.argv[3] ?? '.';

const manifestPath = join(appDir, 'app.manifest.json');
const rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const manifestResolution = resolveManifest(rawManifest, manifestContract);
if (!manifestResolution.ok) {
  console.error(`[${manifestResolution.error.code}] ${manifestResolution.error.message}`);
  process.exitCode = 1;
  process.exit(1);
}
const manifest = manifestResolution.manifest;

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

// Resolves each requirement's own `node --test <files>` command directly (rather than
// shelling out through `npm run`), expanding any glob argument ourselves so the gate behaves
// identically whether the shell running it expands globs or not (e.g. Windows cmd.exe).
async function expandGlobArg(pattern) {
  if (!pattern.includes('*')) return [pattern];
  const dir = dirname(pattern);
  const suffix = basename(pattern).replace('*', '');
  const entries = await readdir(dir).catch(() => []);
  return entries.filter((name) => name.endsWith(suffix)).map((name) => join(dir, name));
}

async function resolveTestFiles(testCommand) {
  const scriptLine = packageJson.scripts?.[testCommand];
  if (!scriptLine || !scriptLine.startsWith('node --test ')) {
    throw new Error(`Unsupported/missing test command for conformance runner: ${testCommand}`);
  }
  const rawArgs = scriptLine.slice('node --test '.length).trim().split(/\s+/);
  const files = [];
  for (const arg of rawArgs) files.push(...(await expandGlobArg(arg)));
  return files;
}

// TC-003: reuses the acceptance-test suite each frozen requirement already owns rather than
// duplicating test logic here - this runner only decides applicability/aggregation/reporting.
async function runTest(requirement) {
  try {
    const files = await resolveTestFiles(requirement.testCommand);
    await execFileAsync(process.execPath, ['--test', ...files]);
    return { status: 'PASS' };
  } catch (error) {
    return { status: 'FAIL', reason: (error?.stderr || error?.message || 'CONFORMANCE_MANDATORY_TEST_FAILED').toString().slice(0, 500) };
  }
}

const env = process.env;
let releaseComposition = null;
try {
  releaseComposition = buildReleaseComposition({
    appId: manifest.appId,
    appVersion: manifest.appVersion,
    gitCommit: env.GITHUB_SHA ?? env.GIT_COMMIT ?? 'local-dev',
    buildId: env.GITHUB_RUN_ID ?? env.BUILD_ID ?? 'local-build',
    containerVersion: env.CONTAINER_VERSION ?? '0.1.0',
    contentVersion: manifest.contentVersion,
    progressSchemaVersion: manifest.progressSchemaVersion,
    voicePackageVersion: env.VOICE_PACKAGE_VERSION ?? '1.0.0',
    manifestVersion: manifest.containerContractVersion,
    dependencyLockFingerprint: env.DEPENDENCY_LOCK_FINGERPRINT ?? 'unpinned-local-dev',
  });
} catch (error) {
  console.error(`[RELEASE_METADATA_INVALID] ${error.message}`);
}

const conformanceRun = await runConformance({ manifest, runTest, releaseComposition });
const report = buildConformanceReport({
  conformanceRun,
  appId: manifest.appId,
  appVersion: manifest.appVersion,
  gitCommit: releaseComposition?.gitCommit ?? env.GITHUB_SHA ?? env.GIT_COMMIT ?? 'local-dev',
  releaseComposition,
});

const summary = renderHumanReadableSummary(report);
console.log(summary);

await writeFile(join(outDir, 'conformance-report.json'), JSON.stringify(report, null, 2), 'utf8');
await writeFile(join(outDir, 'conformance-report.md'), summary, 'utf8');
if (env.GITHUB_STEP_SUMMARY) {
  await appendFile(env.GITHUB_STEP_SUMMARY, `\n${summary}\n`, 'utf8');
}

if (report.overallResult !== 'PASS') {
  process.exitCode = 1;
}
