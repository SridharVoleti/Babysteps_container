/**
 * Verbatim copy of ChessMaster/lib/confetti.ts — pure confetti-burst generator.
 *
 * Framework-agnostic: produces plain data that any renderer (React, Vue,
 * canvas…) can turn into falling confetti. All tunables come from
 * ConfettiConfig; randomness is injectable for deterministic tests.
 */

export type ConfettiShape = 'square' | 'circle' | 'triangle' | 'star'

export interface ConfettiConfig {
  /** number of pieces in the burst (floored, clamped to ≥ 0) */
  count: number
  /** CSS colors; each piece picks one */
  colors: readonly string[]
  /** shapes; each piece picks one */
  shapes: readonly ConfettiShape[]
  /** piece edge length in px [min, max] */
  sizeRangePx: readonly [number, number]
  /** fall duration in ms [min, max] */
  fallDurationRangeMs: readonly [number, number]
  /** stagger before a piece starts falling, ms [min, max] */
  startDelayRangeMs: readonly [number, number]
  /** horizontal drift over the fall, viewport-width units [min, max] */
  driftRangeVw: readonly [number, number]
  /** total rotation over the fall, degrees [min, max]; sign is random */
  spinRangeDeg: readonly [number, number]
}

export interface ConfettiPiece {
  id: number
  /** starting horizontal position, 0–100 (% of container width) */
  leftPct: number
  sizePx: number
  color: string
  shape: ConfettiShape
  fallDurationMs: number
  startDelayMs: number
  driftVw: number
  /** signed rotation; negative spins counter-clockwise */
  spinDeg: number
}

export const DEFAULT_CONFETTI_CONFIG: ConfettiConfig = {
  count: 70,
  colors: ['#f97316', '#3b82f6', '#22c55e', '#eab308', '#ec4899', '#8b5cf6'],
  shapes: ['square', 'circle', 'triangle', 'star'],
  sizeRangePx: [8, 16],
  fallDurationRangeMs: [1800, 3200],
  startDelayRangeMs: [0, 600],
  driftRangeVw: [-18, 18],
  spinRangeDeg: [180, 900],
}

function inRange(random: () => number, [min, max]: readonly [number, number]): number {
  return min + random() * (max - min)
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!
}

/**
 * Generate one confetti burst.
 *
 * @param overrides partial config merged over DEFAULT_CONFETTI_CONFIG
 * @param random    RNG returning [0, 1); defaults to Math.random —
 *                  inject a seeded RNG for deterministic output
 * @throws if the effective colors or shapes list is empty
 */
export function generateConfetti(
  overrides: Partial<ConfettiConfig> = {},
  random: () => number = Math.random,
): ConfettiPiece[] {
  const cfg: ConfettiConfig = { ...DEFAULT_CONFETTI_CONFIG, ...overrides }
  if (cfg.colors.length === 0) throw new Error('generateConfetti: colors must be non-empty')
  if (cfg.shapes.length === 0) throw new Error('generateConfetti: shapes must be non-empty')

  const count = Math.max(0, Math.floor(cfg.count))
  return Array.from({ length: count }, (_, id) => ({
    id,
    leftPct: inRange(random, [0, 100]),
    sizePx: inRange(random, cfg.sizeRangePx),
    color: pick(random, cfg.colors),
    shape: pick(random, cfg.shapes),
    fallDurationMs: Math.round(inRange(random, cfg.fallDurationRangeMs)),
    startDelayMs: Math.round(inRange(random, cfg.startDelayRangeMs)),
    driftVw: inRange(random, cfg.driftRangeVw),
    spinDeg: Math.round(inRange(random, cfg.spinRangeDeg)) * (random() < 0.5 ? -1 : 1),
  }))
}
