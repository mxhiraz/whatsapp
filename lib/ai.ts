import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { interestFrom, type Interest } from './parse.ts'
import { aiConfig, type Provider } from './settings.ts'

export type { Interest }

export interface Classification {
  interest: Interest
  /** What the model actually said, kept so a tag can be sanity-checked later. */
  reason: string
}

/**
 * Reply tagging, through the Vercel AI SDK so the provider is the operator's choice.
 *
 * Each provider is built per call from the key in the database rather than from the
 * environment at import time, which is what lets a key be added or swapped from the
 * dashboard without a restart.
 *
 * Text in, text out, deliberately: no JSON schema, no structured output, no tool
 * calling. Those are not supported by every model, and a tag is never worth a failed
 * request. The answer is parsed by `interestFrom`, which takes the first known label
 * out of whatever prose comes back and yields nothing if there is none.
 */
function languageModel(provider: Provider, apiKey: string, model: string) {
  switch (provider) {
    case 'google': return createGoogleGenerativeAI({ apiKey }).languageModel(model)
    case 'openai': return createOpenAI({ apiKey }).languageModel(model)
    default: return createAnthropic({ apiKey }).languageModel(model)
  }
}

/** Never let a key reach the log, whatever a provider put in its error message. */
const scrub = (message: string, key: string): string =>
  message.split(key).join('[key]').replace(/\b(sk|key|AIza)[-_A-Za-z0-9]{12,}/g, '[key]')

/** Tagging is opt-in: no key for the chosen provider, or the switch off, means no tag. */
export async function aiReady(): Promise<boolean> {
  const cfg = await aiConfig()
  return cfg.enabled && Boolean(cfg.key)
}

/**
 * Best effort by design. A bad key, an outage, a refusal or an answer nobody can
 * parse all mean "no tag" rather than an exception, because this runs while an
 * inbound message is being handled and must never cost you the message.
 */
export async function classifyReply(body: string): Promise<Classification | null> {
  if (!body.trim()) return null
  const cfg = await aiConfig()
  // Off means no provider call at all, not a call whose answer is discarded.
  if (!cfg.enabled || !cfg.key) return null

  try {
    const { text } = await generateText({
      model: languageModel(cfg.provider, cfg.key, cfg.model),
      instructions: cfg.prompt,
      prompt: body.slice(0, 2000),
      temperature: 0,
      // One word and a short clause. Anything longer is a model ignoring the prompt.
      maxOutputTokens: 64,
    })

    const interest = interestFrom(text)
    if (!interest) {
      console.warn(`[ai] ${cfg.provider} answered without a usable tag, so the reply stays untagged`)
      return null
    }
    return { interest, reason: text.trim().replace(/\s+/g, ' ').slice(0, 200) }
  } catch (e) {
    console.warn(`[ai] classify failed: ${scrub((e as Error).message ?? 'unknown error', cfg.key)}`)
    return null
  }
}
