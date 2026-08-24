// Unit test for the AH-001 activity adapter itself, using a hand-built fake context (no
// container internals imported — apps/ code, including its tests, may only ever import the
// public @babysteps/consumer-app-container package or nothing at all; see
// ../../../tests/integration/chessmaster-vertical-slice.test.mjs for the real container-wired
// end-to-end coverage, which lives outside apps/ for exactly this reason).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chessPatternTrainingActivity } from '../src/activity.mjs';
import forkPuzzle from '../content/pattern-fork-01.json' with { type: 'json' };

function fakeContext(content) {
  const calls = { ready: 0, meaningfulProgress: [], completed: [], failed: [] };
  return {
    context: {
      content,
      events: {
        ready: async () => { calls.ready += 1; },
        meaningfulProgress: async (payload) => { calls.meaningfulProgress.push(payload); },
        completed: async (payload) => { calls.completed.push(payload); return { finalStatus: 'completed' }; },
        failed: (payload) => { calls.failed.push(payload); return { code: payload.code, message: payload.message }; },
      },
    },
    calls,
  };
}

test('resumeAttemptNumber lets a stateless host carry attempt count across activity instances', async () => {
  const { context, calls } = fakeContext({ puzzle: forkPuzzle.puzzle, resumeAttemptNumber: 2 });
  const impl = chessPatternTrainingActivity.create(context);

  const result = await impl.attemptMove(forkPuzzle.puzzle.bestMove);

  assert.equal(result.correct, true);
  assert.equal(result.attemptNumber, 3);
  assert.equal(calls.meaningfulProgress[0].attemptNumber, 3);
  assert.equal(calls.completed.length, 1);
});

test('resumeAttemptNumber defaults to 0 when omitted (unchanged behavior)', async () => {
  const { context } = fakeContext({ puzzle: forkPuzzle.puzzle });
  const impl = chessPatternTrainingActivity.create(context);
  assert.equal(impl.attemptNumber, 0);
});

test('an invalid resumeAttemptNumber (negative/non-integer) is ignored, starting from 0', async () => {
  const { context } = fakeContext({ puzzle: forkPuzzle.puzzle, resumeAttemptNumber: -1 });
  const impl = chessPatternTrainingActivity.create(context);
  assert.equal(impl.attemptNumber, 0);
});
