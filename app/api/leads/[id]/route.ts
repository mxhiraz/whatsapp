import { invalidate } from '@/lib/cache.ts'
import { one, q, type Lead } from '@/lib/db.ts'
import { digits, handle } from '@/lib/http.ts'
import { cleanVars, normalizePhone } from '@/lib/parse.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

async function idOf(ctx: Ctx): Promise<number> {
  const id = Number((await ctx.params).id)
  if (!Number.isInteger(id) || id < 1) throw new Error('No such contact')
  return id
}

/**
 * Edit one contact: its name, its number, or its extra fields.
 *
 * Each field is only written when the request actually carries it, so two people
 * editing different fields do not overwrite each other. `vars` is the exception: it
 * is replaced whole, because the form posts the whole set and a merge would make
 * deleting a field impossible.
 *
 * ponytail: last write wins on `vars`. Add a row version and an If-Match if this
 * ever has more than one operator editing the same contact at the same time.
 */
export const PATCH = (req: Request, ctx: Ctx) =>
  handle(async () => {
    const id = await idOf(ctx)
    const body = await req.json().catch(() => ({}))

    // Changing the number re-normalises it, so a pasted "+91 98765 43210" still
    // lands in the same shape the sender uses.
    let phone: string | null = null
    if (body.phone !== undefined) {
      phone = normalizePhone(body.phone, digits(body.cc) || '91')
      if (!phone) throw new Error('Not a usable number')
      /**
       * The blocklist is global and permanent, and editing a contact is another way
       * into the leads table. Without this check, typing an opted-out number over a
       * live contact quietly reinstates someone who asked to be left alone — the
       * import path refuses the same number.
       */
      if (await one(`select 1 from blocklist where phone = $1`, [phone])) {
        throw new Error('that number opted out, so it cannot be added back')
      }
    }

    const updated = await one<Lead>(
      `update leads
          set name  = case when $2::text is null then name else nullif($2, '') end,
              phone = coalesce($3, phone),
              vars  = coalesce($4::jsonb, vars)
        where id = $1
        returning id, list, phone, name, vars, status, interest, note`,
      [
        id,
        body.name === undefined ? null : String(body.name).trim().slice(0, 200),
        phone,
        body.vars === undefined ? null : JSON.stringify(cleanVars(body.vars)),
      ],
    )
    if (!updated) throw new Error('No such contact')
    invalidate()
    return updated
  })

/** Removes one contact. Messages already sent stay in the campaign history. */
export const DELETE = (_req: Request, ctx: Ctx) =>
  handle(async () => {
    await q(`delete from leads where id = $1`, [await idOf(ctx)])
    invalidate()
    return { ok: true }
  })
