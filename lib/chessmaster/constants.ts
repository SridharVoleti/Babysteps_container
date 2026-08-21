// Verbatim copy of ChessMaster/lib/constants.ts — client-side display data only (pattern
// names/tiers/icons for the UI). The runtime XP/validation logic that also lives in the
// original file is NOT duplicated here; it runs server-side in apps/chessmaster's activity
// (src/prototype/constants.mjs) per CC-003. See ../../apps/chessmaster/src/prototype/README.md.

// ── Pattern sequence — fixed order, do not reorder ────────────────
export const PATTERN_SEQUENCE = [
  { key: 'fork',             displayName: 'Fork',           tier: 'Beginner',     icon: '♞', isFree: true  },
  { key: 'pin',              displayName: 'Pin',            tier: 'Beginner',     icon: '📌', isFree: true  },
  { key: 'back_rank_mate',   displayName: 'Back rank mate', tier: 'Beginner',     icon: '♜', isFree: false },
  { key: 'skewer',           displayName: 'Skewer',         tier: 'Intermediate', icon: '→',  isFree: false },
  { key: 'discovered_attack',displayName: 'Discovered attack', tier: 'Intermediate', icon: '👁', isFree: false },
  { key: 'double_check',     displayName: 'Double check',   tier: 'Intermediate', icon: '✓',  isFree: false },
  { key: 'deflection',       displayName: 'Deflection',     tier: 'Advanced',     icon: '↗',  isFree: false },
  { key: 'decoy',            displayName: 'Decoy',          tier: 'Advanced',     icon: '🎣', isFree: false },
  { key: 'smothered_mate',   displayName: 'Smothered mate', tier: 'Advanced',     icon: '♞', isFree: false },
  { key: 'overloading',      displayName: 'Overloading',    tier: 'Expert',       icon: '⚖', isFree: false },
  { key: 'x_ray_attack',     displayName: 'X-Ray attack',   tier: 'Expert',       icon: '🔍', isFree: false },
  { key: 'zwischenzug',      displayName: 'Zwischenzug',    tier: 'Expert',       icon: '⚡', isFree: false },
] as const

export type PatternKey = typeof PATTERN_SEQUENCE[number]['key']
export type Tier = 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert'

export const FREE_PATTERNS: PatternKey[] = ['fork', 'pin']

export const TIER_ORDER: Tier[] = ['Beginner', 'Intermediate', 'Advanced', 'Expert']
