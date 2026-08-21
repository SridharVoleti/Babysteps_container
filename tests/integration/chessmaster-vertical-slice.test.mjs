// Vertical-slice integration test for the ChessMaster prototype running inside the Babysteps
// Consumer App Container (see Instructions.md at the workspace root). This file composes the
// same primitives the container's own AH-002/SB-003 tests compose (bootstrap -> runtime binding
// -> session lifecycle/completion -> activity lifecycle manager -> progress adapter), pointed at
// the real apps/chessmaster package instead of a fixture app. It intentionally lives outside
// apps/ (like every other host-composition script in this repo) because it wires container
// internals directly, which apps/ code is never allowed to do (CC-001/CC-003).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrapLearningApp, BootstrapError } from '../../src/container/internal/bootstrap/atomic-bootstrap.mjs';
import { loadAppPackage } from '../../src/container/internal/manifest/load-app-package.mjs';
import { resolveManifest } from '../../src/container/internal/manifest/index.mjs';
import { manifestContract } from '../../src/container/internal/manifest/contract.mjs';
import { getRuntimeContext } from '../../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createSessionLifecycle } from '../../src/container/internal/session/session-lifecycle.mjs';
import { createSessionCompletion, createFinalizationAdapter } from '../../src/container/internal/session/session-completion.mjs';
import { createActivityLifecycleManager } from '../../src/container/internal/activities/activity-lifecycle-manager.mjs';
import { createProgressAdapter } from '../../src/container/internal/progress/progress-adapter.mjs';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

const APP_DIR = new URL('../../apps/chessmaster/', import.meta.url);
const MANIFEST_PATH = fileURLToPath(new URL('app.manifest.json', APP_DIR));
const PUZZLE = JSON.parse(await readFile(new URL('content/pattern-fork-01.json', APP_DIR), 'utf8')).puzzle;

const baseClaims = Object.freeze({
  learnerId: 'learner-chess-1', appId: 'chessmaster', releaseId: 'release-1', sessionId: 'session-1',
  launchMode: 'start', issuedAt: '2026-08-19T00:00:00.000Z', expiresAt: '2026-08-19T01:00:00.000Z', correlationId: 'corr-chess-1',
});
const proof = (claims) => createHash('sha256').update(JSON.stringify(claims)).digest('hex');
const envelope = (claims = baseClaims) => ({ claims: structuredClone(claims), proof: proof(claims) });
const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });
const launchOptions = Object.freeze({
  expectedReleaseId: 'release-1', expectedSessionId: 'session-1', verifier,
  now: () => new Date('2026-08-19T00:10:00.000Z'),
});

// Minimal in-memory PA-001 transport standing in for the real Babysteps progress/session API —
// this repo's own AH-002/SB-003 tests use the same style of fake transport, since there is no
// live Babysteps backend to talk to in this environment.
function createFakeProgressTransport() {
  const saved = [];
  const finalized = [];
  const progressClient = { call: async (op, payload) => {
    if (op === 'progress.save') { saved.push(payload); return { saved: true }; }
    throw new Error(`unexpected progress op: ${op}`);
  } };
  const finalizationClient = { call: async (op) => {
    if (op === 'session.finalize') { finalized.push(true); return { finalStatus: 'completed' }; }
    throw new Error(`unexpected finalization op: ${op}`);
  } };
  const checkpoints = [];
  const progressAdapter = createProgressAdapter({
    progressClient: { call: async (op, payload) => {
      if (op === 'progress.checkpoint') { checkpoints.push(payload); return { acknowledged: true, progressVersion: String(checkpoints.length) }; }
      throw new Error(`unexpected progress op: ${op}`);
    } },
  });
  return { progressClient, finalizationClient, progressAdapter, saved, finalized, checkpoints };
}

function baseOptions(overrides = {}) {
  return {
    manifestPath: MANIFEST_PATH,
    manifestOptions: manifestContract,
    launchContext: envelope(),
    launchOptions,
    capabilityAdapters: { progress: { version: '1.0', save: async () => ({ saved: true }) } },
    coreServices: [],
    ...overrides,
  };
}

