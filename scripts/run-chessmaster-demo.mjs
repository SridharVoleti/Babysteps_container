// Host/composition script for the ChessMaster vertical slice, in the same spirit as
// scripts/run-container-conformance.mjs: it wires container-owned primitives (bootstrap,
// session lifecycle/completion, activity lifecycle manager, progress adapter) around the real
// apps/chessmaster package and plays through one representative learner interaction end to end,
// printing what happened at each step. This composition script is intentionally NOT part of
// apps/chessmaster — app code is never allowed to wire session/progress infrastructure itself
// (CC-001/CC-003); only a container-side host may.
//
// Run with:  node scripts/run-chessmaster-demo.mjs
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootstrapLearningApp } from '../src/container/internal/bootstrap/atomic-bootstrap.mjs';
import { manifestContract } from '../src/container/internal/manifest/contract.mjs';
import { getRuntimeContext } from '../src/container/internal/runtime/authorized-runtime-identity.mjs';
import { createSessionLifecycle } from '../src/container/internal/session/session-lifecycle.mjs';
import { createSessionCompletion, createFinalizationAdapter } from '../src/container/internal/session/session-completion.mjs';
import { createActivityLifecycleManager } from '../src/container/internal/activities/activity-lifecycle-manager.mjs';
import { createProgressAdapter } from '../src/container/internal/progress/progress-adapter.mjs';

const MANIFEST_PATH = fileURLToPath(new URL('../apps/chessmaster/app.manifest.json', import.meta.url));
const PUZZLE = JSON.parse(await readFile(new URL('../apps/chessmaster/content/pattern-fork-01.json', import.meta.url), 'utf8')).puzzle;

// Stand-in for a real Babysteps-issued launch envelope + verifier (SB-001). Production wiring
// uses createBabystepsLaunchVerifier() with BABYSTEPS_LAUNCH_VERIFICATION_KEY — see
// atomic-bootstrap.mjs#resolveDefaultVerifier. This demo supplies its own dev-only verifier so
// it can run without a live platform.
const claims = Object.freeze({
  learnerId: 'demo-learner', appId: 'chessmaster', releaseId: 'demo-release', sessionId: 'demo-session',
  launchMode: 'start', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  correlationId: 'demo-correlation',
});
const proof = (c) => createHash('sha256').update(JSON.stringify(c)).digest('hex');
const launchContext = { claims, proof: proof(claims) };
const verifier = async (ctx) => ({ ok: ctx?.proof === proof(ctx?.claims ?? {}), claims: ctx?.claims });

console.log('--- SB-001/SB-003: bootstrapping the container and loading the authorized chessmaster app ---');
const { readiness, appDefinition } = await bootstrapLearningApp({
  manifestPath: MANIFEST_PATH,
  manifestOptions: manifestContract,
  launchContext,
  launchOptions: { expectedReleaseId: claims.releaseId, expectedSessionId: claims.sessionId, verifier },
  capabilityAdapters: { progress: { version: '1.0', save: async () => ({ saved: true }) } },
  loadModule: (url) => import(url),
});
console.log(`readiness: ${readiness.phase} (correlationId=${readiness.correlationId})`);
console.log(`loaded app: ${appDefinition.id} / activity: ${appDefinition.activity.activityId}`);

const identity = getRuntimeContext(readiness.runtime);
console.log(`bound runtime identity: learner=${identity.learnerId} app=${identity.appId} session=${identity.sessionId}`);

const progressAdapter = createProgressAdapter({
  progressClient: { call: async (op, payload) => {
    console.log(`  [PA-001] progress.checkpoint ->`, JSON.stringify(payload.appProgress));
    return { acknowledged: true, progressVersion: '1' };
  } },
});
const finalizationAdapter = createFinalizationAdapter({
  progressClient: { call: async () => ({ saved: true }) },
  finalizationClient: { call: async () => { console.log('  [SR-004] session.finalize -> completed'); return { finalStatus: 'completed' }; } },
});
const lifecycle = createSessionLifecycle({ sessionIdentity: identity, sessionAdapter: finalizationAdapter });
const completion = createSessionCompletion({ sessionIdentity: identity, lifecycle });
const manager = createActivityLifecycleManager({
  runtimeBinding: readiness.runtime,
  lifecycle,
  completion,
  onMeaningfulProgress: async (payload) => { await progressAdapter.checkpoint({ patternKey: payload.patternKey, xpAwarded: payload.xpAwarded }, {}); },
  onFailure: (normalized) => console.warn(`  [AH-001] activity failure signal: ${normalized.code} - ${normalized.message}`),
});

await lifecycle.signal('activity-ready');
console.log('\n--- AH-002: activating the pattern-training activity with the fork puzzle ---');
const handle = manager.activate(appDefinition.activity, { content: { puzzle: PUZZLE } });
console.log(`puzzle: "${PUZZLE.title}" (${PUZZLE.opening}) — pattern: ${PUZZLE.patternKey}`);

console.log('\n--- learner interaction ---');
for (const move of ['e2e4', 'e2e4', PUZZLE.bestMove]) {
  const result = await handle.implementation.attemptMove(move);
  console.log(`attemptMove(${move}) ->`, JSON.stringify({ correct: result.correct, showAnswer: result.showAnswer, xpAwarded: result.xpAwarded, feedback: result.feedback }));
}

manager.endSession('PUZZLE_COMPLETED');
console.log(`\nsession lifecycle state: ${lifecycle.state}`);
console.log('done.');
