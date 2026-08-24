'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { generateConfetti, type ConfettiConfig } from '@/lib/chessmaster/confetti'

interface CelebrationProps {
  /** rising edge (false → true) fires one burst */
  show: boolean
  /** badge text; pass null to show confetti only */
  message?: string | null
  /** how long the overlay stays on screen */
  durationMs?: number
  /** tune the burst (piece count, colors, …) */
  confetti?: Partial<ConfettiConfig>
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 2l2.6 6.6L21 9.3l-5 4.4 1.5 6.8L12 16.9l-5.5 3.6L8 13.7 3 9.3l6.4-.7L12 2z" />
    </svg>
  )
}

/**
 * Celebration — full-screen confetti burst + pop-in badge.
 *
 * Purely decorative (aria-hidden, pointer-events: none) and self-dismissing.
 * Animations are transform/opacity only and disabled by
 * prefers-reduced-motion (the badge then shows statically).
 */
export function Celebration({
  show,
  message = 'Brilliant!',
  durationMs = 2800,
  confetti,
}: CelebrationProps) {
  const [burstId, setBurstId] = useState(0)
  const [visible, setVisible] = useState(false)
  const prevShow = useRef(false)

  // Fire one burst per rising edge of `show`
  useEffect(() => {
    if (show && !prevShow.current) {
      setBurstId(id => id + 1)
      setVisible(true)
    }
    prevShow.current = show
  }, [show])

  // Self-dismiss
  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(() => setVisible(false), durationMs)
    return () => clearTimeout(timer)
  }, [visible, burstId, durationMs])

  const pieces = useMemo(
    () => (visible ? generateConfetti(confetti) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, burstId], // one burst per show; overrides treated as stable
  )

  if (!visible) return null

  return (
    <div className="celebration-overlay" data-testid="celebration" aria-hidden="true">
      {pieces.map(p => (
        <span
          key={p.id}
          className={`confetti confetti-${p.shape}`}
          style={{
            '--x': `${p.leftPct}%`,
            '--size': `${p.sizePx}px`,
            '--color': p.color,
            '--fall': `${p.fallDurationMs}ms`,
            '--delay': `${p.startDelayMs}ms`,
            '--drift': `${p.driftVw}vw`,
            '--spin': `${p.spinDeg}deg`,
          } as CSSProperties}
        />
      ))}
      {message && (
        <div className="celebration-badge font-display">
          <StarIcon className="h-6 w-6 text-yellow-400" />
          <span>{message}</span>
          <StarIcon className="h-6 w-6 text-yellow-400" />
        </div>
      )}
    </div>
  )
}
