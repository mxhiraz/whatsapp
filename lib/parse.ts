import assert from 'node:assert/strict'

export interface ParsedLead {
  phone: string
  name: string | null
  vars: Record<string, string>
}

export interface BadRow {
  line: number
  raw: string
  reason: string
}

/**
 * What each column becomes. `var:company` turns that column into {{company}}.
 * The sniffer produces a default set of roles; the import screen can override
 * every one of them, so a file with unrecognisable headers still works.
 */
export type Role = 'phone' | 'name' | 'skip' | `var:${string}`

export interface ColumnInfo {
  index: number
  header: string
  samples: string[]
  role: Role
  /** Share of sampled values in this column that parse as a phone number. */
  phoneScore: number
}

export interface Sniffed {
  hasHeader: boolean
  rows: number
  delimiter: string
  columns: ColumnInfo[]
}

export interface ImportPlan {
  leads: ParsedLead[]
  bad: BadRow[]
  duplicates: number
}

const PHONE_KEYS = ['phone', 'number', 'mobile', 'whatsapp', 'phone_number', 'msisdn', 'cell', 'contact_number', 'tel']
const NAME_KEYS = ['name', 'full_name', 'first_name', 'firstname', 'contact', 'contact_name', 'lead']
const WORDS = /^[\p{L}][\p{L}\s.'’-]{1,60}$/u
/** Share of a column's values that must parse as phone numbers to call it the phone column. */
const PHONE_COLUMN_CONFIDENCE = 0.6

/** RFC4180-ish: handles quotes, escaped quotes, embedded separators/newlines, CRLF. */
function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  // Excel prefixes UTF-8 files with a BOM, which otherwise corrupts the first header.
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') inQuotes = false
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === delimiter) { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(f => f.trim() !== ''))
}

/** Whichever of , ; tab | splits the first line into the most fields. */
function sniffDelimiter(text: string): string {
  const line = text.replace(/^﻿/, '').split('\n')[0] ?? ''
  const counts = [',', ';', '\t', '|'].map(d => ({ d, n: parseCsv(line, d)[0]?.length ?? 0 }))
  return counts.sort((a, b) => b.n - a.n)[0].d
}

/**
 * Digits-only E.164 without '+'. Bare 10-digit numbers get the default country code.
 *
 * A cell containing letters is rejected outright. Without that rule, digits scraped
 * out of prose — "10,000+" in a headcount column, a list of brand names — normalise
 * into plausible-looking numbers, and a file with no phone column at all appears to
 * import a handful of contacts.
 */
export function normalizePhone(raw: unknown, cc = '91'): string | null {
  const text = String(raw ?? '')
  if (/\p{L}/u.test(text)) return null
  // The country code is request input too. Sanitising it here rather than in each
  // caller is what stops a hostile `cc` prefixing letters onto an otherwise valid
  // number and storing "abc9876543210" as a phone number.
  const prefix = String(cc ?? '').replace(/\D/g, '') || '91'
  let d = text.replace(/\D/g, '').replace(/^00/, '')
  if (d.length === 10) d = prefix + d
  if (d.length === 11 && d.startsWith('0')) d = prefix + d.slice(1)
  return d.length >= 11 && d.length <= 15 ? d : null
}

/**
 * Reads any CSV and guesses what each column is.
 *
 * The phone column is found by **content**, not by header name: whichever column
 * has the most values that parse as a phone number wins. That is what makes an
 * arbitrary export work — headers like "Ph No" or no header row at all.
 */
