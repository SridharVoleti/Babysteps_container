// Mechanical JS transcription of ChessMaster's lib/constants.ts (type annotations removed,
// logic/values unchanged). Source of truth remains ../../../../ChessMaster/lib/constants.ts —
// see apps/chessmaster/src/prototype/README.md for why this container runs a transcribed copy
// instead of importing the .ts file directly.

// ── Pattern sequence — fixed order, do not reorder ────────────────
export const PATTERN_SEQUENCE = [
  { key: 'fork',              displayName: 'Fork',             tier: 'Beginner',     icon: '♞', isFree: true },
  { key: 'pin',               displayName: 'Pin',              tier: 'Beginner',     icon: '📌', isFree: true },
  { key: 'back_rank_mate',    displayName: 'Back rank mate',   tier: 'Beginner',     icon: '♜', isFree: false },
  { key: 'skewer',            displayName: 'Skewer',           tier: 'Intermediate', icon: '→', isFree: false },
  { key: 'discovered_attack', displayName: 'Discovered attack', tier: 'Intermediate', icon: '👁', isFree: false },
  { key: 'double_check',      displayName: 'Double check',     tier: 'Intermediate', icon: '✓', isFree: false },
  { key: 'deflection',        displayName: 'Deflection',       tier: 'Advanced',     icon: '↗', isFree: false },
  { key: 'decoy',             displayName: 'Decoy',            tier: 'Advanced',     icon: '🎣', isFree: false },
  { key: 'smothered_mate',    displayName: 'Smothered mate',   tier: 'Advanced',     icon: '♞', isFree: false },
  { key: 'overloading',       displayName: 'Overloading',      tier: 'Expert',       icon: '⚖', isFree: false },
  { key: 'x_ray_attack',      displayName: 'X-Ray attack',     tier: 'Expert',       icon: '🔍', isFree: false },
  { key: 'zwischenzug',       displayName: 'Zwischenzug',      tier: 'Expert',       icon: '⚡', isFree: false },
];

export const FREE_PATTERNS = ['fork', 'pin'];

export const TIER_ORDER = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];

// ── XP system ─────────────────────────────────────────────────────
export const XP_LEVELS = [
  { level: 1, label: 'Beginner',              xpRequired: 0 },
  { level: 2, label: 'Improver',              xpRequired: 500 },
  { level: 3, label: 'Intermediate',          xpRequired: 1200 },
  { level: 4, label: 'Advanced',              xpRequired: 2200 },
  { level: 5, label: 'Grandmaster candidate', xpRequired: 3500 },
];

export const XP_REWARDS = {
  COMPLETE_GAME:     20,
  CORRECT_ATTEMPT_1: 30, // bonus on top of COMPLETE_GAME
  CORRECT_ATTEMPT_2: 15,
  CORRECT_ATTEMPT_3: 5,
  PATTERN_MASTERED:  100,
  STREAK_MILESTONE:  50,
  PATTERN_SPOTTED:   15, // live pattern found during a main game
};

export const STREAK_MILESTONES = [7, 14, 30];

// ── Attempt config ────────────────────────────────────────────────
export const MAX_ATTEMPTS = 3;

// ── Helper: get pattern index ──────────────────────────────────────
export function getPatternIndex(key) {
  return PATTERN_SEQUENCE.findIndex((p) => p.key === key);
}

// ── Helper: get next pattern ───────────────────────────────────────
export function getNextPattern(current) {
  const idx = getPatternIndex(current);
  if (idx === -1 || idx >= PATTERN_SEQUENCE.length - 1) return null;
  return PATTERN_SEQUENCE[idx + 1].key;
}

// ── Helper: XP level from total XP ────────────────────────────────
export function getLevelFromXP(xp) {
  let current = XP_LEVELS[0];
  for (const lvl of XP_LEVELS) {
    if (xp >= lvl.xpRequired) current = lvl;
  }
  return current;
}

export function getNextLevelXP(xp) {
  const currentLevel = getLevelFromXP(xp);
  const nextLevel = XP_LEVELS.find((l) => l.level === currentLevel.level + 1);
  return nextLevel?.xpRequired ?? currentLevel.xpRequired + 500;
}
