import { ttlCache } from './cache.ts'
import {
  logEvent, one, q,
  type Campaign, type DueMessage, type Sender, type SenderHealth,
} from './db.ts'
import { hash, render } from './parse.ts'
import {
  POLICY, breakAfter, breakMs, capForToday, circadian, dailyTarget,
  deliveryVerdict, jitterMs, replyVerdict, risk, throttle,
  type Policy,
} from './safety.ts'
import { effectivePolicy } from './settings.ts'
import { WaTimeout, closeAll, hasWhatsApp, onlinePhones, send, statusOf } from './wa.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const IDLE_MS = 30_000

export interface LogLine { at: string; msg: string; level: 'info' | 'warn' }
/*
 * Shared with the route handlers through globalThis, for the reason documented in
 * lib/wa.ts: instrumentation and the routes are compiled separately, so a plain
 * module-level value is two values. The Activity feed reads `log` from a route.
 */
const shared = <T>(key: string, make: () => T): T => {
  const g = globalThis as typeof globalThis & { __waEngine?: Record<string, unknown> }
  g.__waEngine ??= {}
  return (g.__waEngine[key] ??= make()) as T
}

export const log: LogLine[] = shared('log', () => [] as LogLine[])

const note = (msg: string, level: LogLine['level'] = 'info'): void => {
  log.unshift({ at: new Date().toISOString(), msg, level })
  log.length = Math.min(log.length, 300)
  console.log(`[engine] ${msg}`)
}

/** Trade-off: burst counters live in memory, so a restart begins a fresh burst. */
const sendsSinceBreak = shared('sendsSinceBreak', () => new Map<string, number>())
let running = false

/**
 * Lifetime totals and reply counts feed the statistical gates (reply rate,
 * delivery rate), which are judged over hundreds of sends. A minute of staleness
 * cannot change a verdict, and caching them keeps a full-history scan off the
 * per-send path — the difference between O(all messages ever) and O(today).
 */
const lifetimeStats = ttlCache(60_000, () =>
  q<{ sender_id: number; sent_total: number; delivered_total: number }>(
    `select sender_id,
            count(*)::int as sent_total,
            count(*) filter (where delivered_at is not null)::int as delivered_total
       from messages
      where sender_id is not null and status = 'sent'
      group by sender_id`,
  ),
)

const replyCounts = ttlCache(60_000, () =>
  q<{ sender_phone: string; replies: number }>(
    `select sender_phone, count(distinct lead_phone)::int as replies
       from replies where not outbound group by sender_phone`,
  ),
)

/**
 * Every sender with its derived counters. Counters come from `messages` rather
 * than columns on `senders`, so they can never drift out of sync.
 *
 * Today's and this hour's counts are always exact and never cached: the caps are
 * enforced from them, and an over-send cannot be taken back.
 */
export async function senderHealth(): Promise<SenderHealth[]> {
  const [policy, rows, life, reps] = await Promise.all([
    effectivePolicy(),
    q<Sender & { health: number; sent_today: number; sent_hour: number }>(
      `select s.*,
              coalesce(ev.health, 0) as health,
              coalesce(m.sent_today, 0) as sent_today,
              coalesce(m.sent_hour, 0) as sent_hour
         from senders s
         left join (
              /*
               * Which midnight resets the daily cap: the database's, not the campaign's.
               *
               * A campaign's timezone governs its send window, because that is about
               * when the recipient is awake. The daily cap is a property of the number,
               * and one number can serve several campaigns in different timezones, so a
               * per-campaign midnight would hand it several cap resets a day — the cap
               * would stop being a cap. Per-number local time would be more precise
               * again, but nothing here knows where a number is.
               *
               * So the clock is the database's timezone, written out rather than left
               * implicit in now(). An operator who wants their own midnight sets it
               * once: alter database wa_outreach set timezone = 'Asia/Kolkata'.
               */
              select sender_id,
                     count(*)::int as sent_today,
                     count(*) filter (where sent_at > now() - interval '1 hour')::int as sent_hour
                from messages
               where status = 'sent'
                 and sent_at >= date_trunc('day', now() at time zone current_setting('TimeZone'))
                               at time zone current_setting('TimeZone')
               group by sender_id
         ) m on m.sender_id = s.id
         left join (
              select sender_id, sum(points)::int as health
                from sender_events where at > now() - interval '24 hours' group by sender_id
         ) ev on ev.sender_id = s.id
        order by s.id`,
    ),
    lifetimeStats(),
    replyCounts(),
  ])

  const byId = new Map(life.map(r => [r.sender_id, r]))
  const byPhone = new Map(reps.map(r => [r.sender_phone, r.replies]))

  return rows.map(r => {
    const sent_total = byId.get(r.id)?.sent_total ?? 0
    const delivered_total = byId.get(r.id)?.delivered_total ?? 0
    const replies = byPhone.get(r.phone) ?? 0
    return {
      ...r,
      ...statusOf(r.phone),
      sent_total,
      delivered_total,
      replies,
      cap_today: capForToday(r.warmup_started_at, r.max_per_day, undefined, Number(r.warmup_growth), policy),
      reply_rate: sent_total ? replies / sent_total : 0,
      delivery_rate: sent_total ? delivered_total / sent_total : 0,
    }
  })
}

