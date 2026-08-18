import { invalidate } from '@/lib/cache.ts'
import { tx, type Campaign } from '@/lib/db.ts'
import { clamp, handle, need, timezone } from '@/lib/http.ts'
import { spinVariants } from '@/lib/parse.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface StepInput {
  bodies?: string[]
  delay_hours?: number
}

/** A sequence longer than this is a mistake, not a plan. */
const MAX_STEPS = 20
const MAX_BODY_CHARS = 4000

/**
 * Creates a sequence. Step 1 goes out immediately; later steps wait `delay_hours`
 * after the previous one and are cancelled the moment the lead replies.
 */
export const POST = (req: Request) =>
  handle(async () => {
    const body = await req.json().catch(() => ({}))
    const name = need(String(body.name ?? '').trim().slice(0, 200), 'campaign name')
    const list = need(String(body.list ?? '').trim().slice(0, 200), 'list')

    // Every field here arrives as JSON from a dashboard that may have no password
    // on it, so nothing is assumed to be the shape the form sends.
    if (body.steps !== undefined && !Array.isArray(body.steps)) throw new Error('steps must be a list')
    const steps: StepInput[] = ((body.steps ?? []) as StepInput[]).slice(0, MAX_STEPS).map(s => ({
      ...(s ?? {}),
      bodies: (Array.isArray(s?.bodies) ? s.bodies : [])
        .map(b => String(b ?? '').trim().slice(0, MAX_BODY_CHARS))
        .filter(Boolean),
    }))
    const clean = steps.filter(s => s.bodies!.length)
    if (!clean.length) throw new Error('write at least one message')

    const warnings = clean.flatMap((s, i) =>
      s.bodies!.filter(b => spinVariants(b) < 2).map(() => `step ${i + 1} has no {spintax|variation}`),
    )

    // An inverted or empty window (end <= start) is a campaign that can never
    // send. Clamping it would produce a "running" campaign that sits at zero
    // forever, so it is rejected at the door instead.
    const startHour = clamp(body.start_hour, 0, 23, 9)
    const endHour = clamp(body.end_hour, 1, 24, 19)
    if (endHour <= startHour) throw new Error('send window must end after it starts')

    /**
     * One transaction, because a campaign with no steps cannot be started and is
     * not something the operator asked for: if a step insert fails, the campaign row
     * must not survive it. A round trip per step is fine at MAX_STEPS of them, once,
     * and `bodies` is an array column — it does not go in as one `unnest`.
     */
    const campaign = await tx(async run => {
      const [created] = await run<Campaign>(
        `insert into campaigns (name, list, min_delay_sec, max_delay_sec, start_hour, end_hour, skip_weekends,
                                cooldown_days, timezone, ignore_send_window)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [
          name, list,
          clamp(body.min_delay_sec, 20, 3600, 90),
          clamp(body.max_delay_sec, 20, 7200, 300),
          startHour,
          endHour,
          body.skip_weekends !== false,
          clamp(body.cooldown_days, 0, 365, 30),
          timezone(body.timezone),
          body.ignore_send_window === true,
        ],
      )
      if (!created) throw new Error('could not create campaign')

      for (const [i, s] of clean.entries()) {
        await run(
          `insert into steps (campaign_id, step_no, bodies, delay_hours) values ($1, $2, $3, $4)`,
          [created.id, i + 1, s.bodies, i === 0 ? 0 : clamp(s.delay_hours, 1, 24 * 30, 24)],
        )
      }
      return created
    })

    invalidate()
    return { ...campaign, warnings }
  })
