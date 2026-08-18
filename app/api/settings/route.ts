import { invalidate } from '@/lib/cache.ts'
import { handle } from '@/lib/http.ts'
import { DEFAULT_PROMPT, promptCoversLabels } from '@/lib/parse.ts'
import { LIMITS, POLICY } from '@/lib/safety.ts'
import {
  AI_PROVIDERS, aiConfig, apiKeyStates, authSecret, clearPassword, effectivePolicy, passwordStored,
  setApiKey, setPassword, updateAi, updateLimits, updateSettings,
} from '@/lib/settings.ts'
import { setSession } from '@/proxy.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Everything the Settings page needs, and nothing it should not have: the API keys
 * and the password are represented here only by whether they exist and, for the
 * keys, a masked hint. None of those values ever leaves the server.
 */
const view = async () => {
  const ai = await aiConfig()
  return {
    ai_enabled: ai.enabled,
    ai_provider: ai.provider,
    ai_model: ai.model,
    ai_prompt: ai.prompt,
    ai_prompt_ok: promptCoversLabels(ai.prompt),
    // The chosen provider has a usable key, so tagging can actually run.
    ai_available: Boolean(ai.key),
    ai_keys: await apiKeyStates(),
    auth_enabled: Boolean(await authSecret()),
    auth_stored: await passwordStored(),
    policy: await effectivePolicy(),
  }
}

export const GET = () =>
  handle(async () => ({
    ...(await view()),
    ai_prompt_default: DEFAULT_PROMPT,
    ai_providers: AI_PROVIDERS,
    auth_env: Boolean(process.env.APP_PASSWORD),
    // The limits: what is in force, what the code would do, and what may be typed.
    defaults: POLICY,
    ranges: LIMITS,
  }))

/**
 * One writer for every setting on the page. `limits` replaces the whole set of
 * overrides, so posting the defaults back is the reset.
 */
export const PATCH = async (req: Request) => {
  // Captured out of the handler so a new password can re-sign this session on the
  // way out: changing the password must not lock out the tab that changed it.
  let signedIn: string | null = null

  const res = await handle(async () => {
    const body = await req.json().catch(() => ({}))
    if (body.ai_enabled !== undefined) await updateSettings({ ai_enabled: Boolean(body.ai_enabled) })
    if (body.ai !== undefined) await updateAi(body.ai)
    if (body.api_key !== undefined) {
      const { provider, key } = body.api_key ?? {}
      await setApiKey(provider, key === null || key === undefined ? null : String(key))
    }
    if (body.limits !== undefined) await updateLimits(body.limits)
    if (body.password !== undefined) {
      if (body.password === null) await clearPassword()
      else if (typeof body.password !== 'string') throw new Error('a password must be text')
      else signedIn = await setPassword(body.password)
    }
    // /api/state carries the sending limits too, and its snapshot predates this save.
    invalidate()
    return view()
  })

  if (signedIn) await setSession(res, signedIn)
  return res
}
