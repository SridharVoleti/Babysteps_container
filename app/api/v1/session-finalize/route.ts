import { NextRequest, NextResponse } from 'next/server'
import { getAuthzService, studentFromCookies } from '@/lib/platform/authz/nextAdapter'
import { getSupabaseAdmin } from '@/lib/platform/supabase-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Implements SR-004's session.finalize operation. Also ends the learner's authz usage
// session (the day-quota/timer authority, see ../sessions/route.ts) so authz's notion of
// "active session" stays in sync with the container session actually completing — best
// effort: a session that already ended (e.g. by natural expiry) is not an error here.
export async function POST(req: NextRequest) {
  const student = await studentFromCookies(req.cookies)
  if (!student) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: 'Please log in first.' } },
      { status: 401 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const { learnerId, sessionId } = body ?? {}
  if (learnerId !== student.id) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'learnerId does not match the authenticated session.' } },
      { status: 403 },
    )
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return NextResponse.json(
      { error: { code: 'VALIDATION', message: 'sessionId is required.' } },
      { status: 400 },
    )
  }

  const db = getSupabaseAdmin()
  const { error: insertError } = await db.from('app_sessions').upsert({
    session_id: sessionId,
    learner_id: learnerId,
    app_id: 'chessmaster',
    release_id: body.releaseId ?? null,
    final_progress: {},
    final_status: 'completed',
    finalized_at: new Date().toISOString(),
  })
  if (insertError) {
    return NextResponse.json({ contractVersion: '1.0' }, { status: 500 })
  }

  try {
    await getAuthzService().endSession(student.id)
  } catch {
    // best-effort: no active authz usage session to end is not a finalize failure
  }

  return NextResponse.json({ contractVersion: '1.0', finalStatus: 'completed' })
}