/**
 * Applies the health rules: pause what looks burnt, and let expired pauses back
 * in — but from warmup day 1, which is the "resume slow, ramp up" recovery plan.
 */
async function policeSenders(all: SenderHealth[], policy: Policy): Promise<void> {
  for (const s of all) {
    if (s.paused_until && new Date(s.paused_until) > new Date()) continue

    if (s.paused_until) {
      await q(
        `update senders set paused_until = null, warmup_started_at = now(),
                            status = case when status = 'paused' then 'warming' else status end
          where id = $1`,
        [s.id],
      )
      await logEvent(s.id, 'resumed', 0, 'cool-down over, re-warming from day 1')
      note(`${s.phone}: cool-down over, re-warming from day 1`)
      continue
    }

    const pause = async (hours: number, why: string) => {
      await q(`update senders set status = 'paused', paused_until = now() + ($2 || ' hours')::interval where id = $1`,
        [s.id, hours])
      note(`${s.phone} paused ${hours}h: ${why}`, 'warn')
    }

    if (risk(s.health) === 'critical') { await pause(POLICY.criticalPauseHours, `health ${s.health}`); continue }
    if (replyVerdict(s.sent_total, s.replies, policy) === 'pause') {
      await pause(POLICY.softBanPauseHours, `reply rate ${(s.reply_rate * 100).toFixed(1)}%, so the copy or the list is the problem`)
      continue
    }
    // Low delivery is a weaker ban signal here than it is in email: an undelivered
    // WhatsApp message usually means the recipient's phone is off or the number is
    // dead, which makes it a list-quality metric first. A number that is getting
    // replies is demonstrably reaching people, so it is never paused on delivery
    // alone — both signals have to be bad before this fires.
    if (
      deliveryVerdict(s.sent_total, s.delivered_total, policy) === 'soft_ban' &&
      replyVerdict(s.sent_total, s.replies, policy) !== 'ok'
    ) {
      await pause(
        POLICY.softBanPauseHours,
        `${(s.delivery_rate * 100).toFixed(0)}% delivered and few replies: either the list is dead or the number is`,
      )
    }
  }
}

/** Numbers that may send right now, best candidate first. */
function eligible(all: SenderHealth[]): SenderHealth[] {
  const now = new Date()
  return all
    .filter(s => ['warming', 'active'].includes(s.status))
    .filter(s => s.state === 'online')
    .filter(s => !s.paused_until || new Date(s.paused_until) <= now)
    .filter(s => !s.break_until || new Date(s.break_until) <= now)
    .filter(s => !s.next_ready_at || new Date(s.next_ready_at) <= now) // own pacing clock
    .filter(s => risk(s.health) !== 'critical')
    .filter(s => s.sent_hour < s.max_per_hour)
    .filter(s => s.sent_today < dailyTarget(s.cap_today, s.phone, now))
    .sort((a, b) => a.sent_today - b.sent_today || a.health - b.health)
}

/** How long until some number is free again — used to pick the next tick delay. */
function msUntilNextFree(all: SenderHealth[]): number {
  const waits = all
    .filter(s => ['warming', 'active'].includes(s.status) && s.state === 'online')
    .map(s => {
      const clocks = [s.next_ready_at, s.break_until, s.paused_until]
        .filter((t): t is string => Boolean(t))
        .map(t => new Date(t).getTime() - Date.now())
      return Math.max(0, ...clocks)
    })
  return waits.length ? Math.min(...waits) : IDLE_MS
}

