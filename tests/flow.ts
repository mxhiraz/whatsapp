/**
 * End-to-end proof that the safety rules actually fire.
 *
 * Runs the real engine, the real SQL and the real policy against a stubbed
 * WhatsApp (WA_DRY_RUN=1), then asserts the things that keep numbers alive:
 * caps, non-uniform pacing, sticky threads, duplicate-copy refusal, opt-out,
 * reply cancellation, send windows, cooldowns and every auto-pause gate.
 *
 *   npm run test:flow
 *
 * Takes a couple of minutes: it waits on real timers, because that is the thing
 * being tested.
 */
import assert from 'node:assert/strict'
import { logEvent, migrate, one, pool, q } from '../lib/db.ts'
import { log, senderHealth, startCampaign, startEngine, stopEngine } from '../lib/engine.ts'
import { POLICY } from '../lib/safety.ts'
import { authStateFor, connect, readSessionFromDb, simulateDisconnect, simulateInbound } from '../lib/wa.ts'

if (process.env.WA_DRY_RUN !== '1') {
  console.error('refusing to run: set WA_DRY_RUN=1 so no real WhatsApp traffic can happen')
  process.exit(1)
}
if (!/test/i.test(process.env.DATABASE_URL ?? '')) {
  console.error('refusing to run: point DATABASE_URL at a database with "test" in its name')
  process.exit(1)
}

/*
 * A failed assertion has to take the process with it. The engine keeps timers and a
 * pool open, so without this the loop outlives the failure, carries on writing to the
 * test database, and quietly corrupts the next run — which is how one broken rule
 * turns into three runs failing in three different places.
 */
for (const fatal of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(fatal, e => {
    console.error(e)
    process.exit(1)
  })
}

/*
 * Only one of these may run at a time. A previous run that was killed mid-way leaves
 * its engine loop alive — the send loop is timers and a connection pool, neither of
 * which the assertion that failed takes down — and a second engine writing to the
 * same database makes the next run fail somewhere unrelated: two loops send two
 * messages from one number milliseconds apart, which reads as the pacing rule being
 * broken. The advisory lock is held by the pooled connection, so an orphan still
 * holds it and this refuses to start rather than chase a ghost.
 */
const lock = await pool.connect() // never released: the pool retires idle clients, and with them the lock
const held = await lock.query<{ locked: boolean }>(`select pg_try_advisory_lock(hashtext('wa-flow-test')) as locked`)
if (!held.rows[0]?.locked) {
  console.error('refusing to run: another flow test is still using this database (`pkill -f tests/flow.ts`)')
  process.exit(1)
}

const proven: string[] = []
const pass = (what: string) => { proven.push(what); console.log(`  ✓ ${what}`) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Waits for a condition, and on timeout prints why the engine was idle rather
 * than just failing. A test that says "timed out" sends you guessing; one that
 * dumps sender eligibility and the head of the queue tells you the answer.
 */
async function waitFor(label: string, cond: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await cond()) return
    await sleep(500)
  }
  await explainIdleEngine(label)
  throw new Error(`timed out waiting for: ${label}`)
}

async function explainIdleEngine(label: string): Promise<void> {
  console.error(`\n─── timed out waiting for: ${label} — engine state ───`)
  console.table(
    (await senderHealth()).map(s => ({
      phone: s.phone,
      status: s.status,
      link: s.state,
      today: `${s.sent_today}/${s.cap_today}`,
      hour: `${s.sent_hour}/${s.max_per_hour}`,
      health: s.health,
      paused_until: s.paused_until ?? '',
      break_until: s.break_until ?? '',
      next_ready_at: s.next_ready_at ?? '',
    })),
  )
  console.table(
    await q(
      `select m.id, m.campaign_id, c.status as campaign, c.start_hour, c.end_hour, c.timezone,
              extract(hour from now() at time zone c.timezone)::int as hour_there,
              l.phone, l.status as lead_status, l.sender_id, m.status, m.scheduled_at,
              exists (select 1 from blocklist b where b.phone = l.phone) as blocked,
              exists (select 1 from messages m2 join leads l2 on l2.id = m2.lead_id
                       where l2.phone = l.phone and m2.campaign_id <> m.campaign_id
                         and m2.status = 'sent'
                         and m2.sent_at > now() - (c.cooldown_days || ' days')::interval) as in_cooldown
         from messages m
         join campaigns c on c.id = m.campaign_id
         join leads l on l.id = m.lead_id
        where m.status = 'pending'
        order by m.scheduled_at limit 10`,
    ),
  )
  console.error(`engine log:\n${log.slice(0, 12).map(l => `  ${l.at.slice(11, 19)} ${l.msg}`).join('\n')}`)
}