export function sniff(text: string, cc = '91'): Sniffed {
  const delimiter = sniffDelimiter(text)
  const rows = parseCsv(text, delimiter)
  if (!rows.length) return { hasHeader: false, rows: 0, delimiter, columns: [] }

  const width = Math.max(...rows.map(r => r.length))
  const headerish = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'))

  const score = (cells: string[][], col: number) => {
    const values = cells.map(r => r[col]).filter(v => v?.trim())
    if (!values.length) return 0
    return values.filter(v => normalizePhone(v, cc)).length / values.length
  }

  // Score against rows 2+ when we have them, so a header row can't skew it.
  const sample = (rows.length > 1 ? rows.slice(1) : rows).slice(0, 200)
  const scores = Array.from({ length: width }, (_, c) => score(sample, c))
  const best = scores.indexOf(Math.max(...scores))
  const byHeader = headerish.findIndex(h => PHONE_KEYS.includes(h))
  /**
   * A real phone column is overwhelmingly phone numbers. Anything less is a column
   * that happens to contain some digits, so we fall back to a header match and
   * otherwise leave the phone unmapped — the import screen then asks the user to
   * choose, instead of importing rubbish it assembled from prose.
   */
  const phoneAt = scores[best] >= PHONE_COLUMN_CONFIDENCE ? best : byHeader

  // A first row whose phone cell doesn't parse is a header.
  const hasHeader =
    headerish.some(h => PHONE_KEYS.includes(h) || NAME_KEYS.includes(h)) ||
    phoneAt < 0 ||
    !normalizePhone(rows[0][phoneAt], cc)

  const body = rows.slice(hasHeader ? 1 : 0)
  const nameByHeader = hasHeader ? headerish.findIndex(h => NAME_KEYS.includes(h)) : -1
  const wordy = (col: number) => {
    const values = body.slice(0, 50).map(r => r[col]).filter(v => v?.trim())
    return values.length ? values.filter(v => WORDS.test(v.trim())).length / values.length : 0
  }
  const nameAt =
    nameByHeader >= 0
      ? nameByHeader
      : Array.from({ length: width }, (_, c) => c).filter(c => c !== phoneAt).sort((a, b) => wordy(b) - wordy(a))[0] ?? -1
  const namedByContent = nameByHeader < 0 && nameAt >= 0 && wordy(nameAt) > 0.6

  const columns: ColumnInfo[] = Array.from({ length: width }, (_, c) => {
    const header = (hasHeader ? headerish[c] : '') || `column_${c + 1}`
    const role: Role =
      c === phoneAt ? 'phone'
        : c === nameAt && (nameByHeader >= 0 || namedByContent) ? 'name'
          : `var:${header}`
    return {
      index: c,
      header,
      samples: body.slice(0, 3).map(r => (r[c] ?? '').trim()),
      role,
      phoneScore: Math.round(scores[c] * 100) / 100,
    }
  })

  return { hasHeader, rows: body.length, delimiter, columns }
}

/**
 * Applies a column mapping (or the sniffed default) and produces leads.
 * Rows without a usable phone are reported with their line number rather than
 * dropped silently.
 */
export function toLeads(text: string, cc = '91', roles?: Role[]): ImportPlan {
  const info = sniff(text, cc)
  if (!info.columns.length) return { leads: [], bad: [], duplicates: 0 }

  const mapping = roles?.length ? roles : info.columns.map(c => c.role)
  const phoneAt = mapping.indexOf('phone')
  const nameAt = mapping.indexOf('name')
  const rows = parseCsv(text, info.delimiter).slice(info.hasHeader ? 1 : 0)
  const offset = info.hasHeader ? 2 : 1 // 1-based line numbers as seen in a spreadsheet

  const leads: ParsedLead[] = []
  const bad: BadRow[] = []
  const seen = new Set<string>()
  let duplicates = 0

  rows.forEach((row, i) => {
    const raw = row.join(info.delimiter === '\t' ? ' ' : info.delimiter).slice(0, 120)
    if (phoneAt < 0) {
      bad.push({ line: i + offset, raw, reason: 'no column mapped to phone' })
      return
    }
    const phone = normalizePhone(row[phoneAt], cc)
    if (!phone) {
      bad.push({ line: i + offset, raw, reason: `"${(row[phoneAt] ?? '').trim()}" is not a usable number` })
      return
    }
    if (seen.has(phone)) { duplicates++; return }
    seen.add(phone)

    const vars: Record<string, string> = {}
    mapping.forEach((role, c) => {
      if (!role.startsWith('var:')) return
      const value = row[c]?.trim()
      if (value) vars[role.slice(4)] = value
    })
    leads.push({ phone, name: (nameAt >= 0 ? row[nameAt] : '')?.trim() || null, vars })
  })

  return { leads, bad, duplicates }
}

/** Picks one option per {a|b|c} group, innermost group first. */
export function spin(s: string, rand: () => number = Math.random): string {
  const group = /\{([^{}]*\|[^{}]*)\}/
  let out = s
  for (let i = 0; i < 100 && group.test(out); i++) {
    out = out.replace(group, (_m, body: string) => {
      const opts = body.split('|')
      return opts[Math.floor(rand() * opts.length)]
    })
  }
  return out
}

/**
 * Normalises the extra fields on a contact into the one shape `render` can read.
 *
 * `leads.vars` is jsonb, which accepts `"text"`, `[1,2]` and `null` as happily as an
 * object — and a string spreads character by character when a body is rendered. Keys
 * are folded to the `{{snake_case}}` form message copy actually references, so a
 * column called "Company Name" is usable as `{{company_name}}` however it arrived.
 */
