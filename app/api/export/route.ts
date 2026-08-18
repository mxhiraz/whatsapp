import { q } from '@/lib/db.ts'
import { readable } from '@/lib/http.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * `String(value)` is wrong for two of the column types here: a timestamp comes back
 * as a Date and stringifies to a locale sentence no spreadsheet can parse, and
 * `vars` is jsonb and stringifies to "[object Object]".
 */
const cell = (v: unknown): string => {
  const s =
    v === null || v === undefined ? ''
      : v instanceof Date ? v.toISOString()
        : typeof v === 'object' ? JSON.stringify(v)
          : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Rows per round trip. Small enough that no single chunk is a memory problem. */
const PAGE = 1000

/**
 * One page of the export, keyed on the last id seen.
 *
 * Keyset pagination rather than `offset`: offset re-scans everything it skips, so a
 * 100k-row export would cost O(n²), and rows inserted mid-export would shift the
 * window and duplicate or drop lines.
 */
type Page = (afterId: number) => Promise<Record<string, unknown>[]>

const campaignPage = (campaign: number): Page => afterId =>
  q(
    `select m.id as _id, l.phone, l.name, l.list, l.status as lead_status, l.interest,
            m.step_no, m.variant, m.status, m.sent_at, m.delivered_at, m.read_at,
            s.phone as sent_from, m.body, m.error
       from messages m
       join leads l on l.id = m.lead_id
       left join senders s on s.id = m.sender_id
      where m.campaign_id = $1 and m.id > $2
      order by m.id
      limit ${PAGE}`,
    [campaign, afterId],
  )

const listPage = (list: string): Page => afterId =>
  q(
    `select l.id as _id, l.phone, l.name, l.status, l.interest, l.note, l.vars, l.created_at,
            (select count(*) from messages m where m.lead_id = l.id and m.status = 'sent')::int as messages_sent,
            (select max(r.received_at) from replies r where r.lead_phone = l.phone and not r.outbound) as last_reply_at
       from leads l
      where l.list = $1 and l.id > $2
      order by l.id
      limit ${PAGE}`,
    [list, afterId],
  )

/**
 * Streams the pages out as CSV.
 *
 * The whole result set used to be read into an array and then joined into one
 * string, so exporting a large list held the rows, the strings and the joined copy
 * in memory at once — in the same process that runs the send loop.
 */
function stream(page: Page): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let afterId = 0
  let cols: string[] | null = null
  return new ReadableStream({
    async pull(controller) {
      try {
        const rows = await page(afterId)
        if (!rows.length) {
          controller.close()
          return
        }
        afterId = Number(rows[rows.length - 1]._id)
        if (!cols) {
          // `_id` is the pagination key, not a column of the export.
          cols = Object.keys(rows[0]).filter(c => c !== '_id')
          controller.enqueue(encoder.encode(cols.join(',')))
        }
        controller.enqueue(encoder.encode(rows.map(r => `\n${cols!.map(c => cell(r[c])).join(',')}`).join('')))
      } catch (e) {
        // The headers are long gone by now, so the download can only be cut short.
        console.error('[api] export', (e as Error)?.message)
        controller.error(e)
      }
    },
  })
}

/**
 * Download results as CSV: `?campaign=<id>` for a campaign's messages, or
 * `?list=<name>` for a lead list with its outcome so far.
 *
 * Both parameters are bound, never interpolated, so neither can widen its own scope
 * to another list's contacts. Nothing here reads `app_settings`, which is where the
 * API keys and the password hash live.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const params = new URL(req.url).searchParams
    const campaign = Number(params.get('campaign') ?? '')
    const list = params.get('list') ?? ''

    let page: Page
    let name: string
    if (params.get('campaign')) {
      if (!Number.isInteger(campaign) || campaign < 1) throw new Error('campaign must be an id')
      page = campaignPage(campaign)
      name = `campaign-${campaign}`
    } else if (list) {
      page = listPage(list)
      // A list name reaches a response header, where a quote or a newline would
      // either break the filename or inject a header, so only safe characters survive.
      name = `list-${list.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'export'}`
    } else {
      return Response.json({ error: 'pass ?campaign=<id> or ?list=<name>' }, { status: 400 })
    }

    return new Response(stream(page), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}.csv"`,
      },
    })
  } catch (e) {
    const raw = (e as Error)?.message ?? 'unknown error'
    console.error('[api]', raw)
    return Response.json({ error: readable(raw) }, { status: 400 })
  }
}
