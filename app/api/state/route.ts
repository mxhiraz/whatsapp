import { ttlCache } from '@/lib/cache.ts'
import { q, one } from '@/lib/db.ts'
import { log, senderHealth } from '@/lib/engine.ts'
import { handle } from '@/lib/http.ts'
import { effectivePolicy } from '@/lib/settings.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LISTS = `
  select l.list,
         count(*)::int as total,
         count(*) filter (where l.status = 'replied')::int as replied,
         count(*) filter (where l.status = 'opted_out')::int as opted_out,
         count(*) filter (where l.status = 'invalid')::int as invalid,
         /*
          * "Messaged" is derived from the messages table, not from the lead status.
          * Counting status in ('active','done') silently excluded everyone who
          * replied or opted out — the two outcomes that prove a contact WAS
          * messaged — so the column under-reported by exactly the interesting rows.
          */
         count(*) filter (
           where exists (select 1 from messages m where m.lead_id = l.id and m.status = 'sent')
         )::int as contacted
    from leads l
   group by l.list
   order by l.list`

const CAMPAIGNS = `
  with agg as (
      select campaign_id,
             count(*) filter (where status = 'sent')::int as sent,
             count(*) filter (where status = 'pending')::int as pending,
             count(*) filter (where status = 'pending' and scheduled_at <= now())::int as due,
             count(*) filter (where status = 'failed')::int as failed,
             count(*) filter (where status = 'skipped')::int as skipped,
             count(*) filter (where delivered_at is not null)::int as delivered,
             count(*) filter (where read_at is not null)::int as read
        from messages group by campaign_id
   ), steps_agg as (
      select campaign_id, count(*)::int as step_count from steps group by campaign_id
   ), leads_agg as (
      select list, count(*)::int as leads from leads group by list
   )
   select c.*,
          coalesce(s.step_count, 0) as step_count,
          coalesce(l.leads, 0) as leads,
          coalesce(a.sent, 0) as sent,
          coalesce(a.pending, 0) as pending,
          coalesce(a.failed, 0) as failed,
          coalesce(a.skipped, 0) as skipped,
          coalesce(a.delivered, 0) as delivered,
          coalesce(a.read, 0) as read,
          /*
           * Why a running campaign is not sending right now. Without this the
           * dashboard shows "running" next to a queue that never moves, and the
           * cause (a send window in a timezone that is not the operator's) is
           * invisible. Only covers reasons that hold for the whole campaign —
           * per-number limits are shown on the Numbers page.
           */
          case
            when c.status <> 'running' or coalesce(a.due, 0) = 0 or c.ignore_send_window then null
            when c.skip_weekends and extract(dow from now() at time zone c.timezone)::int in (0, 6)
              then 'Weekend. Sending resumes Monday.'
            when extract(hour from now() at time zone c.timezone)::int < c.start_hour
              or extract(hour from now() at time zone c.timezone)::int >= c.end_hour
              then 'Outside send hours (' || c.start_hour || ':00–' || c.end_hour || ':00 ' || c.timezone
                   || ', now ' || to_char(now() at time zone c.timezone, 'HH24:MI') || ')'
          end as blocked_reason
     from campaigns c
     left join agg a on a.campaign_id = c.id
     left join steps_agg s on s.campaign_id = c.id
     left join leads_agg l on l.list = c.list
    order by c.id desc`

/**
 * Contacts each campaign messaged who then wrote back.
 *
 * This used to be "leads on the campaign's list whose status is 'replied'", which is
 * a different number in three ways that all inflate it: a lead's status is set by
 * phone across every list, two campaigns on one list each claimed the other's
 * replies, and a draft that had sent nothing still reported an Answered count. The
 * dashboard's headline reply rate is the sum of this over the sum of sent, and the
 * ban-avoidance gates judge a number on that same rate, so an inflated one hides a
 * number that is about to die.
 *
 * Kept out of the campaign aggregate deliberately: joined in there the planner gives
 * it one worker instead of two and it costs 114ms rather than 37ms on 2.3M messages.
 */
const ANSWERED = `
  select m.campaign_id, count(distinct m.lead_id)::int as replied
    from messages m
    join leads l on l.id = m.lead_id
    join replies r on r.lead_phone = l.phone and not r.outbound and r.received_at >= m.sent_at
   where m.status = 'sent'
   group by m.campaign_id`

const REPLIES = `
  select r.*, l.name, l.list
    from replies r
    left join leads l on l.phone = r.lead_phone
   where not r.outbound and r.read_at is null
   order by r.received_at desc limit 100`

// 30-day activity series. Grouped once per table, then joined onto a day spine
// so empty days still appear on the chart.
const SERIES = `
  with days as (
      select generate_series(current_date - interval '29 days', current_date, interval '1 day')::date as d
   ), s as (
      select sent_at::date as d, count(*)::int as n
        from messages
       where status = 'sent' and sent_at >= current_date - 29
       group by 1
   ), r as (
      select received_at::date as d, count(*)::int as n
        from replies
       where not outbound and received_at >= current_date - 29
       group by 1
   )
   select days.d as date, coalesce(s.n, 0) as sent, coalesce(r.n, 0) as replies
     from days left join s using (d) left join r using (d)
    order by days.d`

/**
 * Everything the dashboard polls, in one round trip and one pass per table.
 *
 * Issued together rather than in sequence: they touch different tables and the
 * slowest one sets the latency instead of the sum of all of them. Cached for 3s so
 * N open tabs cost the same as one, and registered for invalidation so a write
 * still shows up immediately — the browser refetches the moment a write returns,
 * which without that lands inside the TTL window every time.
 */
const state = ttlCache(
  3000,
  async () => {
    const [senders, lists, campaigns, answered, replies, blocked, policy, series] = await Promise.all([
      senderHealth(),
      q(LISTS),
      q<{ id: number }>(CAMPAIGNS),
      q<{ campaign_id: number; replied: number }>(ANSWERED),
      q(REPLIES),
      one<{ n: number }>(`select count(*)::int as n from blocklist`),
      effectivePolicy(),
      q(SERIES),
    ])
    const replied = new Map(answered.map(r => [r.campaign_id, r.replied]))
    return {
      senders,
      lists,
      campaigns: campaigns.map(c => ({ ...c, replied: replied.get(c.id) ?? 0 })),
      replies,
      blocked: blocked?.n ?? 0,
      policy,
      series,
    }
  },
  { onWrite: true },
)

export const GET = () => handle(async () => ({ ...(await state()), log: log.slice(0, 80) }))
