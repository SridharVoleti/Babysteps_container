'use client'

import { useState, useEffect, useRef } from 'react'
import { Chess }      from 'chess.js'
import { Chessboard } from 'react-chessboard'
import type { CSSProperties } from 'react'

export interface GameBoardProps {
  fen:          string
  onMove?:      (from: string, to: string, promotion?: string) => boolean
  orientation?: 'white' | 'black'
  interactive?: boolean
  boardWidth?:  number
}

// Styles for move-hint dots and rings
const SELECTED_STYLE:  CSSProperties = { background: 'rgba(255, 255, 0, 0.45)' }
const MOVE_DOT_STYLE:  CSSProperties = { background: 'radial-gradient(circle, rgba(0,0,0,.18) 28%, transparent 28%)' }
const CAPTURE_STYLE:   CSSProperties = { background: 'radial-gradient(circle, transparent 62%, rgba(0,0,0,.18) 62%)' }

function getLegalSquares(
  fen:    string,
  square: string,
): Record<string, CSSProperties> {
  try {
    const chess  = new Chess(fen)
    const moves  = chess.moves({ square: square as Parameters<typeof chess.moves>[0]['square'], verbose: true })
    if (moves.length === 0) return {}

    const result: Record<string, CSSProperties> = {
      [square]: SELECTED_STYLE,
    }
    for (const m of moves) {
      result[m.to] = chess.get(m.to as Parameters<typeof chess.get>[0])
        ? CAPTURE_STYLE
        : MOVE_DOT_STYLE
    }
    return result
  } catch {
    return {}
  }
}

export function GameBoard({
  fen,
  onMove,
  orientation = 'white',
  interactive = true,
  boardWidth  = 560,
}: GameBoardProps) {
  const [selected,    setSelected]    = useState<string | null>(null)
  const [squareStyles, setSquareStyles] = useState<Record<string, CSSProperties>>({})

  // Clear highlights whenever the position changes (scripted move played or
  // student move accepted) so stale dots never linger.
  useEffect(() => {
    setSelected(null)
    setSquareStyles({})
  }, [fen])

  // Also clear when the board becomes non-interactive (e.g. answer revealed)
  useEffect(() => {
    if (!interactive) {
      setSelected(null)
      setSquareStyles({})
    }
  }, [interactive])

  // ── Click-to-select / click-to-move ───────────────────────────
  function onSquareClick(square: string) {
    if (!interactive || !onMove) return

    // Clicking a highlighted destination → attempt the move, then clear
    if (selected && square !== selected && squareStyles[square]) {
      onMove(selected, square)
      setSelected(null)
      setSquareStyles({})
      return
    }

    // Clicking the already-selected square → deselect
    if (square === selected) {
      setSelected(null)
      setSquareStyles({})
      return
    }

    // Clicking a new square → compute and show its legal moves
    const styles = getLegalSquares(fen, square)
    if (Object.keys(styles).length <= 1) {
      // No legal moves (wrong colour, empty square, etc.) — just deselect
      setSelected(null)
      setSquareStyles({})
      return
    }
    setSelected(square)
    setSquareStyles(styles)
  }

  // ── Drag-and-drop (existing) ──────────────────────────────────
  // react-chessboard promotion flow: the promotion dialog fires
  // onPromotionPieceSelect first, then re-fires onPieceDrop. We store the
  // result in a ref so the follow-up drop call doesn't double-apply the move.
  const promotionResult = useRef<boolean | null>(null)

  function onPieceDrop(source: string, target: string): boolean {
    if (!onMove || !interactive) return false
    if (promotionResult.current !== null) {
      const handled = promotionResult.current
      promotionResult.current = null
      return handled
    }
    setSelected(null)
    setSquareStyles({})
    return onMove(source, target)
  }

  function onPromotionPieceSelect(
    piece?: string,
    from?:  string,
    to?:    string,
  ): boolean {
    if (!onMove || !interactive || !piece || !from || !to) return false
    promotionResult.current = onMove(from, to, piece[1]?.toLowerCase() ?? 'q')
    return true
  }

  return (
    <div data-testid="chess-board">
      <Chessboard
        position={fen}
        onPieceDrop={onPieceDrop}
        onPromotionPieceSelect={onPromotionPieceSelect}
        onSquareClick={onSquareClick}
        boardOrientation={orientation}
        arePiecesDraggable={interactive}
        customSquareStyles={squareStyles}
        boardWidth={boardWidth}
      />
    </div>
  )
}
