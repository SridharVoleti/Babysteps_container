import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, getAuthzService, setAuthCookie } from '@/lib/platform/authz/nextAdapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST { email, displayName, password } → creates the account and logs in. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const service = getAuthzService()
    await service.registerStudent({
      email: String(body.email ?? ''),
      displayName: String(body.displayName ?? ''),
      password: String(body.password ?? ''),
    })
    const { student, auth } = await service.login({
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
    })
    const res = NextResponse.json({ student }, { status: 201 })
    setAuthCookie(res, auth.token, auth.expiresAt)
    return res
  } catch (e) {
    return errorResponse(e)
  }
}
