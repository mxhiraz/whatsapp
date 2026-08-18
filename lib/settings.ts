import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { ttlCache } from './cache.ts'
import { one } from './db.ts'
import { DEFAULT_PROMPT } from './parse.ts'
import { clampLimits, resolvePolicy, type Limits, type Policy } from './safety.ts'

export interface AppSettings {
  ai_enabled: boolean
}

/**
 * The providers that can tag replies, with the model each one defaults to and a few
 * suggestions for the picker. Any text-in, text-out chat model works, so the lists
 * are hints rather than a whitelist: a new model needs no code change here.
 */
export const AI_PROVIDERS = {
  anthropic: {
    label: 'Claude',
    env: 'ANTHROPIC_API_KEY',
    model: 'claude-opus-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  },
  google: {
    label: 'Gemini',
    env: 'GOOGLE_GENERATIVE_AI_API_KEY',
    model: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  openai: {
    label: 'ChatGPT',
    env: 'OPENAI_API_KEY',
    model: 'gpt-5.1',
    models: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-4.1-mini'],
  },
} as const

export type Provider = keyof typeof AI_PROVIDERS

/** Column per provider. A hardcoded map, never a name from a request. */
const KEY_COLUMN: Record<Provider, string> = {
  anthropic: 'anthropic_api_key',
  google: 'google_api_key',
  openai: 'openai_api_key',
}

const isProvider = (v: unknown): v is Provider => typeof v === 'string' && v in AI_PROVIDERS

/** The whole settings row. Nothing outside this file sees the secrets on it. */
interface Row {
  ai_enabled: boolean
  ai_provider: string
  ai_model: string | null
  ai_prompt: string | null
  limits: Limits
  anthropic_api_key: string | null
  google_api_key: string | null
  openai_api_key: string | null
  password_hash: string | null
}

/**
 * Install-level settings, cached because they are read on every inbound reply,
 * every engine tick and (for the password) every request through the proxy.
 * There is exactly one row; `migrate()` seeds it.
 *
 * Five seconds is short enough that saving a setting takes effect on the next
 * poll without a restart, and long enough to keep this off the hot path.
 */
const row = ttlCache(5_000, async (): Promise<Row> => {
  const r = await one<Row>(
    `select ai_enabled, ai_provider, ai_model, ai_prompt, limits,
            anthropic_api_key, google_api_key, openai_api_key, password_hash
       from app_settings where id = 1`,
  )
  return (
    r ?? {
      ai_enabled: true, ai_provider: 'anthropic', ai_model: null, ai_prompt: null, limits: {},
      anthropic_api_key: null, google_api_key: null, openai_api_key: null, password_hash: null,
    }
  )
})

/** Deliberately narrow: the caller gets the toggle, not the secrets beside it. */
export const settings = async (): Promise<AppSettings> => ({ ai_enabled: (await row()).ai_enabled })

/**
 * The limits the engine actually enforces: the operator's overrides merged over
 * the POLICY defaults, with anything out of range dropped back to the default.
 */
export const effectivePolicy = async (): Promise<Policy> => resolvePolicy((await row()).limits)

/** Everything a classification needs, resolved. `key` undefined means it cannot run. */
export interface AiConfig {
  enabled: boolean
  provider: Provider
  model: string
  prompt: string
  key: string | undefined
}

/**
 * A key saved from the dashboard wins over the environment, so adding one needs no
 * restart. WA_AI_MODEL is still honoured as the Claude default, for installs that set
 * it before the model became a setting.
 */
export const aiConfig = async (): Promise<AiConfig> => {
  const r = await row()
  const provider = isProvider(r.ai_provider) ? r.ai_provider : 'anthropic'
  const stored = { anthropic: r.anthropic_api_key, google: r.google_api_key, openai: r.openai_api_key }[provider]
  const fallback = provider === 'anthropic' ? process.env.WA_AI_MODEL : undefined
  return {
    enabled: r.ai_enabled,
    provider,
    model: r.ai_model?.trim() || fallback?.trim() || AI_PROVIDERS[provider].model,
    prompt: r.ai_prompt?.trim() || DEFAULT_PROMPT,
    key: stored || process.env[AI_PROVIDERS[provider].env] || undefined,
  }
}

/** `sk-ant-…4f2a`: enough to recognise which key is in use, useless to a thief. */
export const maskKey = (key: string): string => `${key.slice(0, 7)}…${key.slice(-4)}`

export interface KeyState {
  /** Masked, never the key. Null when this provider has no key at all. */
  hint: string | null
  /** Saved in the dashboard, so it can be removed there. */
  stored: boolean
  /** Present in the environment, which the dashboard cannot remove. */
  env: boolean
}

/** What the Settings page is allowed to know about the keys. */
export const apiKeyStates = async (): Promise<Record<Provider, KeyState>> => {
  const r = await row()
  const entries = (Object.keys(AI_PROVIDERS) as Provider[]).map(p => {
    const stored = { anthropic: r.anthropic_api_key, google: r.google_api_key, openai: r.openai_api_key }[p]
    const env = process.env[AI_PROVIDERS[p].env]
    const key = stored || env
    return [p, { hint: key ? maskKey(key) : null, stored: Boolean(stored), env: Boolean(env) }] as const
  })
  return Object.fromEntries(entries) as Record<Provider, KeyState>
}

export const passwordStored = async (): Promise<boolean> => Boolean((await row()).password_hash)

/**
 * What the session cookie is signed with: the stored password hash, or the
 * environment password on installs that never set one from the UI. Null means
 * this dashboard has no password at all.
 */
export const authSecret = async (): Promise<string | null> =>
  (await row()).password_hash ?? process.env.APP_PASSWORD ?? null

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const r = await one<Row>(
    `update app_settings set ai_enabled = coalesce($1, ai_enabled), updated_at = now()
      where id = 1 returning ai_enabled, limits, anthropic_api_key, password_hash`,
    [patch.ai_enabled ?? null],
  )
  row.clear()
  return { ai_enabled: r!.ai_enabled }
}

/**
 * Replaces the stored overrides wholesale: the Settings form posts every limit it
 * shows, so a missing key means "back to the default" rather than "leave alone".
 */
export async function updateLimits(input: unknown): Promise<Policy> {
  const limits = clampLimits(input)
  await one(`update app_settings set limits = $1, updated_at = now() where id = 1`, [JSON.stringify(limits)])
  row.clear()
  return resolvePolicy(limits)
}

/** Saves or removes one provider's key. Null removes it. */
export async function setApiKey(provider: unknown, key: string | null): Promise<void> {
  if (!isProvider(provider)) throw new Error('unknown provider')
  const value = key === null ? null : String(key).trim()
  if (value !== null && !/^\S{20,}$/.test(value)) {
    throw new Error(`that does not look like an ${AI_PROVIDERS[provider].label} API key`)
  }
  await one(`update app_settings set ${KEY_COLUMN[provider]} = $1, updated_at = now() where id = 1`, [value])
  row.clear()
}

/**
 * Which model tags replies, and how. An empty model or prompt is stored as null, so
 * the field falls back to the default rather than sending a blank instruction.
 */
export async function updateAi(patch: unknown): Promise<AiConfig> {
  const p = (patch ?? {}) as { provider?: unknown; model?: unknown; prompt?: unknown }
  if (p.provider !== undefined && !isProvider(p.provider)) throw new Error('unknown provider')
  await one(
    `update app_settings
        set ai_provider = coalesce($1::text, ai_provider),
            ai_model = case when $2::text is null then ai_model else nullif(trim($2::text), '') end,
            ai_prompt = case when $3::text is null then ai_prompt else nullif(trim($3::text), '') end,
            updated_at = now()
      where id = 1`,
    [
      p.provider === undefined ? null : String(p.provider),
      p.model === undefined ? null : String(p.model),
      p.prompt === undefined ? null : String(p.prompt),
    ],
  )
  row.clear()
  return aiConfig()
}

const scryptAsync = promisify(scrypt) as (secret: string, salt: string, keylen: number) => Promise<Buffer>

/** 'salt:hash', both hex. A random salt per password, so a leaked row is not a list. */
async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${(await scryptAsync(plain, salt, 64)).toString('hex')}`
}

const sameBytes = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b)

/**
 * Checks a password against the stored hash, or against APP_PASSWORD on installs
 * that never set one from the UI. Both comparisons are constant-time.
 */
export async function verifyPassword(given: string): Promise<boolean> {
  const stored = (await row()).password_hash
  if (stored) {
    const [salt, want] = stored.split(':')
    if (!salt || !want) return false
    return sameBytes(await scryptAsync(given, salt, 64), Buffer.from(want, 'hex'))
  }
  const env = process.env.APP_PASSWORD
  return env ? sameBytes(Buffer.from(given), Buffer.from(env)) : false
}

/** Returns the new session secret, so the caller can keep itself signed in. */
export async function setPassword(plain: string): Promise<string> {
  const value = String(plain ?? '')
  if (value.trim().length < 8) throw new Error('a password needs at least 8 characters')
  const hash = await hashPassword(value)
  await one(`update app_settings set password_hash = $1, updated_at = now() where id = 1`, [hash])
  row.clear()
  return hash
}

export async function clearPassword(): Promise<void> {
  await one(`update app_settings set password_hash = null, updated_at = now() where id = 1`)
  row.clear()
}
