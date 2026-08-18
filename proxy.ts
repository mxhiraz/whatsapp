import { NextResponse, type NextRequest } from 'next/server'
import { authSecret } from '@/lib/settings.ts'

/**
 * Optional password gate. Set one in Settings (or an APP_PASSWORD in the
 * environment) and the dashboard asks for it once; leave it unset and there is no
 * auth at all, which is fine on localhost and not fine anywhere else — this app
 * can send messages from your WhatsApp account.
 *
 * The cookie holds an HMAC of the stored password hash rather than any password,
 * so a stolen cookie can't be read back into the secret. Proxy runs on the Node.js
 * runtime in Next 16, which is what lets it read the setting from the database at
 * all; the read is cached for a few seconds so this is not a query per request.
 */
const PUBLIC = ['/login', '/api/login']

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  // Checked before the secret is read, so signing in still works if the database
  // is unreachable — and so the login screen costs no query.
  if (PUBLIC.some(p => pathname.startsWith(p))) return NextResponse.next()

  let secret: string | null
  try {
    secret = await authSecret()
  } catch {
    // The password lives in the database. An unreadable gate is a closed gate:
    // guessing "no password" here would open the dashboard to anyone.
    return NextResponse.json({ error: 'settings are unavailable, so the dashboard is locked' }, { status: 503 })
  }
  if (!secret) return NextResponse.next()

  const cookie = req.cookies.get('wa_auth')?.value
  if (cookie && cookie === (await token(secret))) return NextResponse.next()

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  }
  const url = req.nextUrl.clone()
  url.pathname = '/login'
  return NextResponse.redirect(url)
}

/** Same digest the login route sets — Web Crypto so this runs on any runtime. */
export async function token(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('wa-outreach-session'))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Signs the session in. Shared by the login route and by Settings, so setting a
 * password from a logged-in tab re-signs that tab instead of locking it out.
 */
export async function setSession(res: NextResponse, secret: string): Promise<void> {
  res.cookies.set('wa_auth', await token(secret), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
