import { NextRequest, NextResponse } from 'next/server'
import {
  errorResponse,
  getAuthzService,
  studentFromCookies,
  unauthenticatedResponse,
} from '@/lib/platform/authz/nextAdapter'
import { issueLaunchContext, newCorrelationId } from '@/lib/platform/launch-issuer'
import { CHESSMASTER_RELEASE_ID } from '@/lib/babysteps-release'
import type { UsageSession } from '@/lib/platform/authz/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function launchFor(studentId: string, session: UsageSession, launchMode: 'start' | 'resume') {
  return issueLaunchContext({
    learnerId: studentId,
    appId: 'chessmaster',
    releaseId: CHESSMASTER_RELEASE_ID,
    sessionId: session.id,
    launchMode,
    issuedAt: new Date().toISOString(),
    expiresAt: session.expiresAt,
    correlationId: newCorrelationId(),
  })
}

/** GET → the active usage session + a fresh SB-001 launch envelope (404 NO_ACTIVE_SESSION if none). */
export async function GET(req: NextRequest) {
  try {
    const student = await studentFromCookies(req.cookies)
    if (!student) return unauthenticatedResponse()
    const session = await getAuthzService().getActiveSession(student.id)
    if (!session) {
      return NextResponse.json(
        { error: { code: 'NO_ACTIVE_SESSION', message: 'No active session.' } },
        { status: 404 },
      )
    }
    return NextResponse.json({ session, launch: await launchFor(student.id, session, 'resume') })
  } catch (e) {
    return errorResponse(e)
  }
}

/** POST → start (or resume) today's usage session. Enforces booking + quota. Also issues the
 *  SB-001 launch envelope the runtime/host layer needs to boot the container for this learner. */
export async function POST(req: NextRequest) {
  try {
    const student = await studentFromCookies(req.cookies)
    if (!student) return unauthenticatedResponse()
    const { session, resumed } = await getAuthzService().startSession(student.id)
    const launch = await launchFor(student.id, session, resumed ? 'resume' : 'start')
    return NextResponse.json({ session, resumed, launch }, { status: resumed ? 200 : 201 })
  } catch (e) {
    return errorResponse(e)
  }
}

/** DELETE → end the active session early (still counts against the quota). */
export async function DELETE(req: NextRequest) {
  try {
    const student = await studentFromCookies(req.cookies)
    if (!student) return unauthenticatedResponse()
    const session = await getAuthzService().endSession(student.id)
    return NextResponse.json({ session })
  } catch (e) {
    return errorResponse(e)
  }
}
