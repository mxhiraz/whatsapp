'use client'

import { useCallback } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { Campaign, Lead, SenderHealth, Step } from './db.ts'
import type { LIMITS, POLICY, Policy } from './safety.ts'
import type { AI_PROVIDERS, KeyState, Provider } from './settings.ts'

export interface ListRow {
  list: string
  total: number
  replied: number
  opted_out: number
  invalid: number
  contacted: number
}

export interface CampaignRow extends Campaign {
  step_count: number
  leads: number
  sent: number
  pending: number
  failed: number
  skipped: number
  delivered: number
  read: number
  replied: number
  /** Set when the campaign is running with due messages it cannot send yet. */
  blocked_reason: string | null
}

export interface ReplyRow {
  id: number
  sender_phone: string
  lead_phone: string
  body: string | null
  received_at: string
  name: string | null
  list: string | null
}

/**
 * Shape of GET /api/settings. The API key and the password are represented only by
 * whether they are set and, for the key, a masked hint: neither value is ever sent
 * to the browser.
 */
export interface InstallSettings {
  ai_enabled: boolean
  /** The chosen provider has a usable key, so tagging can run. */
  ai_available: boolean
  ai_provider: Provider
  ai_model: string
  /** The instructions in force, which is the default unless one has been saved. */
  ai_prompt: string
  ai_prompt_default: string
  /** False when the saved prompt no longer names every tag. A warning, not an error. */
  ai_prompt_ok: boolean
  /** Per provider: a masked hint plus where the key came from. Never the key. */
  ai_keys: Record<Provider, KeyState>
  ai_providers: typeof AI_PROVIDERS
  auth_enabled: boolean
  auth_stored: boolean
  /** An APP_PASSWORD is set in the environment, which the dashboard cannot remove. */
  auth_env: boolean
  /** Sending limits in force: the defaults with the operator's overrides applied. */
  policy: Policy
  defaults: typeof POLICY
  ranges: typeof LIMITS
}

export interface ColumnGuess {
  index: number
  header: string
  samples: string[]
  role: string
  phoneScore: number
}

export interface ParsedContact {
  phone: string
  name: string | null
  vars: Record<string, string>
}

/** What the import screen shows before anything is written. */
export interface ImportPreview {
  hasHeader: boolean
  rows: number
  delimiter: string
  columns: ColumnGuess[]
  valid: number
  duplicates: number
  bad: { line: number; raw: string; reason: string }[]
  badCount: number
  sample: ParsedContact[]
  /** Every parsed row, so the import dialog can offer a per-row choice. */
  contacts: ParsedContact[]
  /** True when the file had more rows than the picker will handle. */
  truncated: boolean
  in_list: number
  in_other_list: number
  blocked: number
}

export interface DayPoint {
  date: string
  sent: number
  replies: number
}

export interface DashboardState {
  senders: SenderHealth[]
  lists: ListRow[]
  campaigns: CampaignRow[]
  replies: ReplyRow[]
  blocked: number
  policy: typeof POLICY
  series: DayPoint[]
  log: { at: string; msg: string; level: 'info' | 'warn' }[]
}

export interface MessageRow {
  id: number
  step_no: number
  variant: number
  status: string
  body: string | null
  scheduled_at: string
  sent_at: string | null
  delivered_at: string | null
  read_at: string | null
  error: string | null
  phone: string
  name: string | null
  lead_status: string
  sent_from: string | null
}

export interface VariantRow {
  step_no: number
  variant: number
  sent: number
  delivered: number
  read: number
  replied: number
}

export interface CampaignDetail {
  campaign: Campaign
  steps: Step[]
  variants: VariantRow[]
  messages: MessageRow[]
}

export type Interest = 'unset' | 'positive' | 'neutral' | 'negative' | 'meeting'

export interface ThreadRow {
  lead_phone: string
  name: string | null
  list: string | null
  last_at: string
  last_body: string | null
  unread: number
  lead_status: string | null
  interest: Interest | null
  note: string | null
  blocked: boolean
}

