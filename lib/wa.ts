import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import makeWASocket, {
  BufferJSON,
  Browsers,
  DisconnectReason,
  isLidUser,
  generateMessageIDV2,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type WASocket,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { classifyReply } from './ai.ts'
import { logEvent, one, q, tx, type LinkState } from './db.ts'
import { isOptOut } from './parse.ts'
import { POLICY, typingMs } from './safety.ts'

const SESSION_DIR = process.env.SESSION_DIR || './sessions'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * WA_DRY_RUN=1 replaces WhatsApp with a stub: numbers link instantly, sends
 * succeed without leaving the process, and acks arrive on a timer. The engine,
 * the safety rules and the database all behave exactly as in production, so the
 * whole pipeline is testable without risking a real number.
 */
const DRY_RUN = process.env.WA_DRY_RUN === '1'

const noop = () => {}
// Baileys expects a pino instance. A silent stub keeps our own logs readable.
const logger = {
  level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  child: () => logger,
} as unknown as Parameters<typeof makeWASocket>[0]['logger']

// ── the session store ────────────────────────────────────────────────────────

/*
 * Baileys' own `useMultiFileAuthState` says, in its source, "I wouldn't endorse
 * this for any production level use other than perhaps a bot. Would recommend
 * writing an auth state for use with a proper SQL or No-SQL DB". The reason bites
 * here: it re-reads `creds.json` on every call, so each socket got its *own* copy
 * of the credentials and the last one to write won. Two sockets on one number then
 * diverge, WhatsApp rejects the stale one with 440 (conflict), and the number
 * ping-pongs between online and closed with nothing obviously wrong in the code.
 *
 * So credentials and signal keys live in Postgres instead: one row per key, one
 * shared credentials object per number, and every write serialised per number so a
 * batch can never interleave with another. The number's WhatsApp login now lives
 * in your database — treat that database like the secret it is.
 */
interface Session {
  state: AuthenticationState
  saveCreds: () => Promise<void>
}

/** phone -> the one session object every socket for that number shares. */
/*
 * Module state has to be pinned to globalThis in this app.
 *
 * Next compiles `instrumentation.ts` separately from the route handlers, so each one
 * gets its own copy of this module. The engine boots from instrumentation and holds
 * the sockets there; a route reading a plain module-level Map sees an empty one. That
 * is why the dashboard reported every number "offline" while the log showed it online,
 * and why a test send answered "not online" for a number that was sending fine.
 */
const shared = <T>(key: string, make: () => T): T => {
  const g = globalThis as typeof globalThis & { __wa?: Record<string, unknown> }
  g.__wa ??= {}
  return (g.__wa[key] ??= make()) as T
}

const sessions = shared('sessions', () => new Map<string, Promise<Session>>())

/** phone -> tail of the write chain, so writes for one number never interleave. */
const writes = shared('writes', () => new Map<string, Promise<unknown>>())

function serialise<T>(phone: string, work: () => Promise<T>): Promise<T> {
  const next = (writes.get(phone) ?? Promise.resolve()).then(work, work)
  // Keep the chain alive after a failed write; one bad write must not wedge the rest.
  writes.set(phone, next.catch(() => {}))
  return next
}

/*
 * Key ids go through Baileys' own filename mangling before they are stored. The
 * only reason is the migration path below: a session imported from disk arrives
 * keyed by filename, so reads have to produce exactly the same string.
 */
const keyId = (type: string, id: string): string => `${type}-${id}`.replace(/\//g, '__').replace(/:/g, '-')

/** Copies an on-disk session into the database once. The files are left untouched. */
async function importFileSession(phone: string): Promise<void> {
  const dir = `${SESSION_DIR}/${phone}`
  if (!existsSync(`${dir}/creds.json`)) return
  if (await one(`select 1 from wa_auth where phone = $1 limit 1`, [phone])) return

  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  for (const f of files) {
    const data = await readFile(`${dir}/${f}`, 'utf8')
    await q(
      `insert into wa_auth (phone, id, data) values ($1, $2, $3)
       on conflict (phone, id) do update set data = excluded.data, updated_at = now()`,
      [phone, f === 'creds.json' ? 'creds' : f.replace(/\.json$/, ''), data],
    )
  }
  console.log(`[wa] ${phone} imported its file session into the database (${files.length} files, files kept)`)
}

/*
 * A failed read throws rather than falling back to fresh credentials. Baileys' file
 * store swallows read errors into `null` and then calls `initAuthCreds()`, so a
 * truncated file or a blip reads as "never paired" and silently unlinks the number.
 */
async function loadSession(phone: string): Promise<Session> {
  await importFileSession(phone)
  const row = await one<{ data: string }>(`select data from wa_auth where phone = $1 and id = 'creds'`, [phone])
  const creds: AuthenticationCreds = row ? JSON.parse(row.data, BufferJSON.reviver) : initAuthCreds()

  const put = (id: string, value: unknown) =>
    q(
      `insert into wa_auth (phone, id, data) values ($1, $2, $3)
       on conflict (phone, id) do update set data = excluded.data, updated_at = now()`,
      [phone, id, JSON.stringify(value, BufferJSON.replacer)],
    )

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const rows = await q<{ id: string; data: string }>(
            `select id, data from wa_auth where phone = $1 and id = any($2::text[])`,
            [phone, ids.map(id => keyId(type, id))],
          )
          const byKey = new Map(rows.map(r => [r.id, r.data]))
          const out: { [id: string]: SignalDataTypeMap[T] } = {}
          for (const id of ids) {
            const raw = byKey.get(keyId(type, id))
            if (!raw) continue
            const value = JSON.parse(raw, BufferJSON.reviver)
            // Baileys needs this one back as a protobuf message, not a plain object.
            out[id] = type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.fromObject(value) : value
          }
          return out
        },
        /*
         * Baileys already batches: it wraps this store in `addTransactionCapability`
         * and hands over one `SignalDataSet` per commit, so one database transaction
         * per call matches its own atomicity exactly — no finer locking needed.
         * Ordering matters too: `creds.myAppStateKeyId` and the pre-key counters
         * point at keys, and Baileys commits the keys before emitting `creds.update`.
         * The per-number write chain preserves that order for free.
         */
        set: async (data: SignalDataSet) => {
          const puts: Array<[string, string]> = []
          const gone: string[] = []
          for (const type of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            for (const [id, value] of Object.entries(data[type] ?? {})) {
              // Null is Baileys asking for a delete. Testing truthiness instead would
              // also delete a value that is merely empty, which the file store does.
              if (value == null) gone.push(keyId(type, id))
              else puts.push([keyId(type, id), JSON.stringify(value, BufferJSON.replacer)])
            }
          }
          await serialise(phone, () =>
            tx(async run => {
              if (puts.length) {
                await run(
                  `insert into wa_auth (phone, id, data)
                   select $1, k, d from unnest($2::text[], $3::text[]) as t(k, d)
                   on conflict (phone, id) do update set data = excluded.data, updated_at = now()`,
                  [phone, puts.map(x => x[0]), puts.map(x => x[1])],
                )
              }
              if (gone.length) await run(`delete from wa_auth where phone = $1 and id = any($2::text[])`, [phone, gone])
            }),
          )
        },
      },
    },
    saveCreds: () => serialise(phone, async () => { await put('creds', creds) }),
  }
}

