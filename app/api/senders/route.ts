import { invalidate } from '@/lib/cache.ts'
import { q } from '@/lib/db.ts'
import { clamp, digits, handle } from '@/lib/http.ts'
import { connect } from '@/lib/wa.ts'
import { effectivePolicy } from '@/lib/settings.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Adds a number and opens its socket. The client then polls for the QR. */
export const POST = (req: Request) =>
  handle(async () => {
    const body = await req.json()
    const phone = digits(body.phone)
    if (phone.length < 11) throw new Error('include the country code, e.g. 919876543210')
    // The ceiling comes from the operator's own sending limits, not the code default.
    const policy = await effectivePolicy()

    /*
     * Every setting the dialog offers is stored here, including the ramp speed. On a
     * re-add the caps are updated too: the dialog showed them as editable, so
     * silently keeping the old values would make the form a lie.
     *
     * Same reason for the empty-string handling. `coalesce(excluded.label, …)` used to
     * treat "cleared" as "not given", so emptying the label or deleting the proxy did
     * nothing while the form said it had worked. Removing a proxy is the one that
     * matters: the operator may be separating two numbers that share an outgoing
     * address, which is exactly the correlation the dashboard warns about. So a field
     * left out of the request keeps its value, and a field sent empty clears it.
     */
    await q(
      `insert into senders (phone, label, max_per_day, max_per_hour, proxy_url, warmup_growth)
       values ($1, nullif($2, ''), $3, $4, nullif($5, ''), $6)
       on conflict (phone) do update
         set label = case when $2 = '' then null else coalesce($2, senders.label) end,
             proxy_url = case when $5 = '' then null else coalesce($5, senders.proxy_url) end,
             max_per_day = excluded.max_per_day,
             max_per_hour = excluded.max_per_hour,
             warmup_growth = excluded.warmup_growth`,
      [
        phone,
        body.label === undefined ? null : String(body.label).trim(),
        clamp(body.max_per_day, 1, policy.hardMaxPerDay, 60),
        clamp(body.max_per_hour, 1, 60, 8),
        body.proxy_url === undefined ? null : String(body.proxy_url).trim(),
        clamp(body.warmup_growth, 1.05, 2, policy.warmupGrowth),
      ],
    )
    invalidate() // the dashboard refetches the moment this returns; don't serve it stale
    return connect(phone)
  })
