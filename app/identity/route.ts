import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /identity — reserved in the deployment manifest, not yet exercised by any live
// BabySteps code path (CHESSMASTER_LAUNCH_INTEGRATION.md). Likely a future identity
// round-trip; returning 501 until the real contract is confirmed is intentional — guessing
// a response shape that does not exist yet would be worse.
export async function GET(): Promise<Response> {
  return NextResponse.json(
    { error: { code: 'NOT_IMPLEMENTED', message: 'GET /identity is reserved and not implemented yet.' } },
    { status: 501, headers: { 'cache-control': 'no-store' } },
  )
}
