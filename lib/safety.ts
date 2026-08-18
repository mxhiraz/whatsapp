import assert from 'node:assert/strict'
import { hash } from './parse.ts'

/**
 * Ban-avoidance policy.
 *
 * WhatsApp does not publish a message limit — bans come from ML heuristics. The
 * signals that actually get numbers killed, in order of weight:
 *
 *   1. WHO you message. Every cold lead is a stranger with no contact-graph link
 *      to you. Stranger volume is the binding constraint, not raw volume.
 *   2. Reply ratio. A number that talks and never gets answered looks like spam.
 *   3. Block / report rate. Invisible to us, so it is proxied by send failures,
 *      403s and delivery collapse.
 *   4. Robotic timing. Fixed intervals, 24/7 activity, identical copy.
 *
 * So the numbers below are deliberately far lower than what bot-oriented
 * "anti-ban" libraries suggest: their presets assume conversations with people
 * who messaged first. Cold outreach gets none of that credit.
 */
export const POLICY = {
  /** Day 1 stranger allowance for a fresh number. */
  warmupStartPerDay: 10,
  /** Daily cap growth per day of warmup. 1.3 reaches ~60/day in a week. */
  warmupGrowth: 1.3,
  /** Never allow more than this per number per day, whatever the UI says. */
  hardMaxPerDay: 200,
  /** Fraction of the day's cap actually aimed for, so days are not identical. */
  dailyTargetJitter: [0.7, 1.0] as const,
  /** Sends before a micro-break, and how long the break lasts. */
  breakEvery: [8, 14] as const,
  breakMinutes: [20, 55] as const,
  /** Reply-rate gates, evaluated once a number has this many sends. */
  minReplySamples: 30,
  replyRateWarn: 0.1,
  replyRatePause: 0.04,
  /** Delivery-rate floor: below this, treat it as a soft ban. */
  minDeliverySamples: 20,
  deliveryFloor: 0.6,
  /** Identical copy from one number inside this window is a hard fingerprint. */
  duplicateWindowHours: 1,
  maxIdenticalPerWindow: 2,
  /** Health score bands (points, decayed over 24h). */
  health: { medium: 30, high: 60, critical: 85 },
  /** Penalty points per incident. */
  penalty: {
    disconnect: 15,
    send_failed: 20,
    timelock: 25,
    /** WhatsApp answered a send with rate-overlimit: it is actively throttling us. */
    rate_limited: 25,
    forbidden: 40,
    logged_out: 60,
  },
  /** How long a critical number sits out before it re-warms from day 1. */
  criticalPauseHours: 24,
  softBanPauseHours: 48,
} as const

/**
 * The limits an operator may change from Settings, and the range each is allowed
 * to take. Everything else in POLICY is code, not configuration.
 *
 * The ranges exist because this is the one screen where a careless number gets a
 * WhatsApp account banned. They are deliberately narrow:
 *
 * - `min` is never 0. A cap of 0 stops sending; a rate floor of 0 removes the
 *   guard entirely, which is worse than any number an operator might pick.
 * - `hardMaxPerDay` tops out at 300. Real accounts messaging strangers die well
 *   below the four-figure numbers "anti-ban" presets suggest, so this leaves a
 *   little headroom above the default and nothing more.
 * - the two rate floors top out below 1: at 1 every number would pause forever.
 */
export const LIMITS = {
  warmupStartPerDay: { default: POLICY.warmupStartPerDay, min: 1, max: 30, int: true },
  warmupGrowth: { default: POLICY.warmupGrowth, min: 1, max: 2, int: false },
  hardMaxPerDay: { default: POLICY.hardMaxPerDay, min: 1, max: 300, int: true },
  breakEveryMin: { default: POLICY.breakEvery[0], min: 1, max: 40, int: true },
  breakEveryMax: { default: POLICY.breakEvery[1], min: 1, max: 50, int: true },
  replyRatePause: { default: POLICY.replyRatePause, min: 0.01, max: 0.5, int: false },
  deliveryFloor: { default: POLICY.deliveryFloor, min: 0.05, max: 0.95, int: false },
} as const

export type LimitKey = keyof typeof LIMITS
/** Stored overrides: only the keys the operator actually changed. */
export type Limits = Partial<Record<LimitKey, number>>

/** POLICY with the editable limits widened to plain numbers. */
export interface Policy
  extends Omit<
    typeof POLICY,
    'warmupStartPerDay' | 'warmupGrowth' | 'hardMaxPerDay' | 'breakEvery' | 'replyRatePause' | 'deliveryFloor'
  > {
  warmupStartPerDay: number
  warmupGrowth: number
  hardMaxPerDay: number
  breakEvery: readonly [number, number]
  replyRatePause: number
  deliveryFloor: number
}