/*
 * Exported for tests: `authStateFor` is the shared session every socket for a number
 * uses, `readSessionFromDb` re-reads it from Postgres so a round trip can be checked.
 * This is the number's WhatsApp login — nothing else should be handing it out.
 */
export { sessionFor as authStateFor, loadSession as readSessionFromDb }

function sessionFor(phone: string): Promise<Session> {
  let s = sessions.get(phone)
  if (!s) {
    // Cached on the promise, not the result, so two callers cannot both load it.
    s = loadSession(phone).catch(e => {
      sessions.delete(phone)
      throw e
    })
    sessions.set(phone, s)
  }
  return s
}

// ── live sockets ─────────────────────────────────────────────────────────────

interface Link {
  sock: WASocket | null
  agent?: SocksProxyAgent
  state: LinkState
  qr: string | null
  error: string | null
  tries: number
  disconnects: number[]
  /** Kept so the `registered` flag can be repaired once the socket opens. */
  auth?: Session
  /** Timestamps of recent 440 (connectionReplaced) closes. */
  replaced: number[]
  /** Timestamps of recent 411/500 closes, which mean the credentials are suspect. */
  rejected: number[]
  /** Set before we close a socket ourselves, so the close is not read as a drop. */
  closing?: boolean
  /** Sequence number of this socket, printed in the log to identify it. */
  no: number
  /** When this socket was created, used to spot one wedged in `connecting`. */
  at: number
}

export interface LinkStatus {
  state: LinkState
  qr: string | null
  error: string | null
}

/** phone -> live socket health. Distinct from the DB row, which holds policy. */
const live = shared('live', () => new Map<string, Link>())

/** phone -> a connect in progress. The guard against opening a rival socket. */
const opening = shared('opening', () => new Map<string, Promise<LinkStatus>>())

let sockets = 0

export const jid = (digits: string): string => `${digits}@s.whatsapp.net`
export const digitsOf = (j: string): string => String(j).split('@')[0].split(':')[0]
export const onlinePhones = (): string[] =>
  [...live.entries()].filter(([, l]) => l.state === 'online').map(([p]) => p)

export function statusOf(phone: string): LinkStatus {
  const s = live.get(phone)
  return { state: s?.state ?? 'offline', qr: s?.qr ?? null, error: s?.error ?? null }
}

async function senderId(phone: string): Promise<number | null> {
  const row = await one<{ id: number }>(`select id from senders where phone = $1`, [phone])
  return row?.id ?? null
}

/**
 * Closes a socket of ours without letting the close look like WhatsApp dropping us.
 *
 * Awaited: `end()` resolves once the websocket has really closed, and that await is
 * the serialisation point that stops the next socket from racing this one — two live
 * connections on one set of credentials are what WhatsApp answers with 440. Bounded,
 * because a wedged socket must not hold a reconnect up forever.
 */
