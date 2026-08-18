import { readFile } from 'node:fs/promises'
import pg from 'pg'

export type SenderStatus = 'warming' | 'active' | 'paused' | 'banned'
export type LinkState = 'offline' | 'connecting' | 'qr' | 'online' | 'banned'
export type LeadStatus = 'new' | 'active' | 'replied' | 'invalid' | 'done' | 'opted_out'
export type MessageStatus = 'pending' | 'sent' | 'failed' | 'canceled' | 'skipped'
export type CampaignStatus = 'draft' | 'running' | 'paused' | 'done'
export type EventKind =
  | 'disconnect' | 'send_failed' | 'timelock' | 'rate_limited' | 'forbidden' | 'logged_out' | 'warmup' | 'resumed'

export interface Sender {
  id: number
  phone: string
  label: string | null
  status: SenderStatus
  max_per_day: number
  max_per_hour: number
  warmup_started_at: string
  paused_until: string | null
  break_until: string | null
  next_ready_at: string | null
  warmup_growth: number
  proxy_url: string | null
  egress_ip: string | null
}

/** A sender row plus everything the dashboard and the loop need to judge it. */
export interface SenderHealth extends Sender {
  state: LinkState
  qr: string | null
  error: string | null
  health: number
  cap_today: number
  sent_today: number
  sent_hour: number
  sent_total: number
  delivered_total: number
  replies: number
  reply_rate: number
  delivery_rate: number
}

export interface Lead {
  id: number
  list: string
  phone: string
  name: string | null
  vars: Record<string, string>
  status: LeadStatus
  sender_id: number | null
  interest: string
  note: string | null
}

export interface Campaign {
  id: number
  name: string
  list: string
  status: CampaignStatus
  min_delay_sec: number
  max_delay_sec: number
  start_hour: number
  end_hour: number
  skip_weekends: boolean
  cooldown_days: number
  timezone: string
  /** Send regardless of start_hour/end_hour and the weekend rule. Off by default. */
  ignore_send_window: boolean
}

export interface Step {
  id: number
  campaign_id: number
  step_no: number
  bodies: string[]
  delay_hours: string
}

/** A pending message joined to everything the sender loop needs to act on it. */
export interface DueMessage {
  id: number
  campaign_id: number
  campaign_name: string
  lead_id: number
  step_no: number
  bodies: string[]
  phone: string
  name: string | null
  vars: Record<string, string>
  sender_id: number | null
  min_delay_sec: number
  max_delay_sec: number
  cooldown_days: number
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:wa@localhost:5439/wa_outreach',
})

export const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> =>
  pool.query<T>(sql, params as unknown[]).then(r => r.rows)

export const one = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T | undefined> => (await q<T>(sql, params))[0]

/** The same signature as `q`, bound to one connection inside a transaction. */
export type Run = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>

/**
 * Runs several statements as one unit on one connection.
 *
 * The handlers that need this are the ones where a half-applied change is worse
 * than no change: blocklisting (a number is on the list but its queue is still
 * live) and creating a campaign (a campaign with no steps, which can never
 * start). Anything that is a single statement does not need it — `q` is already
 * atomic — so this is not the default.
 */
export async function tx<T>(fn: (run: Run) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const run: Run = (sql, params) => client.query(sql, params as unknown[]).then(r => r.rows) as never
    const out = await fn(run)
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function migrate(): Promise<void> {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
}

export const logEvent = (senderId: number, kind: EventKind, points: number, detail?: string) =>
  q(`insert into sender_events (sender_id, kind, points, detail) values ($1, $2, $3, $4)`, [
    senderId, kind, points, detail ?? null,
  ])