const SENDERS = ['919000000001', '919000000002', '919000000003']
const DEAD = '919100000000' // dry-run treats numbers ending 0000 as "not on WhatsApp"

// ── fixture ──────────────────────────────────────────────────────────────────
console.log('\nresetting test database')
await pool.query('drop schema public cascade; create schema public;')
await migrate()

for (const phone of SENDERS) await connect(phone)
await q(
  `update senders set status = 'active', max_per_day = 60, max_per_hour = 5,
                      warmup_started_at = now() - interval '30 days'`,
)

const leadPhones = [DEAD, ...Array.from({ length: 13 }, (_, i) => `9191000000${String(i + 1).padStart(2, '0')}`)]
await q(
  `insert into leads (list, phone, name, vars)
   select 'cold', p, 'Lead ' || p, jsonb_build_object('company', 'Co ' || p)
     from unnest($1::text[]) p`,
  [leadPhones],
)

const campaign = await one<{ id: number }>(
  `insert into campaigns (name, list, min_delay_sec, max_delay_sec, start_hour, end_hour, skip_weekends, cooldown_days)
   values ('Flow test', 'cold', 1, 3, 0, 24, false, 30) returning id`,
)
const cid = campaign!.id
await q(
  `insert into steps (campaign_id, step_no, bodies, delay_hours) values
     ($1, 1, array['{Hi|Hey|Hello} {{first_name}}, saw {{company}} — {worth a chat|open to a chat|any interest}?',
                   '{Morning|Hey there} {{first_name}}, {{company}} {caught my eye|looked interesting}.'], 0),
     ($1, 2, array['{Following up|Circling back|Bumping this} {{first_name}} — {any thoughts|still relevant}?'], 0.0006)`,
  [cid],
)

startEngine()
console.log('\nphase 1 — sending, pacing and rotation')
const { queued } = await startCampaign(cid)
assert.equal(queued, leadPhones.length, 'every lead queued')

await waitFor('first step to finish sending', async () => {
  const row = await one<{ done: number }>(
    `select count(*)::int as done from messages where campaign_id = $1 and step_no = 1 and status in ('sent', 'skipped')`,
    [cid],
  )
  return (row?.done ?? 0) >= leadPhones.length
})

// 1. hourly cap is never exceeded
const perSender = await q<{ phone: string; n: number }>(
  `select s.phone, count(*)::int as n from messages m join senders s on s.id = m.sender_id
    where m.status = 'sent' and m.sent_at > now() - interval '1 hour' group by s.phone`,
)
for (const row of perSender) assert.ok(row.n <= 5, `${row.phone} sent ${row.n}, cap is 5`)
pass(`hourly cap held: ${perSender.map(r => `${r.phone.slice(-4)}=${r.n}`).join(' ')} (cap 5 each)`)

// 2. numbers actually rotate
assert.ok(perSender.length >= 2, 'more than one number was used')
pass(`rotation across ${perSender.length} numbers`)

// 3. each number paces itself, with randomised gaps and no fixed interval
const sends = await q<{ sender_id: number; sent_at: string }>(
  `select sender_id, sent_at from messages where status = 'sent' and campaign_id = $1 order by sent_at`,
  [cid],
)
const perNumberGaps = new Map<number, number[]>()
const lastAt = new Map<number, number>()
for (const s of sends) {
  const t = new Date(s.sent_at).getTime()
  const prev = lastAt.get(s.sender_id)
  if (prev !== undefined) perNumberGaps.set(s.sender_id, [...(perNumberGaps.get(s.sender_id) ?? []), t - prev])
  lastAt.set(s.sender_id, t)
}
const ownGaps = [...perNumberGaps.values()].flat()
assert.ok(ownGaps.length >= 5, 'enough sends per number to judge pacing')
assert.ok(Math.min(...ownGaps) >= 900, `a number sent twice ${Math.min(...ownGaps)}ms apart, under its 1s floor`)
assert.ok(new Set(ownGaps).size / ownGaps.length > 0.6, 'gaps repeat too often to look human')
pass(`per-number pacing randomised: ${ownGaps.length} gaps, ${Math.min(...ownGaps)}–${Math.max(...ownGaps)}ms, ${new Set(ownGaps).size} distinct`)

