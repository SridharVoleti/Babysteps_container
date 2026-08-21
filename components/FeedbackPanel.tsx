interface FeedbackPanelProps {
  feedback: string | null
  hint:     string | null
  status:   'correct' | 'wrong' | 'revealed' | null
}

const BG: Record<NonNullable<FeedbackPanelProps['status']>, string> = {
  correct:  'bg-green-700',
  wrong:    'bg-red-800',
  revealed: 'bg-amber-700',
}

// Entrance motion per status (defined in globals.css, reduced-motion aware)
const MOTION: Record<NonNullable<FeedbackPanelProps['status']>, string> = {
  correct:  'panel-pop',
  wrong:    'panel-shake',
  revealed: 'panel-pop',
}

/**
 * FeedbackPanel — displays validation feedback and optional hint.
 * Renders nothing when both feedback and hint are null/empty.
 */
export function FeedbackPanel({ feedback, hint, status }: FeedbackPanelProps) {
  if (!feedback && !hint) return null

  const bg     = status ? BG[status] : 'bg-gray-700'
  const motion = status ? MOTION[status] : ''

  return (
    <div
      data-testid="feedback-panel"
      className={`${bg} ${motion} px-6 py-4 rounded-xl max-w-md text-center text-white`}
    >
      {feedback && <p>{feedback}</p>}
      {hint     && <p className="mt-2 text-sm opacity-80">{hint}</p>}
    </div>
  )
}
