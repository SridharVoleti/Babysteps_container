import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateLaunchContext } from '../../src/container/internal/bootstrap/launch-context.mjs';
import { bindAuthorizedRuntime } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createContentRuntime, ContentRuntimeError } from '../../src/container/internal/content/content-runtime.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

const baseClaims = Object.freeze({
  learnerId: 'learner-1', appId: 'magical-math', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-18T00:00:00.000Z', expiresAt: '2026-08-18T01:00:00.000Z', correlationId: 'corr-1'
});
const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
const envelope = (claims) => ({ claims: structuredClone(claims), proof: proof(claims) });
const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });

async function boundRuntime(claims = baseClaims) {
  const opts = {
    manifest: Object.freeze({ appId: claims.appId }),
    expectedReleaseId: claims.releaseId,
    expectedSessionId: claims.sessionId,
    verifier,
    now: () => new Date('2026-08-18T00:10:00.000Z'),
  };
  const runtimeContext = await validateLaunchContext({ launchContext: envelope(claims), ...opts });
  return bindAuthorizedRuntime(runtimeContext);
}

test('CR-001-AC01 Magical Math and Chess use structurally different content schemas through the same shared framework', async () => {
  const mathBinding = await boundRuntime();
  const chessBinding = await boundRuntime({ ...baseClaims, appId: 'chess-master', sessionId: 'session-2' });

  const mathRuntime = createContentRuntime({
    runtimeBinding: mathBinding,
    loader: async () => ({ lessons: [{ id: 'l1', problems: [1, 2, 3] }] }),
  });
  const chessRuntime = createContentRuntime({
    runtimeBinding: chessBinding,
    loader: async () => ({ openings: [{ eco: 'B90', moves: ['e4', 'c5'] }] }),
  });

  const mathContent = await mathRuntime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '1.0.0' });
  const chessContent = await chessRuntime.resolve({ appId: 'chess-master', releaseId: 'release-1', contentVersion: '1.0.0' });

  assert.ok(Array.isArray(mathContent.lessons));
  assert.ok(Array.isArray(chessContent.openings));
});

test('CR-001-AC02 only content bound to the current app/release configuration is accepted', async () => {
  const binding = await boundRuntime();
  const runtime = createContentRuntime({ runtimeBinding: binding, loader: async () => ({ lessons: [] }) });
  const content = await runtime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '1.0.0' });
  assert.deepEqual(content, { lessons: [] });
});

test('CR-001-AC03 content belonging to another Babysteps app is rejected and never silently used', async () => {
  const binding = await boundRuntime();
  let loaderCalls = 0;
  const runtime = createContentRuntime({ runtimeBinding: binding, loader: async () => { loaderCalls += 1; return { lessons: [] }; } });

  await assert.rejects(
    () => runtime.resolve({ appId: 'chess-master', releaseId: 'release-1', contentVersion: '1.0.0' }),
    (e) => e instanceof ContentRuntimeError && e.code === 'CONTENT_APP_MISMATCH'
  );
  assert.equal(loaderCalls, 0);
});

test('CR-001-AC04 an incompatible content release version fails safely rather than being interpreted', async () => {
  const binding = await boundRuntime();
  const runtime = createContentRuntime({ runtimeBinding: binding, loader: async () => ({ lessons: [] }) });

  await assert.rejects(
    () => runtime.resolve({ appId: 'magical-math', releaseId: 'release-99', contentVersion: '1.0.0' }),
    (e) => e instanceof ContentRuntimeError && e.code === 'CONTENT_VERSION_INCOMPATIBLE'
  );
});

test('CR-001-AC05 app-specific curriculum sequencing/mastery rules are not implemented in the shared content runtime', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/content/content-runtime.mjs');
  const source = readFileSync(filePath, 'utf8');
  const forbidden = /\b(?:function|const|let|var)\s+(?:decide|determine|calculate|compute|validate)(?:Sequence|Sequencing|Mastery|Curriculum|Lesson|Question|Pedagogy)\b/i;
  assert.equal(forbidden.test(source), false);
});

test('CR-001-AC06 shared content utilities perform only technical loading/resolution/caching/compatibility behavior', () => {
  const filePath = path.join(process.cwd(), 'src/container/internal/content/content-runtime.mjs');
  const source = readFileSync(filePath, 'utf8');
  assert.equal(/\b(lesson|question|mastery|curriculum|pedagogy|sequenc\w*)\b/i.test(source), false);

  const importViolation = inspectSource(
    'apps/demo/rogue-content.mjs',
    "import { createContentRuntime } from '../../src/container/internal/content/content-runtime.mjs';"
  );
  assert.equal(importViolation.some((v) => v.code === 'CONTAINER_PRIVATE_IMPORT'), true);
});

