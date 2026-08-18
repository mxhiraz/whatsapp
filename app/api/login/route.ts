import { NextResponse } from 'next/server'
import { authSecret, verifyPassword } from '@/lib/settings.ts'
import { setSession } from '@/proxy.ts'

export const runtime = 'nodejs'

export async function POST(req: Request): Promise<Response> {
  const secret = await authSecret()
  if (!secret) return NextResponse.json({ error: 'no password is set on this install' }, { status: 400 })

  const { password: given } = await req.json().catch(() => ({ password: '' }))
  if (!given || !(await verifyPassword(String(given)))) {
    return NextResponse.json({ error: 'wrong password' }, { status: 401 })
  }

  const res = NextResponse.json({ ok: true })
  await setSession(res, secret, req)
  return res
}
