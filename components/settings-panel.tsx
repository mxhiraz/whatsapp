'use client'

import { useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useTheme } from 'next-themes'
import { Desktop, DownloadSimple, Moon, Sun, Warning } from '@phosphor-icons/react/dist/ssr'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel as ControlLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ConfirmButton } from '@/components/confirm'
import { Empty, FieldLabel, Tip } from '@/components/shared'
import { api, usePoll, useWrite, type DashboardState, type InstallSettings } from '@/lib/client.ts'

const DASH = '–'

type Ranges = InstallSettings['ranges']
type LimitKey = keyof Ranges
type Policy = InstallSettings['policy']

/**
 * One editable sending limit.
 *
 * `scale` and `offset` translate between what the operator types and what is
 * stored: rates are typed as whole percents, and the warmup ramp is typed as "how
 * much it grows" rather than the 1.3 multiplier the engine uses.
 */
interface Limit {
  key: LimitKey
  /** A second box, for the limits that are a range. */
  second?: LimitKey
  label: string
  unit: string
  /**
   * Printed under the control. There is deliberately no tooltip beside it: every
   * one of these fields used to carry the same sentence twice, once on hover and
   * once on the page, and the one on the page is the one people read.
   */
  description: string
  scale: number
  offset: number
}

const LIMIT_FIELDS: Limit[] = [
  {
    key: 'warmupStartPerDay',
    label: 'New numbers start at',
    unit: 'a day',
    scale: 1,
    offset: 0,
    description: 'A brand new number sends only this many messages on its first day.',
  },
  {
    key: 'warmupGrowth',
    label: 'Grows each day by',
    unit: '% a day',
    scale: 100,
    offset: 1,
    description: 'How much the daily allowance rises per day while a number warms up. Zero keeps it flat.',
  },
  {
    key: 'hardMaxPerDay',
    label: 'Never more than',
    unit: 'a day',
    scale: 1,
    offset: 0,
    description: 'The hard ceiling for one number in a day, however long it has been warming up.',
  },
  {
    key: 'breakEveryMin',
    second: 'breakEveryMax',
    label: 'Rest after',
    unit: 'messages',
    scale: 1,
    offset: 0,
    description: 'The number stops for 20 to 55 minutes somewhere in this range of sends, so its pace is not a metronome.',
  },
  {
    key: 'replyRatePause',
    label: 'Pause if replies below',
    unit: '%',
    scale: 100,
    offset: 0,
    description: 'Almost nobody answering is the first sign of trouble, so the number stops for two days.',
  },
  {
    key: 'deliveryFloor',
    label: 'Pause if delivery below',
    unit: '%',
    scale: 100,
    offset: 0,
    description: 'Messages not reaching phones is the second sign, so the number stops for two days.',
  },
]

/** Where each editable limit lives on a resolved policy. */
const READ: Record<LimitKey, (p: Policy) => number> = {
  warmupStartPerDay: p => p.warmupStartPerDay,
  warmupGrowth: p => p.warmupGrowth,
  hardMaxPerDay: p => p.hardMaxPerDay,
  breakEveryMin: p => p.breakEvery[0],
  breakEveryMax: p => p.breakEvery[1],
  replyRatePause: p => p.replyRatePause,
  deliveryFloor: p => p.deliveryFloor,
}

const show = (f: Limit, value: number): number => Math.round((value - f.offset) * f.scale * 100) / 100
const store = (f: Limit, typed: string): number => f.offset + Number(typed) / f.scale

/** Both boxes of a range share one field definition, so scales stay in step. */
const FIELD_OF = Object.fromEntries(
  LIMIT_FIELDS.flatMap(f => (f.second ? [[f.key, f], [f.second, f]] : [[f.key, f]])),
) as Record<LimitKey, Limit>

/** Where to create a key, per provider. Linked from the key field. */
const KEY_CONSOLES: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  openai: 'https://platform.openai.com/api-keys',
}

const THEMES = [
  { key: 'system', label: 'System', icon: Desktop },
  { key: 'light', label: 'Light', icon: Sun },
  { key: 'dark', label: 'Dark', icon: Moon },
] as const

