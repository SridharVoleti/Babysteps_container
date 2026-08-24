// AH-001/AH-002 activity definition: the adapter between the container's standard learning
// activity contract and ChessMaster's existing pattern-training logic. This module owns no
// platform infrastructure (no network, no storage, no session/timer authority) — it only
// evaluates a learner's move with the prototype's validateMove() and reports outcomes through
// the standard event channel (ready / meaningfulProgress / completed / failed). What happens to
// those events (progress persistence, session completion) is entirely container/host-owned.
import { validateMove } from './prototype/pattern-validator.mjs';

const UCI_MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/i;

export const chessPatternTrainingActivity = Object.freeze({
  activityId: 'pattern-training',
  // No direct container services are used: progress is reported via events.meaningfulProgress
  // / events.completed and persisted by whatever the host wires those callbacks to (PA-001),
  // not by this activity calling a capability directly.
  requiredServices: [],

  create(context) {
    const { events, content } = context;
    const puzzle = content?.puzzle;
    if (!puzzle || typeof puzzle.bestMove !== 'string' || puzzle.bestMove.trim() === '') {
      throw new TypeError('pattern-training activity requires context.content.puzzle with at least a bestMove.');
    }
    if (!puzzle.lesson || typeof puzzle.lesson.feedback_correct !== 'string') {
      throw new TypeError('pattern-training activity requires context.content.puzzle.lesson feedback text.');
    }

    // resumeAttemptNumber lets a stateless host (one activity instance per HTTP request,
    // e.g. a serverless runtime route) carry attempt-count continuity across requests: the
    // caller tracks the count itself and hands the last-known value back in. Defaults to 0
    // (unchanged behavior) so every existing caller/test is unaffected.
    const startingAttemptNumber = Number.isInteger(content?.resumeAttemptNumber) && content.resumeAttemptNumber >= 0
      ? content.resumeAttemptNumber
      : 0;
    let attemptNumber = startingAttemptNumber;
    let settled = false;

    // The puzzle content is already resolved by the time create() runs, so the activity can
    // announce readiness immediately. Fire-and-forget: mountActivity/activate() do not await
    // create()'s return value, so a rejected ready() is surfaced to the host via its own
    // telemetry/error handling rather than by throwing out of create().
    events.ready().catch(() => {});

    async function attemptMove(playerMoveUci) {
      if (settled) {
        throw new Error('This puzzle has already been settled; activate a new activity instance for the next puzzle.');
      }
      if (typeof playerMoveUci !== 'string' || !UCI_MOVE_PATTERN.test(playerMoveUci.trim())) {
        return events.failed({
          code: 'INVALID_MOVE_FORMAT',
          message: 'A move must be given in UCI notation, e.g. "d4d5" or "e7e8q".',
        });
      }

      attemptNumber += 1;
      const result = validateMove(playerMoveUci, puzzle.bestMove, attemptNumber, puzzle.lesson, {
        patternFen: puzzle.patternFen ?? null,
        patternKey: puzzle.patternKey ?? null,
      });

      await events.meaningfulProgress({
        patternKey: puzzle.patternKey ?? null,
        attemptNumber: result.attemptNumber,
        correct: result.correct,
        xpAwarded: result.xpAwarded,
      });

      if (result.correct || result.showAnswer) {
        settled = true;
        await events.completed({
          patternKey: puzzle.patternKey ?? null,
          solved: result.correct,
          attempts: attemptNumber,
          xpAwarded: result.xpAwarded,
        });
      }

      return result;
    }

    return Object.freeze({
      get puzzle() { return puzzle; },
      get attemptNumber() { return attemptNumber; },
      get isSettled() { return settled; },
      attemptMove,
    });
  },
});
