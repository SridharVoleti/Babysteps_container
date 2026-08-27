import { NextRequest, NextResponse } from 'next/server'
import {
  clearAuthCookie,
  getAuthzService,
  studentFromCookies,
} from '@/lib/platform/authz/nextAdapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_RETURN_URL = 'https://www.babystepsindia.com'

// GET /return — declared in the deployment manifest; no BabySteps caller wired to it yet
// (CHESSMASTER_LAUNCH_INTEGRATION.md). Minimal build: end the local ChessMaster session and
// send the learner back to BabySteps. Revisit once BabySteps confirms the real contract.
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const student = await studentFromCookies(req.cookies)
    if (student) {
      await getAuthzService()
        .endSession(student.id)
        .catch(() => {}) // no active session is fine — we're leaving anyway
    }
  } catch (e) {
    console.error('[return] could not end session cleanly:', e instanceof Error ? e.message : e)
  }

  const target = process.env.APP_LAUNCH_RETURN_URL?.trim() || DEFAULT_RETURN_URL
  const res = NextResponse.redirect(target, 303)
  clearAuthCookie(res)
  return res
}
