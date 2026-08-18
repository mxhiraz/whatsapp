import { rm } from 'node:fs/promises'
import { invalidate } from '@/lib/cache.ts'
import { q, type Sender } from '@/lib/db.ts'
import { clamp, digits, handle } from '@/lib/http.ts'
import { normalizePhone } from '@/lib/parse.ts'
import { effectivePolicy } from '@/lib/settings.ts'
import { connect, disconnect, onlinePhones, send, statusOf } from '@/lib/wa.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ phone: string }> }
const phoneOf = async (ctx: Ctx) => digits((await ctx.params).phone)

/** Link state + QR, polled while a number is being connected. */
export const GET = (_req: Request, ctx: Ctx) => handle(async () => statusOf(await phoneOf(ctx)))

/** Pause / resume, change caps or proxy, or force a reconnect. */
export const PATCH = (req: Request, ctx: Ctx) =>
  handle(async () => {
    const phone = await phoneOf(ctx)
    const body = await req.json()

    if (body.action === 'reconnect') {
      await q(`update senders set status = 'warming', paused_until = null where phone = $1 and status = 'banned'`, [phone])
      invalidate()
      return connect(phone)
    }

    /**
     * Sends a real message from this number, to prove the whole path works —
     * socket, proxy, WhatsApp itself — without spending a cold send on a lead.
     *
     * Normally you send it to your own phone so you can see it arrive. With no
     * recipient given it falls back to another linked number, which still checks
     * the connection; traffic between your own numbers is excluded from the inbox
     * and from reply metrics either way, so a test can never flatter your stats.
     */
    if (body.action === 'test') {
      const to = body.to ? normalizePhone(body.to, digits(body.cc) || '91') : onlinePhones().find(p => p !== phone)
      if (!to) {
        throw new Error(
          body.to
            ? 'that does not look like a usable phone number'
            : 'enter a number to send the test to, or link a second number',
        )
      }
      if (to === phone) throw new Error('pick a different number: a number cannot test itself')
      const id = await send(phone, to, 'Test message from WA Outreach.')
      return { ok: true, sent_to: to, wa_id: id }
    }

    if (body.status) {
      if (!['warming', 'active', 'paused'].includes(body.status)) throw new Error('bad status')
      // The dashboard refetches /api/state as soon as this returns, and that read must
      // not come out of a cache filled before the write.
      invalidate()
      // Manually resuming clears any cool-down; the warmup ramp is left intact.
      return q<Sender>(
        `update senders set status = $2, paused_until = case when $2 = 'paused' then paused_until else null end
          where phone = $1 returning *`,
        [phone, body.status],
      )
    }

    // The ceiling comes from the operator's own sending limits, not the code default.
    const policy = await effectivePolicy()
    invalidate()
    return q<Sender>(
      `update senders
          set max_per_day = coalesce($2, max_per_day),
              max_per_hour = coalesce($3, max_per_hour),
              proxy_url = case when $4 = '' then null else coalesce($4, proxy_url) end,
              warmup_growth = coalesce($5, warmup_growth)
        where phone = $1 returning *`,
      [
        phone,
        body.max_per_day === undefined ? null : clamp(body.max_per_day, 1, policy.hardMaxPerDay, 60),
        body.max_per_hour === undefined ? null : clamp(body.max_per_hour, 1, 60, 8),
        body.proxy_url === undefined ? null : String(body.proxy_url).trim(),
        // 1.3 reaches the ceiling in about a week, 1.12 in about three.
        body.warmup_growth === undefined ? null : clamp(body.warmup_growth, 1.05, 2, policy.warmupGrowth),
      ],
    )
  })

/** Unlinks the number and deletes its stored session. Leads keep their history. */
export const DELETE = (_req: Request, ctx: Ctx) =>
  handle(async () => {
    const phone = await phoneOf(ctx)
    await disconnect(phone)
    await q(`delete from senders where phone = $1`, [phone])
    // Credentials live in the database now; the directory is only there for installs
    // that predate that, and it has to go too or the next add would re-import them.
    await rm(`${process.env.SESSION_DIR || './sessions'}/${phone}`, { recursive: true, force: true })
    invalidate()
    return { ok: true }
  })
