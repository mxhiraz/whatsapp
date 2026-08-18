'use client'

import { toast } from 'sonner'
import { Check, Plus, X } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { FieldLabel, Tip } from '@/components/shared'
import { api, useWrite, type ListRow } from '@/lib/client.ts'
import { clearDraft, setDraft, useDraft, type CampaignStep } from '@/lib/store.ts'

const BLANK: CampaignStep = { bodies: [''], delay_hours: 24 }

// A short list of common zones rather than every IANA name — plenty for picking "where my
// contacts are" without scrolling through hundreds of small Pacific islands. The browser's
// own zone is added on top so it is always offered, wherever the operator happens to be.
const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
]

const browserTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const TIMEZONES = [...new Set([browserTimezone(), ...COMMON_TIMEZONES])]

/** Formats an hour as a readable clock time for the send-window pickers. */
const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`

/**
 * The campaign builder, in a dialog rather than a permanent form. Creating a
 * campaign is a one-off task with a clear end — as a form sitting above the
 * table it pushed the campaigns you actually came to check off the screen.
 *
 * Everything in here is a draft in `lib/store.ts`, so closing the dialog by mistake,
 * reloading, or going to look at a list first does not throw the sequence away. The
 * draft is dropped only once the campaign has actually been created.
 */
export function CampaignDialog({
  open,
  onOpenChange,
  lists,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  lists: ListRow[]
}) {
  const draft = useDraft('campaign')
  const { name, list, steps, cfg, startNow, sendOutsideHours } = draft
  // Stored empty until it is chosen, so the default follows whichever browser the
  // dialog is opened in rather than the one that first saved a draft.
  const timezone = draft.timezone || browserTimezone()

  const edit = (patch: Partial<typeof draft>) => setDraft('campaign', patch)
  const setCfg = (next: typeof cfg) => edit({ cfg: next })
  const setSteps = (next: CampaignStep[]) => edit({ steps: next })

  /** Keeps the window valid by construction: the end hour can only be after the start. */
  const setStartHour = (h: number) =>
    setCfg({ ...cfg, start_hour: h, end_hour: Math.max(cfg.end_hour, h + 1) })

  const setBody = (si: number, bi: number, value: string) =>
    setSteps(steps.map((s, i) => (i === si ? { ...s, bodies: s.bodies.map((b, j) => (j === bi ? value : b)) } : s)))

  const create = useWrite(
    async () => {
      const res = await api<{ id: number; warnings: string[] }>('/campaigns', {
        body: { name, list, steps, timezone, ignore_send_window: sendOutsideHours, ...cfg },
      })
      if (startNow) await api(`/campaigns/${res.id}`, { method: 'PATCH', body: { action: 'start' } })
      return res
    },
    {
      invalidate: ['/campaigns'],
      onSuccess: res => {
        toast.success(
          `${startNow ? 'Campaign started' : 'Campaign saved as a draft'}${res.warnings.length ? `. ${res.warnings[0]}` : ''}`,
        )
        clearDraft('campaign')
        onOpenChange(false)
      },
    },
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>
            If someone replies, the rest of their follow-ups are cancelled automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto pr-3">
          <div className="space-y-4">
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5 sm:col-span-2">
                <FieldLabel htmlFor="campaign-name">Campaign name</FieldLabel>
                <Input
                  id="campaign-name"
                  value={name}
                  placeholder="Q3 founders outreach"
                  onChange={e => edit({ name: e.target.value })}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel>Send to</FieldLabel>
                <Select value={list} onValueChange={v => edit({ list: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a list" />
                  </SelectTrigger>
                  <SelectContent>
                    {lists.map(l => (
                      <SelectItem key={l.list} value={l.list}>
                        {l.list} · {l.total} contacts
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel tooltip="Send hours below are read in this timezone: your contacts', not your computer's.">
                  Contacts&apos; timezone
                </FieldLabel>
                <Select value={timezone} onValueChange={v => edit({ timezone: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map(tz => (
                      <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>

            {steps.map((step, si) => (
              <div key={si} className="rounded-md border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <span className="text-sm font-medium">{si === 0 ? 'First message' : `Follow-up ${si}`}</span>
                  {si === 0 ? (
                    <span className="text-muted-foreground text-xs">goes out first</span>
                  ) : (
                    <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                      wait
                      <Input
                        type="number"
                        value={step.delay_hours}
                        aria-label="Hours to wait before this follow-up"
                        className="h-7 w-20 tabular-nums"
                        onChange={e =>
                          setSteps(steps.map((s, i) => (i === si ? { ...s, delay_hours: Number(e.target.value) } : s)))
                        }
                      />
                      hours if they don’t reply
                    </span>
                  )}
                  {steps.length > 1 ? (
                    // Icon only, so `aria-label` carries the name. The confirmation is
                    // that the block disappears, which needs no hover text.
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Remove this message"
                      className="ml-auto text-red-600 dark:text-red-400"
                      onClick={() => setSteps(steps.filter((_, i) => i !== si))}
                    >
                      <X />
                    </Button>
                  ) : null}
                </div>

                {step.bodies.map((body, bi) => (
                  <div key={bi} className="mb-2">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">
                        version {String.fromCharCode(65 + bi)}
                      </span>
                      {step.bodies.length > 1 ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Remove this version"
                          className="h-7 px-2 text-red-600 sm:h-6 dark:text-red-400"
                          onClick={() =>
                            setSteps(steps.map((s, i) => (i === si ? { ...s, bodies: s.bodies.filter((_, j) => j !== bi) } : s)))
                          }
                        >
                          <X />
                        </Button>
                      ) : null}
                    </div>
                    <Textarea
                      value={body}
                      rows={3}
                      placeholder="{Hi|Hey} {{first_name}}, saw {{company}} is hiring. {Worth a chat?|Open to a quick chat?}"
                      onChange={e => setBody(si, bi, e.target.value)}
                      className="font-mono text-xs"
                    />
                  </div>
                ))}

                <Tip asChild tooltip="Adds another wording to rotate. We show you which one gets more replies.">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSteps(steps.map((s, i) => (i === si ? { ...s, bodies: [...s.bodies, ''] } : s)))}
                  >
                    <Plus /> Add another version
                  </Button>
                </Tip>
              </div>
            ))}

            <p className="text-muted-foreground text-xs">
              <code>{'{{tags}}'}</code> are swapped for that contact&apos;s details. <code>{'{Hi|Hey}'}</code> picks a random option each time.
            </p>

            <Button size="sm" variant="secondary" onClick={() => setSteps([...steps, { ...BLANK }])}>
              <Plus /> Add follow-up
            </Button>

            <Separator />

            {/*
              Two columns, never four: the labels here are sentences, and at a
              quarter of the dialog every one of them wrapped. The unit lives in
              the description under the control rather than beside the label, so
              the labels stay on one line and the controls line up in a grid.
            */}
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5">
                <FieldLabel tooltip="Randomizes the gap between sends. Identical intervals are an easy way to get flagged as a bot.">
                  Gap between messages
                </FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    className="tabular-nums"
                    value={cfg.min_delay_sec}
                    onChange={e => setCfg({ ...cfg, min_delay_sec: Number(e.target.value) })}
                  />
                  <span className="text-muted-foreground text-xs">to</span>
                  <Input
                    type="number"
                    className="tabular-nums"
                    value={cfg.max_delay_sec}
                    onChange={e => setCfg({ ...cfg, max_delay_sec: Number(e.target.value) })}
                  />
                </div>
                <FieldDescription className="text-xs">
                  Seconds. A random wait in this range between sends.
                </FieldDescription>
              </Field>

              <Field className="gap-1.5">
                <FieldLabel tooltip="Nothing goes out outside this window. Odd hours look like a bot.">
                  Send only between
                </FieldLabel>
                {/* Two dropdowns rather than free text, so an end hour before the start cannot be picked. */}
                <div className="flex items-center gap-2">
                  <Select value={String(cfg.start_hour)} onValueChange={v => setStartHour(Number(v))}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 23 }, (_, h) => (
                        <SelectItem key={h} value={String(h)}>{hourLabel(h)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground text-xs">to</span>
                  <Select value={String(cfg.end_hour)} onValueChange={v => setCfg({ ...cfg, end_hour: Number(v) })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 - cfg.start_hour }, (_, i) => cfg.start_hour + 1 + i).map(h => (
                        <SelectItem key={h} value={String(h)}>{hourLabel(h)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <FieldDescription className="text-xs">In your contacts&apos; timezone.</FieldDescription>
              </Field>

              <Field className="gap-1.5">
                <FieldLabel
                  htmlFor="cooldown"
                  tooltip="Once someone is messaged, no campaign will message them again until this many days pass."
                >
                  Wait before contacting again
                </FieldLabel>
                <Input
                  id="cooldown"
                  type="number"
                  className="tabular-nums"
                  value={cfg.cooldown_days}
                  onChange={e => setCfg({ ...cfg, cooldown_days: Number(e.target.value) })}
                />
                <FieldDescription className="text-xs">Days. Applies across all campaigns.</FieldDescription>
              </Field>

              <Field className="gap-1.5">
                <FieldLabel htmlFor="weekends" tooltip="Sending every day of the week looks less human.">
                  Weekdays only
                </FieldLabel>
                {/* Boxed to the height of an input so the switch sits on the same line as the field beside it. */}
                <div className="flex h-8 items-center">
                  <Switch
                    id="weekends"
                    checked={cfg.skip_weekends}
                    onCheckedChange={v => setCfg({ ...cfg, skip_weekends: v })}
                  />
                </div>
                <FieldDescription className="text-xs">Nothing goes out on Saturdays or Sundays.</FieldDescription>
              </Field>
            </FieldGroup>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <div className="flex items-center gap-2">
              <Switch checked={startNow} onCheckedChange={v => edit({ startNow: v })} id="start-now" />
              <Tip asChild tooltip="Queues the first message for everyone on the list as soon as the campaign is created.">
                <label
                  htmlFor="start-now"
                  className="decoration-muted-foreground/50 cursor-help text-xs underline decoration-dotted underline-offset-2"
                >
                  Start sending now
                </label>
              </Tip>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={sendOutsideHours} onCheckedChange={v => edit({ sendOutsideHours: v })} id="ignore-hours" />
              <Tip asChild tooltip="Sends whatever time it is, including nights and weekends. Messages at odd hours are one of the clearest bot signals there is, so leave this off unless you need a campaign out immediately.">
                <label
                  htmlFor="ignore-hours"
                  className="decoration-muted-foreground/50 cursor-help text-xs underline decoration-dotted underline-offset-2"
                >
                  Ignore send hours
                </label>
              </Tip>
            </div>
          </div>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !name.trim() || !list || !steps[0].bodies[0].trim()}
          >
            <Check />
            {create.isPending ? 'Creating…' : startNow ? 'Create and start' : 'Create campaign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
