import assert from 'node:assert/strict'
import type { NextResponse } from 'next/server'

/**
 * Runs a handler and turns any thrown error into a 400 with a readable message.
 *
 * `next/server` is imported inside the function rather than at the top of the file
 * so the pure helpers below stay runnable under plain `node lib/http.ts`, which is
 * how their self-check at the bottom runs. ESM caches the module after the first
 * request, so this is not a per-request cost.
 */
export async function handle<T>(fn: () => Promise<T>): Promise<NextResponse> {
  const { NextResponse } = await import('next/server')
  try {
    return NextResponse.json((await fn()) as object)
  } catch (e) {
    const raw = (e as Error)?.message ?? 'unknown error'
    console.error('[api]', raw)
    return NextResponse.json({ error: readable(raw) }, { status: 400 })
  }
}

/**
 * Database and driver errors are written for whoever wrote the query, not for the
 * person using the app. "bind message supplies 10 parameters, but prepared statement
 * requires 9" tells an operator nothing they can act on, so those are replaced with
 * a plain sentence while the original still goes to the server log for whoever is
 * debugging. Messages this app raises itself are already written for a person and
 * are passed through untouched.
 */
const DB_NOISE = [
  /bind message supplies/i,
  /prepared statement/i,
  /relation ".*" does not exist/i,
  /column ".*" does not exist/i,
  /invalid input syntax/i,
  /violates (not-null|foreign key|unique|check) constraint/i,
  /syntax error at or near/i,
  /connect(ion)? (refused|terminated|reset)/i,
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/,
  // A malformed request body surfaces as a parser message written for whoever wrote
  // the fetch call, not for whoever is looking at the toast.
  /JSON|Unexpected (end of|token|non-whitespace)/i,
]

export function readable(raw: string): string {
  if (!DB_NOISE.some(p => p.test(raw))) return raw
  if (/connect|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(raw)) {
    return 'Could not reach the database. Check that it is running, then try again.'
  }
  if (/JSON|Unexpected (end of|token|non-whitespace)/i.test(raw)) {
    return 'That request was malformed and nothing was changed. Reload the page and try again.'
  }
  return 'Something went wrong saving that. Nothing was changed. The details are in the server log.'
}

export const digits = (v: unknown): string => String(v ?? '').replace(/\D/g, '')

export function need<T>(value: T | undefined | null | '', what: string): T {
  if (value === undefined || value === null || value === '') throw new Error(`${what} is required`)
  return value
}

export const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback
}

/**
 * Validates an IANA timezone name before it reaches Postgres. An unknown zone
 * would make every send-window comparison throw at query time, which would
 * look like a stuck campaign rather than a bad setting.
 */
export function timezone(v: unknown, fallback = 'UTC'): string {
  const name = String(v ?? '').trim()
  if (!name) return fallback
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return name
  } catch {
    return fallback
  }
}

if (import.meta.filename === process.argv[1]) {
  assert.equal(clamp('42', 0, 100, 7), 42)
  assert.equal(clamp('abc', 0, 100, 7), 7, 'unparseable falls back')
  assert.equal(clamp(500, 0, 100, 7), 100, 'clamped to the ceiling')

  assert.equal(timezone('Asia/Kolkata'), 'Asia/Kolkata')
  assert.equal(timezone('Not/AZone'), 'UTC', 'an unknown zone must not reach Postgres')
  assert.equal(timezone(''), 'UTC')
  assert.equal(timezone(null, 'Europe/London'), 'Europe/London')

  assert.equal(digits('+91 (98) 765-43210'), '919876543210')

  assert.equal(readable('write at least one message'), 'write at least one message', 'our own copy passes through')
  assert.match(readable('bind message supplies 10 parameters, but prepared statement "" requires 9'), /went wrong saving/)
  assert.match(readable('connect ECONNREFUSED 127.0.0.1:5439'), /Could not reach the database/)
  assert.match(readable('duplicate key value violates unique constraint "senders_phone_key"'), /went wrong saving/)
  assert.match(readable('Unexpected end of JSON input'), /malformed/)
  assert.throws(() => need('', 'a list'), /a list is required/)

  console.log('http.ts ok')
}
