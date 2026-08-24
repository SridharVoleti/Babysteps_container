import { NextRequest, NextResponse } from 'next/server'
import { runChessmasterAttempt } from '@/lib/host/bootstrap-chessmaster'
import forkPuzzleContent from '@/apps/chessmaster/content/pattern-fork-01.json'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The only route the browser calls while playing. It never touches Supabase itself (CC-003):
// it fetches a fresh SB-001 launch envelope from the Babysteps Platform API (forwarding the
// learner's own authz cookie) and hands off to the host/composition layer, which drives the
// real apps/chessmaster activity through the container's full bootstrap → session →
// activity-lifecycle → progress/completion pipeline.
export async function POST(req: NextRequest) {
  const cookieHeader = req.headers.get('cookie') ?? ''
  const baseUrl = req.nextUrl.origin
  const body = await req.json().catch(() => ({}))
  const playerMoveUci = String(body.playerMoveUci ?? '')
  const resumeAttemptNumber = Number.isInteger(body.resumeAttemptNumber) ? body.resumeAttemptNumber : 0

  const sessionRes = await fetch(`${baseUrl}/api/v1/sessions`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  })
  if (!sessionRes.ok) {
    const errBody = await sessionRes.json().catch(() => ({ error: { code: 'SESSION_UNAVAILABLE', message: 'No active session.' } }))
    return NextResponse.json(errBody, { status: sessionRes.status })
  }
  const { launch } = await sessionRes.json()

  try {
    const result = await runChessmasterAttempt({
      baseUrl,
      cookieHeader,
      launch,
      puzzle: forkPuzzleContent.puzzle,
      playerMoveUci,
      resumeAttemptNumber,
    })
    return NextResponse.json(result)
  } catch (e) {
    console.error('[runtime/chessmaster/attempt-move]', e)
    return NextResponse.json(
      { error: { code: 'RUNTIME_ERROR', message: 'The activity could not process this move.' } },
      { status: 500 },
    )
  }
}