/** Enqueue the first step for every contactable lead in the campaign's list. */
export async function startCampaign(id: number): Promise<{ queued: number }> {
  const c = await one<Campaign>(`select * from campaigns where id = $1`, [id])
  if (!c) throw new Error('no such campaign')
  const first = await one<{ step_no: number }>(
    `select min(step_no)::int as step_no from steps where campaign_id = $1`, [id],
  )
  if (!first?.step_no) throw new Error('this campaign has no message steps yet')

  await q(`update campaigns set status = 'running' where id = $1`, [id])
  const rows = await q(
    `insert into messages (campaign_id, lead_id, step_no, scheduled_at)
     select $1, l.id, $3, now()
       from leads l
      where l.list = $2
        /*
         * 'done' means this contact finished some earlier sequence, not that they are
         * spent. A new campaign is allowed to reach them again; how long it has to
         * wait is the cross-campaign cooldown's job, checked when the message is
         * actually due. Excluding them here made a contact single-use for life, so a
         * second campaign over the same list silently queued nothing.
         *
         * 'replied' and 'opted_out' stay excluded on purpose. Someone who answered is
         * a conversation, not a cold lead, and an opt-out is forever.
         */
        and l.status in ('new', 'active', 'done')
        and not exists (select 1 from blocklist b where b.phone = l.phone)
     on conflict (campaign_id, lead_id, step_no) do nothing
     returning id`,
    [id, c.list, first.step_no],
  )
  // Saying "queued 0 leads" as though work happened is how a Start that did nothing
  // reads as success. Nothing to queue has a reason, so give it.
  note(
    rows.length
      ? `${c.name}: queued ${rows.length} leads`
      : `every contactable lead in "${c.list}" is already queued, replied to or blocklisted, so ${c.name} queued nothing`,
    rows.length ? 'info' : 'warn',
  )
  return { queued: rows.length }
}

/**
 * The next message that is allowed to go out: campaign running, inside its send
 * window, lead still cold, not blocklisted, and not contacted by any other
 * campaign inside the cooldown.
 *
 * `senderIds` are the numbers that can send right now. Filtering on it in SQL is
 * what stops head-of-line blocking: a lead whose sticky number is capped, resting
 * or offline is skipped over instead of stalling everything queued behind it.
 */
function nextDue(senderIds: number[]): Promise<DueMessage | undefined> {
  return one<DueMessage>(
    `select m.id, m.campaign_id, m.lead_id, m.step_no,
            st.bodies,
            l.phone, l.name, l.vars, l.sender_id,
            c.min_delay_sec, c.max_delay_sec, c.cooldown_days, c.name as campaign_name
       from messages m
       join campaigns c on c.id = m.campaign_id and c.status = 'running'
       join leads l on l.id = m.lead_id
       join steps st on st.campaign_id = m.campaign_id and st.step_no = m.step_no
      where m.status = 'pending'
        and m.scheduled_at <= now()
        -- Same set startCampaign queues, or a queued row would never become due.
        and l.status in ('new', 'active', 'done')
        and (l.sender_id is null or l.sender_id = any($1::int[]))
        and (c.ignore_send_window or (
              extract(hour from now() at time zone c.timezone)::int >= c.start_hour
          and extract(hour from now() at time zone c.timezone)::int <  c.end_hour
          and (not c.skip_weekends or extract(dow from now() at time zone c.timezone)::int not in (0, 6))
        ))
        and not exists (select 1 from blocklist b where b.phone = l.phone)
        and not exists (
              select 1 from messages m2
                join leads l2 on l2.id = m2.lead_id
               where l2.phone = l.phone
                 and m2.campaign_id <> m.campaign_id
                 and m2.status = 'sent'
                 and m2.sent_at > now() - (c.cooldown_days || ' days')::interval)
      order by m.scheduled_at
      limit 1`,
    [senderIds],
  )
}

/**
 * Renders a unique message. Identical copy leaving one number repeatedly is a
 * cheap fingerprint, so spintax is re-rolled until the text is fresh.
 */