export const cleanVars = (raw: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {})
      .map(([k, v]) => [
        String(k).trim().toLowerCase().replace(/\s+/g, '_').slice(0, 60),
        (typeof v === 'object' && v !== null ? '' : String(v ?? '')).trim().slice(0, 500),
      ])
      .filter(([k, v]) => k && v),
  )

/** Anything render() can personalise — a DB row or a freshly parsed CSV line. */
export interface Renderable {
  phone: string
  name?: string | null
  vars?: Record<string, string> | null
}

/** {{var}} substitution + spintax. Unknown vars collapse to ''. */
export function render(body: string, lead: Renderable, rand: () => number = Math.random): string {
  const name = lead.name || lead.vars?.name || ''
  const bag: Record<string, string> = {
    ...(lead.vars ?? {}),
    name,
    first_name: name.split(/\s+/)[0] || '',
    phone: lead.phone,
  }
  return spin(body, rand)
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => String(bag[k] ?? '').trim())
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** How many distinct messages the spintax in a body can produce. */
export function spinVariants(body: string): number {
  let total = 1
  for (const m of body.matchAll(/\{([^{}]*\|[^{}]*)\}/g)) total *= m[1].split('|').length
  return total
}

/**
 * Opt-out phrasing, in the two scripts a reply to Indian cold outreach arrives in.
 *
 * Two regexes rather than one because `\b` is ASCII-only in JavaScript: a boundary
 * in front of `बंद` can never match, so the Devanagari phrases have to be tested
 * without one. The Latin list keeps its boundaries — without them "stop" fires on
 * "stopped by later" and opts out someone who was interested.
 *
 * Missing an opt-out is the expensive failure here (it is a legal one, not a
 * cosmetic one), so this leans towards matching: anything that reads as "stop
 * contacting me" counts, including a soft "nahi chahiye".
 */
const OPT_OUT_LATIN = new RegExp(
  `\\b(${[
    'stop',
    'unsub(scribed?|s)?',
    'opt[\\s-]?out',
    'remove\\s+(me|my\\s+(number|name|details|contact))',
    'delete\\s+my\\s+(number|name|details|contact)',
    'take\\s+me\\s+off',
    // "dont" / "don't" / "don’t" / "do not" — phone keyboards produce all four.
    "do\\s?n[o'’]?t\\s+(contact|text|message|msg|call|whatsapp|disturb)",
    'not\\s+intere?sted',
    'leave\\s+me\\s+alone',
    'no\\s+more\\s+(messages|texts|msgs)',
    // Hinglish, as it is actually typed: Latin script, Hindi words.
    'band(h)?\\s+kar\\w*',
    'mat\\s+bhej\\w*',
    'mat\\s+karo',
    'nah?i(n|ns)?\\s+chahiye',
    'block\\s+kar\\w*',
    'pareshan\\s+mat',
  ].join('|')})\\b`,
  'i',
)

const OPT_OUT_DEVANAGARI = /बंद\s*कर|बन्द\s*कर|मत\s*भेज|नहीं?\s*चाहिए|नंबर\s*हटा|परेशान\s*मत/

export const isOptOut = (text: unknown): boolean => {
  const said = String(text ?? '')
  return OPT_OUT_LATIN.test(said) || OPT_OUT_DEVANAGARI.test(said)
}

/** The only tags the classifier may produce. Order is the order shown to a model. */
export const INTERESTS = ['meeting', 'positive', 'neutral', 'negative'] as const
export type Interest = (typeof INTERESTS)[number]

/**
 * The instructions sent with every reply, and the text the Settings page shows and
 * lets you edit. It lives here, next to the parser, so the self-check below can
 * prove the shipped default still names every tag it asks for.
 */
export const DEFAULT_PROMPT = `You label replies to cold WhatsApp outreach so a salesperson can triage an inbox.

Answer with exactly one of these words:
- meeting: they agree to a call or demo, propose a time, or ask for a calendar link.
- positive: interest or a buying question, such as pricing, how it works, "send details", "who are you with?".
- neutral: an acknowledgement, a holding reply, an out-of-office, or a wrong-person redirect.
- negative: not interested, annoyed, or telling you to stop.

Label what the message actually says, not what you hope it means. A short reply is
usually neutral rather than positive. Start with the word, then at most eight more
words saying what decided it.`

