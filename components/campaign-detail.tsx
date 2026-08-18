'use client'

import Link from 'next/link'
import { createColumnHelper } from '@tanstack/react-table'
import { ArrowLeft } from '@phosphor-icons/react/dist/ssr'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable, PlainHeader, SortableHeader } from '@/components/data-table/data-table'
import { type TableFeatures } from '@/components/data-table/features'
import { Empty, FieldLabel, Pill, Stat, Tip } from '@/components/shared'
import {
  ago,
  api,
  pct,
  phone,
  usePoll,
  useWrite,
  type CampaignDetail,
  type DashboardState,
  type MessageRow,
  type VariantRow,
} from '@/lib/client.ts'

const DASH = '–'

/** Version 0 is A, 1 is B, and so on. */
const letter = (variant: number) => String.fromCharCode(65 + variant)

/** A share of sent, or `null` when nothing was sent to divide by. */
const share = (n: number, sent: number) => (sent ? n / sent : null)

/** The same share, formatted for a cell. */
const shown = (n: number, sent: number) => (sent ? pct(n / sent) : DASH)

/*
  Every accessor below is annotated `unknown`, which is the value type the shared
  DataTable and SortableHeader are written against. TanStack v9 makes `Column`
  invariant in its value type, so a narrower accessor (a `number` count, say)
  would not fit a header that takes `Column<TableFeatures, VariantRow>`. Cells
  read `row.original`, which is what most of them need anyway.
*/
const variantCol = createColumnHelper<TableFeatures, VariantRow>()

const VARIANT_COLUMNS = variantCol.columns([
  variantCol.accessor((v): unknown => v.step_no, {
    id: 'step_no',
    header: ({ column }) => <SortableHeader column={column} title="Step" />,
    cell: ({ row }) => <span className="tabular-nums">{row.original.step_no}</span>,
  }),
  variantCol.accessor((v): unknown => v.variant, {
    id: 'variant',
    header: ({ column }) => (
      <SortableHeader column={column} title="Version" tooltip="The wording used for this step: version A, version B, and so on." />
    ),
    cell: ({ row }) => <span>{letter(row.original.variant)}</span>,
  }),
  variantCol.accessor((v): unknown => v.sent, {
    id: 'sent',
    header: ({ column }) => <SortableHeader column={column} title="Sent" align="right" />,
    cell: ({ row }) => <div className="text-right tabular-nums">{row.original.sent}</div>,
  }),
  variantCol.accessor((v): unknown => share(v.delivered, v.sent), {
    id: 'delivered',
    meta: { className: 'hidden sm:table-cell' },
    header: ({ column }) => (
      <SortableHeader column={column} title="Delivered" tooltip="Share of these messages that reached the phone." align="right" />
    ),
    cell: ({ row }) => <div className="text-right tabular-nums">{shown(row.original.delivered, row.original.sent)}</div>,
  }),
  variantCol.accessor((v): unknown => share(v.read, v.sent), {
    id: 'read',
    meta: { className: 'hidden sm:table-cell' },
    header: ({ column }) => (
      <SortableHeader column={column} title="Read" tooltip="Share of these messages that were opened." align="right" />
    ),
    cell: ({ row }) => <div className="text-right tabular-nums">{shown(row.original.read, row.original.sent)}</div>,
  }),
  variantCol.accessor((v): unknown => share(v.replied, v.sent), {
    id: 'answered',
    header: ({ column }) => (
      <SortableHeader column={column} title="Answered" tooltip="Share of these messages that got a reply." align="right" />
    ),
    cell: ({ row }) => (
      <div className="text-right tabular-nums text-sky-600 dark:text-sky-400">
        {shown(row.original.replied, row.original.sent)}
      </div>
    ),
  }),
])


const step = (m: MessageRow) => `${m.step_no}${m.variant ? letter(m.variant) : ''}`

const messageStatus = (m: MessageRow) => (m.read_at ? 'read' : m.delivered_at ? 'delivered' : m.status)

const messageCol = createColumnHelper<TableFeatures, MessageRow>()