async function uniqueBody(msg: DueMessage, senderDbId: number): Promise<{ body: string; variant: number } | null> {
  const variant = msg.bodies.length > 1 ? msg.lead_id % msg.bodies.length : 0
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = render(msg.bodies[variant], { name: msg.name, vars: msg.vars, phone: msg.phone })
    const dupes = await one<{ n: number }>(
      `select count(*)::int as n from messages
        where sender_id = $1 and body_hash = $2 and sent_at > now() - ($3 || ' hours')::interval`,
      [senderDbId, hash(body), POLICY.duplicateWindowHours],
    )
    if ((dupes?.n ?? 0) < POLICY.maxIdenticalPerWindow) return { body, variant }
  }
  return null
}

/** Queue the follow-up step, or close the lead out. */
async function scheduleNext(msg: DueMessage): Promise<void> {
  const next = await one<{ step_no: number; delay_hours: string }>(
    `select step_no, delay_hours from steps where campaign_id = $1 and step_no > $2 order by step_no limit 1`,
    [msg.campaign_id, msg.step_no],
  )
  if (!next) {
    await q(`update leads set status = 'done' where id = $1`, [msg.lead_id])
    return
  }
  /*
   * The same guards the queue query uses, because a contact can leave between the send
   * and this insert: an opt-out arriving in that window cancels their pending rows and
   * then this would add a fresh one. It would never send — `nextDue` blocks it — but it
   * would sit in "Waiting" forever and keep its campaign from ever being done.
   */
  await q(
    `insert into messages (campaign_id, lead_id, step_no, scheduled_at)
     select $1, $2, $3, now() + ($4 || ' hours')::interval
       from leads l
      where l.id = $2
        and l.status in ('new', 'active')
        and not exists (select 1 from blocklist b where b.phone = l.phone)
     on conflict (campaign_id, lead_id, step_no) do nothing`,
    [msg.campaign_id, msg.lead_id, next.step_no, next.delay_hours],
  )
}


/**
 * Marks campaigns done once their queue is empty.
 *
 * Without this a finished campaign sits at "running" with nothing waiting, which
 * reads as though it is still working. It sweeps every running campaign rather than
 * the one just sent to, because a campaign can also drain without a single send —
 * every remaining lead skipped as not on WhatsApp, or failed — and then nothing
 * would ever evaluate it again.
 *
 * The `exists` guard keeps a campaign that queued nothing at all in `running`: it
 * has never had a queue to drain, and calling that done would make Start look like
 * it worked. Follow-ups are pending rows with a future `scheduled_at`, so they still
 * count and a sequence is not done until its last step has gone out. Starting it
 * again re-queues any contact still new or active, so this is not a one-way door.
 */
async function finishDrainedCampaigns(): Promise<void> {
  const rows = await q<{ name: string }>(
    `update campaigns c set status = 'done'
      where c.status = 'running'
        and exists (select 1 from messages m where m.campaign_id = c.id)
        and not exists (select 1 from messages m where m.campaign_id = c.id and m.status = 'pending')
      returning c.name`,
  )
  for (const r of rows) note(`${r.name}: nothing left in the queue, campaign done`)
}

