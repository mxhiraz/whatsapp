'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { createColumnHelper } from '@tanstack/react-table'
import {
  ArrowsClockwise,
  Check,
  DeviceMobile,
  DotsThree,
  PaperPlaneRight,
  Pause,
  Play,
  Plus,
  QrCode,
  SlidersHorizontal,
  Trash,
  Warning,
} from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmButton, menuItemClass } from '@/components/confirm'
import { DataTable, PlainHeader, SortableHeader } from '@/components/data-table/data-table'
import { type TableFeatures } from '@/components/data-table/features'
import { Pill, Tip } from '@/components/shared'
import { api, pct, useWrite, type DashboardState, type SenderHealth } from '@/lib/client.ts'
import type { Risk } from '@/lib/safety.ts'
import { clearDraft, setDraft, useDraft } from '@/lib/store.ts'

// The two supported ramp speeds, in the `warmup_growth` daily multiplier the API
// expects. That request field is part of the API contract, so it keeps its name
// even though nothing user-facing says "warmup" any more: 1.3 reaches the ceiling
// in about a week, 1.12 in about three (see app/api/senders/[phone]/route.ts).
/** Shown where a number has no nickname. */
const DASH = '–'

const RAMP_SPEEDS = [
  { value: 1.3, label: 'About a week' },
  { value: 1.12, label: 'About three weeks' },
]

const RAMP_TIP = 'A new number starts at 10 messages a day. This is how quickly that limit grows to its ceiling.'

const PROXY_TIP = "Gives this number its own internet connection, so it doesn't look linked to your others."

const LINK_TEXT: Record<string, string> = {
  online: 'Connected',
  connecting: 'Connecting',
  qr: 'Scan the code',
  offline: 'Disconnected',
  banned: 'Blocked by WhatsApp',
}

const MODE_TEXT: Record<string, string> = {
  warming: 'Ramping up',
  active: 'Sending',
  paused: 'Paused',
  banned: 'Stopped',
}

/**
 * The band a warning-point score falls in, the same test `risk()` in lib/safety.ts
 * runs. That module cannot be imported into the browser bundle (it pulls in
 * `node:assert`), so the bands come from the policy the API already sends down.
 */
function riskBand(health: number, bands: DashboardState['policy']['health']): Risk {
  if (health >= bands.critical) return 'critical'
  if (health >= bands.high) return 'high'
  if (health >= bands.medium) return 'medium'
  return 'low'
}

// A raw warning-point count means nothing to a reader, so the column shows the
// band instead. Colour stays quiet until it matters.
const RISK_TEXT = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' } as const

const RISK_CLASS = {
  low: 'text-muted-foreground',
  medium: 'text-amber-600 dark:text-amber-400',
  high: 'text-amber-600 dark:text-amber-400',
  critical: 'text-red-600 dark:text-red-400',
} as const


const col = createColumnHelper<TableFeatures, SenderHealth>()

/** The settings both dialogs send in the same PATCH/POST body. */
type Caps = { max_per_day: number; max_per_hour: number; proxy_url: string; warmup_growth: number }

/**
 * The four sending settings, two columns at most so no label has to wrap.
 * Shared by the add dialog and the per-number limits dialog: they showed the
 * same four controls with copy that had drifted apart.
 *
 * Labels keep `htmlFor`, so the tooltip lives inside the label as a plain
 * trigger rather than replacing it.
 */
