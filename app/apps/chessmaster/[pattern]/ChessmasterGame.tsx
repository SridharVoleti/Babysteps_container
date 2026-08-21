'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Chess } from 'chess.js'
import { GameBoard } from '@/components/GameBoard'
import { FeedbackPanel } from '@/components/FeedbackPanel'
import { Celebration } from '@/components/Celebration'
import { DidacticOpponent } from '@/lib/chessmaster/DidacticOpponent'
import { PATTERN_SEQUENCE } from '@/lib/chessmaster/constants'

export interface Puzzle {
  patternKey: string
  title: string
  opening: string
  story: string
  patternFen: string
  bestMove: string
  side: 'white' | 'black'
  setupFen: string
  pgn: string
  lesson: {
    feedback_correct: string
    feedback_hint: string
    feedback_reveal: string
  }
}

interface ValidationResult {
  correct: boolean
  feedback: string
  hint: string | null
  showAnswer: boolean
  xpAwarded: number
  attemptNumber: number
}

interface ApiError {
  error: { code: string; message: string }
}

type Status = 'scripted' | 'pattern_moment' | 'correct' | 'wrong' | 'revealed'

const MOVE_DELAY_MS = 600

/**
 * Adapted from ChessMaster's app/play/[pattern]/GamePage.tsx: same board/opponent/feedback
 * choreography, simplified to a single puzzle (no next-game/main-game mode — see the
 * integration report's stated gaps). The only behavioral change is what handleMove calls:
 * the container-mediated /api/runtime/chessmaster/attempt-move route instead of the old
 * direct-Supabase /api/validate-move.
 */
export function ChessmasterGame({ puzzle }: { puzzle: Puzzle }) {
  const patDef = PATTERN_SEQUENCE.find(p => p.key === puzzle.patternKey)

  const [instanceKey, setInstanceKey] = useState(0)
  const gameRef = useRef<Chess>(null!)
  const opponentRef = useRef<DidacticOpponent>(null!)
  const attemptRef = useRef(0)

  const [fen, setFen] = useState(puzzle.setupFen)
  const [status, setStatus] = useState<Status>('scripted')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  // ── Combined init + scripted-move advance ────────────────────
  useEffect(() => {
    const game = new Chess(puzzle.setupFen)
    const opponent = new DidacticOpponent({
      scriptedPgn: puzzle.pgn,
      patternFen: puzzle.patternFen,
      bestMove: puzzle.bestMove,
    })

    gameRef.current = game
    opponentRef.current = opponent
    attemptRef.current = 0

    setFen(game.fen())
    setStatus('scripted')
    setFeedback(null)
    setHint(null)

    let cancelled = false

    async function advance() {
      while (!cancelled) {
        const move = opponent.getMove(game)
        if (move === null) {
          if (!cancelled) setStatus('pattern_moment')
          return
        }
        game.move({ from: move.slice(0, 2), to: move.slice(2, 4) })
        if (!cancelled) setFen(game.fen())
        await new Promise(r => setTimeout(r, MOVE_DELAY_MS))
      }
    }

    advance()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceKey])

  function handleReset() {
    setInstanceKey(k => k + 1)
  }

  // ── Student move ─────────────────────────────────────────────
  const handleMove = useCallback((from: string, to: string, promotion?: string): boolean => {
    if (status !== 'pattern_moment' && status !== 'wrong') return false

    const uci = `${from}${to}${promotion ?? ''}`

    fetch('/api/runtime/chessmaster/attempt-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerMoveUci: uci, resumeAttemptNumber: attemptRef.current }),
    })
      .then(r => r.json() as Promise<ValidationResult | ApiError>)
      .then(result => {
        if ('error' in result) {
          setStatus('pattern_moment')
          setFeedback(result.error.message)
          return
        }
        if (result.correct) {
          try { gameRef.current.move({ from, to, ...(promotion ? { promotion } : {}) }) } catch {}
          setFen(gameRef.current.fen())
          setStatus('correct')
          setFeedback(result.feedback)
          setHint(null)
        } else if (result.showAnswer) {
          const bf = puzzle.bestMove.slice(0, 2)
          const bt = puzzle.bestMove.slice(2, 4)
          try { gameRef.current.move({ from: bf, to: bt }) } catch {}
          setFen(gameRef.current.fen())
          setStatus('revealed')
          setFeedback(result.feedback)
          setHint(null)
        } else {
          setStatus('wrong')
          setFeedback(result.feedback)
          setHint(result.hint)
        }
        attemptRef.current = result.attemptNumber ?? attemptRef.current + 1
      })
      .catch(() => setStatus('pattern_moment'))

    return false
  }, [status, puzzle])

  const isFinished = status === 'correct' || status === 'revealed'
  const interactive = status === 'pattern_moment' || status === 'wrong'

  return (
    <main className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-3xl font-bold">{patDef?.displayName ?? puzzle.patternKey}</h1>

      <p className="text-gray-400 text-sm">{puzzle.title}</p>

      <p className="text-gray-300 text-sm h-5">
        {status === 'scripted' && 'Watch the position unfold…'}
        {status === 'pattern_moment' && 'Your turn — find the best move!'}
        {status === 'wrong' && (hint ?? 'Not quite — try again!')}
      </p>

      <GameBoard
        fen={fen}
        onMove={handleMove}
        orientation={puzzle.side}
        interactive={interactive}
        boardWidth={520}
      />

      <FeedbackPanel
        key={`${status}:${feedback ?? ''}`}
        feedback={feedback}
        hint={hint}
        status={status === 'scripted' || status === 'pattern_moment' ? null : status}
      />

      <Celebration show={status === 'correct'} message="Brilliant!" />

      {isFinished && (
        <div className="flex gap-4">
          <button
            onClick={handleReset}
            className="px-8 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-semibold transition-colors"
          >
            Play Again
          </button>
        </div>
      )}
    </main>
  )
}
