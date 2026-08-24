/**
 * Mechanical JS transcription of ChessMaster's lib/patternDetectors.ts (type annotations
 * and type-only imports removed, logic/values unchanged). Source of truth remains
 * ../../../../ChessMaster/lib/patternDetectors.ts — see ./README.md.
 *
 * Chess tactical-pattern detectors. Pure functions over FEN strings. Each detector answers:
 * "does `moveUci`, played from `fen`, create the named pattern soundly?"
 *
 * Sound = the moved piece cannot be immediately captured at a profit
 * (checked against *legal* replies, so pins and check obligations are
 * respected automatically).
 *
 * Reusable across projects: no game-format or app-specific imports.
 */

import { Chess } from 'chess.js';

export const PIECE_VALUES = {
  p: 1, n: 3, b: 3, r: 5, q: 9, k: 100,
};

const SLIDERS = ['b', 'r', 'q'];

const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ── Square helpers ────────────────────────────────────────────────
const FILES = 'abcdefgh';

function fileOf(s) { return FILES.indexOf(s[0]); }
function rankOf(s) { return Number(s[1]) - 1; }

function makeSquare(file, rank) {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return FILES[file] + String(rank + 1);
}

function* raySquares(from, [df, dr]) {
  let f = fileOf(from) + df;
  let r = rankOf(from) + dr;
  while (true) {
    const s = makeSquare(f, r);
    if (s === null) return;
    yield s;
    f += df;
    r += dr;
  }
}

function sliderDirections(type) {
  if (type === 'b') return DIAG;
  if (type === 'r') return ORTH;
  if (type === 'q') return [...DIAG, ...ORTH];
  return [];
}

/** Squares strictly between two aligned squares; empty array if unaligned. */
export function squaresBetween(a, b) {
  const df = fileOf(b) - fileOf(a);
  const dr = rankOf(b) - rankOf(a);
  if (df === 0 && dr === 0) return [];
  if (df !== 0 && dr !== 0 && Math.abs(df) !== Math.abs(dr)) return [];
  const step = [Math.sign(df), Math.sign(dr)];
  const out = [];
  for (const s of raySquares(a, step)) {
    if (s === b) break;
    out.push(s);
  }
  return out;
}

// ── Board helpers ─────────────────────────────────────────────────
function other(color) { return color === 'w' ? 'b' : 'w'; }

function pieceValue(piece) {
  return piece ? PIECE_VALUES[piece.type] : 0;
}

function* allPieces(game) {
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const s = makeSquare(f, r);
      const p = game.get(s);
      if (p) yield [s, p];
    }
  }
}

function findKing(game, color) {
  for (const [s, p] of allPieces(game)) {
    if (p.type === 'k' && p.color === color) return s;
  }
  return null;
}

/** True if the piece on `square` attacks `target` (pseudo-legal attack). */
function attacksSquare(game, square, target) {
  const piece = game.get(square);
  if (!piece) return false;
  return game.attackers(target, piece.color).includes(square);
}

/**
 * True if the piece on `square` cannot be captured at a profit by any
 * legal reply. Equal-value trades by an undefended capture also count
 * as unsafe (the tactic would just be a swap, not a pattern win).
 */
export function isMoveSafe(gameAfter, square) {
  const mover = gameAfter.get(square);
  if (!mover) return true;
  const moverVal = PIECE_VALUES[mover.type];
  const defenders = gameAfter.attackers(square, mover.color);

  for (const reply of gameAfter.moves({ verbose: true })) {
    if (reply.to !== square || !reply.captured) continue;
    const capturerVal = PIECE_VALUES[reply.piece];
    if (capturerVal < moverVal) return false; // cheaper piece takes: always a loss
    if (defenders.length === 0) return false; // undefended: any capture loses
  }
  return true;
}

/** For each ray of the slider on sliderSq, yield [front, behind]:
 *  the first two occupied squares along the ray. */
function* linePairs(game, sliderSq) {
  const slider = game.get(sliderSq);
  if (!slider) return;
  for (const dir of sliderDirections(slider.type)) {
    let front = null;
    for (const s of raySquares(sliderSq, dir)) {
      if (!game.get(s)) continue;
      if (front === null) {
        front = s;
      } else {
        yield [front, s];
        break;
      }
    }
  }
}

/** Absolute pin: the piece on `square` shields its own king from an
 *  enemy slider along a straight or diagonal line. */