// 3b. throughput comes from having several numbers, not from sending faster
const globalGaps = sends.slice(1).map((r, i) => new Date(r.sent_at).getTime() - new Date(sends[i].sent_at).getTime())
assert.ok(
  Math.min(...globalGaps) < Math.min(...ownGaps),
  'numbers are queueing behind one global timer instead of pacing independently',
)
pass(`numbers send in parallel: global gaps down to ${Math.min(...globalGaps)}ms while each number waits ≥${Math.min(...ownGaps)}ms`)

// 4. no number sends the same text twice inside the window
const dupes = await q<{ n: number }>(
  `select count(*)::int as n from messages
    where status = 'sent' and sent_at > now() - ($1 || ' hours')::interval
    group by sender_id, body_hash having count(*) > $2`,
  [POLICY.duplicateWindowHours, POLICY.maxIdenticalPerWindow],
)
assert.equal(dupes.length, 0, 'identical copy was sent too often from one number')
pass(`duplicate-copy guard held (max ${POLICY.maxIdenticalPerWindow}/number/${POLICY.duplicateWindowHours}h)`)

// 5. dead numbers are detected instead of burning quota
const dead = await one<{ status: string }>(`select status from leads where phone = $1`, [DEAD])
assert.equal(dead?.status, 'invalid', 'number without WhatsApp marked invalid')
const deadMsg = await one<{ status: string }>(
  `select m.status from messages m join leads l on l.id = m.lead_id where l.phone = $1`,
  [DEAD],
)
assert.equal(deadMsg?.status, 'skipped', 'no send attempted to a number with no WhatsApp account')
pass('numbers without WhatsApp skipped, not sent to')

// 6. follow-ups are scheduled and sent from the same number
await waitFor('follow-up step to send', async () => {
  const row = await one<{ n: number }>(
    `select count(*)::int as n from messages where campaign_id = $1 and step_no = 2 and status = 'sent'`,
    [cid],
  )
  return (row?.n ?? 0) >= 1
})
const drift = await q<{ phone: string }>(
  `select l.phone from messages m join leads l on l.id = m.lead_id
    where m.status = 'sent' group by l.phone having count(distinct m.sender_id) > 1`,
)
assert.equal(drift.length, 0, 'a follow-up came from a different number than step 1')
pass('follow-ups sent, always from the number that opened the thread')

// ── replies ──────────────────────────────────────────────────────────────────
console.log('\nphase 2 — replies, opt-out and the inbox')
const replier = await one<{ phone: string; sender: string }>(
  `select l.phone, s.phone as sender from messages m
     join leads l on l.id = m.lead_id join senders s on s.id = m.sender_id
    where m.step_no = 1 and m.status = 'sent' and l.phone <> $1
      and exists (select 1 from messages p where p.lead_id = l.id and p.status = 'pending')
    limit 1`,
  [DEAD],
)
assert.ok(replier, 'found a lead mid-sequence to reply with')
await simulateInbound(replier!.sender, replier!.phone, 'sounds interesting, tell me more')

const afterReply = await one<{ status: string; pending: number; unread: number }>(
  `select l.status,
          (select count(*)::int from messages m where m.lead_id = l.id and m.status = 'pending') as pending,
          (select count(*)::int from replies r where r.lead_phone = l.phone and r.read_at is null) as unread
     from leads l where l.phone = $1`,
  [replier!.phone],
)
assert.equal(afterReply?.status, 'replied')
assert.equal(afterReply?.pending, 0, 'remaining steps cancelled on reply')
assert.equal(afterReply?.unread, 1, 'reply lands in the inbox unread')
pass('a reply stops the sequence and shows up unread in the inbox')

const optOutLead = await one<{ phone: string; sender: string }>(
  `select l.phone, s.phone as sender from messages m
     join leads l on l.id = m.lead_id join senders s on s.id = m.sender_id
    where m.status = 'sent' and l.status = 'active' and l.phone <> $1 limit 1`,
  [replier!.phone],
)
await simulateInbound(optOutLead!.sender, optOutLead!.phone, 'STOP')
const blocked = await one(`select 1 from blocklist where phone = $1`, [optOutLead!.phone])
const optOutStatus = await one<{ status: string }>(`select status from leads where phone = $1`, [optOutLead!.phone])
assert.ok(blocked, 'opt-out added to the global blocklist')
assert.equal(optOutStatus?.status, 'opted_out')
pass('opt-out blocklists the number globally and cancels its queue')

/**
 * Delivery and read receipts. The dry run acks every send a beat after it lands,
 * so this waits for the acks to catch up rather than asserting against a fudge
 * factor — an assertion that tolerated "all but two" passed or failed depending
 * on how many sends happened in the previous two seconds.
 */