async function teardown(entry: Link): Promise<void> {
  entry.closing = true
  const sock = entry.sock
  entry.sock = null
  if (!sock) return
  // Belt and braces: Baileys 7 destroys the emitter inside end(), but a stale handler
  // firing against a superseded entry would overwrite the reason shown for the live one.
  for (const ev of ['connection.update', 'creds.update', 'messages.upsert', 'messages.update'] as const) {
    try { sock.ev.removeAllListeners(ev) } catch { /* emitter already torn down */ }
  }
  await withTimeout('the socket close', 5_000, Promise.resolve(sock.end(undefined))).catch(e =>
    console.warn(`[wa] socket #${entry.no} did not close cleanly: ${(e as Error).message}`))
}

/**
 * Links a number, creating the sender row if needed. Poll statusOf() for the QR.
 *
 * The in-flight guard is the important part and it has to be synchronous. Opening a
 * socket takes several awaits, so two overlapping calls — the boot resume and an
 * operator pressing Reconnect, say — used to sail past a state check and each build
 * a socket on the same credentials. WhatsApp then closes one with 440 conflict, our
 * close handler reopens it, it displaces the other, and the number flaps forever
 * while the log blames the operator's other devices. Registering the promise before
 * the first await means the second caller joins that attempt instead.
 */
export function connect(phone: string, resuming = false): Promise<LinkStatus> {
  const inFlight = opening.get(phone)
  if (inFlight) return inFlight

  /*
   * A socket that has been "connecting" for more than a minute is wedged, not
   * starting. Baileys has its own connect timeout and a failure normally arrives as a
   * close, but if neither ever comes the number would sit in a state this guard
   * refuses to replace — offline, with nothing to explain it.
   */
  const existing = live.get(phone)
  const wedged = existing?.state === 'connecting' && Date.now() - existing.at > 60_000
  if (existing && !wedged && ['connecting', 'qr', 'online'].includes(existing.state)) {
    return Promise.resolve(statusOf(phone))
  }

  const attempt = open(phone, resuming).finally(() => opening.delete(phone))
  opening.set(phone, attempt)
  return attempt
}

async function open(phone: string, resuming: boolean): Promise<LinkStatus> {
  const existing = live.get(phone)

  if (DRY_RUN) {
    // Counters carry over exactly as they do for a real socket, or the retry rules
    // would behave differently under test than in production.
    live.set(phone, {
      sock: null, state: 'online', qr: null, error: null, tries: 0,
      disconnects: existing?.disconnects ?? [],
      replaced: existing?.replaced ?? [],
      rejected: existing?.rejected ?? [],
      no: ++sockets, at: Date.now(),
    })
    await q(`insert into senders (phone) values ($1) on conflict (phone) do nothing`, [phone])
    return statusOf(phone)
  }

  const session = await sessionFor(phone)
  /*
   * Repair sessions written before the flag was persisted on pairing. A session
   * that has `me.id` completed pairing, so if `registered` is still false the flag
   * was simply lost, and leaving it false makes Baileys ask for a new QR instead
   * of resuming. Doing this before the socket opens saves an unnecessary re-scan.
   */
  const creds = session.state.creds
  if (creds.me?.id && !creds.registered) {
    creds.registered = true
    await session.saveCreds()
    console.log(`[wa] ${phone} repaired a session that was missing its registration flag`)
  }

  const row = await one<{ id: number; proxy_url: string | null }>(
    `select id, proxy_url from senders where phone = $1`,
    [phone],
  )

  // Tear the previous socket down first, and wait for it: two live sockets on one set
  // of credentials are exactly the conflict the store comment above describes.
  if (existing) await teardown(existing)

  const entry: Link = {
    sock: null,
    auth: session,
    state: 'connecting',
    replaced: existing?.replaced ?? [],
    rejected: existing?.rejected ?? [],
    qr: null,
    error: null,
    // An operator asking for a reconnect starts the ramp over; our own retries do not.
    tries: resuming ? (existing?.tries ?? 0) : 0,
    disconnects: existing?.disconnects ?? [],
    no: ++sockets,
    at: Date.now(),
  }
  live.set(phone, entry)

  // One sticky proxy per number, never rotated. The point is not to move away from
  // a "flagged" IP — WhatsApp identity is the number and the linked device, and a
  // session whose IP keeps hopping is a worse signal than one that sits still. The
  // point is that numbers sharing an address are correlated to each other, and that
  // datacenter ranges look nothing like the mobile/residential IPs real users have.
  const agent = row?.proxy_url ? new SocksProxyAgent(row.proxy_url) : undefined
  entry.agent = agent
  const sock = makeWASocket({
    auth: session.state,
    logger,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false, // permanently-online is a bot tell
    syncFullHistory: false,
    agent,
    fetchAgent: agent,
  })
  entry.sock = sock

  sock.ev.on('creds.update', () => void session.saveCreds().catch(e =>
    console.error(`[wa] ${phone} could not save credentials: ${(e as Error).message}`)))
  sock.ev.on('connection.update', u => void onConnectionUpdate(phone, entry, u))
  sock.ev.on('messages.upsert', p => void onUpsert(phone, sock, p))
  sock.ev.on('messages.update', p => void onAck(p))

  return statusOf(phone)
}

/**
 * Digs the HTTP-ish status code out of a Baileys disconnect error.
 *
 * Baileys does not hand this over consistently: sometimes `lastDisconnect.error`
 * is the Boom itself, sometimes it is a wrapper with the Boom under `.error`, and
 * the code can sit on `output.statusCode`, `output.payload.statusCode` or plain
 * `statusCode`. Reading only one of those shapes is how the 515 restart path ends
 * up as dead code: the code reads `undefined`, the reconnect is treated as a
 * generic drop, and a number that only needed an immediate reopen never comes
 * back. See WhiskeySockets/Baileys and openclaw/openclaw#33961.
 */