function isAbsolutelyPinned(game, square) {
  const piece = game.get(square);
  if (!piece) return false;
  const kingSq = findKing(game, piece.color);
  if (!kingSq || kingSq === square) return false;

  const df = fileOf(square) - fileOf(kingSq);
  const dr = rankOf(square) - rankOf(kingSq);
  if (df !== 0 && dr !== 0 && Math.abs(df) !== Math.abs(dr)) return false;

  // king -> square must be unobstructed
  for (const s of squaresBetween(kingSq, square)) {
    if (game.get(s)) return false;
  }
  // continue past the piece: first occupied square must be an enemy
  // slider that moves along this direction
  const step = [Math.sign(df), Math.sign(dr)];
  const diagonal = step[0] !== 0 && step[1] !== 0;
  for (const s of raySquares(square, step)) {
    const p = game.get(s);
    if (!p) continue;
    if (p.color === piece.color) return false;
    if (p.type === 'q') return true;
    return diagonal ? p.type === 'b' : p.type === 'r';
  }
  return false;
}

/** Apply a UCI move if legal; null otherwise. */
function applyMove(fen, moveUci) {
  let before;
  try {
    before = new Chess(fen);
  } catch {
    return null;
  }
  const from = moveUci.slice(0, 2);
  const to = moveUci.slice(2, 4);
  const promotion = moveUci.slice(4, 5) || undefined;

  const legal = before.moves({ verbose: true }).find(
    (m) => m.from === from && m.to === to && (m.promotion ?? '') === (promotion ?? '')
  );
  if (!legal) return null;

  const after = new Chess(fen);
  after.move({ from, to, promotion });
  return { before, after, from, to, color: before.turn(), wasCapture: Boolean(legal.captured) };
}

// ── Detectors ─────────────────────────────────────────────────────

/** Moved piece attacks >=2 enemy targets at once, each of which is
 *  the king (check), worth more than the mover, or undefended. */
export function detectFork(fen, moveUci) {
  const ctx = applyMove(fen, moveUci);
  if (!ctx) return false;
  const { after, to } = ctx;
  const mover = after.get(to);
  if (!mover || !isMoveSafe(after, to)) return false;

  const moverVal = PIECE_VALUES[mover.type];
  const enemy = other(mover.color);
  let targets = 0;
  for (const [t, victim] of allPieces(after)) {
    if (victim.color !== enemy) continue;
    if (!attacksSquare(after, to, t)) continue;
    if (victim.type === 'k') {
      targets += 1;
    } else if (PIECE_VALUES[victim.type] > moverVal) {
      targets += 1;
    } else if (PIECE_VALUES[victim.type] >= 3 && after.attackers(t, enemy).length === 0) {
      targets += 1;
    }
  }
  return targets >= 2;
}

/** Move places a slider so an enemy piece is stuck in front of its
 *  king (absolute pin) or in front of a heavier piece (Q/R behind). */
export function detectPin(fen, moveUci) {
  const ctx = applyMove(fen, moveUci);
  if (!ctx) return false;
  const { after, to } = ctx;
  const mover = after.get(to);
  if (!mover || !SLIDERS.includes(mover.type)) return false;
  if (!isMoveSafe(after, to)) return false;

  const enemy = other(mover.color);
  for (const [front, behind] of linePairs(after, to)) {
    const p1 = after.get(front);
    const p2 = after.get(behind);
    if (p1.color !== enemy || p2.color !== enemy) continue;
    if (p1.type === 'k') continue; // that ordering is a skewer, not a pin
    if (PIECE_VALUES[p1.type] < 3) continue; // pinned pawns are not worth teaching
    // Fake pin: the "pinned" piece can simply capture the pinner
    // (e.g. bishop "pinning" a bishop on the same diagonal).
    if (attacksSquare(after, front, to)) {
      const pinnerDefended = after.attackers(to, mover.color).length > 0;
      if (!pinnerDefended || PIECE_VALUES[p1.type] <= PIECE_VALUES[mover.type]) continue;
    }
    const absolute = p2.type === 'k';
    const relative = PIECE_VALUES[p2.type] >= 5 && PIECE_VALUES[p2.type] > PIECE_VALUES[p1.type];
    if (absolute && isAbsolutelyPinned(after, front)) return true;
    if (relative) return true;
  }
  return false;
}

/** Move attacks a high-value enemy piece (K or Q) in line with a
 *  lesser piece behind it: when the front piece moves, the back one falls. */
export function detectSkewer(fen, moveUci) {
  const ctx = applyMove(fen, moveUci);
  if (!ctx) return false;
  const { after, to } = ctx;
  const mover = after.get(to);
  if (!mover || !SLIDERS.includes(mover.type)) return false;
  if (!isMoveSafe(after, to)) return false;

  const enemy = other(mover.color);
  const moverVal = PIECE_VALUES[mover.type];
  for (const [front, behind] of linePairs(after, to)) {
    const p1 = after.get(front);
    const p2 = after.get(behind);
    if (p1.color !== enemy || p2.color !== enemy) continue;
    const frontForced =
      p1.type === 'k' || (p1.type === 'q' && moverVal < PIECE_VALUES[p1.type]);
    if (!frontForced) continue;
    if (!(PIECE_VALUES[p2.type] >= 3 && PIECE_VALUES[p2.type] < PIECE_VALUES[p1.type])) continue;
    // The loot must actually be winnable once the front piece flees:
    // undefended (not counting the fleeing piece), or worth more
    // than the attacker.
    const defenders = after.attackers(behind, enemy).filter((s) => s !== front);
    if (defenders.length === 0 || PIECE_VALUES[p2.type] > moverVal) return true;
  }
  return false;
}