const ackCounts = () =>
  one<{ sent: number; delivered: number; read: number }>(
    `select count(*)::int as sent,
            count(*) filter (where delivered_at is not null)::int as delivered,
            count(*) filter (where read_at is not null)::int as read
       from messages where status = 'sent'`,
  )

await waitFor('delivery and read receipts to arrive for every send', async () => {
  const row = await ackCounts()
  // Read acks land a second behind delivery ones, so wait for both to catch up:
  // asserting on delivery alone raced the stub's own ladder.
  return Boolean(row && row.sent > 0 && row.delivered >= row.sent && row.read >= row.delivered)
}, 60_000)
const acked = (await ackCounts())!
assert.equal(acked.read, acked.delivered, 'a read receipt implies a delivery receipt')
pass(`delivery and read receipts recorded for all ${acked.sent} sends`)

// ── the auto-pause gates ─────────────────────────────────────────────────────
console.log('\nphase 3 — health, reply-rate and delivery gates')

// 7. health score pauses a number and stops it sending
const victim = await one<{ id: number; phone: string }>(`select id, phone from senders order by id limit 1`)
await logEvent(victim!.id, 'forbidden', POLICY.penalty.forbidden, 'simulated 403')
await logEvent(victim!.id, 'logged_out', POLICY.penalty.logged_out, 'simulated 401')
await waitFor('critical health to pause the number', async () => {
  const row = await one<{ status: string; paused_until: string | null }>(
    `select status, paused_until from senders where id = $1`, [victim!.id],
  )
  return row?.status === 'paused' && Boolean(row.paused_until)
})
const before = await one<{ n: number }>(`select count(*)::int as n from messages where sender_id = $1`, [victim!.id])
await sleep(6_000)
const after = await one<{ n: number }>(`select count(*)::int as n from messages where sender_id = $1`, [victim!.id])
assert.equal(after!.n, before!.n, 'a paused number kept sending')
pass(`health ${POLICY.penalty.forbidden + POLICY.penalty.logged_out} → auto-paused ${POLICY.criticalPauseHours}h and stopped sending`)

// 8. a number nobody replies to gets pulled
await q(
  `insert into senders (phone, status, max_per_day, warmup_started_at)
   values ('919000000009', 'active', 60, now() - interval '30 days')`,
)
const ghost = await one<{ id: number }>(`select id from senders where phone = '919000000009'`)
await q(
  `insert into messages (campaign_id, lead_id, step_no, sender_id, status, body, wa_id, sent_at)
   select $1, (select id from leads limit 1), 100 + g, $2, 'sent', 'x', 'ghost-' || g, now() - interval '2 hours'
     from generate_series(1, $3) g`,
  [cid, ghost!.id, POLICY.minReplySamples + 5],
)
await waitFor('zero-reply number to be paused', async () => {
  const row = await one<{ status: string }>(`select status from senders where id = $1`, [ghost!.id])
  return row?.status === 'paused'
})
pass(`reply rate below ${POLICY.replyRatePause * 100}% after ${POLICY.minReplySamples} sends → auto-paused ${POLICY.softBanPauseHours}h`)

/**
 * 9. Collapsed delivery pauses a number — but only alongside a poor reply rate.
 *
 * Fixture: 100 sends, 17% delivered (below the floor) and 6 replies, which is a
 * reply-rate *warning* rather than a pause on its own. That isolates the delivery
 * branch: if it fires, it fired for the delivery reason.
 */
const seedSender = async (phone: string, sent: number, delivered: number, replies: number) => {
  await q(
    `insert into senders (phone, status, max_per_day, warmup_started_at)
     values ($1, 'active', 60, now() - interval '30 days') on conflict (phone) do nothing`,
    [phone],
  )
  const row = await one<{ id: number }>(`select id from senders where phone = $1`, [phone])
  await q(
    `insert into messages (campaign_id, lead_id, step_no, sender_id, status, body, wa_id, sent_at, delivered_at)
     select $1, (select id from leads limit 1), $4 + g, $2, 'sent', 'x', $5 || g, now() - interval '2 hours',
            case when g <= $3 then now() end
       from generate_series(1, $6) g`,
    [cid, row!.id, delivered, 200 + Number(phone.slice(-2)) * 400, `d-${phone}-`, sent],
  )
  if (replies > 0) {
    await q(
      `insert into replies (sender_phone, lead_phone, body, received_at)
       select $1, '92' || $1 || lpad(g::text, 3, '0'), 'ok', now() from generate_series(1, $2) g`,
      [phone, replies],
    )
  }
  return row!.id
}

