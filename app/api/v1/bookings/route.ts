import { NextRequest, NextResponse } from 'next/server'
import {
  errorResponse,
  getAuthzService,
  studentFromCookies,
  unauthenticatedResponse,
} from '@/lib/platform/authz/nextAdapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET → the student's bookings with per-day usage counts. */
export async function GET(req: NextRequest) {
  try {
    const student = await studentFromCookies(req.cookies)
    if (!student) return unauthenticatedResponse()
    return NextResponse.json({ bookings: await getAuthzService().listBookings(student.id) })
  } catch (e) {
    return errorResponse(e)
  }
}

/** POST { slotDate: "YYYY-MM-DD" } → reserve that day. */
export async function POST(req: NextRequest) {
  try {
    const student = await studentFromCookies(req.cookies)
    if (!student) return unauthenticatedResponse()
    const body = await req.json()
    const booking = await getAuthzService().bookSlot(student.id, String(body.slotDate ?? ''))
    return NextResponse.json({ booking }, { status: 201 })
  } catch (e) {
    return errorResponse(e)
  }
}