// ── manifest validates (CC-002) ──────────────────────────────────────────────────────────
test('chessmaster manifest resolves against the frozen CC-002 contract', async () => {
  const raw = JSON.parse(await readFile(new URL('app.manifest.json', APP_DIR), 'utf8'));
  const result = resolveManifest(raw, manifestContract);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.appId, 'chessmaster');
  assert.deepEqual(result.manifest.requiredCapabilities, ['progress']);
});

// ── direct prohibited infrastructure access is absent (CC-001/CC-003) ───────────────────
test('no apps/chessmaster source file trips a CC-001/CC-003 architecture boundary rule', async () => {
  const violations = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') await walk(full); continue; }
      if (!/\.(mjs|js|jsx|ts|tsx)$/.test(entry.name)) continue;
      const source = await readFile(full, 'utf8');
      const relative = path.relative(fileURLToPath(new URL('../..', import.meta.url)), full);
      violations.push(...inspectSource(relative, source));
    }
  }
  await walk(fileURLToPath(APP_DIR));
  assert.deepEqual(violations, []);
});

// ── prototype cannot run before Container bootstrap; mandatory bootstrap failure prevents
//    app startup (SB-001/SB-003) ─────────────────────────────────────────────────────────
test('an expired launch context prevents any observable chessmaster module import', async () => {
  let executed = false;
  const loadModule = async (url) => { executed = true; return import(url); };
  const expiredClaims = { ...baseClaims, expiresAt: '2026-08-19T00:05:00.000Z' };
  await assert.rejects(
    () => bootstrapLearningApp({ ...baseOptions({ launchContext: envelope(expiredClaims) }), loadModule }),
    (e) => e instanceof BootstrapError && e.phase === 'VALIDATE_LAUNCH' && e.metadata.category === 'LAUNCH_CONTEXT_EXPIRED'
  );
  assert.equal(executed, false);
});

test('a missing required "progress" capability prevents any observable chessmaster module import', async () => {
  let executed = false;
  const loadModule = async (url) => { executed = true; return import(url); };
  await assert.rejects(
    () => bootstrapLearningApp({ ...baseOptions({ capabilityAdapters: {} }), loadModule }),
    (e) => e instanceof BootstrapError && e.phase === 'RESOLVE_CAPABILITIES'
  );
  assert.equal(executed, false);
});