const undelivered = await seedSender('919000000010', 100, 17, 6)
await waitFor('undelivered number with few replies to be paused', async () => {
  const row = await one<{ status: string }>(`select status from senders where id = $1`, [undelivered])
  return row?.status === 'paused'
})
pass(`delivery below ${POLICY.deliveryFloor * 100}% with a weak reply rate → auto-paused`)

/**
 * 9b. The control for the same rule, and the reason it exists: low delivery on
 * WhatsApp usually means dead numbers in the list, not a burnt sender. A number
 * that is clearly reaching people must keep sending.
 */
const answered = await seedSender('919000000011', 100, 17, 40)
await sleep(8_000)
const stillSending = await one<{ status: string }>(`select status from senders where id = $1`, [answered])
assert.equal(stillSending?.status, 'active', 'a number with healthy replies was paused on delivery alone')
pass('low delivery alone does not pause a number that is getting replies')

// ── windows and cooldowns ────────────────────────────────────────────────────
console.log('\nphase 4 — send windows and cross-campaign cooldown')

// 10. nothing is sent outside the campaign's hours
const hour = new Date().getHours()
const closed = await one<{ id: number }>(
  `insert into campaigns (name, list, min_delay_sec, max_delay_sec, start_hour, end_hour, skip_weekends, cooldown_days)
   values ('Closed window', 'window', 1, 2, $1, $2, false, 0) returning id`,
  [(hour + 2) % 24, (hour + 3) % 24],
)
await q(
  `insert into leads (list, phone, name) select 'window', '9193000000' || lpad(g::text, 2, '0'), 'W' || g
     from generate_series(1, 5) g`,
)
await assert.rejects(
  () => startCampaign(closed!.id),
  /no message steps/,
  'refuses to start a campaign with nothing written yet',
)
await q(
  `insert into steps (campaign_id, step_no, bodies, delay_hours) values ($1, 1, array['{Hi|Hey} out of hours'], 0)`,
  [closed!.id],
)
await assert.rejects(
  () => startCampaign(-1),
  /no such campaign/,
  'starting a campaign that does not exist fails loudly',
)
// Give the surviving numbers room, so "nothing sent" can only mean the rule fired
// and not that every number happened to be capped.
await q(`update senders set max_per_hour = 50, break_until = null where status = 'active'`)

await startCampaign(closed!.id)
await sleep(12_000)
const outOfHours = await one<{ n: number }>(
  `select count(*)::int as n from messages where campaign_id = $1 and status = 'sent'`, [closed!.id],
)
assert.equal(outOfHours!.n, 0, 'sent outside the configured window')

// Control: open the window and the same queue drains, proving the gate was the cause.
await q(`update campaigns set start_hour = 0, end_hour = 24 where id = $1`, [closed!.id])
await waitFor('the same campaign to send once its window opens', async () => {
  const row = await one<{ n: number }>(
    `select count(*)::int as n from messages where campaign_id = $1 and status = 'sent'`, [closed!.id],
  )
  return (row?.n ?? 0) > 0
})
pass('send window respected: queue frozen outside campaign hours, drains as soon as they open')

// 11. a lead contacted by one campaign is off-limits to another during the cooldown
const contacted = await one<{ phone: string }>(
  `select l.phone from messages m join leads l on l.id = m.lead_id where m.status = 'sent' limit 1`,
)
const fresh = '919400000001'
await q(`insert into leads (list, phone, name) values ('cold2', $1, 'dup'), ('cold2', $2, 'fresh')`, [
  contacted!.phone, fresh,
])
const second = await one<{ id: number }>(
  `insert into campaigns (name, list, min_delay_sec, max_delay_sec, start_hour, end_hour, skip_weekends, cooldown_days)
   values ('Cooldown test', 'cold2', 1, 2, 0, 24, false, 30) returning id`,
)
await q(`insert into steps (campaign_id, step_no, bodies, delay_hours) values ($1, 1, array['{Hi|Hey} again'], 0)`, [second!.id])

/**
 * Clear the micro-breaks first. By this point the working numbers have finished a
 * burst and are legitimately resting for 20–55 minutes, which is far longer than
 * this test waits. That is the pacing rule behaving correctly — but this test is
 * about the cooldown rule, so it neutralises breaks rather than waiting them out.
 */
await q(`update senders set break_until = null, next_ready_at = null where status = 'active'`)
await startCampaign(second!.id)