function statusCodeOf(err: unknown, depth = 0): number | undefined {
  if (!err || typeof err !== 'object' || depth > 4) return undefined
  const e = err as {
    output?: { statusCode?: number; payload?: { statusCode?: number } }
    statusCode?: number
    data?: { statusCode?: number }
    error?: unknown
  }
  return (
    e.output?.statusCode ??
    e.output?.payload?.statusCode ??
    e.statusCode ??
    e.data?.statusCode ??
    statusCodeOf(e.error, depth + 1)
  )
}

interface ConnUpdate {
  connection?: string | null
  qr?: string | null
  lastDisconnect?: { error?: Error | null } | null
}

/** Schedules our own reconnect. Never silent: an unexplained offline number is the bug. */
function reconnect(phone: string, entry: Link): void {
  if (live.get(phone) !== entry) return // a newer socket already owns this number
  void connect(phone, true).catch(e => {
    entry.error = `reconnect failed: ${(e as Error).message}`
    console.error(`[wa] ${phone} reconnect failed: ${(e as Error).message}`)
  })
}

async function onConnectionUpdate(phone: string, entry: Link, u: ConnUpdate): Promise<void> {
  if (u.qr) {
    entry.state = 'qr'
    entry.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 })
  }

  if (u.connection === 'open') {
    console.log(`[wa] ${phone} online (socket #${entry.no})`)

    /*
     * Baileys does not reliably persist `creds.registered` after a successful
     * pairing, most visibly on WhatsApp Business accounts. The stored credentials
     * then look unregistered on the next boot, so instead of resuming the session
     * Baileys asks for a fresh QR, which reads as "the number silently stopped
     * working after a restart". Setting the flag here and flushing it is the
     * accepted workaround (WhiskeySockets/Baileys#499); `me.id` is already present
     * at this point, so the session really is paired.
     */
    if (entry.auth && !entry.auth.state.creds.registered) {
      entry.auth.state.creds.registered = true
      await entry.auth.saveCreds().catch(e => console.error(`[wa] ${phone} could not persist registration: ${(e as Error).message}`))
      console.log(`[wa] ${phone} marked registered so it resumes after a restart`)
    }

    entry.state = 'online'
    entry.qr = null
    entry.error = null
    entry.tries = 0
    // Whatever WhatsApp objected to before, these credentials demonstrably work.
    entry.rejected = []
    await q(
      `insert into senders (phone) values ($1)
       on conflict (phone) do update
         set status = case when senders.status = 'banned' then 'warming' else senders.status end`,
      [phone],
    )
    void recordEgressIp(phone, entry.agent)
    return
  }

  if (u.connection !== 'close') return

  /*
   * Only the socket that currently owns this number gets to act on a close. Either
   * we closed this one on purpose — a reconnect, an unlink, a shutdown — or a newer
   * socket has already replaced it. Handling those as drops is what turned every
   * teardown into another reconnect, cost the number health points for our own
   * churn, and let a stale handler overwrite the reason shown on a live entry.
   */
  if (entry.closing || live.get(phone) !== entry) {
    entry.state = 'offline'
    return
  }

  const code = statusCodeOf(u.lastDisconnect?.error)
  const id = await senderId(phone)
  entry.qr = null

  // 401/403 are terminal: unlinked from the phone, or the account is gone.
  if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
    entry.state = 'banned'
    entry.error = code === 403 ? 'blocked by WhatsApp' : 'logged out / unlinked'
    await q(`update senders set status = 'banned' where phone = $1`, [phone])
    if (id) await logEvent(id, code === 403 ? 'forbidden' : 'logged_out',
      code === 403 ? POLICY.penalty.forbidden : POLICY.penalty.logged_out, entry.error)
    return
  }

  entry.state = 'offline'
  entry.error = u.lastDisconnect?.error?.message || `closed (${code})`
  console.warn(`[wa] ${phone} closed: socket #${entry.no} code=${code ?? 'none'} ${entry.error}`)
  entry.tries++

  // Repeated flapping is itself a risk signal, so it costs health points.
  const nowMs = Date.now()
  entry.disconnects = [...entry.disconnects.filter(t => nowMs - t < 3_600_000), nowMs]
  if (id && entry.disconnects.length >= 3) {
    await logEvent(id, 'disconnect', POLICY.penalty.disconnect, `${entry.disconnects.length} disconnects/hour`)
  }
  if (id && code === 463) await logEvent(id, 'timelock', POLICY.penalty.timelock, 'reachout timelock')

  /*
   * 411 (multideviceMismatch) and 500 (badSession) point at the stored credentials
   * rather than the network, and a ramped retry against credentials that cannot work
   * is a number that says "reconnecting" for days.
   *
   * It does not clear the session, though, and that is deliberate. Baileys uses 500
   * as the *default* for any stream error that carries no numeric code
   * (`getErrorCodeFromStreamError` in src/Utils/generics.ts), so "500 means the
   * session is corrupt" would throw away working pairings over ordinary stream
   * hiccups. Nor is "411 can never be retried" anything the project actually states.
   * So after three inside ten minutes — with the counter cleared by any successful
   * connection — it stops, says so, and leaves the decision to the operator:
   * Reconnect tries again for free, and removing and re-adding the number re-pairs.
   */
  if (code === DisconnectReason.multideviceMismatch || code === DisconnectReason.badSession) {
    entry.rejected = [...entry.rejected.filter(t => nowMs - t < 600_000), nowMs]
    if (entry.rejected.length >= 3) {
      entry.error =
        `WhatsApp keeps rejecting this session (code ${code}). Press reconnect to try again; ` +
        'if it keeps happening, remove the number and add it back to re-pair it.'
      console.warn(`[wa] ${phone} stopped reconnecting: ${entry.error}`)
      if (id) await logEvent(id, 'disconnect', 0, entry.error)
      return
    }
  }

  /*
   * 405 is not in Baileys' enum: the raw server reason is passed through, and it
   * means WhatsApp refused this client version. Retrying is fine — a restart picks
   * up a newer version — but without saying so the number just looks stuck.
   */
  if (code === 405) entry.error = 'WhatsApp rejected this client version (405). Update the app to a newer Baileys.'

  /*
   * 440 is connectionReplaced, which WhatsApp sends when a second live connection
   * shows up using *these credentials*. Retrying straight away is how the
   * online/closed ping-pong starts, because each new socket displaces the other. So
   * back off hard, and after three inside ten minutes stop and say so.
   *
   * The message deliberately does not blame WhatsApp Web. Each linked device has its
   * own identity and its own slot, and nothing in the protocol or in Baileys shows a
   * *different* device evicting this one — the payload is a bare
   * `<conflict type="replaced"/>` with no hint of who replaced us. What does produce
   * it is the same session running twice, so that is what the operator is told to
   * look for.
   */
  if (code === DisconnectReason.connectionReplaced) {
    entry.replaced = [...entry.replaced.filter(t => nowMs - t < 600_000), nowMs]
    entry.error = 'another connection is using this number\'s session'
    if (entry.replaced.length >= 3) {
      entry.error =
        "another connection keeps taking over this number's session. Check for a second copy of this app, " +
        'or another tool, running against the same number, then reconnect.'
      console.warn(`[wa] ${phone} giving up: ${entry.error}`)
      return
    }
    await sleep(60_000)
    reconnect(phone, entry)
    return
  }

  /*
   * Reconnect on a ramp, never in a tight loop. Two exceptions:
   *
   * 515 (restartRequired) is what WhatsApp sends immediately after a QR is
   * scanned successfully. Credentials are already saved at that point and the
   * socket is expected to be reopened at once, so delaying it makes a pairing
   * that actually worked look like it failed.
   *
   * While a number has never been paired, a closed socket usually means the QR
   * simply expired. Ramping to two minutes there leaves the pairing dialog empty
   * for long enough to look broken, so a fresh code is fetched promptly instead —
   * but not forever: an unattended QR would otherwise rebuild a socket every three
   * seconds for as long as the process lives.
   */
  const pairing = !entry.auth?.state.creds.registered
  if (pairing && entry.tries > 10) {
    entry.error = 'the QR code was never scanned. Press reconnect to get a fresh one.'
    console.warn(`[wa] ${phone} stopped asking for a QR: ${entry.error}`)
    return
  }

  const wait = code === DisconnectReason.restartRequired ? 0 : pairing ? 3_000 : Math.min(5_000 * entry.tries, 120_000)
  await sleep(wait)
  reconnect(phone, entry)
}

