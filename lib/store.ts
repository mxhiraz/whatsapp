'use client'

import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Draft state for the three long forms, kept in `localStorage`.
 *
 * Closing a dialog by accident, reloading, or wandering off to another section used
 * to throw away everything typed into it. Everything anyone types into the campaign
 * builder, the add-a-number dialog and the import dialog now lands here instead, and
 * is dropped only once that form has actually been submitted.
 *
 * Two things deliberately stay out:
 *
 * - **Secrets.** The dashboard password and the AI provider keys live in
 *   `components/settings-panel.tsx` and nowhere else. Neither is a draft worth
 *   keeping, and `localStorage` is readable by anything that can run a script on
 *   this page.
 * - **Server data.** Senders, lists, campaigns and replies stay in TanStack Query,
 *   which knows how to refetch and invalidate them. This store only holds what
 *   somebody has typed and not yet sent.
 */

/** One message in a sequence, with every wording of it. */
export interface CampaignStep {
  bodies: string[]
  delay_hours: number
}

export interface CampaignDraft {
  name: string
  list: string
  /** Empty means "this browser's zone", which the dialog resolves as it renders. */
  timezone: string
  steps: CampaignStep[]
  /** The sending settings, exactly as the create request takes them. */
  cfg: {
    min_delay_sec: number
    max_delay_sec: number
    start_hour: number
    end_hour: number
    skip_weekends: boolean
    cooldown_days: number
  }
  startNow: boolean
  sendOutsideHours: boolean
}

export interface NumberDraft {
  phone: string
  label: string
  /** Whether the limits and proxy block is open. */
  advanced: boolean
  caps: {
    max_per_day: number
    max_per_hour: number
    proxy_url: string
    warmup_growth: number
  }
}

export interface ImportDraft {
  list: string
  cc: string
  /**
   * One role per column, in column order: the mapping somebody corrected by hand.
   *
   * The parsed file, the preview and the row selection are deliberately NOT kept: a
   * CSV runs to megabytes, `localStorage` throws once the quota is gone, and none of
   * it means anything without the original file, which a browser cannot re-read on
   * its own. Only these three small settings are persisted.
   */
  roles: string[]
}

export interface Drafts {
  campaign: CampaignDraft
  number: NumberDraft
  import: ImportDraft
}

/**
 * Bump this whenever a field here changes shape. A stored draft from another version
 * is thrown away rather than half-converted, which is the whole point of versioning
 * something as disposable as a draft.
 */
const VERSION = 1

const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const count = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

const fields = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const texts = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : fallback

/** The dialog indexes `steps[0]` and `bodies[0]`, so there is always one of each. */
const steps = (v: unknown): CampaignStep[] => {
  const parsed = (Array.isArray(v) ? v : [])
    .map(step => ({
      bodies: texts(fields(step).bodies, ['']),
      delay_hours: count(fields(step).delay_hours, 24),
    }))
    .map(step => ({ ...step, bodies: step.bodies.length ? step.bodies : [''] }))
  return parsed.length ? parsed : [{ bodies: [''], delay_hours: 0 }]
}

/**
 * Rebuilds a valid set of drafts from whatever is actually in `localStorage`.
 *
 * Called on every read, so a value left behind by an older build, hand-edited in the
 * devtools, or written by something else under the same key can only ever produce
 * drafts the dialogs can render. Each field falls back on its own: a good campaign
 * name survives a broken sequence beside it. Passing nothing gives the empty drafts,
 * which makes this the one definition of what "no draft" means.
 */
export function sanitizeDrafts(persisted: unknown): Drafts {
  const all = fields(persisted)
  const campaign = fields(all.campaign)
  const cfg = fields(campaign.cfg)
  const number = fields(all.number)
  const caps = fields(number.caps)
  const imported = fields(all.import)
  return {
    campaign: {
      name: text(campaign.name),
      list: text(campaign.list),
      timezone: text(campaign.timezone),
      steps: steps(campaign.steps),
      cfg: {
        min_delay_sec: count(cfg.min_delay_sec, 90),
        max_delay_sec: count(cfg.max_delay_sec, 300),
        start_hour: count(cfg.start_hour, 9),
        end_hour: count(cfg.end_hour, 19),
        skip_weekends: flag(cfg.skip_weekends, true),
        cooldown_days: count(cfg.cooldown_days, 30),
      },
      startNow: flag(campaign.startNow, true),
      sendOutsideHours: flag(campaign.sendOutsideHours, false),
    },
    number: {
      phone: text(number.phone),
      label: text(number.label),
      advanced: flag(number.advanced, false),
      caps: {
        max_per_day: count(caps.max_per_day, 60),
        max_per_hour: count(caps.max_per_hour, 8),
        proxy_url: text(caps.proxy_url),
        warmup_growth: count(caps.warmup_growth, 1.3),
      },
    },
    import: {
      list: text(imported.list),
      cc: text(imported.cc, '91'),
      roles: texts(imported.roles, []),
    },
  }
}

/** No drafts at all: the server snapshot, and what a bad stored value falls back to. */
export const NO_DRAFTS: Drafts = sanitizeDrafts(undefined)

/**
 * What comes back out of storage, whatever is in there.
 *
 * Used as both `merge` (every read, including the version we recognise) and
 * `migrate` (a version we do not), so neither path can hand a dialog something that
 * throws on its first `.map`.
 */
export function readDrafts(persisted: unknown, version = VERSION): Drafts {
  return version === VERSION ? sanitizeDrafts(persisted) : NO_DRAFTS
}

export const draftStore = create<Drafts>()(
  persist(() => NO_DRAFTS, {
    name: 'wa-outreach-drafts',
    version: VERSION,
    // Both wrapped rather than passed by reference: `merge`'s second argument is the
    // current state, not a version number.
    merge: persisted => readDrafts(persisted),
    migrate: (persisted, version) => readDrafts(persisted, version),
    /*
      There is no `localStorage` on the server, and reading it before React has
      hydrated would make the first client render disagree with the server's HTML.
      The first subscription triggers the read instead (see `useDraft` below), which
      keeps both renders on the empty drafts and needs no setState in an effect.
    */
    skipHydration: true,
  }),
)

let hasRead = false

const subscribe = (onStoreChange: () => void) => {
  const unsubscribe = draftStore.subscribe(onStoreChange)
  if (!hasRead) {
    hasRead = true
    // Optional: a browser that refuses `localStorage` outright leaves the persist
    // API unbuilt, and drafts simply do not survive a reload there.
    void draftStore.persist?.rehydrate()
  }
  return unsubscribe
}

/**
 * Reads one draft.
 *
 * `useSyncExternalStore` rather than a plain hook because the subscription is what
 * loads the saved draft: the server and the first client render both see the empty
 * defaults, so there is no hydration mismatch, and the saved draft arrives on the
 * render straight after mount.
 */
export function useDraft<K extends keyof Drafts>(key: K): Drafts[K] {
  return useSyncExternalStore(
    subscribe,
    () => draftStore.getState()[key],
    () => NO_DRAFTS[key],
  )
}

/** Merges a change into one draft. */
export function setDraft<K extends keyof Drafts>(key: K, patch: Partial<Drafts[K]>): void {
  draftStore.setState(state => ({ [key]: { ...state[key], ...patch } }) as Pick<Drafts, K>)
}

/**
 * Drops a draft, which every form does once its submit actually succeeded. A stale
 * draft reappearing after a successful create is worse than losing one.
 */
export function clearDraft<K extends keyof Drafts>(key: K): void {
  draftStore.setState({ [key]: NO_DRAFTS[key] } as Pick<Drafts, K>)
}
