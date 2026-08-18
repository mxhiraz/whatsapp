import { invalidate } from '@/lib/cache.ts'
import { tx } from '@/lib/db.ts'
import { digits, handle } from '@/lib/http.ts'
import { normalizePhone } from '@/lib/parse.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_PHONES = 50_000

/**
 * Blocking is permanent and global: the number is opted out of every list and
 * any queued message to it is cancelled immediately.
 */
export const POST = (req: Request) =>
  handle(async () => {
    const body = await req.json().catch(() => ({}))
    const phones = [
      ...new Set(
        String(body.phones ?? '')
          .split(/[\s,;]+/)
          .slice(0, MAX_PHONES)
          .map(p => normalizePhone(p, digits(body.cc) || '91'))
          .filter((p): p is string => Boolean(p)),
      ),
    ]
    if (!phones.length) throw new Error('no valid numbers')

    /**
     * All three statements or none. Half of this applied — on the list but with a
     * live queue, or a cancelled queue but nothing on the list — is the state where
     * an opted-out number can still be messaged, which is the one outcome this
     * endpoint exists to prevent.
     */
    await tx(async run => {
      await run(
        `insert into blocklist (phone, reason) select p, 'manual' from unnest($1::text[]) p
         on conflict (phone) do nothing`,
        [phones],
      )
      await run(`update leads set status = 'opted_out' where phone = any($1::text[])`, [phones])
      await run(
        `update messages set status = 'canceled', error = 'blocklisted'
          where status = 'pending' and lead_id in (select id from leads where phone = any($1::text[]))`,
        [phones],
      )
    })
    invalidate()
    return { added: phones.length }
  })