interface UpsertPayload {
  messages: Array<{
    key: { fromMe?: boolean | null; remoteJid?: string | null; id?: string | null }
    message?: {
      conversation?: string | null
      extendedTextMessage?: { text?: string | null } | null
      imageMessage?: { caption?: string | null } | null
    } | null
  }>
  type: string
}

/**
 * The phone number on the other end of an inbound message, or null if this is not a
 * one-to-one chat we should record.
 *
 * WhatsApp no longer always addresses people by their phone number. A newer client
 * uses a LID (`<id>@lid`), and the phone JID then arrives alongside it in
 * `remoteJidAlt`, with the signal repository's mapping as a fallback. The previous
 * code accepted only `@s.whatsapp.net` and skipped anything else without a word, so a
 * reply from such a contact was dropped and left no trace to explain the empty inbox.
 *
 * Groups, broadcasts, status updates and newsletters are skipped on purpose: this is
 * an outreach inbox for one-to-one replies, and a group message is not a reply from a
 * lead. Those are logged too, at debug level, so "nothing arrived" is never a mystery.
 */
async function counterparty(sock: WASocket, key: { remoteJid?: string | null; remoteJidAlt?: string | null }): Promise<string | null> {
  const jid = key.remoteJid
  if (!jid) return null

  if (jid.endsWith('@s.whatsapp.net')) return digitsOf(jid)

  if (isLidUser(jid)) {
    const alt = key.remoteJidAlt
    if (alt?.endsWith('@s.whatsapp.net')) return digitsOf(alt)
    const mapped = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid).catch(() => null)
    if (mapped) return digitsOf(mapped)
    console.warn(`[wa] a reply came from ${jid} and no phone number could be resolved for it, so it was not recorded`)
    return null
  }

  console.log(`[wa] ignoring a message from ${jid}: only one-to-one chats are recorded as replies`)
  return null
}

