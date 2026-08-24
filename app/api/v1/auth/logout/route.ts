import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE, clearAuthCookie, getAuthzService } from '@/lib/platform/authz/nextAdapter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const token = req.cookies.get(AUTH_COOKIE)?.value
  if (token) await getAuthzService().logout(token)
  const res = NextResponse.json({ ok: true })
  clearAuthCookie(res)
  return res
}
