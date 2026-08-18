/**
 * Seeds a load-test dataset so you can see how the dashboard and the send loop
 * behave at scale before pointing them at real numbers.
 *
 *   node scripts/seed.ts --leads 100000 --senders 20 --sent 300000
 *
 * Everything lands in the `bench` list and a `Bench` campaign. Safe to re-run.
 */
import { migrate, pool, q } from '../lib/db.ts'

/*
 * Refuse to run against anything that does not look like a scratch database.
 *
 * This writes six-figure counts of fake leads, fake messages and fake senders with
 * status 'active'. Run by accident against the database an operator is actually
 * using, it buries their real contacts in noise and hands the send loop twenty
 * senders that do not exist. tests/flow.ts guards itself the same way; this had no
 * guard at all and defaulted to the normal database name.
 */
const url = process.env.DATABASE_URL ?? ''
if (!/(test|bench|seed|scratch)/i.test(url)) {
  console.error('refusing to seed: point DATABASE_URL at a scratch database, one with "test" or "bench" in its name')
  console.error(`got: ${url.replace(/:[^:@/]*@/, ':***@') || '(unset)'}`)
  process.exit(1)
}

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) : fallback
}

const leads = arg('leads', 100_000)
const senders = arg('senders', 20)
const sent = arg('sent', 300_000)

await migrate()

console.log(`seeding ${senders} senders, ${leads} leads, ${sent} sent messages…`)

await q(
  `insert into senders (phone, label, status, max_per_day, warmup_started_at)
   select '9198' || lpad(g::text, 8, '0'), 'bench-' || g, 'active', 60, now() - interval '30 days'
     from generate_series(1, $1) g
   on conflict (phone) do nothing`,
  [senders],
)

await q(
  `insert into leads (list, phone, name, vars)
   select 'bench', '9199' || lpad(g::text, 8, '0'), 'Lead ' || g,
          jsonb_build_object('company', 'Company ' || g)
     from generate_series(1, $1) g
   on conflict (list, phone) do nothing`,
  [leads],
)

const [campaign] = await q<{ id: number }>(
  `insert into campaigns (name, list, status, start_hour, end_hour, skip_weekends)
   values ('Bench', 'bench', 'paused', 0, 24, false)
   on conflict do nothing
   returning id`,
)
const campaignId =
  campaign?.id ??
  (await q<{ id: number }>(`select id from campaigns where name = 'Bench' limit 1`))[0].id

await q(
  `insert into steps (campaign_id, step_no, bodies, delay_hours)
   values ($1, 1, array['{Hi|Hey} {{first_name}}, saw {{company}}.'], 0),
          ($1, 2, array['{Following up|Circling back} {{first_name}}'], 48)
   on conflict (campaign_id, step_no) do nothing`,
  [campaignId],
)

// Sent history spread over the last 30 days, so aggregate queries face real volume.
// Each pass over the lead list becomes the next step number, so every row is a
// distinct (campaign, lead, step) and nothing is silently dropped by the conflict.
await q(
  `with p as (
      select count(*)::int as leads, min(id) as lead_lo from leads where list = 'bench'
   ), s as (
      select count(*)::int as senders, min(id) as sender_lo from senders
   )
   insert into messages (campaign_id, lead_id, step_no, sender_id, status, body, body_hash, wa_id, scheduled_at, sent_at, delivered_at, read_at)
   select $1,
          p.lead_lo + ((g - 1) % p.leads),
          1 + ((g - 1) / p.leads)::int,
          s.sender_lo + ((g - 1) % s.senders),
          'sent',
          'seeded body ' || g,
          md5(g::text),
          'seed-' || g,
          now() - ((g % 30) || ' days')::interval,
          now() - ((g % 30) || ' days')::interval,
          case when g % 10 < 9 then now() - ((g % 30) || ' days')::interval end,
          case when g % 10 < 5 then now() - ((g % 30) || ' days')::interval end
     from generate_series(1, $2) g, p, s
   on conflict (campaign_id, lead_id, step_no) do nothing`,
  [campaignId, sent],
)

const counts = await q<{ table_name: string; n: number }>(
  `select 'leads' as table_name, count(*)::int as n from leads
   union all select 'senders', count(*)::int from senders
   union all select 'messages', count(*)::int from messages
   union all select 'replies', count(*)::int from replies`,
)
console.table(counts)
await pool.end()
