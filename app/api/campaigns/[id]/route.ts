import { invalidate } from '@/lib/cache.ts'
import { one, q, type Campaign, type Step } from '@/lib/db.ts'
import { startCampaign } from '@/lib/engine.ts'
import { handle } from '@/lib/http.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * A path segment is request input. `Number('abc')` is NaN, which Postgres rejects
 * as an integer and reports as a driver error nobody can act on, so it is turned
 * into a plain "no such campaign" here instead.
 */
async function idOf(ctx: Ctx): Promise<number> {
  const id = Number((await ctx.params).id)
  if (!Number.isInteger(id) || id < 1) throw new Error('no such campaign')
  return id
}

/** Campaign detail: steps, per-variant performance, and the message log. */
export const GET = (_req: Request, ctx: Ctx) =>
  handle(async () => {
    const id = await idOf(ctx)
    const [campaign, steps, variants, messages] = await Promise.all([
      one<Campaign>(`select * from campaigns where id = $1`, [id]),
      q<Step>(`select * from steps where campaign_id = $1 order by step_no`, [id]),
      q(
        // `replied` counts contacts who wrote back after getting this exact wording,
        // read from `replies`. Reading `leads.status` instead credited a version with
        // replies to a different campaign, because a lead's status is set per phone
        // across every list rather than per campaign.
        `select m.step_no, m.variant,
                count(*)::int as sent,
                count(*) filter (where m.delivered_at is not null)::int as delivered,
                count(*) filter (where m.read_at is not null)::int as read,
                count(*) filter (
                  where exists (select 1 from replies r
                                 where r.lead_phone = l.phone and not r.outbound
                                   and r.received_at >= m.sent_at)
                )::int as replied
           from messages m join leads l on l.id = m.lead_id
          where m.campaign_id = $1 and m.status = 'sent'
          group by m.step_no, m.variant order by m.step_no, m.variant`,
        [id],
      ),
      q(
        `select m.id, m.step_no, m.variant, m.status, m.body, m.scheduled_at, m.sent_at,
                m.delivered_at, m.read_at, m.error,
                l.phone, l.name, l.status as lead_status, s.phone as sent_from
           from messages m
           join leads l on l.id = m.lead_id
           left join senders s on s.id = m.sender_id
          where m.campaign_id = $1
          order by coalesce(m.sent_at, m.scheduled_at) desc limit 300`,
        [id],
      ),
    ])
    if (!campaign) throw new Error('no such campaign')
    return { campaign, steps, variants, messages }
  })

/** start = queue step 1 for the whole list; pause = stop sending, keep the queue. */
export const PATCH = (req: Request, ctx: Ctx) =>
  handle(async () => {
    const id = await idOf(ctx)
    const { action } = await req.json().catch(() => ({ action: undefined }))
    try {
      if (action === 'start') return await startCampaign(id)

      /**
       * Drops the wait: every queued message becomes due now, and the numbers on the
       * campaign stop resting between sends.
       *
       * The per-number daily and hourly caps still apply — they are the protection
       * that actually keeps a number alive, so this deliberately does not lift them.
       * What it removes is the randomised gap and the micro-breaks, which is exactly
       * the human-looking pacing WhatsApp's heuristics reward. Use it to catch up a
       * campaign you started late, not to blast a list.
       */
      if (action === 'send_now') {
        const due = await q(
          `update messages set scheduled_at = now()
            where campaign_id = $1 and status = 'pending' and scheduled_at > now()
            returning id`,
          [id],
        )
        await q(
          `update senders set next_ready_at = null, break_until = null
            where id in (select distinct sender_id from leads
                          where sender_id is not null
                            and list = (select list from campaigns where id = $1))`,
          [id],
        )
        return { due: due.length }
      }
      if (action === 'pause') {
        const paused = await one<Campaign>(`update campaigns set status = 'paused' where id = $1 returning *`, [id])
        if (!paused) throw new Error('no such campaign')
        return paused
      }
      throw new Error('Unknown action')
    } finally {
      // Whatever the action did, the dashboard's cached snapshot predates it. Pause
      // in particular: the browser refetches as soon as this returns, so without
      // this the operator watches a paused campaign report "running" for 3s.
      invalidate()
    }
  })

export const DELETE = (_req: Request, ctx: Ctx) =>
  handle(async () => {
    // Deliberately idempotent: two tabs deleting the same campaign is not an error
    // worth a toast, it is the outcome both of them asked for.
    await q(`delete from campaigns where id = $1`, [await idOf(ctx)])
    invalidate()
    return { ok: true }
  })