export interface ChatLine {
  dir: 'in' | 'out'
  body: string | null
  at: string
  via: string | null
  seen_at: string | null
}

export type { Lead, SenderHealth }

/** Every call goes through here so errors surface as thrown messages, not silent 400s. */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText)
  return data as T
}

/**
 * Polls an endpoint and exposes a manual refresh, backed by TanStack Query.
 *
 * The cache is what makes this cheap: two components asking for the same endpoint
 * share one request, a revisited tab renders instantly from cache while it
 * refetches behind the scenes, and `refresh()` is an invalidation rather than
 * another fetch — so a write updates every view that reads the same data.
 */
export function usePoll<T>(path: string, intervalMs = 5000): { data: T | null; refresh: () => void } {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: [path],
    queryFn: () => api<T>(path),
    refetchInterval: intervalMs,
    /*
     * Keep showing the previous response while a new one is in flight.
     *
     * The path is part of the query key, so changing an inbox filter or typing in a
     * search box starts a *different* query with no data of its own. Without this,
     * `data` went null for one render, which blanked the panel back to its skeleton
     * or its empty state and then filled in again. On a screen that also polls every
     * few seconds, that reads as the content constantly redrawing itself.
     */
    placeholderData: keepPreviousData,
  })
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [path] })
  }, [queryClient, path])
  return { data: data ?? null, refresh }
}

/**
 * Matches every cached query whose path starts with one of these prefixes.
 *
 * Query keys here are the request path, sometimes with its own query string
 * (`/inbox?filter=unread&q=`) and sometimes with extra parts (`['/leads', list, q]`),
 * so an exact-key match would miss most of them. `/inbox` covers every inbox view and
 * `/campaigns` covers every campaign's detail page.
 */
const touching = (paths: string[]) => ({
  predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    paths.some(path => typeof queryKey[0] === 'string' && queryKey[0].startsWith(path)),
})

/**
 * A write: the request, the cache invalidation it implies, and the error toast.
 *
 * Reads poll through `usePoll`; every write goes through here, so no call site keeps
 * its own `busy` flag (use the returned `isPending` for the button label) or its own
 * `try/catch` (a failure is reported once, from here). `/state` is invalidated by
 * every write because the dashboard summary is derived from everything; `invalidate`
 * names the extra paths this particular write touches.
 *
 * `mutate` swallows a failure once it has been reported. `mutateAsync` re-throws it,
 * which is how a dialog knows to stay open instead of closing over a failed write.
 */
export function useWrite<TVars = void, TData = unknown>(
  send: (vars: TVars) => Promise<TData>,
  options: {
    invalidate?: string[]
    onSuccess?: (data: TData, vars: TVars) => void
    /**
     * Applies a guess before the server has answered, and returns the undo for it,
     * which runs if the write fails. Only for a guess that is harmless and obviously
     * reversible: never for sending, importing or deleting.
     */
    optimistic?: (vars: TVars) => () => void
  } = {},
) {
  const queryClient = useQueryClient()
  const { invalidate, onSuccess, optimistic } = options
  const paths = ['/state', ...(invalidate ?? [])]
  return useMutation<TData, Error, TVars, (() => void) | undefined>({
    mutationFn: send,
    onMutate: optimistic
      ? async vars => {
          // Without this an in-flight poll can land on top of the guess.
          await queryClient.cancelQueries(touching(paths))
          return optimistic(vars)
        }
      : undefined,
    onSuccess,
    onError: (error, _vars, undo) => {
      undo?.()
      toast.error(error.message)
    },
    // Deliberately not awaited: `isPending` should track the request, not the
    // refetches that follow it, or every button would stay busy until they land.
    onSettled: () => void queryClient.invalidateQueries(touching(paths)),
  })
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '–'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (Math.abs(mins) < 1) return 'now'
  if (mins < 0) {
    const m = -mins
    return m < 60 ? `in ${m}m` : m < 1440 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 1440)}d`
  }
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

export const pct = (n: number): string => `${Math.round(n * 100)}%`
export const phone = (p: string | null | undefined): string => (p ? `+${p}` : '–')
