import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, getAuthzService, setAuthCookie } from '@/lib/platform/authz/nextAdapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST { email, password } → sets the auth cookie. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { student, auth } = await getAuthzService().login({
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
    })
    const res = NextResponse.json({ student })
    setAuthCookie(res, auth.token, auth.expiresAt)
    return res
  } catch (e) {
    return errorResponse(e)
  }
}