// The never-contacted lead in the same campaign must go out — that is the control.
await waitFor('the fresh lead in the second campaign to send', async () => {
  const row = await one<{ n: number }>(
    `select count(*)::int as n from messages m join leads l on l.id = m.lead_id
      where m.campaign_id = $1 and l.phone = $2 and m.status = 'sent'`,
    [second!.id, fresh],
  )
  return (row?.n ?? 0) > 0
})
const reContacted = await one<{ n: number }>(
  `select count(*)::int as n from messages m join leads l on l.id = m.lead_id
    where m.campaign_id = $1 and l.phone = $2 and m.status = 'sent'`,
  [second!.id, contacted!.phone],
)
assert.equal(reContacted!.n, 0, 'contacted a number again inside the cooldown')
pass('cross-campaign cooldown respected: fresh lead sent, already-contacted lead held back')

// ── failure paths ────────────────────────────────────────────────────────────
console.log('\nphase 5 — timeouts, duplicate replies and terminal disconnects')

/**
 * The dry run fails the first WhatsApp call for a lead whose number ends 9999
 * (the lookup) or 8888 (the send), then answers normally. That is the failure
 * that used to stop the send loop dead: an unbounded await with nothing logged.
 */
const SLOW_LOOKUP = '919200009999'
const SLOW_SEND = '919200008888'
await q(
  `insert into leads (list, phone, name) values ('faults', $1, 'Slow lookup'), ('faults', $2, 'Slow send')`,
  [SLOW_LOOKUP, SLOW_SEND],
)
const faults = await one<{ id: number }>(
  `insert into campaigns (name, list, min_delay_sec, max_delay_sec, start_hour, end_hour, skip_weekends, cooldown_days)
   values ('Fault test', 'faults', 1, 2, 0, 24, false, 0) returning id`,
)
await q(`insert into steps (campaign_id, step_no, bodies, delay_hours) values ($1, 1, array['{Hi|Hey} there'], 0)`, [faults!.id])
const clearBreaks = () => q(`update senders set break_until = null, next_ready_at = null where status = 'active'`)
await clearBreaks()
await startCampaign(faults!.id)

// 12. a timed-out call is re-queued, not failed, and the loop carries on
await waitFor('the timed-out lookup to be re-queued', async () => {
  const row = await one<{ status: string; error: string | null; later: boolean }>(
    `select m.status, m.error, m.scheduled_at > now() as later from messages m
       join leads l on l.id = m.lead_id where l.phone = $1`,
    [SLOW_LOOKUP],
  )
  return row?.status === 'pending' && row.later && row.error === null
})
pass('a WhatsApp call that times out re-queues the message instead of failing it')

// The loop must not have stopped on it: the other lead in the same campaign goes out.
await clearBreaks()
await waitFor('the send loop to keep working after the timeout', async () => {
  const row = await one<{ status: string }>(
    `select m.status from messages m join leads l on l.id = m.lead_id where l.phone = $1`,
    [SLOW_SEND],
  )
  return row?.status === 'sent'
})

// 13. a send whose confirmation times out is filed once, never sent twice
const unconfirmed = await one<{ n: number; wa_id: string | null; error: string | null }>(
  `select count(*)::int as n, max(m.wa_id) as wa_id, max(m.error) as error
     from messages m join leads l on l.id = m.lead_id
    where l.phone = $1 and m.status = 'sent'`,
  [SLOW_SEND],
)
assert.equal(unconfirmed!.n, 1, 'a send that timed out was recorded twice')
assert.ok(unconfirmed!.wa_id, 'a send that timed out was recorded without its message id')
assert.match(unconfirmed!.error ?? '', /not confirmed/, 'a send that timed out is not flagged as unconfirmed')
pass('a send whose confirmation times out is recorded once, with its id, never re-sent')

// The re-queued lookup succeeds on the retry rather than being lost.
await q(`update messages set scheduled_at = now() where id in
          (select m.id from messages m join leads l on l.id = m.lead_id where l.phone = $1)`, [SLOW_LOOKUP])
await clearBreaks()
await waitFor('the re-queued message to send on the retry', async () => {
  const row = await one<{ status: string }>(
    `select m.status from messages m join leads l on l.id = m.lead_id where l.phone = $1`,
    [SLOW_LOOKUP],
  )
  return row?.status === 'sent'
})
pass('the re-queued message goes out on the next attempt, so nothing is lost')

