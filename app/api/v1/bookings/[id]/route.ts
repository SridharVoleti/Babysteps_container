import { NextRequest, NextResponse } from 'next/server'
import {
  errorResponse,
  getAuthzService,
  studentFromCookies,
  unauthenticatedResponse,
} from '@/lib/platform/authz/nextAdapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** DELETE → cancel an unused booking. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const student = await studentFromCookies(req.cookies)
    if (!student) return unauthenticatedResponse()
    await getAuthzService().cancelBooking(student.id, params.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return errorResponse(e)
  }
}
