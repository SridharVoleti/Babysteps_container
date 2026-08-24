import { NextRequest, NextResponse } from 'next/server'
import {
  errorResponse,
  getAuthzService,
  studentFromCookies,
  unauthenticatedResponse,
} from '@/lib/platform/authz/nextAdapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET → full account status: student, bookings, today's quota, active session. */
export async function GET(req: NextRequest) {
  try {
    const student = await studentFromCookies(req.cookies)
    if (!student) return unauthenticatedResponse()
    return NextResponse.json(await getAuthzService().getStatus(student))
  } catch (e) {
    return errorResponse(e)
  }
}