test('CR-001-AC07 a new app-specific content structure requires no shared content-core changes', async () => {
  const binding = await boundRuntime({ ...baseClaims, appId: 'speed-reading', sessionId: 'session-3' });
  const runtime = createContentRuntime({
    runtimeBinding: binding,
    loader: async () => ({ passages: [{ text: 'once upon a time', targetWpm: 220, comprehensionChecks: [{ q: 'who?', a: 'a mouse' }] }] }),
  });
  const content = await runtime.resolve({ appId: 'speed-reading', releaseId: 'release-1', contentVersion: '1.0.0' });
  assert.equal(content.passages[0].targetWpm, 220);
});

test('CR-001-AC08 repeated loading of the same immutable content/version is cached without cross-app/version contamination', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-4' });
  let loaderCalls = 0;
  const runtime = createContentRuntime({ runtimeBinding: binding, loader: async ({ contentVersion }) => { loaderCalls += 1; return { version: contentVersion }; } });

  const first = await runtime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '1.0.0' });
  const second = await runtime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '1.0.0' });
  assert.equal(first, second);
  assert.equal(loaderCalls, 1);

  const differentVersion = await runtime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '2.0.0' });
  assert.equal(loaderCalls, 2);
  assert.notEqual(differentVersion, first);

  const otherBinding = await boundRuntime({ ...baseClaims, sessionId: 'session-5' });
  const otherRuntime = createContentRuntime({ runtimeBinding: otherBinding, loader: async ({ contentVersion }) => ({ version: contentVersion, owner: 'other-runtime' }) });
  const otherContent = await otherRuntime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '1.0.0' });
  assert.equal(otherContent.owner, 'other-runtime');
});

test('CR-001-AC09 required content or an asset that cannot be loaded surfaces a normalized technical error without inventing replacement content', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-6' });
  const missingRuntime = createContentRuntime({ runtimeBinding: binding, loader: async () => null });
  await assert.rejects(
    () => missingRuntime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '1.0.0' }),
    (e) => e instanceof ContentRuntimeError && e.code === 'CONTENT_NOT_FOUND'
  );

  const throwingRuntime = createContentRuntime({ runtimeBinding: binding, loader: async () => { throw new Error('storage unreachable'); } });
  await assert.rejects(
    () => throwingRuntime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '2.0.0' }),
    (e) => e instanceof ContentRuntimeError && e.code === 'CONTENT_LOAD_FAILED'
  );

  await assert.rejects(
    () => throwingRuntime.resolveAsset('board-sprite.png', async () => null),
    (e) => e instanceof ContentRuntimeError && e.code === 'CONTENT_ASSET_UNAVAILABLE'
  );
});

test('CR-001-AC10 only technical content telemetry is emitted; detailed learner content-consumption history is not automatically created', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-7' });
  const events = [];
  const runtime = createContentRuntime({
    runtimeBinding: binding,
    loader: async () => ({ lessons: [{ id: 'l1', text: 'sensitive learner-facing lesson text' }] }),
    onTelemetry: (e) => events.push(e),
  });
  await runtime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '1.0.0' });
  await runtime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '1.0.0' });

  assert.ok(events.length >= 2);
  for (const event of events) {
    const keys = Object.keys(event);
    assert.ok(keys.every((k) => ['event', 'appId', 'releaseId', 'correlationId', 'contentVersion', 'reason', 'assetRef'].includes(k)));
    assert.equal(JSON.stringify(event).includes('sensitive learner-facing lesson text'), false);
  }
});

test('CR-001-AC11 a compatible content version upgrade is adopted without changing the shared content core', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-8' });
  const runtime = createContentRuntime({
    runtimeBinding: binding,
    loader: async ({ contentVersion }) => ({ schemaShape: contentVersion === '1.0.0' ? 'legacy' : 'v2-with-new-fields', contentVersion }),
  });

  const before = await runtime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '1.0.0' });
  const after = await runtime.resolve({ appId: 'magical-math', releaseId: 'release-1', contentVersion: '1.1.0' });
  assert.equal(before.schemaShape, 'legacy');
  assert.equal(after.schemaShape, 'v2-with-new-fields');
});

test('CR-001 invalid input is rejected', async () => {
  const binding = await boundRuntime({ ...baseClaims, sessionId: 'session-9' });
  assert.throws(() => createContentRuntime({ runtimeBinding: binding, loader: 'not-a-function' }), (e) => e instanceof ContentRuntimeError && e.code === 'CONTENT_LOAD_FAILED');
  const runtime = createContentRuntime({ runtimeBinding: binding, loader: async () => ({}) });
  await assert.rejects(() => runtime.resolve({}), (e) => e.code === 'CONTENT_LOAD_FAILED');
  await assert.rejects(() => runtime.resolve({ appId: 'magical-math' }), (e) => e.code === 'CONTENT_LOAD_FAILED');
});
