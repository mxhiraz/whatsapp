import { invalidate } from '@/lib/cache.ts'
import { q, type Lead } from '@/lib/db.ts'
import { digits, handle, need } from '@/lib/http.ts'
import { cleanVars, normalizePhone, sniff, toLeads, type Role } from '@/lib/parse.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Row-picking sends the parsed rows to the browser so they can be ticked off
 * individually. Past this many rows that stops being a sensible payload, so the
 * dialog hides the picker and imports the file wholesale instead.
 */
const ROW_PICKER_LIMIT = 5000

/**
 * Hard ceilings on what one request may carry.
 *
 * This process is also the send engine. An import big enough to exhaust the heap
 * does not just fail the import, it kills the loop that is keeping numbers warm —
 * so an oversized body is refused with a sentence rather than parsed optimistically.
 */
const MAX_CSV_BYTES = 32 * 1024 * 1024
const MAX_CONTACTS = 200_000
const MAX_LIST_CHARS = 200

/** How many of these numbers we already know about, before importing anything. */
async function overlap(list: string, phones: string[]) {
  const row = await q<{ in_list: number; in_other_list: number; blocked: number }>(
    `select count(*) filter (where mine.phone is not null)::int as in_list,
            count(*) filter (where other.phone is not null)::int as in_other_list,
            count(*) filter (where b.phone is not null)::int as blocked
       from unnest($2::text[]) as p(phone)
       left join (select phone from leads where list = $1) mine on mine.phone = p.phone
       left join (select distinct phone from leads where list <> $1) other on other.phone = p.phone
       left join blocklist b on b.phone = p.phone`,
    [list, phones],
  )
  return row[0]
}

/**
 * Import in two passes. `preview` reads the file, guesses what each column is and
 * reports what would happen — nothing is written. The second call sends back the
 * (possibly corrected) column mapping and inserts.
 */
interface ContactInput {
  phone?: string
  name?: string
  vars?: Record<string, string>
}

interface Contact {
  phone: string
  name: string | null
  vars: Record<string, string>
}

/**
 * Writes contacts, skipping anyone opted out.
 *
 * `do nothing` on a contact already in the list is deliberate: an import is
 * additive, and the count returned to the dialog says how many were left alone.
 * Editing an existing contact is what PATCH /api/leads/[id] is for.
 */
async function insertContacts(list: string, contacts: Contact[]) {
  return q(
    `insert into leads (list, phone, name, vars)
     select $1, p, nullif(n, ''), v::jsonb
       from unnest($2::text[], $3::text[], $4::text[]) as t(p, n, v)
      where not exists (select 1 from blocklist b where b.phone = p)
     on conflict (list, phone) do nothing
     returning id`,
    [list, contacts.map(c => c.phone), contacts.map(c => c.name ?? ''), contacts.map(c => JSON.stringify(c.vars))],
  )
}

export const POST = (req: Request) =>
  handle(async () => {
    const body = await req.json().catch(() => ({}))
    const csv = String(body.csv ?? '')
    if (csv.length > MAX_CSV_BYTES) throw new Error('that file is too big to import in one go — split it up')
    const cc = digits(body.cc) || '91'
    const list = String(body.list ?? '').trim().slice(0, MAX_LIST_CHARS)
    const roles = (Array.isArray(body.roles) ? body.roles : undefined) as Role[] | undefined

    /**
     * Structured contacts, for adding one lead by hand rather than importing a
     * file. Only the phone number is required; everything else is optional and
     * anything extra becomes a {{tag}} usable in message copy.
     */
    if (Array.isArray(body.contacts)) {
      need(list, 'list name')
      if (body.contacts.length > MAX_CONTACTS) throw new Error('too many contacts in one request — split it up')
      const contacts = (body.contacts as ContactInput[])
        .map(c => ({
          phone: normalizePhone(c?.phone, cc),
          name: String(c?.name ?? '').trim().slice(0, 200) || null,
          vars: cleanVars(c?.vars),
        }))
        .filter((c): c is Contact => Boolean(c.phone))

      if (!contacts.length) throw new Error('that does not look like a usable phone number')
      const written = await insertContacts(list, contacts)
      invalidate()
      return {
        parsed: contacts.length,
        inserted: written.length,
        skipped: contacts.length - written.length,
        duplicates: 0,
        badCount: 0,
      }
    }

    if (body.preview) {
      const detected = sniff(csv, cc)
      const plan = toLeads(csv, cc, roles)
      return {
        ...detected,
        valid: plan.leads.length,
        duplicates: plan.duplicates,
        bad: plan.bad.slice(0, 8),
        badCount: plan.bad.length,
        sample: plan.leads.slice(0, 5),
        contacts: plan.leads.slice(0, ROW_PICKER_LIMIT),
        truncated: plan.leads.length > ROW_PICKER_LIMIT,
        ...(list ? await overlap(list, plan.leads.map(l => l.phone)) : { in_list: 0, in_other_list: 0, blocked: 0 }),
      }
    }

    need(list, 'list name')
    const { leads, bad, duplicates } = toLeads(csv, cc, roles)
    if (!leads.length) throw new Error('no usable phone numbers found')
    if (leads.length > MAX_CONTACTS) throw new Error('too many rows in one import — split the file up')

    // Opted-out numbers are never imported — not imported-then-skipped.
    const inserted = await insertContacts(list, leads)
    invalidate()
    return {
      parsed: leads.length,
      inserted: inserted.length,
      skipped: leads.length - inserted.length,
      duplicates,
      badCount: bad.length,
    }
  })

/** Contacts in one list, newest first, optionally filtered by name or number. */
export const GET = (req: Request) =>
  handle(async () => {
    const params = new URL(req.url).searchParams
    const list = need(params.get('list'), 'list')
    // `%` and `_` in a search box are literal to the person typing them, so they are
    // escaped rather than left to act as LIKE wildcards.
    const search = (params.get('q') ?? '').trim().slice(0, 200).replace(/[%_\\]/g, '\\$&')
    return q<Lead>(
      `select id, list, phone, name, vars, status, interest, note
         from leads
        where list = $1
          and ($2 = '' or phone like '%' || $2 || '%' or coalesce(name, '') ilike '%' || $2 || '%')
        order by id desc
        limit 500`,
      [list, search],
    )
  })

export const DELETE = (req: Request) =>
  handle(async () => {
    const list = need(new URL(req.url).searchParams.get('list'), 'list')
    await q(`delete from leads where list = $1`, [list])
    invalidate()
    return { ok: true }
  })
