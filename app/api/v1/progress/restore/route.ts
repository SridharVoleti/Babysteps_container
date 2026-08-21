import { NextRequest, NextResponse } from 'next/server'
import { studentFromCookies } from '@/lib/platform/authz/nextAdapter'
import { getSupabaseAdmin } from '@/lib/platform/supabase-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Implements the PA-001 progress.restore operation — see
// lib/host/babysteps-api-operations.ts and app/api/v1/progress/checkpoint/route.ts.
export async function POST(req: NextRequest) {
  const student = await studentFromCookies(req.cookies)
  if (!student) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: 'Please log in first.' } },
      { status: 401 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const { learnerId, appId, releaseId } = body ?? {}
  if (learnerId !== student.id) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'learnerId does not match the authenticated session.' } },
      { status: 403 },
    )
  }
  if (typeof appId !== 'string' || typeof releaseId !== 'string') {
    return NextResponse.json(
      { error: { code: 'VALIDATION', message: 'appId and releaseId are required.' } },
      { status: 400 },
    )
  }

  const db = getSupabaseAdmin()
  const { data: row, error } = await db
    .from('app_progress')
    .select('*')
    .eq('learner_id', learnerId)
    .eq('app_id', appId)
    .eq('release_id', releaseId)
    .maybeSingle<{
      progress_version: number
      app_progress_schema_version: string
      app_progress: Record<string, unknown>
    }>()
  if (error) {
    return NextResponse.json({ contractVersion: '1.0', found: false }, { status: 500 })
  }

  if (!row) {
    return NextResponse.json({ contractVersion: '1.0', found: false })
  }

  return NextResponse.json({
    contractVersion: '1.0',
    found: true,
    learnerId,
    appId,
    releaseId,
    progressVersion: String(row.progress_version),
    appProgressSchemaVersion: row.app_progress_schema_version,
    appProgress: row.app_progress,
  })
}