/** One unit of work. Returns how long to wait before trying again. */
async function tick(): Promise<number> {
  const policy = await effectivePolicy()
  const all = await senderHealth()
  await policeSenders(all, policy)

  const pool = eligible(all)
  if (!pool.length) {
    await finishDrainedCampaigns()
    return Math.min(IDLE_MS, Math.max(500, msUntilNextFree(all)))
  }

  const msg = await nextDue(pool.map(s => s.id))
  if (!msg) {
    await finishDrainedCampaigns()
    return IDLE_MS
  }

  // Sticky: a follow-up comes from the number that opened the thread. nextDue()
  // already guaranteed that number is in the pool.
  const sender = pool.find(s => s.id === msg.sender_id) ?? pool[0]

  // Declared out here so a send whose confirmation times out can still be filed
  // with the copy that went out.
  let unique: { body: string; variant: number } | null = null

  try {
    if (!(await hasWhatsApp(sender.phone, msg.phone))) {
      await q(`update leads set status = 'invalid' where id = $1`, [msg.lead_id])
      await q(`update messages set status = 'skipped', error = 'no whatsapp account' where id = $1`, [msg.id])
      note(`skip ${msg.phone}: not on WhatsApp`)
      return 4_000
    }

    unique = await uniqueBody(msg, sender.id)
    if (!unique) {
      await q(`update messages set scheduled_at = now() + interval '45 minutes' where id = $1`, [msg.id])
      note(`deferred ${msg.phone}: copy too repetitive, add spintax to this step`, 'warn')
      return 2_000
    }

    const waId = await send(sender.phone, msg.phone, unique.body)

    await q(
      `update messages
          set status = 'sent', sender_id = $2, body = $3, body_hash = $4, variant = $5,
              wa_id = $6, sent_at = now(), error = null
        where id = $1`,
      [msg.id, sender.id, unique.body, hash(unique.body), unique.variant, waId],
    )
    await q(`update leads set status = 'active', sender_id = $2 where id = $1`, [msg.lead_id, sender.id])
    await scheduleNext(msg)
    await finishDrainedCampaigns()

    // This number now waits out its own randomised gap. Other numbers are free
    // to send meanwhile, so throughput scales with how many you have linked.
    const gap = Math.round(
      jitterMs(msg.min_delay_sec, msg.max_delay_sec) *
        circadian(new Date().getHours()) *
        throttle(risk(sender.health)),
    )
    await q(`update senders set next_ready_at = now() + ($2 || ' milliseconds')::interval where id = $1`, [sender.id, gap])
    note(`step ${msg.step_no} → +${msg.phone} via +${sender.phone} (${msg.campaign_name}, next in ${Math.round(gap / 1000)}s)`)

    // Micro-break: work a burst, then rest, like a person going through a list.
    const burst = (sendsSinceBreak.get(sender.phone) ?? 0) + 1
    if (burst >= breakAfter(sender.phone, undefined, policy)) {
      sendsSinceBreak.set(sender.phone, 0)
      const ms = breakMs()
      await q(`update senders set break_until = now() + ($2 || ' milliseconds')::interval where id = $1`, [sender.id, ms])
      note(`${sender.phone} resting ${Math.round(ms / 60000)}m after ${burst} sends`)
    } else {
      sendsSinceBreak.set(sender.phone, burst)
    }
  } catch (e) {
    const err = String((e as Error)?.message ?? e)

    /*
     * A call that timed out says nothing about the message or the recipient, only
     * that the socket went quiet. Marking it failed would burn a lead and dock the
     * number's health for something it did not do, so it goes back in the queue and
     * the reconnect logic in lib/wa.ts deals with the socket.
     *
     * The send itself is the exception. `waId` is set only when it was `sendMessage`
     * that went quiet, and by then WhatsApp may already have the message. Putting
     * that back in the queue risks messaging a stranger twice — rude, and a ban
     * signal — so it is filed as sent under the id we generated, flagged as
     * unconfirmed, and the delivery receipt settles it: if it did go out, the ack
     * clears the flag, and if it never arrives the row keeps its warning.
     */
    if (e instanceof WaTimeout) {
      if (e.waId) {
        await q(
          `update messages
              set status = 'sent', sender_id = $2, body = $3, body_hash = $4, variant = $5,
                  wa_id = $6, sent_at = now(), error = 'not confirmed: the send timed out, watching for a delivery receipt'
            where id = $1`,
          [msg.id, sender.id, unique?.body ?? null, unique ? hash(unique.body) : null, unique?.variant ?? 0, e.waId],
        )
        await q(`update leads set status = 'active', sender_id = $2 where id = $1`, [msg.lead_id, sender.id])
        // The sequence continues either way: leaving the lead active with nothing
        // queued is how a contact silently falls out of a campaign.
        await scheduleNext(msg)
        // The socket just went quiet, so park this number for a couple of minutes
        // rather than letting the next tick pick it again immediately.
        await q(`update senders set next_ready_at = now() + interval '2 minutes' where id = $1`, [sender.id])
        note(`${msg.phone} may have gone out but was not confirmed: ${err}`, 'warn')
        return 5_000
      }
      await q(`update messages set scheduled_at = now() + interval '3 minutes' where id = $1`, [msg.id])
      note(`${msg.phone} put back in the queue: ${err}`, 'warn')
      return 5_000
    }

    /*
     * `rate-overlimit` is WhatsApp telling us to slow down. Baileys raises it as a
     * query error carrying 429 in `data`, never as a disconnect, so nothing in
     * lib/wa.ts sees it and the whole thing would otherwise be filed as a failed
     * message. The message is fine — the pace was not — so it waits, and the number
     * stands down for long enough to matter.
     */
    if (/rate.?overlimit|\b429\b/i.test(err)) {
      await q(`update messages set scheduled_at = now() + interval '15 minutes' where id = $1`, [msg.id])
      await q(`update senders set next_ready_at = now() + interval '15 minutes' where id = $1`, [sender.id])
      await logEvent(sender.id, 'rate_limited', POLICY.penalty.rate_limited, err.slice(0, 200))
      note(`${sender.phone} was rate limited by WhatsApp, standing down 15m: ${err}`, 'warn')
      return 5_000
    }

    await q(`update messages set status = 'failed', error = $2 where id = $1`, [msg.id, err.slice(0, 300)])
    await logEvent(sender.id, 'send_failed', POLICY.penalty.send_failed, err.slice(0, 200))
    if (/403|forbidden|blocked|not-authorized/i.test(err)) {
      await logEvent(sender.id, 'forbidden', POLICY.penalty.forbidden, err.slice(0, 200))
    }
    note(`failed +${msg.phone} via +${sender.phone}: ${err}`, 'warn')
    return 10_000
  }

  // Come back as soon as any number is free, not after this one's whole gap.
  return Math.min(IDLE_MS, Math.max(250, msUntilNextFree(await senderHealth())))
}

