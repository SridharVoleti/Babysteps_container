// Parity test: a representative subset of ChessMaster/__tests__/patternDetectors.test.ts,
// against the transcribed copy in ../src/prototype/pattern-detectors.mjs. The 'fork #1' case
// is the exact puzzle shipped as this app's vertical-slice content (../content/pattern-fork-01.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { DETECTORS, patternMoves, squaresBetween } from '../src/prototype/pattern-detectors.mjs';
import forkPuzzle from '../content/pattern-fork-01.json' with { type: 'json' };

test('fork #1 (The Pawn Wedge): the shipped puzzle content is a real, detector-verified fork', () => {
  const { patternFen, bestMove } = forkPuzzle.puzzle;
  assert.equal(DETECTORS.fork(patternFen, bestMove), true);
  assert.ok(patternMoves(patternFen, 'fork').includes(bestMove));
});

test('negative cases: a quiet opening move is not a pattern, for every detector', () => {
  const START = new Chess().fen();
  for (const pattern of Object.keys(DETECTORS)) {
    assert.equal(DETECTORS[pattern](START, 'e2e4'), false, `${pattern} should reject a quiet opening move`);
  }
});

test('negative cases: an illegal move returns false, for every detector', () => {
  const START = new Chess().fen();
  for (const pattern of Object.keys(DETECTORS)) {
    assert.equal(DETECTORS[pattern](START, 'e2e5'), false, `${pattern} should reject an illegal move`);
  }
});

test('negative cases: a garbage FEN returns false, for every detector', () => {
  for (const pattern of Object.keys(DETECTORS)) {
    assert.equal(DETECTORS[pattern]('not a fen', 'e2e4'), false, `${pattern} should fail closed on a garbage FEN`);
  }
});

test('double_check: knight discovery gives double check', () => {
  const fen = '4k3/8/8/8/4N3/8/8/4RK2 w - - 0 1';
  assert.equal(DETECTORS.double_check(fen, 'e4d6'), true);
  assert.equal(DETECTORS.double_check(fen, 'e4c3'), false);
});

test('squaresBetween: aligned, unaligned and adjacent squares', () => {
  assert.deepEqual(squaresBetween('a1', 'a4'), ['a2', 'a3']);
  assert.deepEqual(squaresBetween('c1', 'f4'), ['d2', 'e3']);
  assert.deepEqual(squaresBetween('a1', 'b3'), []);
  assert.deepEqual(squaresBetween('a1', 'a2'), []);
});
