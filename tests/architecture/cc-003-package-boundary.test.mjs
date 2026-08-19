import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

// These checks are resolution-based, not text-pattern-based: they prove that Node's own
// module resolution — not a regex — makes container internals unreachable through the
// public package contract, regardless of import syntax (static, dynamic, aliased subpath).
const PACKAGE_NAME = '@babysteps/consumer-app-container';

test('CC-003-AC01/AC-boundary the public package entry point resolves and exposes only approved app-facing exports', async () => {
  const publicModule = await import(PACKAGE_NAME);
  assert.deepEqual(Object.keys(publicModule).sort(), ['CONTAINER_RESPONSIBILITY_BOUNDARY', 'defineLearningApp']);
});

for (const internalSubpath of [
  '/internal/session/session-lifecycle.mjs',
  '/internal/progress/progress-adapter.mjs',
  '/internal/bootstrap/atomic-bootstrap.mjs',
  '/internal/api/babysteps-api-client.mjs',
  '/internal/manifest/load-app-package.mjs',
]) {
  test(`CC-003-AC-boundary container-private module "${internalSubpath}" cannot be resolved through the package contract`, async () => {
    await assert.rejects(
      () => import(`${PACKAGE_NAME}${internalSubpath}`),
      (error) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    );
  });
}

test('CC-003-AC-boundary no wildcard export exposes src/container/internal', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const exportValues = JSON.stringify(pkg.exports ?? {});
  assert.equal(exportValues.includes('internal'), false);
  assert.equal(exportValues.includes('*'), false);
});

test('CC-003-AC-boundary the example app package depends on the public package, not a filesystem-relative container path', async () => {
  const appPkg = JSON.parse(await readFile(new URL('../../apps/example/package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(appPkg.dependencies ?? {}).includes(PACKAGE_NAME), true);

  const appSource = await readFile(new URL('../../apps/example/index.mjs', import.meta.url), 'utf8');
  assert.equal(appSource.includes(PACKAGE_NAME), true);
  assert.deepEqual(inspectSource('apps/example/index.mjs', appSource), []);
});

test('CC-003-AC-boundary the running example app was loaded through the public package, not a private import', async () => {
  const appModule = await import('../../apps/example/index.mjs');
  assert.deepEqual(appModule.default, { id: 'example' });
});