test('loadAppPackage cannot import chessmaster app code without an already-authorized runtime binding', async () => {
  let executed = false;
  const result = await loadAppPackage(MANIFEST_PATH, manifestContract, {
    loadModule: async (url) => { executed = true; return import(url); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTHORIZATION_REQUIRED');
  assert.equal(executed, false);
});

// ── app initializes successfully in the Container; runtime context reaches the app through
//    the approved interface (SB-002/SB-003) ─────────────────────────────────────────────
test('the authorized/valid path bootstraps the container and loads the real chessmaster app definition', async () => {
  const loadModule = (url) => import(url);
  const { readiness, appDefinition } = await bootstrapLearningApp({ ...baseOptions(), loadModule });

  assert.equal(readiness.ok, true);
  assert.equal(readiness.phase, 'READY');
  assert.equal(appDefinition.id, 'chessmaster');
  assert.equal(appDefinition.activity.activityId, 'pattern-training');

  const identity = getRuntimeContext(readiness.runtime);
  assert.equal(identity.appId, 'chessmaster');
  assert.equal(identity.learnerId, 'learner-chess-1');
  assert.equal(identity.sessionId, 'session-1');
});

// ── full representative learning flow: readiness -> wrong attempt -> wrong attempt (hint) ->
//    correct attempt -> progress travels through PA-001 -> completion travels through
//    SR-004/AH-001 -> session lifecycle reaches ENDED. Session/runtime remains container-owned
//    throughout: the activity never touches session-lifecycle, progress-adapter or the
//    runtime binding directly. ───────────────────────────────────────────────────────────
test('a learner can play the fork puzzle end to end through the standard activity/progress/completion contracts', async () => {
  const { readiness, appDefinition } = await bootstrapLearningApp({ ...baseOptions(), loadModule: (url) => import(url) });
  const identity = getRuntimeContext(readiness.runtime);

  const { finalizationClient, progressAdapter, finalized, checkpoints } = createFakeProgressTransport();
  const finalizationAdapter = createFinalizationAdapter({ progressClient: { call: async () => ({ saved: true }) }, finalizationClient });
  const lifecycle = createSessionLifecycle({ sessionIdentity: identity, sessionAdapter: finalizationAdapter });
  const completion = createSessionCompletion({ sessionIdentity: identity, lifecycle });

  const meaningfulProgressCalls = [];
  const manager = createActivityLifecycleManager({
    runtimeBinding: readiness.runtime,
    lifecycle,
    completion,
    // This is the one place progress persistence is wired: the activity only ever calls
    // events.meaningfulProgress(); what happens with that payload is entirely host/container
    // owned (PA-001), never decided by the activity itself.
    onMeaningfulProgress: async (payload) => {
      meaningfulProgressCalls.push(payload);
      await progressAdapter.checkpoint({ patternKey: payload.patternKey, xpAwarded: payload.xpAwarded }, {});
    },
  });

  await lifecycle.signal('activity-ready');
  const handle = manager.activate(appDefinition.activity, { content: { puzzle: PUZZLE } });
  assert.equal(manager.state, 'ACTIVE');

  const wrong1 = await handle.implementation.attemptMove('e2e4');
  assert.equal(wrong1.correct, false);
  assert.equal(wrong1.showAnswer, false);

  const wrong2 = await handle.implementation.attemptMove('e2e4');
  assert.equal(wrong2.correct, false);
  assert.ok(wrong2.hint);

  const correct = await handle.implementation.attemptMove(PUZZLE.bestMove);
  assert.equal(correct.correct, true);
  assert.equal(correct.xpAwarded, 20 + 5); // COMPLETE_GAME + CORRECT_ATTEMPT_3 (3rd attempt)

  // Progress travelled through the standard AH-001/PA-001 contract, not a direct DB write.
  assert.equal(meaningfulProgressCalls.length, 3);
  assert.equal(checkpoints.length, 3);
  assert.equal(checkpoints[2].appProgress.xpAwarded, 25);

  // Completion travelled through the standard SR-004 contract and the session actually ended;
  // the activity itself never called session-lifecycle or session-completion directly.
  assert.equal(lifecycle.state, 'ENDED');
  assert.equal(finalized.length, 1);

  // AH-002: the host, not the activity, is responsible for ending the activity lifecycle once
  // the session it belongs to has ended (mirrors this repo's own AH-002-AC08 convention).
  manager.endSession('SESSION_ENDED');
  assert.equal(manager.current, null);

  // The now-disposed activity instance can no longer emit actionable events (AH-002).
  await assert.rejects(() => handle.context.events.completed({}), (e) => e.code === 'ACTIVITY_ALREADY_DISPOSED');
});

test('an invalid move format is reported through events.failed(), not thrown as an app-crash', async () => {
  const { readiness, appDefinition } = await bootstrapLearningApp({ ...baseOptions(), loadModule: (url) => import(url) });
  const identity = getRuntimeContext(readiness.runtime);
  const lifecycle = createSessionLifecycle({ sessionIdentity: identity });
  const manager = createActivityLifecycleManager({ runtimeBinding: readiness.runtime, lifecycle });
  const handle = manager.activate(appDefinition.activity, { content: { puzzle: PUZZLE } });

  const outcome = await handle.implementation.attemptMove('not-a-move');
  assert.equal(outcome.code, 'INVALID_MOVE_FORMAT');
});
