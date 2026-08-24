import { NextRequest, NextResponse } from 'next/server'
import { studentFromCookies } from '@/lib/platform/authz/nextAdapter'
import { getSupabaseAdmin } from '@/lib/platform/supabase-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Implements the PA-001 progress.checkpoint (and SR-004 progress.save) operation the host
// layer's createBabystepsApiClient calls — see lib/host/babysteps-api-operations.ts. Called
// server-to-server by the runtime layer, authenticated by forwarding the learner's own authz
// cookie, never by app/activity code directly (CC-003).
export async function POST(req: NextRequest) {
  const student = await studentFromCookies(req.cookies)
  if (!student) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: 'Please log in first.' } },
      { status: 401 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const { learnerId, appId, releaseId, sessionId, appProgress } = body ?? {}
  if (learnerId !== student.id) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'learnerId does not match the authenticated session.' } },
      { status: 403 },
    )
  }
  if (typeof appId !== 'string' || typeof releaseId !== 'string' || !appProgress || typeof appProgress !== 'object') {
    return NextResponse.json(
      { error: { code: 'VALIDATION', message: 'appId, releaseId and appProgress are required.' } },
      { status: 400 },
    )
  }

  const db = getSupabaseAdmin()
  const { data: existing, error: readError } = await db
    .from('app_progress')
    .select('progress_version')
    .eq('learner_id', learnerId)
    .eq('app_id', appId)
    .eq('release_id', releaseId)
    .maybeSingle<{ progress_version: number }>()
  if (readError) {
    return NextResponse.json({ contractVersion: '1.0', acknowledged: false }, { status: 500 })
  }

  const nextVersion = (existing?.progress_version ?? 0) + 1
  const { error: upsertError } = await db.from('app_progress').upsert({
    learner_id: learnerId,
    app_id: appId,
    release_id: releaseId,
    app_progress_schema_version: '1',
    app_progress: appProgress,
    progress_version: nextVersion,
    updated_at: new Date().toISOString(),
  })
  if (upsertError) {
    return NextResponse.json({ contractVersion: '1.0', acknowledged: false }, { status: 500 })
  }

  void sessionId // scoping only; this endpoint is not session-specific
  return NextResponse.json({
    contractVersion: '1.0',
    acknowledged: true,
    progressVersion: String(nextVersion),
  })
}