/**
 * One settings PATCH: which field is saving, what to send, what to say afterwards.
 *
 * `what` is only there so the right button can read "Saving…" while the others stay
 * enabled; the card has four independent saves and one endpoint.
 */
interface SettingsWrite {
  what: '' | 'key' | 'model' | 'prompt'
  body: unknown
  done?: string
  after?: () => void
}

function useSettingsWrite() {
  return useWrite((vars: SettingsWrite) => api('/settings', { method: 'PATCH', body: vars.body }), {
    invalidate: ['/settings'],
    onSuccess: (_data, vars) => {
      if (vars.done) toast.success(vars.done)
      vars.after?.()
    },
  })
}

type SettingsSave = ReturnType<typeof useSettingsWrite>

/** One label and one number. `tooltip` is only for a count whose scope is not obvious. */
function Row({ label, tooltip, value }: { label: string; tooltip?: string; value: string | number }) {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground w-full whitespace-normal">
        {tooltip ? <Tip tooltip={tooltip}>{label}</Tip> : label}
      </TableCell>
      <TableCell className="text-right tabular-nums">{value}</TableCell>
    </TableRow>
  )
}

export function SettingsPanel({ state }: { state: DashboardState }) {
  const { theme, setTheme } = useTheme()
  // next-themes only knows the real theme after mount, so render the toggle
  // once mounted to avoid a server/client mismatch (same pattern as use-mobile.ts).
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )
  const { data: settings } = usePoll<InstallSettings>('/settings', 15000)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="tracking-tighter">Appearance</CardTitle>
          <CardDescription>Pick how the dashboard looks on this device.</CardDescription>
        </CardHeader>
        <CardContent>
          {mounted ? (
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={theme}
              onValueChange={v => v && setTheme(v)}
            >
              {THEMES.map(t => (
                <ToggleGroupItem key={t.key} value={t.key}>
                  <t.icon weight="duotone" /> {t.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <Skeleton className="h-9 w-64" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="tracking-tighter">Sending limits</CardTitle>
          <CardDescription>
            Enforced on every number, on its own. The defaults are deliberately cautious for messaging strangers.
            Raising them is your call and your risk: WhatsApp bans accounts for it, and nothing here can appeal that.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {settings ? <LimitsForm settings={settings} /> : <Skeleton className="h-64 w-full" />}
        </CardContent>
      </Card>

      <AiTaggingCard settings={settings} />

      <Card>
        <CardHeader>
          <CardTitle className="tracking-tighter">This install</CardTitle>
          <CardDescription>What this copy of the app is holding right now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <Row label="Linked numbers" value={state.senders.length} />
              <Row
                label="Contacts across all lists"
                tooltip="Every contact you have imported, counted once per list."
                value={state.lists.reduce((a, l) => a + l.total, 0)}
              />
              <Row label="Campaigns" value={state.campaigns.length} />
              <Row
                label="Contacts opted out"
                tooltip="People on the never-contact list. They are never messaged again."
                value={state.blocked}
              />
              <Row label="Dashboard password" value={settings ? (settings.auth_enabled ? 'Set' : 'Not set') : DASH} />
            </TableBody>
          </Table>

          {settings && !settings.auth_enabled ? (
            <Alert variant="destructive">
              <Warning weight="duotone" />
              <AlertTitle>This dashboard has no password</AlertTitle>
              <AlertDescription>
                Anyone with the link can send messages from your numbers. Set one below to add a login.
              </AlertDescription>
            </Alert>
          ) : null}

          <PasswordField settings={settings} />
        </CardContent>
      </Card>

      <ExportCard state={state} />

      <NeverContactCard />
    </div>
  )
}

/**
 * The editable limits.
 *
 * Mounted only once the settings have arrived, so the boxes are seeded from real
 * values on the first render and a background poll can never overwrite something
 * half-typed. Every value is clamped again on the server, and what comes back is
 * what the boxes then show.
 */
function LimitsForm({ settings }: { settings: InstallSettings }) {
  const seed = (policy: Policy) =>
    Object.fromEntries(
      (Object.keys(FIELD_OF) as LimitKey[]).map(k => [k, String(show(FIELD_OF[k], READ[k](policy)))]),
    ) as Record<LimitKey, string>

  const [values, setValues] = useState(() => seed(settings.policy))

  // `undefined` means "whatever is in the boxes"; `{}` is the reset, which asks the
  // server for its own defaults back.
  const save = useWrite(
    (limits: Record<string, number> | undefined) => {
      const edited =
        limits ??
        Object.fromEntries(
          (Object.keys(values) as LimitKey[])
            .filter(k => values[k].trim() !== '')
            .map(k => [k, store(FIELD_OF[k], values[k])]),
        )
      return api<{ policy: Policy }>('/settings', { method: 'PATCH', body: { limits: edited } })
    },
    {
      invalidate: ['/settings'],
      onSuccess: saved => {
        // The server clamps, so the boxes end up showing what it actually kept.
        setValues(seed(saved.policy))
        toast.success('Sending limits saved')
      },
    },
  )
  const busy = save.isPending

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {LIMIT_FIELDS.map(f => {
          const range = settings.ranges[f.key]
          const def = show(f, READ[f.key](settings.defaults))
          const hint = f.second ? `default ${def} to ${show(f, READ[f.second](settings.defaults))}` : `default ${def}`
          const raised = f.key === 'hardMaxPerDay' && Number(values.hardMaxPerDay) > def
          return (
            <Field key={f.key}>
              <FieldLabel hint={hint} htmlFor={f.key}>
                {f.label}
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id={f.key}
                  type="number"
                  min={show(f, range.min)}
                  max={show(f, range.max)}
                  step={1}
                  value={values[f.key]}
                  onChange={e => setValues({ ...values, [f.key]: e.target.value })}
                  className="w-20 tabular-nums"
                />
                {f.second ? (
                  <>
                    <span className="text-muted-foreground text-xs">to</span>
                    <Input
                      type="number"
                      aria-label={`${f.label}, at most`}
                      min={show(f, settings.ranges[f.second].min)}
                      max={show(f, settings.ranges[f.second].max)}
                      step={1}
                      value={values[f.second]}
                      onChange={e => setValues({ ...values, [f.second!]: e.target.value })}
                      className="w-20 tabular-nums"
                    />
                  </>
                ) : null}
                <span className="text-muted-foreground text-xs">{f.unit}</span>
              </div>
              <FieldDescription className="text-xs">
                {f.description}
                {raised
                  ? ` You have raised this above ${def}. It is the last thing stopping a number from sending itself into a ban.`
                  : ''}
              </FieldDescription>
            </Field>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => save.mutate(undefined)}>
          {busy ? 'Saving…' : 'Save limits'}
        </Button>
        <ConfirmButton
          variant="outline"
          size="sm"
          destructive
          disabled={busy}
          title="Reset the sending limits?"
          description="Every limit goes back to the cautious default that ships with the app. Anything you have changed here is lost."
          confirmLabel="Reset them"
          onConfirm={() => save.mutateAsync({})}
        >
          Reset to defaults
        </ConfirmButton>
      </div>
    </div>
  )
}

/**
 * Reply tagging: which model does it, with which key, and on what instructions.
 *
 * The provider toggle saves immediately (with that provider's default model), so the
 * key box, the switch and the warnings always describe what is actually in force
 * rather than an unsaved selection.
 */
function AiTaggingCard({ settings }: { settings: InstallSettings | null }) {
  const [key, setKey] = useState('')
  const save = useSettingsWrite()
  // Only the field actually being saved says so; the rest of the card stays usable.
  const busy = save.isPending ? (save.variables?.what ?? '') : ''

  if (!settings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="tracking-tighter">Automatic reply tagging</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    )
  }

  const provider = settings.ai_providers[settings.ai_provider]
  const keyState = settings.ai_keys[settings.ai_provider]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="tracking-tighter">Automatic reply tagging</CardTitle>
        <CardDescription>
          A model reads each reply and tags it as interested, meeting booked, or not interested. You choose which
          model, and you pay for it with your own key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={settings.ai_provider}
          onValueChange={v =>
            v && v !== settings.ai_provider
              ? save.mutate({
                  what: 'model',
                  body: { ai: { provider: v, model: '' } },
                  done: `Tagging switched to ${settings.ai_providers[v as keyof typeof settings.ai_providers].label}`,
                })
              : undefined
          }
        >
          {(Object.keys(settings.ai_providers) as (keyof typeof settings.ai_providers)[]).map(p => (
            <Tip
              asChild
              key={p}
              tooltip={`Tag replies with ${settings.ai_providers[p].label}, using the key you save below.`}
            >
              <ToggleGroupItem value={p}>{settings.ai_providers[p].label}</ToggleGroupItem>
            </Tip>
          ))}
        </ToggleGroup>

        <Field orientation="horizontal">
          <Switch
            checked={settings.ai_enabled}
            disabled={!settings.ai_available}
            onCheckedChange={checked => save.mutate({ what: '', body: { ai_enabled: checked } })}
            id="ai-tagging"
          />
          <Tip
            asChild
            tooltip={`Uses ${settings.ai_model} through ${provider.label}. A tag you set by hand is never changed.`}
          >
            <ControlLabel htmlFor="ai-tagging">Tag replies automatically</ControlLabel>
          </Tip>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel
              hint={keyState.hint ?? undefined}
              tooltip={`Your ${provider.label} key. It is what pays for the tagging.`}
              htmlFor="ai-key"
            >
              {provider.label} API key
            </FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="ai-key"
                type="password"
                autoComplete="off"
                value={key}
                placeholder={keyState.hint ? 'Replace the saved key' : 'Paste your key'}
                onChange={e => setKey(e.target.value)}
                className="min-w-40 flex-1 font-mono text-xs"
              />
              <Button
                size="default"
                disabled={Boolean(busy) || !key.trim()}
                onClick={() =>
                  save.mutate({
                    what: 'key',
                    body: { api_key: { provider: settings.ai_provider, key: key.trim() } },
                    done: 'Key saved',
                    after: () => setKey(''),
                  })
                }
              >
                {busy === 'key' ? 'Saving…' : 'Save key'}
              </Button>
              {keyState.stored ? (
                <ConfirmButton
                  variant="outline"
                  size="default"
                  destructive
                  disabled={Boolean(busy)}
                  title={`Remove the ${provider.label} key?`}
                  description="Tagging stops until you save another key. Tags already on your replies stay as they are."
                  confirmLabel="Remove it"
                  onConfirm={() =>
                    save.mutateAsync({
                      what: 'key',
                      body: { api_key: { provider: settings.ai_provider, key: null } },
                      done: 'Key removed',
                    })
                  }
                >
                  Remove key
                </ConfirmButton>
              ) : null}
            </div>
            <FieldDescription className="text-xs">
              Kept in the database of this install and never shown again, only the last few characters. Saving one
              turns tagging on right away, with no restart.{' '}
              <a href={KEY_CONSOLES[settings.ai_provider]} target="_blank" rel="noreferrer noopener">
                Get a {provider.label} key
              </a>
              .
            </FieldDescription>
          </Field>

          {/* Keyed on the provider: switching it re-seeds the box with that
              provider's own model rather than leaving the previous one behind. */}
          <ModelField key={settings.ai_provider} settings={settings} busy={busy} save={save} />
        </div>

        <PromptField settings={settings} busy={busy} save={save} />

        {!settings.ai_available ? (
          <Alert>
            <Warning weight="duotone" />
            <AlertTitle>No {provider.label} key yet</AlertTitle>
            <AlertDescription>
              Tagging stays off until this install has one. Paste a key above, or put it in a{' '}
              <code>{provider.env}</code> environment variable. Everything else in the app works without it.
            </AlertDescription>
          </Alert>
        ) : null}

        {!settings.ai_prompt_ok ? (
          <Alert>
            <Warning weight="duotone" />
            <AlertTitle>These instructions may not produce a tag</AlertTitle>
            <AlertDescription>
              The text below no longer asks for all four tags (meeting, positive, neutral, negative), so replies can
              come back with nothing this app understands and stay untagged.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** Free text, because a model released tomorrow should work without a code change. */
function ModelField({ settings, busy, save }: { settings: InstallSettings; busy: string; save: SettingsSave }) {
  const [model, setModel] = useState(settings.ai_model)
  const suggestions = settings.ai_providers[settings.ai_provider].models

  return (
    <Field>
      <FieldLabel
        hint={`default ${settings.ai_providers[settings.ai_provider].model}`}
        tooltip="The model id to ask for. Any chat model that takes text and answers with text will do."
        htmlFor="ai-model"
      >
        Model
      </FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        {/* A native datalist: suggestions without giving up free text. */}
        <Input
          id="ai-model"
          list="ai-model-options"
          value={model}
          onChange={e => setModel(e.target.value)}
          className="min-w-40 flex-1 font-mono text-xs"
        />
        <datalist id="ai-model-options">
          {suggestions.map(m => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Button
          size="default"
          disabled={Boolean(busy) || !model.trim() || model.trim() === settings.ai_model}
          onClick={() => save.mutate({ what: 'model', body: { ai: { model: model.trim() } }, done: 'Model saved' })}
        >
          {busy === 'model' ? 'Saving…' : 'Save model'}
        </Button>
      </div>
      <FieldDescription className="text-xs">
        Suggestions: {suggestions.join(', ')}. Anything else you type is used as it is. Tagging is plain text in and
        plain text out, so vision, audio and structured-output models buy you nothing here.
      </FieldDescription>
    </Field>
  )
}

/** The actual instructions, on the page rather than buried in the source. */
function PromptField({ settings, busy, save }: { settings: InstallSettings; busy: string; save: SettingsSave }) {
  const [prompt, setPrompt] = useState(settings.ai_prompt)

  return (
    <Field>
      <FieldLabel
        tooltip="Sent with every reply. The first tag named in the answer is the one that gets used."
        htmlFor="ai-prompt"
      >
        Tagging instructions
      </FieldLabel>
      <Textarea
        id="ai-prompt"
        rows={10}
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        className="text-xs"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={Boolean(busy) || prompt.trim() === settings.ai_prompt.trim()}
          onClick={() => save.mutate({ what: 'prompt', body: { ai: { prompt } }, done: 'Instructions saved' })}
        >
          {busy === 'prompt' ? 'Saving…' : 'Save instructions'}
        </Button>
        <ConfirmButton
          variant="outline"
          size="sm"
          destructive
          disabled={Boolean(busy)}
          title="Reset the tagging instructions?"
          description="The text goes back to the wording the app ships with. Anything you have written here is lost."
          confirmLabel="Reset them"
          onConfirm={() =>
            save.mutateAsync({
              what: 'prompt',
              body: { ai: { prompt: '' } },
              done: 'Instructions reset',
              after: () => setPrompt(settings.ai_prompt_default),
            })
          }
        >
          Reset to default
        </ConfirmButton>
      </div>
      <FieldDescription className="text-xs">
        Keep asking for one of meeting, positive, neutral or negative: those are the only tags the inbox understands.
        A reply the model answers with anything else is left untagged rather than guessed at.
      </FieldDescription>
    </Field>
  )
}

/**
 * The dashboard login.
 *
 * The password is sent once, hashed on the server and never sent back. Saving a new
 * one re-signs this session on the way out, so changing it cannot lock out the tab
 * that changed it.
 */
function PasswordField({ settings }: { settings: InstallSettings | null }) {
  // Deliberately not a draft in lib/store.ts: a password has no business in
  // localStorage, and it is one field rather than a form worth rescuing.
  const [password, setPassword] = useState('')

  const save = useWrite((value: string | null) => api('/settings', { method: 'PATCH', body: { password: value } }), {
    invalidate: ['/settings'],
    onSuccess: (_data, value) => {
      setPassword('')
      toast.success(value === null ? 'Password removed' : 'Password saved')
    },
  })
  const busy = save.isPending

  return (
    <Field>
      <FieldLabel
        tooltip="Asked for once per device, then remembered for 30 days."
        htmlFor="app-password"
      >
        Dashboard password
      </FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="app-password"
          type="password"
          autoComplete="new-password"
          value={password}
          placeholder={settings?.auth_enabled ? 'Replace the current password' : 'At least 8 characters'}
          onChange={e => setPassword(e.target.value)}
          className="min-w-56 flex-1"
        />
        <Button size="default" disabled={busy || password.trim().length < 8} onClick={() => save.mutate(password)}>
          {busy ? 'Saving…' : 'Save password'}
        </Button>
        {settings?.auth_stored ? (
          <ConfirmButton
            variant="outline"
            size="default"
            destructive
            disabled={busy}
            title="Remove the dashboard password?"
            description={
              settings.auth_env
                ? 'The login falls back to the APP_PASSWORD set in the app environment. Everyone signed in stays signed in.'
                : 'The dashboard becomes open to anyone with the link, and they can send messages from your numbers.'
            }
            confirmLabel="Remove it"
            onConfirm={() => save.mutateAsync(null)}
          >
            Remove password
          </ConfirmButton>
        ) : null}
      </div>
      <FieldDescription className="text-xs">
        Stored scrambled, so nobody can read it back out of the database, not even this app.
        {settings?.auth_env && !settings.auth_stored
          ? ' This install currently uses the password from its environment. Saving one here replaces it.'
          : ' You stay signed in on this device.'}
      </FieldDescription>
    </Field>
  )
}

/** CSV download, per list. A campaign's messages export from the campaign page. */
function ExportCard({ state }: { state: DashboardState }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="tracking-tighter">Download your data</CardTitle>
        <CardDescription>
          A spreadsheet file (CSV) of one list with every contact and what happened to them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.lists.length ? (
          <div className="flex flex-wrap gap-2">
            {state.lists.map(l => (
              <Button key={l.list} asChild variant="outline" size="sm">
                <a href={`/api/export?list=${encodeURIComponent(l.list)}`}>
                  <DownloadSimple weight="duotone" /> {l.list}
                  <span className="text-muted-foreground tabular-nums">
                    {l.total} {l.total === 1 ? 'contact' : 'contacts'}
                  </span>
                </a>
              </Button>
            ))}
          </div>
        ) : (
          <Empty>Import a list of contacts and it shows up here.</Empty>
        )}
      </CardContent>
    </Card>
  )
}

/** Moved here from the leads panel: this is a global suppression list, not part of importing. */
function NeverContactCard() {
  const [cc, setCc] = useState('91')
  const [value, setValue] = useState('')
  const count = value.split(/[\s,]+/).filter(Boolean).length

  // Blocking removes the numbers from every list, so the per-list counts move too.
  const block = useWrite(() => api<{ added: number }>('/blocklist', { body: { phones: value, cc } }), {
    invalidate: ['/leads'],
    onSuccess: r => {
      toast.success(`${r.added} blocked`)
      setValue('')
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="tracking-tighter">Never contact these</CardTitle>
        <CardDescription>
          Anyone who replies “stop” lands here automatically and is removed from every list. You can also add numbers
          by hand.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field>
          <FieldLabel tooltip="These numbers are skipped by every campaign, now and later.">Numbers to block</FieldLabel>
          {/* A textarea, because the usual gesture here is pasting a column of
              numbers out of a spreadsheet. */}
          <div className="flex flex-wrap items-end gap-2">
            <Textarea
              value={value}
              rows={2}
              placeholder="Paste numbers, separated by commas, spaces or new lines"
              onChange={e => setValue(e.target.value)}
              className="min-w-48 flex-1 font-mono text-xs"
            />
            <Tip tooltip="Country code, added to any 10-digit number you paste." asChild>
              <Input
                value={cc}
                inputMode="tel"
                onChange={e => setCc(e.target.value)}
                aria-label="Country code"
                className="w-16 font-mono text-xs tabular-nums"
              />
            </Tip>
            <ConfirmButton
              variant="secondary"
              size="default"
              disabled={!count}
              title="Block these numbers?"
              description={`Blocking ${count} ${count === 1 ? 'number' : 'numbers'} is permanent and removes them from every list.`}
              confirmLabel="Block them"
              onConfirm={() => block.mutateAsync()}
            >
              Block
            </ConfirmButton>
          </div>
          <FieldDescription className="text-xs">Blocking cannot be undone from the dashboard.</FieldDescription>
        </Field>
      </CardContent>
    </Card>
  )
}
