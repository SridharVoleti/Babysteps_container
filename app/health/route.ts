import { NextRequest, NextResponse } from 'next/server'
import { getAuthzService } from '@/lib/platform/authz/nextAdapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /health — BabySteps checks this before letting a deployment go live and as part of
// ongoing availability checks (CHESSMASTER_LAUNCH_INTEGRATION.md). 200 when the app can
// actually serve a game; a non-2xx holds the deployment back rather than sending children
// to a broken game.
//
// Default: a cheap liveness check (config is loadable). `?deep=1` also round-trips the
// learner/session store (Supabase), which every real launch depends on.
export async function GET(req: NextRequest): Promise<Response> {
  const deep = req.nextUrl.searchParams.get('deep') === '1'

  try {
    const authz = getAuthzService()
    if (deep) {
      // A trivial read — proves the DB the session gate reads is reachable.
      await authz.getStudentByToken('health-check-not-a-real-token')
    }
  } catch (e) {
    console.error('[health] dependency check failed:', e instanceof Error ? e.message : e)
    return new NextResponse('unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  return new NextResponse('ok', {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}