// 14. the same inbound message delivered twice counts once
const twice = '919200001111'
await simulateInbound(SENDERS[1], twice, 'same message', 'wa-dup-1')
await simulateInbound(SENDERS[1], twice, 'same message', 'wa-dup-1')  // WhatsApp re-delivers
const dupReplies = await one<{ n: number }>(`select count(*)::int as n from replies where lead_phone = $1`, [twice])
assert.equal(dupReplies!.n, 1, 'a re-delivered reply was counted twice')
await simulateInbound(SENDERS[1], twice, 'a second, different message', 'wa-dup-2')
const bothReplies = await one<{ n: number }>(`select count(*)::int as n from replies where lead_phone = $1`, [twice])
assert.equal(bothReplies!.n, 2, 'a genuinely new reply was dropped as a duplicate')
pass('a reply delivered twice is counted once; a different reply still counts')

/**
 * A reply that arrived while the socket was down comes back on reconnect as an
 * 'append' upsert, not a 'notify' one. Dropping those is how a reply vanishes while
 * the sequence keeps messaging someone who already answered.
 */
const backlog = '919200002222'
await simulateInbound(SENDERS[1], backlog, 'I replied while you were offline', 'wa-append-1', 'append')
const recovered = await one<{ n: number }>(`select count(*)::int as n from replies where lead_phone = $1`, [backlog])
assert.equal(recovered!.n, 1, 'a reply queued while the socket was down was dropped')
// The same message arriving again live must still not double-count.
await simulateInbound(SENDERS[1], backlog, 'I replied while you were offline', 'wa-append-1')
const recoveredOnce = await one<{ n: number }>(`select count(*)::int as n from replies where lead_phone = $1`, [backlog])
assert.equal(recoveredOnce!.n, 1, 'a message seen as both append and notify was counted twice')
pass('a reply queued while the socket was down still lands, and only once')

// 15. a campaign that only ever skips still finishes
await q(`insert into leads (list, phone, name) values ('skips', '919200000000', 'No WhatsApp')`)
const skipOnly = await one<{ id: number }>(
  `insert into campaigns (name, list, min_delay_sec, max_delay_sec, start_hour, end_hour, skip_weekends, cooldown_days)
   values ('Skip only', 'skips', 1, 2, 0, 24, false, 0) returning id`,
)
await q(`insert into steps (campaign_id, step_no, bodies, delay_hours) values ($1, 1, array['{Hi|Hey} skipped'], 0)`, [skipOnly!.id])
await clearBreaks()
await startCampaign(skipOnly!.id)
await waitFor('a campaign whose only message is skipped to reach done', async () => {
  const row = await one<{ status: string }>(`select status from campaigns where id = $1`, [skipOnly!.id])
  return row?.status === 'done'
})
pass('a campaign that sent nothing but skipped everything still reports done')

// 16. a contact who opts out mid-sequence leaves nothing behind
const quitter = '919200003333'
await q(`insert into leads (list, phone, name) values ('optout', $1, 'Opts out')`, [quitter])
const optOutOnly = await one<{ id: number }>(
  `insert into campaigns (name, list, min_delay_sec, max_delay_sec, start_hour, end_hour, skip_weekends, cooldown_days)
   values ('Opt-out only', 'optout', 1, 2, 0, 24, false, 0) returning id`,
)
await q(
  `insert into steps (campaign_id, step_no, bodies, delay_hours) values
     ($1, 1, array['{Hi|Hey} there'], 0),
     ($1, 2, array['{Following up|Circling back}'], 0.0006)`,
  [optOutOnly!.id],
)
await clearBreaks()
await startCampaign(optOutOnly!.id)
await waitFor('the first step of the opt-out campaign to send', async () => {
  const row = await one<{ n: number }>(
    `select count(*)::int as n from messages m join leads l on l.id = m.lead_id
      where m.campaign_id = $1 and l.phone = $2 and m.status = 'sent'`,
    [optOutOnly!.id, quitter],
  )
  return (row?.n ?? 0) > 0
})
await simulateInbound(SENDERS[1], quitter, 'STOP please', 'wa-optout-1')
await waitFor('a campaign whose only contact opted out to reach done', async () => {
  const row = await one<{ status: string }>(`select status from campaigns where id = $1`, [optOutOnly!.id])
  return row?.status === 'done'
})
const leftBehind = await one<{ n: number }>(
  `select count(*)::int as n from messages m join leads l on l.id = m.lead_id
    where l.phone = $1 and m.status = 'pending'`,
  [quitter],
)
assert.equal(leftBehind!.n, 0, 'a follow-up was queued for a contact who had opted out')
pass('an opt-out mid-sequence queues no follow-up, and its campaign still finishes')

