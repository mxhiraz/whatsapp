import { invalidate } from '@/lib/cache.ts'
import { one, q } from '@/lib/db.ts'
import { digits, handle, need } from '@/lib/http.ts'
import { send } from '@/lib/wa.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INTEREST = ['unset', 'positive', 'neutral', 'negative', 'meeting']
const MAX_NOTE_CHARS = 4000
const MAX_MESSAGE_CHARS = 4000

/** Thread list (with unread counts and outcome), or one conversation via ?phone=. */
export const GET = (req: Request) =>
  handle(async () => {
    const params = new URL(req.url).searchParams
    const phone = digits(params.get('phone'))

    if (phone) {
      // Campaign sends and chat messages interleaved, oldest first.
      return q(
        `select 'out' as dir, m.body, m.sent_at as at, s.phone as via, m.read_at as seen_at
           from messages m
           join leads l on l.id = m.lead_id
           left join senders s on s.id = m.sender_id
          where l.phone = $1 and m.status = 'sent'
         union all
        select case when r.outbound then 'out' else 'in' end as dir,
               r.body, r.received_at as at, r.sender_phone as via, r.read_at as seen_at
           from replies r where r.lead_phone = $1
         order by at asc`,
        [phone],
      )
    }

    const filter = params.get('filter') ?? 'all'
    // A search box types literals, so LIKE wildcards in it are escaped rather than
    // left to act as wildcards.
    const typed = (params.get('q') ?? '').trim().slice(0, 200)
    const search = (digits(typed) || typed).replace(/[%_\\]/g, '\\$&')
    return q(
      `with thread as (
          select r.lead_phone,
                 max(r.received_at) as last_at,
                 count(*) filter (where not r.outbound and r.read_at is null)::int as unread,
                 (array_agg(r.body order by r.received_at desc))[1] as last_body
            from replies r group by r.lead_phone
       )
       select t.*, l.name, l.list, l.status as lead_status, l.interest, l.note,
              exists (select 1 from blocklist b where b.phone = t.lead_phone) as blocked
         from thread t
         left join leads l on l.phone = t.lead_phone
        where ($1 = 'all'
               or ($1 = 'unread' and t.unread > 0)
               or ($1 = 'interested' and l.interest in ('positive', 'meeting'))
               or ($1 = 'opted_out' and l.status = 'opted_out'))
          and ($2 = '' or t.lead_phone like '%' || $2 || '%' or coalesce(l.name, '') ilike '%' || $2 || '%')
        order by t.unread > 0 desc, t.last_at desc
        limit 200`,
      [filter, search],
    )
  })

/** Replies go out from the number that owns the thread, keeping one chat per lead. */
export const POST = (req: Request) =>
  handle(async () => {
    const body = await req.json().catch(() => ({}))
    const to = need(digits(body.to), 'recipient')
    const text = need(String(body.body ?? '').trim().slice(0, MAX_MESSAGE_CHARS), 'message')

    if (await one(`select 1 from blocklist where phone = $1`, [to])) {
      throw new Error('this number opted out, so replying to it is blocked')
    }

    const owner = await one<{ phone: string }>(
      `select s.phone from leads l join senders s on s.id = l.sender_id
        where l.phone = $1 and s.status <> 'banned' limit 1`,
      [to],
    )
    const fallback = await one<{ sender_phone: string }>(
      `select sender_phone from replies where lead_phone = $1 order by received_at desc limit 1`,
      [to],
    )
    const from = owner?.phone ?? fallback?.sender_phone
    if (!from) throw new Error('no linked number owns this conversation')

    await send(from, to, text)
    await q(
      `insert into replies (sender_phone, lead_phone, body, outbound, read_at) values ($1, $2, $3, true, now())`,
      [from, to, text],
    )
    // Answering a thread marks it read: you have just seen it.
    await q(`update replies set read_at = now() where lead_phone = $1 and read_at is null`, [to])
    invalidate()
    return { ok: true, from }
  })

/** Mark a thread read, set its outcome, or attach a note. */
export const PATCH = (req: Request) =>
  handle(async () => {
    const body = await req.json().catch(() => ({}))
    const phone = need(digits(body.phone), 'phone')

    if (body.read) {
      /**
       * Only up to what the operator has actually seen.
       *
       * `before` is the timestamp of the newest reply the thread list rendered. A
       * reply that lands between the click and this request has not been read by
       * anyone, and marking it read is the one mistake here that cannot be noticed:
       * it silently drops a notification for a message someone is waiting on. With
       * no `before` given this behaves as it always did and marks everything.
       */
      const before = body.before === undefined ? null : new Date(String(body.before))
      if (before && Number.isNaN(before.getTime())) throw new Error('before must be a timestamp')
      await q(
        `update replies set read_at = now()
          where lead_phone = $1 and read_at is null and received_at <= coalesce($2::timestamptz, now())`,
        [phone, before?.toISOString() ?? null],
      )
    }

    if (body.interest !== undefined) {
      if (!INTEREST.includes(body.interest)) throw new Error(`interest must be one of ${INTEREST.join(', ')}`)
      await q(`update leads set interest = $2 where phone = $1`, [phone, body.interest])
    }

    if (body.note !== undefined) {
      await q(`update leads set note = nullif($2, '') where phone = $1`, [
        phone,
        String(body.note ?? '').trim().slice(0, MAX_NOTE_CHARS),
      ])
    }

    invalidate()
    return { ok: true }
  })