async function onUpsert(phone: string, sock: WASocket, { messages, type }: UpsertPayload): Promise<void> {
  /*
   * 'notify' is a live message; 'append' is one WhatsApp handed us after the fact,
   * which is how replies that arrived while the socket was down come back. Dropping
   * 'append' loses those, and a missed reply is worse than a missed send: the
   * sequence keeps messaging someone who already answered. Both are safe to take
   * because the insert below is idempotent on the WhatsApp message id.
   */
  if (type !== 'notify' && type !== 'append') return
  if (type === 'append') console.log(`[wa] ${phone} received ${messages.length} message(s) queued while it was offline`)
  for (const m of messages) {
    if (m.key.fromMe) continue

    const from = await counterparty(sock, m.key)
    if (!from) continue

    const body =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      m.message?.imageMessage?.caption ||
      '[media]'
    await onInbound(phone, from, body, m.key.id ?? undefined)

    // Read the message after a human-ish pause; instant read receipts are a tell.
    const key = m.key
    setTimeout(() => {
      void sock.readMessages([key as Parameters<WASocket['readMessages']>[0][number]]).catch(e =>
        console.warn(`[wa] ${phone} could not send a read receipt: ${(e as Error).message}`))
    }, 20_000 + Math.random() * 100_000)
  }
}

/** A reply stops the sequence. An opt-out stops everything, on every list, forever. */
async function onInbound(senderPhone: string, leadPhone: string, body: string, waId?: string): Promise<void> {
  // Warmup chatter between our own numbers must not land in the inbox or count
  // as a lead reply — it would inflate the very metric it exists to support.
  if (await one(`select 1 from senders where phone = $1`, [leadPhone])) return

  /*
   * The same message can arrive twice: WhatsApp re-delivers on reconnect, and a
   * message can come through as both 'notify' and 'append'. A second row would
   * double-count in the inbox and in the reply-rate gate that decides whether a
   * number is burnt, so the WhatsApp message id is unique in the table and a
   * duplicate simply returns no row and stops here.
   */
  const reply = await one<{ id: number }>(
    `insert into replies (sender_phone, lead_phone, body, wa_id) values ($1, $2, $3, $4)
     on conflict (lead_phone, wa_id) do nothing returning id`,
    [senderPhone, leadPhone, body, waId ?? null],
  )
  if (!reply) return

  const optOut = isOptOut(body)
  if (optOut) {
    await q(`insert into blocklist (phone, reason) values ($1, 'replied stop') on conflict (phone) do nothing`, [leadPhone])
  }
  await q(`update leads set status = $2 where phone = $1 and status <> 'opted_out'`, [
    leadPhone,
    optOut ? 'opted_out' : 'replied',
  ])
  await q(
    `update messages set status = 'canceled', error = $2
       where status = 'pending' and lead_id in (select id from leads where phone = $1)`,
    [leadPhone, optOut ? 'opted out' : 'replied'],
  )


  // Tagging runs after the reply is safely recorded, so a classifier outage can
  // never cost you the message itself. An explicit opt-out needs no model call.
  if (!optOut) void tagReply(reply.id, leadPhone, body)
}

async function tagReply(replyId: number, leadPhone: string, body: string): Promise<void> {
  const verdict = await classifyReply(body)
  if (!verdict) return
  await q(`update replies set ai_reason = $2 where id = $1`, [replyId, verdict.reason])
  // Never overwrite a human's own tag.
  await q(`update leads set interest = $2 where phone = $1 and interest = 'unset'`, [leadPhone, verdict.interest])
}

/*
 * WhatsApp's own ack ladder, from proto.WebMessageInfo.Status:
 *
 *   0 ERROR   1 PENDING   2 SERVER_ACK   3 DELIVERY_ACK   4 READ   5 PLAYED
 *
 * SERVER_ACK means WhatsApp's server took the message, NOT that it reached the
 * recipient's phone: one tick, not two. Treating 2 as delivered and 3 as read
 * inflates both rates, and because the soft-ban check compares delivery against a
 * floor, an inflated delivery rate also means that check stops firing when it
 * should. Delivered is 3 and above; read is 4 and above.
 */
const ACK = { ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 } as const

async function onAck(updates: Array<{ key: { id?: string | null }; update?: { status?: number | string | null } }>): Promise<void> {
  for (const u of updates) {
    const raw = u.update?.status
    const status = typeof raw === 'string' ? (ACK[raw as keyof typeof ACK] ?? 0) : (raw ?? 0)
    if (!u.key.id || status < ACK.DELIVERY_ACK) continue

    /*
     * A read ack can arrive without a delivery ack ever being seen, when someone
     * reads the message the moment it lands. Backfilling delivered_at from it is an
     * inference, not an observation, but it is a safe one: nothing can be read
     * without having been delivered.
     *
     * An ack also settles a send whose confirmation timed out: the message clearly
     * went out, so the warning on the row is cleared.
     */
    await q(
      `update messages
          set delivered_at = coalesce(delivered_at, now()),
              read_at = case when $2 >= $3 then coalesce(read_at, now()) else read_at end,
              error = case when error like 'not confirmed%' then null else error end
        where wa_id = $1`,
      [u.key.id, status, ACK.READ],
    )
  }
}