/** Moving one piece uncovers a friendly slider's attack on the enemy
 *  king (discovered check) or a heavy piece, while the moved piece itself
 *  also does something (captures, checks, or attacks material). */
export function detectDiscoveredAttack(fen, moveUci) {
  const ctx = applyMove(fen, moveUci);
  if (!ctx) return false;
  const { before, after, from, to, color, wasCapture } = ctx;
  const enemy = other(color);

  if (!isMoveSafe(after, to)) return false;

  let bestDiscovered = 0; // 100 = king, 9 = queen, 5 = rook
  outer:
  for (const [sliderSq, slider] of allPieces(after)) {
    if (slider.color !== color || !SLIDERS.includes(slider.type)) continue;
    if (sliderSq === to) continue; // the mover itself is not the discovered piece
    for (const [target, victim] of allPieces(after)) {
      if (victim.color !== enemy) continue;
      if (victim.type !== 'k' && PIECE_VALUES[victim.type] < 5) continue;
      if (!attacksSquare(after, sliderSq, target)) continue;
      // The vacated square must sit on the line between slider and target.
      if (!squaresBetween(sliderSq, target).includes(from)) continue;
      if (attacksSquare(before, sliderSq, target)) continue; // already attacked
      // Refutable: the attacked piece just captures the slider.
      if (
        attacksSquare(after, target, sliderSq) &&
        after.attackers(sliderSq, color).length === 0
      ) continue;
      bestDiscovered = Math.max(bestDiscovered, PIECE_VALUES[victim.type]);
      if (bestDiscovered >= 9) break outer;
    }
  }
  if (!bestDiscovered) return false;

  // A revealed attack on king or queen forces a response by itself.
  if (bestDiscovered >= 9) return true;

  // A revealed attack on a rook needs the mover to add its own threat
  // (a true double attack), or the rook simply steps away.
  if (wasCapture) return true;
  if (after.isCheck()) return true;
  const moverVal = pieceValue(after.get(to));
  for (const [t, victim] of allPieces(after)) {
    if (victim.color !== enemy) continue;
    if (!attacksSquare(after, to, t)) continue;
    if (PIECE_VALUES[victim.type] > moverVal) return true;
    if (PIECE_VALUES[victim.type] >= 3 && after.attackers(t, enemy).length === 0) return true;
  }
  return false;
}

/** Two pieces give check simultaneously. */
export function detectDoubleCheck(fen, moveUci) {
  const ctx = applyMove(fen, moveUci);
  if (!ctx) return false;
  const { after, color } = ctx;
  const kingSq = findKing(after, other(color));
  if (!kingSq) return false;
  return after.attackers(kingSq, color).length === 2;
}

/** Checkmate delivered by a heavy piece along the enemy back rank,
 *  the king walled in on that rank. */
export function detectBackRankMate(fen, moveUci) {
  const ctx = applyMove(fen, moveUci);
  if (!ctx) return false;
  const { after, color } = ctx;
  if (!after.isCheckmate()) return false;

  const enemy = other(color); // side that just got mated
  const kingSq = findKing(after, enemy);
  if (!kingSq) return false;
  const backRank = enemy === 'b' ? 7 : 0;
  if (rankOf(kingSq) !== backRank) return false;

  for (const checkerSq of after.attackers(kingSq, color)) {
    const checker = after.get(checkerSq);
    if ((checker.type === 'r' || checker.type === 'q') && rankOf(checkerSq) === backRank) {
      return true;
    }
  }
  return false;
}

export const DETECTORS = {
  fork: detectFork,
  pin: detectPin,
  skewer: detectSkewer,
  discovered_attack: detectDiscoveredAttack,
  double_check: detectDoubleCheck,
  back_rank_mate: detectBackRankMate,
};

/** All detector-positive moves for `pattern` in the position. */
export function patternMoves(fen, pattern) {
  const detector = DETECTORS[pattern];
  if (!detector) return [];
  const game = new Chess(fen);
  const hits = [];
  for (const m of game.moves({ verbose: true })) {
    const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
    if (detector(fen, uci)) hits.push(uci);
  }
  return hits;
}
