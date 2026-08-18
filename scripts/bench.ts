/**
 * Times the queries that run on a hot path, against whatever is in the database.
 * Pair with scripts/seed.ts to see the numbers at scale.
 *
 *   node scripts/seed.ts --leads 100000 --sent 300000 && node scripts/bench.ts
 */
import { pool, q } from '../lib/db.ts'
import { senderHealth } from '../lib/engine.ts'

const time = async (label: string, fn: () => Promise<unknown>, runs = 5) => {
  await fn() // warm the plan cache
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  console.log(`${label.padEnd(38)} median ${times[Math.floor(runs / 2)].toFixed(1).padStart(7)} ms   max ${times[runs - 1].toFixed(1)} ms`)
}

const rows = await q<{ table_name: string; n: number }>(
  `select 'leads' as table_name, count(*)::int as n from leads
   union all select 'senders', count(*)::int from senders
   union all select 'messages', count(*)::int from messages`,
)
console.log(rows.map(r => `${r.n} ${r.table_name}`).join(' · '), '\n')

await time('senderHealth (caps, exact, per send)', () => senderHealth())

await time('lifetime stats (cached 60s)', () =>
  q(`select sender_id, count(*)::int as sent_total,
            count(*) filter (where delivered_at is not null)::int as delivered_total
       from messages where sender_id is not null and status = 'sent' group by sender_id`),
)

await time('campaign aggregates (dashboard)', () =>
  q(`with agg as (
        select campaign_id,
               count(*) filter (where status = 'sent')::int as sent,
               count(*) filter (where status = 'pending')::int as pending,
               count(*) filter (where delivered_at is not null)::int as delivered,
               count(*) filter (where read_at is not null)::int as read
          from messages group by campaign_id)
      select c.id, a.* from campaigns c left join agg a on a.campaign_id = c.id`),
)

await time('nextDue (send loop, every tick)', () =>
  q(`select m.id from messages m
       join campaigns c on c.id = m.campaign_id and c.status = 'running'
       join leads l on l.id = m.lead_id
       join steps st on st.campaign_id = m.campaign_id and st.step_no = m.step_no
      where m.status = 'pending' and m.scheduled_at <= now()
        and l.status in ('new', 'active')
        and not exists (select 1 from blocklist b where b.phone = l.phone)
        and not exists (
              select 1 from messages m2 join leads l2 on l2.id = m2.lead_id
               where l2.phone = l.phone and m2.campaign_id <> m.campaign_id
                 and m2.status = 'sent' and m2.sent_at > now() - (c.cooldown_days || ' days')::interval)
      order by m.scheduled_at limit 1`),
)

await time('inbox threads', () =>
  q(`with thread as (
        select lead_phone, max(received_at) as last_at,
               count(*) filter (where not outbound and read_at is null)::int as unread
          from replies group by lead_phone)
      select t.*, l.name from thread t left join leads l on l.phone = t.lead_phone
       order by t.last_at desc limit 200`),
)

await time('duplicate-copy guard (per send)', () =>
  q(`select count(*)::int from messages
      where sender_id = (select min(id) from senders) and body_hash = 'nope'
        and sent_at > now() - interval '1 hour'`),
)

await pool.end()
