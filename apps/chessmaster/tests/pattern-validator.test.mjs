// Parity test: mirrors ChessMaster/__tests__/PatternValidator.test.ts assertion-for-assertion,
// against the transcribed copy in ../src/prototype/pattern-validator.mjs. Keeping these in sync
// is how this integration proves the transcription (see ../src/prototype/README.md) preserved
// the prototype's behaviour rather than just its shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMove,
  shouldIncrementStreak,
  shouldResetStreak,
  computeStreakBonus,
} from '../src/prototype/pattern-validator.mjs';
import { XP_REWARDS } from '../src/prototype/constants.mjs';

const LESSON = {
  feedback_correct: 'Yes! That is a fork!',
  feedback_hint: 'Hint: look at your knight.',
  feedback_reveal: 'The answer was Nd3-e5, a fork!',
};

test('validateMove: attempt 1 correct -> correct:true, xpAwarded 50, showAnswer:false', () => {
  const result = validateMove('d3e5', 'd3e5', 1, LESSON);
  assert.equal(result.correct, true);
  assert.equal(result.xpAwarded, XP_REWARDS.COMPLETE_GAME + XP_REWARDS.CORRECT_ATTEMPT_1);
  assert.equal(result.showAnswer, false);
  assert.equal(result.hint, null);
});

test('validateMove: attempt 2 correct -> xpAwarded 35', () => {
  const result = validateMove('d3e5', 'd3e5', 2, LESSON);
  assert.equal(result.correct, true);
  assert.equal(result.xpAwarded, XP_REWARDS.COMPLETE_GAME + XP_REWARDS.CORRECT_ATTEMPT_2);
});

test('validateMove: attempt 3 correct -> xpAwarded 25', () => {
  const result = validateMove('d3e5', 'd3e5', 3, LESSON);
  assert.equal(result.correct, true);
  assert.equal(result.xpAwarded, XP_REWARDS.COMPLETE_GAME + XP_REWARDS.CORRECT_ATTEMPT_3);
});

test('validateMove: attempt 1 wrong -> correct:false, hint:null, showAnswer:false, xp:0', () => {
  const result = validateMove('e2e4', 'd3e5', 1, LESSON);
  assert.equal(result.correct, false);
  assert.equal(result.hint, null);
  assert.equal(result.showAnswer, false);
  assert.equal(result.xpAwarded, 0);
});

test('validateMove: attempt 2 wrong -> hint is a non-empty string', () => {
  const result = validateMove('e2e4', 'd3e5', 2, LESSON);
  assert.equal(result.correct, false);
  assert.notEqual(result.hint, null);
  assert.equal(typeof result.hint, 'string');
  assert.ok(result.hint.length > 0);
  assert.equal(result.showAnswer, false);
});

test('validateMove: attempt 3 wrong -> showAnswer:true, xpAwarded base only', () => {
  const result = validateMove('e2e4', 'd3e5', 3, LESSON);
  assert.equal(result.correct, false);
  assert.equal(result.showAnswer, true);
  assert.equal(result.xpAwarded, XP_REWARDS.COMPLETE_GAME);
  assert.equal(result.feedback, LESSON.feedback_reveal);
});

test('shouldIncrementStreak: true when lastActive is null (first ever game)', () => {
  assert.equal(shouldIncrementStreak(null), true);
});

test('shouldIncrementStreak: true when last played yesterday (24h ago)', () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  assert.equal(shouldIncrementStreak(yesterday), true);
});

test('shouldIncrementStreak: false when last played today (2h ago)', () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  assert.equal(shouldIncrementStreak(twoHoursAgo), false);
});

test('shouldIncrementStreak: true (reset to 1) when last played 3 days ago', () => {
  const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
  assert.equal(shouldIncrementStreak(threeDaysAgo), true);
});

test('shouldResetStreak: true when last active > 48h ago', () => {
  const oldDate = new Date(Date.now() - 49 * 60 * 60 * 1000);
  assert.equal(shouldResetStreak(oldDate), true);
});

test('shouldResetStreak: false when last active < 48h ago', () => {
  const recent = new Date(Date.now() - 12 * 60 * 60 * 1000);
  assert.equal(shouldResetStreak(recent), false);
});

test('computeStreakBonus: 50 XP on day 7 milestone', () => {
  assert.equal(computeStreakBonus(7), XP_REWARDS.STREAK_MILESTONE);
});

test('computeStreakBonus: 0 for non-milestone streaks', () => {
  assert.equal(computeStreakBonus(5), 0);
  assert.equal(computeStreakBonus(10), 0);
});

test('computeStreakBonus: 50 XP on day 14 and 30 milestones', () => {
  assert.equal(computeStreakBonus(14), XP_REWARDS.STREAK_MILESTONE);
  assert.equal(computeStreakBonus(30), XP_REWARDS.STREAK_MILESTONE);
});