/**
 * Validates one override on the way in. Unparseable is a thrown error (the
 * operator typed something), out of range is pulled to the nearest bound.
 */
function clampOne(key: LimitKey, raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`)
  const { min, max, int } = LIMITS[key]
  const inRange = Math.max(min, Math.min(max, n))
  return int ? Math.round(inRange) : inRange
}

/**
 * What to store for a set of edited limits. Unknown keys are ignored, blanks are
 * left alone, and anything that matches the default is dropped so a default
 * install keeps following the code rather than pinning today's numbers.
 */
export function clampLimits(input: unknown): Limits {
  const given = (input ?? {}) as Record<string, unknown>
  const out: Limits = {}
  for (const key of Object.keys(LIMITS) as LimitKey[]) {
    if (given[key] === undefined || given[key] === null || given[key] === '') continue
    const value = clampOne(key, given[key])
    if (value !== LIMITS[key].default) out[key] = value
  }
  // A rest window that runs backwards would never let a number take a break.
  if (out.breakEveryMax !== undefined && out.breakEveryMax < (out.breakEveryMin ?? LIMITS.breakEveryMin.default)) {
    out.breakEveryMax = out.breakEveryMin ?? LIMITS.breakEveryMin.default
  }
  return out
}

/**
 * Stored overrides merged over the defaults. A value that is missing, unparseable
 * or outside its range falls back to the default: a row edited by hand in psql
 * cannot widen a limit past what this file allows.
 */
export function resolvePolicy(stored: Limits | null | undefined): Policy {
  const value = (key: LimitKey): number => {
    const n = Number(stored?.[key])
    const { default: fallback, min, max } = LIMITS[key]
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback
  }
  const restFrom = value('breakEveryMin')
  return {
    ...POLICY,
    warmupStartPerDay: value('warmupStartPerDay'),
    warmupGrowth: value('warmupGrowth'),
    hardMaxPerDay: value('hardMaxPerDay'),
    breakEvery: [restFrom, Math.max(restFrom, value('breakEveryMax'))],
    replyRatePause: value('replyRatePause'),
    deliveryFloor: value('deliveryFloor'),
  }
}

export type Risk = 'low' | 'medium' | 'high' | 'critical'

/** Standard normal via Box-Muller, clamped to ±3σ so nothing degenerates. */
function gauss(rand: () => number = Math.random): number {
  const u = Math.max(rand(), 1e-9)
  const v = rand()
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  return Math.max(-3, Math.min(3, z))
}

/**
 * Gap between two sends. Uniform delays are the easiest bot tell there is, so
 * this is a bell curve centred in the range with the tails kept inside it.
 */
export function jitterMs(minSec: number, maxSec: number, rand: () => number = Math.random): number {
  const lo = Math.min(minSec, maxSec)
  const hi = Math.max(minSec, maxSec)
  const mid = (lo + hi) / 2
  const sec = mid + gauss(rand) * ((hi - lo) / 6)
  return Math.round(Math.max(lo, Math.min(hi, sec)) * 1000)
}

/** People are slower early and late in the day. Multiplies the send gap. */
export function circadian(hour: number): number {
  if (hour >= 10 && hour < 14) return 0.9 // business peak
  if (hour >= 14 && hour < 18) return 1.0
  if (hour >= 18 && hour < 21) return 1.4
  return 2.5 // fringe hours: crawl (the send window should exclude them anyway)
}

export function risk(health: number): Risk {
  if (health >= POLICY.health.critical) return 'critical'
  if (health >= POLICY.health.high) return 'high'
  if (health >= POLICY.health.medium) return 'medium'
  return 'low'
}

/** Unhealthy numbers do not stop dead, they slow down first. */
export function throttle(level: Risk): number {
  return { low: 1, medium: 2, high: 5, critical: Infinity }[level]
}

/**
 * Warmup ramp: day 1 = 10 strangers, growing each day, never past the number's
 * ceiling. `growth` is per number so a cautious number can ramp over weeks
 * instead of days (1.3 ≈ one week to 60/day, 1.12 ≈ three weeks).
 *
 * `policy` is where the operator's edited limits arrive; callers that do not have
 * the database in reach get the defaults.
 */
export function capForToday(
  warmupStartedAt: Date | string,
  maxPerDay: number,
  now = new Date(),
  growth?: number,
  policy: Policy = POLICY,
): number {
  const started = new Date(warmupStartedAt).getTime()
  const days = Math.max(0, Math.floor((now.getTime() - started) / 86_400_000))
  const rate = Number.isFinite(growth) && (growth as number) >= 1 ? (growth as number) : policy.warmupGrowth
  const ramped = Math.round(policy.warmupStartPerDay * rate ** days)
  return Math.max(1, Math.min(maxPerDay, policy.hardMaxPerDay, ramped))
}

/**
 * Today's actual target, 70–100% of the cap. Seeded on phone+date so it is
 * stable all day (a target that re-rolled every tick would be meaningless).
 */
export function dailyTarget(cap: number, phone: string, now = new Date()): number {
  const [lo, hi] = POLICY.dailyTargetJitter
  const seed = parseInt(hash(`${phone}:${now.toDateString()}`).slice(-4), 36) % 1000
  return Math.max(1, Math.round(cap * (lo + (hi - lo) * (seed / 1000))))
}

/** Bursts then rests, like a person working a list — not a metronome. */
export function breakAfter(phone: string, now = new Date(), policy: Policy = POLICY): number {
  const [lo, hi] = policy.breakEvery
  const seed = parseInt(hash(`brk:${phone}:${now.toDateString()}:${now.getHours()}`).slice(-3), 36) % 100
  return lo + Math.round((hi - lo) * (seed / 100))
}

export function breakMs(rand: () => number = Math.random): number {
  const [lo, hi] = POLICY.breakMinutes
  return jitterMs(lo * 60, hi * 60, rand)
}

/** A number nobody answers is a number about to be reported. */
export function replyVerdict(
  sent: number,
  replies: number,
  policy: Policy = POLICY,
): 'ok' | 'insufficient' | 'warn' | 'pause' {
  if (sent < POLICY.minReplySamples) return 'insufficient'
  const rate = replies / sent
  if (rate < policy.replyRatePause) return 'pause'
  if (rate < POLICY.replyRateWarn) return 'warn'
  return 'ok'
}

/** Messages sent but never delivered = the recipients' clients are dropping you. */
export function deliveryVerdict(
  sent: number,
  delivered: number,
  policy: Policy = POLICY,
): 'ok' | 'insufficient' | 'soft_ban' {
  if (sent < POLICY.minDeliverySamples) return 'insufficient'
  return delivered / sent < policy.deliveryFloor ? 'soft_ban' : 'ok'
}

/** Typing time for the composing indicator: ~45 wpm with occasional thinking. */
export function typingMs(text: string, rand: () => number = Math.random): number {
  const base = text.length * 60 * (0.8 + 0.4 * rand())
  const thinks = Math.floor(text.length / 120)
  const pause = thinks > 0 && rand() < 0.35 ? 800 + rand() * 2700 : 0
  return Math.round(Math.min(12_000, 900 + base + pause))
}

if (import.meta.filename === process.argv[1]) {
  const day = (n: number) => new Date(Date.now() - n * 86_400_000)

  assert.equal(capForToday(day(0), 60), 10, 'fresh number starts at 10 strangers/day')
  assert.equal(capForToday(day(3), 60), 22)
  assert.equal(capForToday(day(30), 60), 60, 'never exceeds its own ceiling')
  assert.equal(capForToday(day(365), 9999), POLICY.hardMaxPerDay, 'hard ceiling always wins')
  assert.ok(capForToday(day(7), 200, undefined, 1.12) < capForToday(day(7), 200, undefined, 1.3), 'slow ramp is slower')
  assert.equal(capForToday(day(3), 60, undefined, 0), 22, 'a nonsense growth rate falls back to the default')

  const t = dailyTarget(100, '919876543210')
  assert.ok(t >= 70 && t <= 100, `target in band, got ${t}`)
  assert.equal(t, dailyTarget(100, '919876543210'), 'stable within the same day')

  for (let i = 0; i < 500; i++) {
    const ms = jitterMs(90, 300)
    assert.ok(ms >= 90_000 && ms <= 300_000, `jitter out of range: ${ms}`)
  }
  const spread = new Set(Array.from({ length: 50 }, () => jitterMs(90, 300)))
  assert.ok(spread.size > 40, 'delays must not repeat')

  assert.equal(risk(0), 'low')
  assert.equal(risk(40), 'medium')
  assert.equal(risk(POLICY.penalty.forbidden + POLICY.penalty.send_failed), 'high')
  assert.equal(risk(POLICY.penalty.logged_out + POLICY.penalty.timelock), 'critical')
  assert.equal(throttle('critical'), Infinity, 'critical never sends')

  // The send window itself (hours + weekdays-only) is enforced in the SQL that
  // picks the next message, and covered end to end by tests/flow.ts.
  assert.ok(circadian(3) > circadian(11), 'fringe hours are slower')

  const b = breakAfter('919876543210')
  assert.ok(b >= 8 && b <= 14 && b === breakAfter('919876543210'), 'break point stable per hour')

  assert.equal(replyVerdict(10, 0), 'insufficient')
  assert.equal(replyVerdict(100, 0), 'pause')
  assert.equal(replyVerdict(100, 6), 'warn')
  assert.equal(replyVerdict(100, 20), 'ok')
  assert.equal(deliveryVerdict(100, 40), 'soft_ban')
  assert.equal(deliveryVerdict(100, 95), 'ok')

  assert.ok(typingMs('hi') < typingMs('x'.repeat(200)))
  assert.ok(typingMs('x'.repeat(5000)) <= 12_000, 'typing indicator is capped')

  // Editable limits. The ranges themselves are part of the guarantee: an operator
  // can loosen a limit, but not to a value that makes the guard meaningless.
  assert.ok(Object.values(LIMITS).every(l => l.min > 0), 'no limit may be zero or negative')
  assert.ok(LIMITS.replyRatePause.max < 1 && LIMITS.deliveryFloor.max < 1, 'a rate floor of 100% would pause everything')
  assert.ok(LIMITS.hardMaxPerDay.max <= 300, 'the last line of defence stays far below what a real account tolerates')

  // Reads: a stored override is used only while it is inside its range.
  assert.deepEqual(resolvePolicy(null), { ...POLICY, breakEvery: [...POLICY.breakEvery] }, 'no overrides means the defaults')
  assert.equal(resolvePolicy({ hardMaxPerDay: 120 }).hardMaxPerDay, 120, 'an in-range override goes through')
  assert.equal(resolvePolicy({ hardMaxPerDay: 5000 }).hardMaxPerDay, POLICY.hardMaxPerDay, 'past the ceiling falls back to the default')
  assert.equal(resolvePolicy({ warmupStartPerDay: 0 }).warmupStartPerDay, POLICY.warmupStartPerDay, 'zero is never a cap')
  assert.equal(resolvePolicy({ warmupStartPerDay: -5 }).warmupStartPerDay, POLICY.warmupStartPerDay, 'negative is never a cap')
  assert.equal(resolvePolicy({ deliveryFloor: 1.5 }).deliveryFloor, POLICY.deliveryFloor, 'a floor above 1 would pause every number')
  assert.equal(resolvePolicy({ replyRatePause: 2 }).replyRatePause, POLICY.replyRatePause)
  assert.equal(resolvePolicy({ hardMaxPerDay: NaN }).hardMaxPerDay, POLICY.hardMaxPerDay, 'unparseable falls back')
  assert.deepEqual(resolvePolicy({ breakEveryMin: 20, breakEveryMax: 5 }).breakEvery, [20, 20], 'the rest window cannot run backwards')

  // Writes: clamped to the nearest bound, defaults dropped, nonsense rejected.
  assert.deepEqual(clampLimits({}), {}, 'a default install stores nothing')
  assert.deepEqual(clampLimits({ hardMaxPerDay: POLICY.hardMaxPerDay }), {}, 'a value left at its default is not stored')
  assert.equal(clampLimits({ hardMaxPerDay: 5000 }).hardMaxPerDay, LIMITS.hardMaxPerDay.max, 'a write is clamped, never stored raw')
  assert.equal(clampLimits({ warmupStartPerDay: 0 }).warmupStartPerDay, LIMITS.warmupStartPerDay.min)
  assert.equal(clampLimits({ warmupStartPerDay: 7.6 }).warmupStartPerDay, 8, 'message counts are whole numbers')
  assert.throws(() => clampLimits({ hardMaxPerDay: 'lots' }), /must be a number/)

  // And the limits actually bind where the engine reads them.
  assert.equal(capForToday(day(365), 9999, undefined, 1.3, resolvePolicy({ hardMaxPerDay: 120 })), 120)
  assert.equal(capForToday(day(0), 9999, undefined, 1.3, resolvePolicy({ warmupStartPerDay: 3 })), 3)
  assert.equal(replyVerdict(100, 10, resolvePolicy({ replyRatePause: 0.2 })), 'pause')
  assert.equal(deliveryVerdict(100, 80, resolvePolicy({ deliveryFloor: 0.9 })), 'soft_ban')

  console.log('safety.ts ok')
}