/**
 * Reads a tag out of whatever a model actually said.
 *
 * Tagging is text in, text out on purpose: no JSON mode, no schema, no tool calls,
 * because not every model supports them and a tag is never worth a failed request.
 * The cost of that choice is paid here, so this is deliberately forgiving about
 * casing, quotes, code fences, "Label: positive" and whole sentences, and takes the
 * first tag that appears. Anything unrecognisable means no tag, never an error.
 */
export function interestFrom(text: unknown): Interest | null {
  const said = String(text ?? '').toLowerCase()
  let best: { at: number; interest: Interest } | null = null
  for (const interest of INTERESTS) {
    // Word boundaries, so "positivity" is not a tag and "(negative)" is.
    const at = said.search(new RegExp(`\\b${interest}\\b`))
    if (at >= 0 && (!best || at < best.at)) best = { at, interest }
  }
  return best?.interest ?? null
}

/**
 * Whether an edited prompt still asks for the tags this app understands. A prompt
 * that names none of them produces replies that stay untagged forever, which is
 * worth a warning on the settings page rather than silence.
 */
export const promptCoversLabels = (prompt: unknown): boolean => {
  const text = String(prompt ?? '').toLowerCase()
  return INTERESTS.every(i => text.includes(i))
}

/** djb2 — only used to spot identical outbound copy, never for security. */
export function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