/**
 * Records the public IP this number's traffic leaves from.
 *
 * Rotating IPs is an email tactic that does not transfer: a WhatsApp session is
 * tied to the number and the linked device, and a session whose IP keeps moving
 * looks *more* anomalous, not less. What does matter is correlation — several
 * numbers egressing from one address tie those accounts together — so we record
 * the address once per connection and let the dashboard flag sharing.
 */
async function recordEgressIp(phone: string, agent?: SocksProxyAgent): Promise<void> {
  try {
    const res = await fetch('https://api.ipify.org', {
      signal: AbortSignal.timeout(8000),
      // @ts-expect-error -- undici accepts a dispatcher-compatible agent at runtime
      agent,
    })
    const ip = (await res.text()).trim()
    if (/^[0-9a-f.:]{3,45}$/i.test(ip)) await q(`update senders set egress_ip = $2 where phone = $1`, [phone, ip])
  } catch { /* not knowing the IP is not worth failing a connection over */ }
}

/**
 * Dry-run only: pushes a fake inbound message through the real upsert handler, so the
 * `notify`/`append` filtering and the duplicate check are the ones under test.
 */
export async function simulateInbound(
  senderPhone: string,
  leadPhone: string,
  body: string,
  waId?: string,
  type = 'notify',
): Promise<void> {
  if (!DRY_RUN) throw new Error('simulateInbound requires WA_DRY_RUN=1')
  const stub = { readMessages: async () => {} } as unknown as WASocket
  await onUpsert(senderPhone, stub, {
    type,
    messages: [
      {
        key: { remoteJid: jid(leadPhone), id: waId ?? `dry-in-${process.hrtime.bigint()}` },
        message: { conversation: body },
      },
    ],
  })
}

/** Dry-run only: drives the real close handler, so the retry rules can be tested. */
export async function simulateDisconnect(phone: string, code: number): Promise<void> {
  if (!DRY_RUN) throw new Error('simulateDisconnect requires WA_DRY_RUN=1')
  const entry = live.get(phone)
  if (!entry) throw new Error(`${phone} is not linked`)
  await onConnectionUpdate(phone, entry, {
    connection: 'close',
    lastDisconnect: { error: Object.assign(new Error(`simulated ${code}`), { output: { statusCode: code } }) },
  })
}

function sockFor(phone: string): WASocket {
  const s = live.get(phone)
  if (!s?.sock || s.state !== 'online') throw new Error(`${phone} not online (${s?.state ?? 'offline'})`)
  return s.sock
}

/**
 * Bounds a Baileys call.
 *
 * The socket can be open as far as we can tell and still never answer, most often
 * in the seconds after a reconnect. Every one of these calls used to be awaited
 * with no limit, so a single unanswered request stopped the whole send loop: the
 * queue stayed full, the dashboard showed every number as ready, and nothing was
 * logged because nothing had failed yet. A timeout turns that silence into an error
 * the engine can retry.
 */
export class WaTimeout extends Error {
  /** Set when the send itself timed out, in which case the message may be on its way. */
  readonly waId?: string
  constructor(what: string, ms: number, waId?: string) {
    super(`${what} did not answer within ${Math.round(ms / 1000)}s`)
    this.name = 'WaTimeout'
    this.waId = waId
  }
}

function withTimeout<T>(what: string, ms: number, work: Promise<T>, waId?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WaTimeout(what, ms, waId)), ms)
    work.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      e => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/*
 * Whether a number is on WhatsApp barely changes, and this used to be asked once
 * per outbound message — including on every follow-up to a lead already proven to
 * exist. Repeated lookups are the kind of automated pattern number-checking bans
 * are handed out for, so answers are remembered for a week.
 *
 * ponytail: process-local and cleared wholesale when it gets big. A table would
 * survive restarts; worth it only if you are checking hundreds of thousands.
 */
const lookups = shared('lookups', () => new Map<string, { at: number; exists: boolean }>())
const LOOKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** false = the number has no WhatsApp account. Skipping beats burning a send. */
export async function hasWhatsApp(phone: string, target: string): Promise<boolean> {
  if (DRY_RUN) {
    if (dryFailOnce(`lookup-${target}`)) throw new WaTimeout('the WhatsApp lookup', 15_000)
    return !target.endsWith('0000') // a fixed slice of fake numbers "don't exist"
  }

  const known = lookups.get(target)
  if (known && Date.now() - known.at < LOOKUP_TTL_MS) return known.exists

  const res = await withTimeout('the WhatsApp lookup', 15_000, sockFor(phone).onWhatsApp(target))
  const exists = Boolean(res?.[0]?.exists)
  if (lookups.size > 20_000) lookups.clear()
  lookups.set(target, { at: Date.now(), exists })
  return exists
}

/**
 * Dry-run fault injection: fails the first call for a key, succeeds after that.
 * Lets tests prove that a timeout is retried rather than lost.
 */
const dryFailed = new Set<string>()
function dryFailOnce(key: string): boolean {
  if (!DRY_RUN || dryFailed.has(key)) return false
  const target = key.split('-')[1] ?? ''
  if (!(key.startsWith('lookup-') && target.endsWith('9999')) && !(key.startsWith('send-') && target.endsWith('8888'))) {
    return false
  }
  dryFailed.add(key)
  return true
}

