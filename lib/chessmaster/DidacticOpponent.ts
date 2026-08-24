// Verbatim copy of ChessMaster/lib/DidacticOpponent.ts. Client-side only: plays back the
// scripted PGN intro move-by-move in the browser before handing control to the learner. Pure
// presentation/pacing (setTimeout in the component that drives it is animation speed, not an
// authoritative session timer — SR-003 is unaffected). Does not touch the container or any
// capability; the actual move validation happens server-side via apps/chessmaster's activity.
import { Chess } from 'chess.js'

export interface StockfishProvider {
  getBestMove(fen: string, depth?: number): Promise<string>
}

export interface DidacticOpponentConfig {
  scriptedPgn:      string            // Full PGN of the scripted game
  patternFen:       string            // FEN where student must find the pattern move
  bestMove:         string            // Correct UCI move e.g. "d3e5"
  stockfishDepth?:  number
  stockfishWorker?: StockfishProvider // Injected for getStockfishMove; optional in tests
}

export interface OpponentState {
  scriptComplete:      boolean
  patternMomentReached: boolean
  moveIndex:           number
  totalScriptedMoves:  number
}

// ── FEN normalisation ─────────────────────────────────────────────
// Compare only first 4 fields: position, turn, castling, en passant
// Ignore halfmove clock and fullmove number to avoid false negatives
export function normaliseFen(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ')
}

// ── Parse PGN into list of UCI moves ─────────────────────────────
// Supports [FEN "..."] headers for games starting from a custom position.
export function parsePgnToMoves(pgn: string): string[] {
  if (!pgn.trim()) return []

  const fenMatch = pgn.match(/\[FEN "([^"]+)"\]/)
  const game     = fenMatch ? new Chess(fenMatch[1]) : new Chess()
  const moves: string[] = []

  // Strip headers
  const lines = pgn.split('\n').filter(l => !l.startsWith('[') && l.trim())
  const moveText = lines.join(' ')

  // Remove move numbers (both "1." and "1...") and result tokens
  const tokens = moveText
    .replace(/\d+\.\.\./g, '')
    .replace(/\d+\./g, '')
    .replace(/\*|1-0|0-1|1\/2-1\/2/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  for (const token of tokens) {
    try {
      const result = game.move(token)
      if (result) {
        moves.push(`${result.from}${result.to}${result.promotion ?? ''}`)
      }
    } catch {
      // Skip invalid tokens (comments, annotations)
    }
  }

  return moves
}

// ── DidacticOpponent ─────────────────────────────────────────────
export class DidacticOpponent {
  private readonly scriptedMoves: string[]
  private readonly patternFenNorm: string
  readonly bestMove: string
  private moveIndex: number

  constructor(private config: DidacticOpponentConfig) {
    this.scriptedMoves  = parsePgnToMoves(config.scriptedPgn)
    this.patternFenNorm = normaliseFen(config.patternFen)
    this.bestMove       = config.bestMove
    this.moveIndex      = 0
  }

  // ── isPatternMoment ───────────────────────────────────────────
  // Returns true when the current board matches the pattern position
  isPatternMoment(board: Chess): boolean {
    return normaliseFen(board.fen()) === this.patternFenNorm
  }

  // ── getMove ───────────────────────────────────────────────────
  // Returns next scripted UCI move, or null when pattern moment reached.
  // After pattern moment: caller should switch to Stockfish / end game.
  getMove(board: Chess): string | null {
    if (this.isPatternMoment(board)) return null

    if (this.moveIndex >= this.scriptedMoves.length) return null

    const move = this.scriptedMoves[this.moveIndex]
    this.moveIndex++
    return move
  }

  // ── validateStudentMove ──────────────────────────────────────
  // Checks if the student's UCI move matches the correct pattern move
  validateStudentMove(studentMove: string): boolean {
    return studentMove.toLowerCase() === this.bestMove.toLowerCase()
  }

  // ── getState ──────────────────────────────────────────────────
  getState(): OpponentState {
    return {
      scriptComplete:       this.moveIndex >= this.scriptedMoves.length,
      patternMomentReached: false, // evaluated per-call via isPatternMoment
      moveIndex:            this.moveIndex,
      totalScriptedMoves:   this.scriptedMoves.length,
    }
  }

  // ── getStockfishMove ──────────────────────────────────────────
  // Called after the pattern moment for normal CPU play.
  // Requires stockfishWorker to be provided in config.
  async getStockfishMove(board: Chess): Promise<string> {
    if (!this.config.stockfishWorker) {
      throw new Error('StockfishWorker not provided in DidacticOpponentConfig')
    }
    return this.config.stockfishWorker.getBestMove(board.fen(), this.config.stockfishDepth ?? 8)
  }

  // ── reset ────────────────────────────────────────────────────
  reset(): void {
    this.moveIndex = 0
  }
}