if (import.meta.filename === process.argv[1]) {
  // Ordinary export with quoted fields
  const csv = 'Name,Phone,Company\nAda Lovelace,+91 98765 43210,"Analytic, Engines"\nBad Row,12,X\nDup,919876543210,Y\n'
  const plan = toLeads(csv)
  assert.equal(plan.leads.length, 1, 'drops the invalid row, dedupes the repeat')
  assert.equal(plan.duplicates, 1)
  assert.deepEqual(plan.bad, [{ line: 3, raw: 'Bad Row,12,X', reason: '"12" is not a usable number' }])
  assert.equal(plan.leads[0].phone, '919876543210')
  assert.equal(plan.leads[0].vars.company, 'Analytic, Engines')

  // Unrecognisable headers: the phone column is found by content, not by name
  const weird = 'Ph No;Who;Where\n98765 43210;Grace Hopper;Remote\n'
  const w = sniff(weird)
  assert.equal(w.delimiter, ';')
  assert.equal(w.columns[0].role, 'phone', 'sniffed the phone column despite the header')
  assert.equal(w.columns[1].role, 'name', 'sniffed a name column from its content')
  assert.equal(w.columns[2].role, 'var:where')
  assert.equal(toLeads(weird).leads[0].name, 'Grace Hopper')

  // Headerless, BOM-prefixed, tab-separated, phone not in the first column
  const bom = '﻿Acme Corp\t919876543210\nOther Ltd\t919876543211\n'
  const b = sniff(bom)
  assert.equal(b.hasHeader, false)
  assert.equal(b.columns[1].role, 'phone')
  assert.equal(toLeads(bom).leads.length, 2)
  // A wordy column becomes the name by default — content can't tell a person from
  // a company, which is exactly why the import screen lets you remap it.
  assert.equal(toLeads(bom).leads[0].name, 'Acme Corp')
  assert.equal(toLeads(bom, '91', ['var:company', 'phone']).leads[0].vars.company, 'Acme Corp')

  // Explicit mapping overrides the guess, and skip drops a column
  const mapped = toLeads(csv, '91', ['var:label', 'phone', 'skip'])
  assert.equal(mapped.leads[0].name, null, 'nothing mapped to name')
  assert.equal(mapped.leads[0].vars.label, 'Ada Lovelace')
  assert.equal(mapped.leads[0].vars.company, undefined, 'skipped column excluded')

  // A spreadsheet of companies with no phone column at all must import nothing
  // rather than assembling numbers out of prose and stray digits.
  const noPhones =
    '#,company,segment,hq_city,headcount_band,key_brands_/_notes\n' +
    '1,Trent Ltd,Apparel & Fashion Retail,Mumbai,"10,000+","Westside, Zudio, Samoh"\n' +
    '2,Shoppers Stop Ltd,Retail,Mumbai,"5,000+","Shoppers Stop, HomeStop"\n'
  const sniffed = sniff(noPhones)
  assert.ok(!sniffed.columns.some(c => c.role === 'phone'), 'refuses to guess a phone column')
  assert.equal(toLeads(noPhones).leads.length, 0, 'imports nothing from a file with no numbers')
  assert.equal(normalizePhone('Westside, Zudio, Samoh, Star Bazaar'), null, 'prose is not a phone number')
  assert.equal(normalizePhone('10,000+'), null, 'a headcount is not a phone number')

  assert.equal(normalizePhone('98765 43210'), '919876543210')
  assert.equal(normalizePhone('+1 (415) 555-0132', '1'), '14155550132')
  assert.equal(normalizePhone("'919876543210"), '919876543210', 'Excel text-guard apostrophe')
  assert.equal(normalizePhone('123'), null)

  const zero = () => 0
  assert.equal(spin('{Hey|Hi} {there|you}', zero), 'Hey there')
  assert.equal(spin('no groups {{name}}', zero), 'no groups {{name}}', 'vars survive spintax')
  assert.equal(spinVariants('{a|b|c} and {d|e}'), 6)
  assert.equal(
    render('{Hey|Hi} {{first_name}}, saw {{company}}. {{missing}}', plan.leads[0], zero),
    'Hey Ada, saw Analytic, Engines.',
  )
  assert.ok(isOptOut('STOP') && isOptOut('please remove me') && !isOptOut('stopped by later'))
  // An opt-out that is not recognised keeps messaging someone who asked you to
  // stop, so every phrasing below is a legal problem, not a cosmetic one.
  for (const said of [
    'unsub', 'Unsubscribe', 'unsubscribed', 'opt out', 'opt-out', 'OptOut',
    'please delete my number', 'take me off your list', 'no more messages',
    "don't contact me again", 'don’t message me', 'dont text me', 'do not disturb',
    'band karo bhai', 'band kar do', 'bandh karo', 'mat bhejo', 'mat bhejna',
    'nahi chahiye', 'nahin chahiye', 'block karunga', 'pareshan mat karo',
    'बंद करो', 'मत भेजो', 'नहीं चाहिए', 'मेरा नंबर हटा दो', 'परेशान मत करो',
  ]) {
    assert.ok(isOptOut(said), `must be read as an opt-out: ${said}`)
  }
  // The other half of the job: a reply worth answering must not be silently blocked.
  for (const said of [
    'stopped by later', 'interested, send details', 'who is this?', 'call me tomorrow',
    'not right now, maybe next quarter', 'kal baat karo', 'kitna paisa',
  ]) {
    assert.ok(!isOptOut(said), `must not be read as an opt-out: ${said}`)
  }
  assert.deepEqual(cleanVars({ 'Company Name': ' Acme ', empty: '', n: 7 }), { company_name: 'Acme', n: '7' })
  assert.deepEqual(cleanVars('pwned'), {}, 'a jsonb scalar would spread character by character when rendered')
  assert.deepEqual(cleanVars(null), {})
  assert.deepEqual(cleanVars({ nested: { a: 1 } }), {}, 'nothing renders as "[object Object]"')

  assert.equal(normalizePhone('9876543210', 'abc'), '919876543210', 'a junk country code cannot reach the database')
  assert.equal(normalizePhone('9876543210', '+1 '), '19876543210', 'a punctuated country code still works')

  // The tag parser. A model answers in prose whatever you ask it for, so every one
  // of these has to land on the same tag, and nonsense has to mean "no tag".
  assert.equal(interestFrom('POSITIVE'), 'positive')
  assert.equal(interestFrom(' positive\n'), 'positive')
  assert.equal(interestFrom('```\npositive\n```'), 'positive')
  assert.equal(interestFrom('I would call this positive, they asked about pricing.'), 'positive')
  assert.equal(interestFrom('Label: **negative**'), 'negative')
  assert.equal(interestFrom('meeting, they proposed Tuesday'), 'meeting')
  assert.equal(interestFrom('banana'), null, 'an unusable answer means no tag, not an error')
  assert.equal(interestFrom(''), null)
  assert.equal(interestFrom(null), null)
  assert.equal(interestFrom(undefined), null)
  assert.equal(interestFrom('positivity'), null, 'a word that merely contains a tag is not a tag')
  assert.equal(interestFrom('neutral, unless you read it as positive'), 'neutral', 'the first tag wins')

  assert.ok(promptCoversLabels(DEFAULT_PROMPT), 'the shipped prompt asks for every tag')
  assert.ok(!promptCoversLabels('just answer yes or no'), 'a prompt naming no tag is caught')
  assert.ok(!promptCoversLabels('answer positive or negative'), 'a prompt missing tags is caught')
  assert.ok(INTERESTS.every(i => interestFrom(i) === i), 'every tag parses back to itself')
  assert.equal(hash('a'), hash('a'))
  assert.notEqual(hash('a'), hash('b'))
  console.log('parse.ts ok')
}