/** Sends with presence + typing simulation. Returns the WhatsApp message id. */
export async function send(phone: string, target: string, text: string): Promise<string | null> {
  if (DRY_RUN) {
    const id = `dry-${phone}-${target}-${process.hrtime.bigint()}`
    if (dryFailOnce(`send-${target}`)) throw new WaTimeout('the send', 45_000, id)
    // Mirror the real ack ladder on the real code path: delivered first, then read.
    const ackFailed = (e: unknown) => console.error(`[wa] dry-run ack failed: ${(e as Error).message}`)
    setTimeout(() => void onAck([{ key: { id }, update: { status: ACK.DELIVERY_ACK } }]).catch(ackFailed), 2_000)
    setTimeout(() => void onAck([{ key: { id }, update: { status: ACK.READ } }]).catch(ackFailed), 3_000)
    return id
  }

  const sock = sockFor(phone)
  const to = jid(target)

  // Presence is decoration: it makes the send look human, but failing to set it is
  // no reason to skip the message, so these are allowed to fail quietly.
  const presence = async (state: 'composing' | 'paused') => {
    try {
      await withTimeout(`presence ${state}`, 5_000, sock.sendPresenceUpdate(state, to))
    } catch {
      // ignored on purpose
    }
  }

  /*
   * No global 'available' here, deliberately. That announces this device as the
   * active one for the whole account, and if the same number is open anywhere else,
   * WhatsApp Web in a browser tab or the desktop app, the server resolves the fight
   * by closing one socket with 440 connectionReplaced. That is what dropped the
   * connection after every single send. `composing` and `paused` are scoped to the
   * one chat, give the same human typing signal, and do not claim the account.
   */
  await presence('composing')
  await sleep(typingMs(text))
  await presence('paused')

  /*
   * The message id is ours, not Baileys'. A send that times out may still have
   * gone out, and without the id we could neither record it nor recognise its
   * delivery receipt — so the only options would be to lose the message or to send
   * it twice. Knowing the id up front means the engine can file it as sent but
   * unconfirmed and let the ack settle it.
   */
  const waId = generateMessageIDV2(sock.user?.id)
  await withTimeout('the send', 45_000, sock.sendMessage(to, { text }, { messageId: waId }), waId)
  return waId
}

/** Unlinks the number: WhatsApp forgets the device and its session is worthless. */
export async function disconnect(phone: string): Promise<void> {
  const s = live.get(phone)
  live.delete(phone)
  sessions.delete(phone)
  if (s) s.closing = true
  try {
    // Bounded: logout waits on the server, and an unlink must not hang the request.
    if (s?.sock) await withTimeout('the logout', 10_000, s.sock.logout())
  } catch (e) {
    console.warn(`[wa] ${phone} logout failed, closing the socket anyway: ${(e as Error).message}`)
  } finally {
    if (s) await teardown(s)
  }
  await q(`delete from wa_auth where phone = $1`, [phone])
}

/**
 * Closes every socket without logging out.
 *
 * `logout()` would unlink the device and force a fresh QR, which is the opposite of
 * what a restart should cost. `end()` just closes the connection, so the stored
 * credentials stay valid and the number comes straight back on the next boot.
 */
export async function closeAll(): Promise<void> {
  await Promise.all(
    [...live].map(async ([phone, link]) => {
      await teardown(link)
      console.log(`[wa] ${phone} closed for shutdown`)
    }),
  )
  live.clear()
  // Let queued credential writes finish; a half-written session costs a QR scan.
  await Promise.allSettled([...writes.values()])
}

/** Re-links every number that already has stored credentials. Called at boot. */
export async function resumeAll(): Promise<void> {
  const rows = await q<{ phone: string; status: string }>(`select phone, status from senders order by id`)
  for (const r of rows) {
    /*
     * A banned number is not re-linked — its credentials are gone — but it still
     * needs to say so. With no entry at all the dashboard showed it as plainly
     * "offline" with no error, which is indistinguishable from a number that is
     * merely idle.
     */
    if (r.status === 'banned') {
      live.set(r.phone, {
        sock: null, state: 'banned', qr: null,
        error: 'logged out or blocked by WhatsApp. Scan the QR again to re-link this number.',
        tries: 0, disconnects: [], replaced: [], rejected: [], no: ++sockets, at: Date.now(),
      })
      continue
    }

    /*
     * Never swallow this. A number that fails to re-link after a restart looks
     * identical to one that is simply idle, and the empty catch that used to be
     * here meant the reason was thrown away: the dashboard showed "offline" with
     * no error and there was nothing in the log to explain it. The message is
     * kept on the link so the Numbers page can show it.
     */
    try {
      await connect(r.phone, true)
      console.log(`[wa] resuming ${r.phone}`)
    } catch (e) {
      const message = (e as Error)?.message ?? 'unknown error'
      console.error(`[wa] could not resume ${r.phone}: ${message}`)
      live.set(r.phone, {
        sock: null,
        state: 'offline',
        qr: null,
        error: `could not resume: ${message}`,
        tries: 0,
        disconnects: [],
        replaced: [],
        rejected: [],
        no: ++sockets,
        at: Date.now(),
      })
    }
  }
}