/**
 * One loop, but pacing is per number: each send parks that number behind its own
 * randomised gap while the others stay free, so throughput scales with how many
 * numbers you have linked. Daily throughput ≈ numbers × their daily cap.
 *
 * Known ceiling: still one send at a time overall. That only binds past a few
 * thousand sends an hour, which is far beyond what is safe for cold outreach.
 * Per-number workers are the upgrade path if you ever get there.
 */
/** Stops the send loop. Called on shutdown so nothing is mid-send when we exit. */
export function stopEngine(): void {
  running = false
}

/**
 * Closes the sockets on the way out.
 *
 * Docker sends SIGTERM for `stop`, `restart` and `up --build` (the exit code 143 in
 * the logs). A socket killed mid-flight looks to WhatsApp like an abrupt drop, and
 * the next boot reconnects into a session it still considers live, which comes back
 * as 440 connectionReplaced. That is the connect-then-disconnect churn after a
 * rebuild. Closing without logging out keeps the credentials valid.
 */
export function installShutdown(): void {
  /*
   * Node's default for an unhandled rejection is to kill the process, and Baileys
   * rejects from event handlers we do not own. A campaign that stops because one
   * promise went unhandled, with the reason never printed, is the exact failure this
   * app cannot afford — so rejections are logged loudly and the loop carries on. An
   * uncaught exception is different: the process is in an unknown state afterwards,
   * so it exits and lets Docker's restart policy bring it back clean.
   */
  process.on('unhandledRejection', reason => {
    note(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`, 'warn')
    console.error(reason)
  })
  process.on('uncaughtException', err => {
    console.error('[engine] uncaught exception, exiting so the container restarts:', err?.stack ?? err)
    process.exit(1)
  })

  let leaving = false
  const leave = (signal: string) => {
    if (leaving) return
    leaving = true
    console.log(`[boot] ${signal}: closing sockets`)
    stopEngine()
    void closeAll().finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => leave('SIGTERM'))
  process.on('SIGINT', () => leave('SIGINT'))
}

export function startEngine(): void {
  if (running) return
  running = true
  note(`engine started · ${onlinePhones().length} numbers online`)
  void (async () => {
    while (running) {
      let wait = IDLE_MS
      try {
        // Belt and braces: every WhatsApp call inside tick() has its own timeout, but
        // an unbounded await anywhere else in here would stop sending for good, and a
        // stalled queue is the one failure this app cannot afford to have silently.
        wait = await Promise.race([
          tick(),
          new Promise<number>((_, reject) => setTimeout(() => reject(new Error('tick took longer than 2 minutes')), 120_000)),
        ])
      } catch (e) {
        note(`tick error: ${(e as Error).message}`, 'warn')
        wait = 15_000
      }
      await sleep(wait)
    }
  })()
}