const MESSAGE_COLUMNS = messageCol.columns([
  messageCol.accessor((m): unknown => step(m), {
    id: 'step',
    meta: { className: 'hidden md:table-cell' },
    header: ({ column }) => <SortableHeader column={column} title="Step" />,
    cell: ({ row }) => <span className="tabular-nums">{step(row.original)}</span>,
  }),
  // Phone and name are both in the accessor value, so the search box finds either.
  messageCol.accessor((m): unknown => [m.phone, m.name].filter(Boolean).join(' '), {
    id: 'contact',
    filterFn: 'includesString',
    header: ({ column }) => <SortableHeader column={column} title="Contact" />,
    cell: ({ row }) => (
      <div className="text-xs tabular-nums">
        {phone(row.original.phone)}
        {row.original.name ? <div className="text-muted-foreground">{row.original.name}</div> : null}
      </div>
    ),
  }),
  messageCol.accessor((m): unknown => messageStatus(m), {
    id: 'status',
    header: ({ column }) => <SortableHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <>
        <Pill value={messageStatus(row.original)} />
        {row.original.error ? <div className="text-muted-foreground text-xs">{row.original.error}</div> : null}
      </>
    ),
  }),
  messageCol.accessor((m): unknown => m.sent_from, {
    id: 'sent_from',
    meta: { className: 'hidden lg:table-cell' },
    // "From" needed a tooltip to say whose number this was, so the heading says it.
    header: ({ column }) => <SortableHeader column={column} title="Sent from" />,
    cell: ({ row }) => (
      <span className="text-muted-foreground text-xs tabular-nums">{phone(row.original.sent_from)}</span>
    ),
  }),
  messageCol.accessor((m): unknown => m.sent_at ?? m.scheduled_at, {
    id: 'when',
    header: ({ column }) => <SortableHeader column={column} title="When" />,
    cell: ({ row }) => (
      <span className="text-muted-foreground text-xs">{ago(row.original.sent_at ?? row.original.scheduled_at)}</span>
    ),
  }),
  messageCol.accessor((m): unknown => m.body, {
    id: 'body',
    meta: { className: 'hidden lg:table-cell' },
    header: () => <PlainHeader title="Body" />,
    cell: ({ row }) => (
      // The body is only written at send time, when the spintax and the
      // contact's details are resolved, so a queued row has none yet.
      <div className="text-muted-foreground max-w-md truncate text-xs">
        {row.original.body || <span className="italic">picked when it sends</span>}
      </div>
    ),
  }),
])


/**
 * One campaign on its own page, reached from the campaigns table. It was an
 * expanding row before, which meant the URL never changed: a refresh threw you
 * back to the list and there was no link to send anyone.
 */
export function CampaignDetailPanel({ id, state }: { id: number; state: DashboardState }) {
  const row = state.campaigns.find(c => c.id === id) ?? null
  const { data: detail } = usePoll<CampaignDetail>(`/campaigns/${id}`, 8000)
  const start = useWrite(() => api(`/campaigns/${id}`, { method: 'PATCH', body: { action: 'start' } }), {
    invalidate: ['/campaigns'],
  })

  if (!row) {
    return (
      <Card>
        <CardContent className="py-10">
          <Empty>That campaign no longer exists.</Empty>
          <div className="mt-4 flex justify-center">
            <Button asChild variant="secondary" size="sm">
              <Link href="/campaigns">
                <ArrowLeft /> Back to campaigns
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const rate = (n: number) => (row.sent ? pct(n / row.sent) : DASH)

  return (
    <div className="space-y-4">
      {/* A breadcrumb rather than a back button: it names where you are as well as
          where you came from, and matches the URL you can now link to. */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/campaigns">Campaigns</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{row.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tighter">{row.name}</h1>
        <Pill value={row.status} />
        <Tip tooltip="The list this campaign sends to, and the hours it is allowed to send in.">
          <span className="text-muted-foreground text-xs tabular-nums">
            {row.list} ·{' '}
            {row.ignore_send_window ? 'any time of day' : `${row.start_hour}:00 to ${row.end_hour}:00`} ·{' '}
            {row.timezone}
          </span>
        </Tip>
      </div>

      {row.blocked_reason ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 text-sm">
            <span className="font-medium">Not sending right now.</span>{' '}
            <span className="text-muted-foreground">{row.blocked_reason}</span>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Results</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-x-6 gap-y-4">
            <Metric label="Sent" value={row.sent} />
            <Metric label="Delivered" value={rate(row.delivered)} tooltip="Share of sent messages that reached the phone." />
            <Metric label="Read" value={rate(row.read)} tooltip="Share of sent messages that were opened." />
            <Metric label="Answered" value={rate(row.replied)} tooltip="Share of sent messages that got a reply." />
          </div>

          {detail && detail.variants.length > 1 ? (
            <div className="space-y-2">
              <FieldLabel tooltip="The same step written more than one way. Compare the reply rates before you settle on a wording.">
                Which version works better
              </FieldLabel>
              <DataTable columns={VARIANT_COLUMNS} data={detail.variants} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Messages</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={MESSAGE_COLUMNS}
            data={detail?.messages ?? []}
            searchColumn="contact"
            searchPlaceholder="Search contacts"
            // Only claim there is nothing queued once the messages have loaded.
            empty={
              detail ? (
                <Empty>
                  {/*
                    A finished campaign has nothing queued for a different reason than a
                    draft does, and offering "Start the campaign" on one that already ran
                    reads as though it never worked.
                  */}
                  {row.status === 'done' ? (
                    'Every message in this campaign has been sent.'
                  ) : row.status === 'running' ? (
                    'Nothing queued yet. The first messages appear here once the campaign starts sending.'
                  ) : (
                    <>
                      Nothing queued yet.{' '}
                      <button className="underline" disabled={start.isPending} onClick={() => start.mutate()}>
                        Start the campaign
                      </button>
                    </>
                  )}
                </Empty>
              ) : null
            }
          />
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * A headline number, matching the activity panel. It only gets hover text where the
 * label cannot carry the definition: "Sent" is a count of sends, while "Delivered"
 * is a share of them and has to say so.
 */
function Metric({ label, value, tooltip }: { label: string; value: string | number; tooltip?: string }) {
  const stat = <Stat label={label} value={value} />
  if (!tooltip) return stat
  return (
    <Tip asChild tooltip={tooltip}>
      <div className="cursor-help">{stat}</div>
    </Tip>
  )
}