function LimitFields({
  idPrefix,
  caps,
  onChange,
}: {
  idPrefix: string
  caps: Caps
  onChange: (caps: Caps) => void
}) {
  return (
    <FieldGroup className="grid gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-per-day`}>Most per day</FieldLabel>
        <Input
          id={`${idPrefix}-per-day`}
          type="number"
          value={caps.max_per_day}
          onChange={e => onChange({ ...caps, max_per_day: Number(e.target.value) })}
        />
        <FieldDescription>The number ramps up to this on its own.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-per-hour`}>Most per hour</FieldLabel>
        <Input
          id={`${idPrefix}-per-hour`}
          type="number"
          value={caps.max_per_hour}
          onChange={e => onChange({ ...caps, max_per_hour: Number(e.target.value) })}
        />
        <FieldDescription>Spread across the day.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-ramp`}>
          {/*
            `text-left whitespace-nowrap`: the tooltip trigger is a button, which
            centres its own text, so a label that wrapped also came out centred
            next to its left-aligned neighbours. Keep it on one line and left-aligned.
          */}
          <Tip tooltip={RAMP_TIP} className="text-left whitespace-nowrap">
            Reach full sending limit in
          </Tip>
        </FieldLabel>
        <Select value={String(caps.warmup_growth)} onValueChange={v => onChange({ ...caps, warmup_growth: Number(v) })}>
          <SelectTrigger id={`${idPrefix}-ramp`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RAMP_SPEEDS.map(r => (
              <SelectItem key={r.value} value={String(r.value)}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>Slower is safer for a new number.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-proxy`}>
          <Tip tooltip={PROXY_TIP} className="text-left whitespace-nowrap">
            Send through a proxy
          </Tip>
        </FieldLabel>
        <Input
          id={`${idPrefix}-proxy`}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={caps.proxy_url}
          placeholder="socks5://user:pass@host:1080"
          onChange={e => onChange({ ...caps, proxy_url: e.target.value })}
          className="font-mono text-xs"
        />
        <FieldDescription>Optional.</FieldDescription>
      </Field>
    </FieldGroup>
  )
}

export function NumbersPanel({ state, refresh }: { state: DashboardState; refresh: () => void }) {
  // The add dialog is a draft, so closing it by mistake keeps the number, the
  // nickname and any limits already typed in.
  const { phone, label, advanced, caps } = useDraft('number')
  const [qrFor, setQrFor] = useState<string | null>(null)
  const [testFor, setTestFor] = useState<string | null>(null)
  const [limitsFor, setLimitsFor] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const add = useWrite(() => api('/senders', { body: { phone, label, ...caps } }), {
    onSuccess: () => {
      setAdding(false)
      setQrFor(phone.replace(/\D/g, ''))
      clearDraft('number')
    },
  })

  // Two online numbers behind the same outgoing address are visibly related to WhatsApp,
  // so we count how many online senders share each address and flag any used more than once.
  const ipUseCount = state.senders.reduce<Record<string, number>>((counts, s) => {
    if (s.egress_ip && s.state === 'online') counts[s.egress_ip] = (counts[s.egress_ip] ?? 0) + 1
    return counts
  }, {})

  // Built here rather than at module scope: the actions cell opens this
  // component's dialogs, so it needs the state setters above.
  //
  // The accessors are functions returning `unknown` rather than plain keys on
  // purpose: v9 treats a column's value type as invariant, so a column typed
  // `number` would not be assignable to the shared `SortableHeader`, which takes
  // the default `Column<TableFeatures, SenderHealth>`.
  const columns = col.columns([
    col.accessor((s): unknown => s.phone, {
      id: 'phone',
      header: () => <PlainHeader title="Number" />,
      filterFn: 'includesString',
      enableHiding: false,
      /*
        One line on a wide screen. The nickname has its own column and the outgoing
        address lives in the tooltip: three stacked lines made every row three times
        taller than the data in it justified. Below `md` the nickname column is gone,
        so it comes back here as a second line rather than being lost.
      */
      cell: ({ row }) => {
        const s = row.original
        const shared = s.state === 'online' && s.egress_ip ? ipUseCount[s.egress_ip] > 1 : false
        return (
          <>
            <div className="flex items-center gap-1.5">
              <Tip
                tooltip={s.egress_ip ? `Sending from ${s.egress_ip}` : 'No outgoing address recorded yet.'}
                className="tabular-nums no-underline"
              >
                +{s.phone}
              </Tip>
              {shared ? (
                <Tip
                  tooltip="Another number is sending from this same address. Numbers that share an address look linked, which raises ban risk. Give each one its own proxy."
                  className="text-amber-600 no-underline dark:text-amber-400"
                >
                  <Warning className="inline size-3.5" />
                </Tip>
              ) : null}
            </div>
            {s.label ? <div className="text-muted-foreground text-xs md:hidden">{s.label}</div> : null}
          </>
        )
      },
    }),
    col.accessor((s): unknown => s.label ?? '', {
      id: 'label',
      // A nickname is the least load-bearing thing here, so it is the first column
      // to go. The number cell shows it inline below this breakpoint.
      meta: { className: 'hidden md:table-cell' },
      header: ({ column }) => <SortableHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.label || DASH}</span>
      ),
    }),
    col.accessor((s): unknown => s.status, {
      id: 'status',
      header: ({ column }) => <SortableHeader column={column} title="Status" />,
      cell: ({ row }) => {
        const s = row.original
        return (
          <>
            <div className="flex items-center gap-2">
              <Pill value={s.state} title={s.error ?? undefined} />
              <span className="text-muted-foreground text-xs">{MODE_TEXT[s.status] ?? s.status}</span>
            </div>
            {s.state !== 'online' || s.paused_until ? (
              <div className="text-muted-foreground text-xs">
                {s.state === 'online' ? '' : (LINK_TEXT[s.state] ?? s.state)}
                {s.paused_until
                  ? `${s.state === 'online' ? 'Paused' : ','} until ${new Date(s.paused_until).toLocaleTimeString()}`
                  : ''}
              </div>
            ) : null}
          </>
        )
      },
    }),
    col.accessor((s): unknown => s.sent_today, {
      id: 'sent_today',
      meta: { className: 'hidden sm:table-cell' },
      header: ({ column }) => (
        <SortableHeader column={column} title="Sent today" tooltip="Messages sent today out of today's cap." align="right" />
      ),
      cell: ({ row }) => {
        const s = row.original
        return (
          <div className="text-right">
            <div className="tabular-nums">
              {s.sent_today}
              <span className="text-muted-foreground">/{s.cap_today}</span>
            </div>
            <div className="text-muted-foreground text-xs tabular-nums">{s.sent_hour} this hour</div>
          </div>
        )
      },
    }),
    col.accessor((s): unknown => s.reply_rate, {
      id: 'reply_rate',
      meta: { className: 'hidden lg:table-cell' },
      header: ({ column }) => (
        <SortableHeader
          column={column}
          title="Answered"
          tooltip="Share of all-time sends from this number that got a reply."
          align="right"
        />
      ),
      cell: ({ row }) => (
        <div className="text-right tabular-nums text-sky-600 dark:text-sky-400">
          {row.original.sent_total ? pct(row.original.reply_rate) : '–'}
        </div>
      ),
    }),
    col.accessor((s): unknown => s.delivery_rate, {
      id: 'delivery_rate',
      meta: { className: 'hidden lg:table-cell' },
      header: ({ column }) => (
        <SortableHeader
          column={column}
          title="Delivered"
          tooltip="Share of all-time sends that WhatsApp confirmed reached the device."
          align="right"
        />
      ),
      cell: ({ row }) => (
        <div className="text-right tabular-nums">
          {row.original.sent_total ? pct(row.original.delivery_rate) : '–'}
        </div>
      ),
    }),
    col.accessor((s): unknown => s.health, {
      id: 'health',
      meta: { className: 'hidden sm:table-cell' },
      header: ({ column }) => (
        <SortableHeader
          column={column}
          title="Risk"
          tooltip={`How close this number is to a safety pause, from warning points in the last 24 hours (it pauses at ${state.policy.health.critical}).`}
          align="right"
        />
      ),
      cell: ({ row }) => {
        const level = riskBand(row.original.health, state.policy.health)
        return (
          <div className="text-right">
            <Tip
              className={RISK_CLASS[level]}
              tooltip={`${row.original.health} warning points in the last 24 hours. At ${state.policy.health.critical} the number pauses for a day.`}
            >
              {RISK_TEXT[level]}
            </Tip>
          </div>
        )
      },
    }),
    col.display({
      id: 'actions',
      enableSorting: false,
      enableHiding: false,
      header: () => <PlainHeader title="Actions" align="right" />,
      cell: ({ row }) => (
        <RowActions
          sender={row.original}
          onTest={() => setTestFor(row.original.phone)}
          onQr={() => setQrFor(row.original.phone)}
          onLimits={() => setLimitsFor(row.original.phone)}
        />
      ),
    }),
  ])

  return (
    <div className="space-y-4">
      {/*
        Adding a number is a one-off task, so it lives in a dialog. As a permanent
        card it pushed the list of numbers you actually monitor down the page.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setAdding(true)}>
          <Plus /> Add number
        </Button>
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        {/*
          Same width as the limits dialog: both show the same two-column block. The
          three-row grid with a natively scrolling middle is what keeps the footer on
          screen at 667px tall once the limits block is open.
        */}
        <DialogContent className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add a WhatsApp number</DialogTitle>
            <DialogDescription>You&apos;ll scan a QR code, like WhatsApp Web.</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-4 overflow-y-auto pr-3">
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="new-phone">Number</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>+</InputGroupAddon>
                  <InputGroupInput
                    id="new-phone"
                    inputMode="tel"
                    value={phone}
                    placeholder="919876543210"
                    onChange={e => setDraft('number', { phone: e.target.value })}
                    className="font-mono"
                  />
                </InputGroup>
                <FieldDescription>Country code first, no spaces.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="new-label">Nickname</FieldLabel>
                <Input
                  id="new-label"
                  value={label}
                  placeholder="Sales 1"
                  onChange={e => setDraft('number', { label: e.target.value })}
                />
                <FieldDescription>Just so you can tell them apart.</FieldDescription>
              </Field>
            </FieldGroup>

            {advanced ? (
              <div className="border-t pt-4">
                <LimitFields idPrefix="new" caps={caps} onChange={next => setDraft('number', { caps: next })} />
              </div>
            ) : null}
          </div>

          <DialogFooter className="sm:justify-between">
            <Button variant="ghost" size="sm" onClick={() => setDraft('number', { advanced: !advanced })}>
              <SlidersHorizontal /> {advanced ? 'Hide limits and proxy' : 'Limits and proxy'}
            </Button>
            <Button onClick={() => add.mutate()} disabled={add.isPending || phone.replace(/\D/g, '').length < 11}>
              <Plus /> {add.isPending ? 'Adding…' : 'Add number'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>Your numbers</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={state.senders}
            searchColumn="phone"
            searchPlaceholder="Search numbers"
            empty={
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <DeviceMobile />
                  </EmptyMedia>
                  <EmptyTitle>No numbers yet</EmptyTitle>
                  <EmptyDescription>Add a WhatsApp number, scan the QR code, and it can start sending.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={() => setAdding(true)}>
                    <Plus /> Add number
                  </Button>
                </EmptyContent>
              </Empty>
            }
          />
        </CardContent>
      </Card>

      {/* Still a manual refresh: pairing finishes on WhatsApp's side, not through a
          write of ours, so there is no mutation to hang the invalidation off. */}
      <QrDialog phone={qrFor} onClose={() => { setQrFor(null); refresh() }} />
      <TestDialog phone={testFor} onOpenChange={open => !open && setTestFor(null)} />
      {/*
        Keyed by phone so a fresh instance mounts per number: the caps below are
        seeded from props once at mount, rather than synced in an effect on every
        prop change (opening the dialog for a different number is the only time
        the seed should change).
      */}
      <LimitsDialog
        key={limitsFor ?? 'none'}
        sender={state.senders.find(s => s.phone === limitsFor) ?? null}
        onOpenChange={open => !open && setLimitsFor(null)}
      />
    </div>
  )
}

/**
 * Every per-number action, in its own component so each write is a real mutation
 * rather than a hook called from inside a table cell.
 */
function RowActions({
  sender: s,
  onTest,
  onQr,
  onLimits,
}: {
  sender: SenderHealth
  onTest: () => void
  onQr: () => void
  onLimits: () => void
}) {
  // One PATCH covers reconnect, pause and resume; the confirmation each one gets is
  // carried alongside the body rather than duplicated into three mutations.
  const patch = useWrite(
    ({ body }: { body: Record<string, unknown>; done: string }) =>
      api(`/senders/${s.phone}`, { method: 'PATCH', body }),
    { onSuccess: (_data, vars) => toast.success(vars.done) },
  )
  const remove = useWrite(() => api(`/senders/${s.phone}`, { method: 'DELETE' }), {
    onSuccess: () => toast.success('Removed'),
  })

  return (
    <div className="flex justify-end">
      <ButtonGroup>
        {/* Sending a test is the first thing you do with a new number,
            so it stays visible instead of hiding behind the menu. */}
        {s.state === 'online' ? (
          // Icon only below `sm`, so the number and its actions both fit a phone
          // without the row scrolling sideways.
          <Button size="sm" variant="outline" onClick={onTest} aria-label="Send a test message">
            <PaperPlaneRight />
            <span className="hidden sm:inline">Test</span>
          </Button>
        ) : null}
        {s.state === 'qr' || s.state === 'connecting' ? (
          <Button size="sm" variant="outline" onClick={onQr}>
            <QrCode /> Scan QR
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" aria-label="More actions for this number">
              <DotsThree weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          {/*
            An explicit width matters here: the menu defaults to the width of
            its trigger, which is an icon button, so without this the labels
            get clipped. `whitespace-nowrap` keeps them on one line.
          */}
          <DropdownMenuContent align="end" className="w-60 whitespace-nowrap">
            {s.state === 'offline' || s.state === 'banned' ? (
              <DropdownMenuItem
                onSelect={() => patch.mutate({ body: { action: 'reconnect' }, done: 'Reconnecting' })}
              >
                <ArrowsClockwise /> Reconnect
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onSelect={() =>
                patch.mutate({
                  body: { status: s.status === 'paused' ? 'active' : 'paused' },
                  done: s.status === 'paused' ? 'Resumed' : 'Paused',
                })
              }
            >
              {s.status === 'paused' ? <Play /> : <Pause />}
              {s.status === 'paused' ? 'Resume sending' : 'Pause sending'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onLimits}>
              <SlidersHorizontal /> Limits and proxy
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/*
              Not a DropdownMenuItem: Radix closes (and eventually unmounts) the menu
              the instant an item is selected, which would tear the confirm dialog
              down with it. A plain child inside the menu doesn't trigger that, so
              ConfirmButton's own dialog gets to stay open on top.
            */}
            <ConfirmButton
              destructive
              size="sm"
              variant="ghost"
              className={menuItemClass}
              title="Remove this number?"
              description={`You'll need to scan the QR code again to reconnect +${s.phone}; sent messages stay in your history.`}
              confirmLabel="Remove number"
              onConfirm={() => remove.mutateAsync()}
            >
              <Trash /> Remove number
            </ConfirmButton>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
    </div>
  )
}

function QrDialog({ phone: target, onClose }: { phone: string | null; onClose: () => void }) {
  const [status, setStatus] = useState<{ state: string; qr: string | null; error: string | null } | null>(null)

  useEffect(() => {
    if (!target) return
    let alive = true
    const poll = async () => {
      try {
        const s = await api<{ state: string; qr: string | null; error: string | null }>(`/senders/${target}`)
        if (!alive) return
        setStatus(s)
        if (s.state === 'online') {
          toast.success(`+${target} connected`)
          onClose()
        }
      } catch { /* keep polling */ }
    }
    poll()
    const t = setInterval(poll, 1500)
    return () => { alive = false; clearInterval(t) }
  }, [target, onClose])

  return (
    <Dialog open={Boolean(target)} onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Scan with WhatsApp</DialogTitle>
          <DialogDescription>On your phone: Settings → Linked devices → Link a device</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          {status?.qr ? (
            /* eslint-disable-next-line @next/next/no-img-element -- data: URI from the socket */
            <img
              src={status.qr}
              alt="WhatsApp QR code"
              width={280}
              height={280}
              className="h-auto w-full max-w-[280px] rounded-md bg-white p-2"
            />
          ) : (
            <div className="text-muted-foreground flex h-[280px] w-full max-w-[280px] items-center justify-center text-sm">
              Waiting for the QR code…
            </div>
          )}
          <p className="text-muted-foreground text-xs">{status?.error ?? LINK_TEXT[status?.state ?? ''] ?? 'Connecting'}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A test is only worth sending if it lands on a phone you can actually look at,
 * so this asks for a recipient instead of silently picking one of your own numbers.
 */
function TestDialog({ phone, onOpenChange }: { phone: string | null; onOpenChange: (open: boolean) => void }) {
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('91')

  const send = useWrite(
    () => api<{ sent_to: string }>(`/senders/${phone}`, { method: 'PATCH', body: { action: 'test', to, cc } }),
    {
      onSuccess: r => {
        toast.success(`Test message sent to +${r.sent_to}`)
        setTo('')
        onOpenChange(false)
      },
    },
  )

  return (
    <Dialog open={Boolean(phone)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Send a test message</DialogTitle>
          <DialogDescription>
            One real message from +{phone}. It doesn&apos;t count against sending limits or reply rate.
          </DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor="test-to">Send to</FieldLabel>
          <InputGroup>
            <InputGroupAddon className="gap-1 pr-0">
              +
              <Tip asChild tooltip="Country code. It's added automatically to 10-digit numbers.">
                <Input
                  aria-label="Country code"
                  inputMode="tel"
                  value={cc}
                  onChange={e => setCc(e.target.value)}
                  className="h-6 w-9 border-0 bg-transparent px-0 font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
                />
              </Tip>
            </InputGroupAddon>
            <InputGroupInput
              id="test-to"
              autoFocus
              inputMode="tel"
              value={to}
              placeholder="98765 43210"
              onChange={e => setTo(e.target.value)}
              className="font-mono"
            />
          </InputGroup>
          <FieldDescription>Use a phone you can pick up and check.</FieldDescription>
        </Field>

        <DialogFooter>
          <Button onClick={() => send.mutate()} disabled={send.isPending || !to.trim()}>
            <PaperPlaneRight /> {send.isPending ? 'Sending…' : 'Send test'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Prefilled from the sender's current row, saved as a single PATCH. */
function LimitsDialog({
  sender,
  onOpenChange,
}: {
  sender: SenderHealth | null
  onOpenChange: (open: boolean) => void
}) {
  const [caps, setCaps] = useState<Caps>(() => ({
    max_per_day: sender?.max_per_day ?? 60,
    max_per_hour: sender?.max_per_hour ?? 8,
    proxy_url: sender?.proxy_url ?? '',
    warmup_growth: sender?.warmup_growth ?? 1.3,
  }))

  const save = useWrite(() => api(`/senders/${sender?.phone}`, { method: 'PATCH', body: caps }), {
    onSuccess: () => {
      toast.success('Limits updated')
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={Boolean(sender)} onOpenChange={onOpenChange}>
      {/* Wide enough that two columns of these labels each stay on one line. On a
          phone they stack into one column, which is taller than the viewport, so the
          body scrolls and the footer stays put. */}
      <DialogContent className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Limits and proxy for +{sender?.phone}</DialogTitle>
          <DialogDescription>
            Safety ceilings the number ramps up to on its own. Most people never touch these. Proxy changes apply on
            the next reconnect.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto pr-3">
          <LimitFields idPrefix="limits" caps={caps} onChange={setCaps} />
        </div>

        <DialogFooter>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            <Check /> {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