// 17. a terminal disconnect stops retrying and says why
const terminal = '919000000021'
await connect(terminal)
await simulateDisconnect(terminal, 401)
const bannedRow = await one<{ status: string }>(`select status from senders where phone = $1`, [terminal])
assert.equal(bannedRow?.status, 'banned', 'a logged-out number was not marked banned')
const bannedLink = (await senderHealth()).find(s => s.phone === terminal)
assert.equal(bannedLink?.state, 'banned')
assert.match(bannedLink?.error ?? '', /logged out/, 'a banned number does not say why')
await sleep(6_000)
const stillBanned = (await senderHealth()).find(s => s.phone === terminal)
assert.equal(stillBanned?.state, 'banned', 'a logged-out number kept reconnecting instead of stopping')
pass('a terminal disconnect (401) stops retrying, marks the number banned and shows the reason')

// 18. credentials WhatsApp keeps rejecting stop being retried
const rejected = '919000000022'
await connect(rejected)
// 500 is Baileys' default for any stream error without a code, so one or two are not
// evidence of anything. Three inside ten minutes are, and the retrying then stops.
for (let i = 0; i < 3; i++) {
  await simulateDisconnect(rejected, 500)
  await sleep(1_000) // let the scheduled reconnect settle before the next close
}
await sleep(6_000)
const stillRejected = (await senderHealth()).find(s => s.phone === rejected)
assert.equal(stillRejected?.state, 'offline', 'a rejected session kept reconnecting against credentials WhatsApp refuses')
assert.match(stillRejected?.error ?? '', /Press reconnect/, 'a rejected session does not tell the operator what to do')
pass('a session WhatsApp keeps rejecting (500) stops retrying and says what to do, instead of looping forever')

// ── the session store ────────────────────────────────────────────────────────
console.log('\nphase 6 — the WhatsApp session store')

/**
 * The credentials and signal keys are the number's WhatsApp login. They used to be
 * loose JSON files that each socket re-read into its own copy, which is how two
 * sockets ended up with divergent credentials and the loser was rejected with 440.
 * This proves the Postgres store round-trips them intact — Buffers included, since a
 * Buffer that comes back as a plain object is a session that cannot decrypt.
 */
const authPhone = '919000000030'
const session = await authStateFor(authPhone)
session.state.creds.registered = true
await session.saveCreds()
await session.state.keys.set({ 'pre-key': { '7': { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } } })

const reread = await readSessionFromDb(authPhone)
assert.equal(reread.state.creds.registered, true, 'credentials did not survive a reload')
assert.equal(reread.state.creds.registrationId, session.state.creds.registrationId)
const preKey = (await reread.state.keys.get('pre-key', ['7']))['7']
assert.ok(Buffer.isBuffer(preKey?.public), 'a key came back as something other than a Buffer')
assert.deepEqual([...preKey.public], [1, 2, 3], 'key material changed in the round trip')

// Baileys asks for a key to be deleted by setting it to null.
await reread.state.keys.set({ 'pre-key': { '7': null } })
assert.deepEqual(await (await readSessionFromDb(authPhone)).state.keys.get('pre-key', ['7']), {}, 'a deleted key came back')
const stored = await one<{ n: number }>(`select count(*)::int as n from wa_auth where phone = $1`, [authPhone])
assert.equal(stored!.n, 1, 'deleting a key left its row behind')
pass('the session store round-trips credentials and keys through Postgres, and a null value deletes')

// ── summary ──────────────────────────────────────────────────────────────────
const health = await senderHealth()
console.log('\nfinal state of the numbers')
console.table(
  health.map(s => ({
    phone: s.phone,
    status: s.status,
    link: s.state,
    today: `${s.sent_today}/${s.cap_today}`,
    hour: `${s.sent_hour}/${s.max_per_hour}`,
    health: s.health,
    reply: `${Math.round(s.reply_rate * 100)}%`,
    delivered: `${Math.round(s.delivery_rate * 100)}%`,
  })),
)

console.log(`\n${proven.length} safety rules proven under a live engine:`)
proven.forEach((p, i) => console.log(` ${String(i + 1).padStart(2)}. ${p}`))
console.log('\nflow.ts ok')
// Stop the loop before the pool goes, or the engine spends the shutdown ticking
// against a closed pool. The lock connection has to go back too: `pool.end()` waits
// for every client, and one held forever would hang the exit.
stopEngine()
lock.release()
await pool.end()
process.exit(0)
