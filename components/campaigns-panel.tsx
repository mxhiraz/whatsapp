'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createColumnHelper } from '@tanstack/react-table'
import {
  DotsThree,
  DownloadSimple,
  Pause,
  PaperPlaneRight,
  Play,
  Plus,
  Trash,
} from '@phosphor-icons/react/dist/ssr'
import { Button, buttonVariants } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CampaignDialog } from '@/components/campaign-dialog'
import { ConfirmButton, menuItemClass } from '@/components/confirm'
import { DataTable, PlainHeader, SortableHeader } from '@/components/data-table/data-table'
import { type TableFeatures } from '@/components/data-table/features'
import { Empty, Pill, Tip } from '@/components/shared'
import { api, pct, useWrite, type CampaignRow, type DashboardState } from '@/lib/client.ts'

const col = createColumnHelper<TableFeatures, CampaignRow>()


export function CampaignsPanel({ state }: { state: DashboardState }) {
  const [creating, setCreating] = useState(false)
  const router = useRouter()

  /*
    Built here rather than at module scope: the actions cell renders this component's
    row menu.

    Every accessor is annotated `unknown`, which is the value type the shared
    DataTable and SortableHeader are written against. TanStack v9 makes `Column`
    invariant in its value type, so a narrower accessor (a `number` count, say)
    would not fit a header that takes `Column<TableFeatures, CampaignRow>`. Cells
    read `row.original` instead of `getValue()`, which they mostly need anyway.
  */
  const columns = useMemo(
    () =>
      col.columns([
        col.accessor((c): unknown => c.name, {
          id: 'name',
          filterFn: 'includesString',
          header: ({ column }) => <SortableHeader column={column} title="Name" />,
          cell: ({ row }) => (
            // `whitespace-normal` below `sm`: the sub-line is a sentence, and cells
            // are nowrap by default, so on a phone it held the name column open at
            // 260px and pushed the row actions off the screen.
            <div className="font-medium whitespace-normal sm:whitespace-nowrap">
              {row.original.name}
              <div className="text-muted-foreground text-xs font-normal tabular-nums">
                {row.original.list} ·{' '}
                {row.original.ignore_send_window
                  ? 'any time of day'
                  : `${row.original.start_hour}:00 to ${row.original.end_hour}:00`}{' '}
                · {row.original.timezone}
              </div>
            </div>
          ),
        }),
        col.accessor((c): unknown => c.status, {
          id: 'status',
          header: ({ column }) => <SortableHeader column={column} title="Status" />,
          cell: ({ row }) => (
            <>
              <Pill value={row.original.status} />
              {/* A running campaign with a queue that never moves needs to say why. */}
              {row.original.blocked_reason ? (
                <div className="mt-1 max-w-32 text-xs leading-tight whitespace-normal text-amber-600 sm:max-w-52 dark:text-amber-400">
                  {row.original.blocked_reason}
                </div>
              ) : null}
            </>
          ),
        }),
        col.accessor((c): unknown => c.sent, {
          id: 'sent',
          meta: { className: 'hidden sm:table-cell' },
          header: ({ column }) => <SortableHeader column={column} title="Sent" align="right" />,
          cell: ({ row }) => <div className="text-right tabular-nums">{row.original.sent}</div>,
        }),
        col.accessor((c): unknown => c.pending, {
          id: 'pending',
          meta: { className: 'hidden md:table-cell' },
          header: ({ column }) => <SortableHeader column={column} title="Waiting" align="right" />,
          cell: ({ row }) => <div className="text-right tabular-nums">{row.original.pending}</div>,
        }),
        col.accessor((c): unknown => c.replied, {
          id: 'replied',
          meta: { className: 'hidden md:table-cell' },
          header: ({ column }) => (
            <SortableHeader column={column} title="Answered" tooltip="Share of sent messages that got a reply." align="right" />
          ),
          cell: ({ row }) => (
            <div className="text-right tabular-nums text-sky-600 dark:text-sky-400">
              {row.original.replied}
              {row.original.sent ? (
                <span className="text-muted-foreground text-xs"> ({pct(row.original.replied / row.original.sent)})</span>
              ) : null}
            </div>
          ),
        }),
        col.accessor((c): unknown => c.failed + c.skipped, {
          id: 'problems',
          meta: { className: 'hidden lg:table-cell' },
          header: ({ column }) => (
            <SortableHeader
              column={column}
              title="Problems"
              tooltip="Messages that failed or were skipped, such as a blocked or opted-out contact."
              align="right"
            />
          ),
          cell: ({ row }) => <div className="text-right tabular-nums">{row.original.failed + row.original.skipped}</div>,
        }),
        col.display({
          id: 'actions',
          enableSorting: false,
          enableHiding: false,
          header: () => <PlainHeader title="" />,
          cell: ({ row }) => (
            // The menu must not open the campaign underneath it.
            <div className="text-right" onClick={e => e.stopPropagation()}>
              <CampaignRowMenu campaign={row.original} />
            </div>
          ),
        }),
      ]),
    [],
  )

  return (
    <div className="space-y-4">
      {/*
        Building a campaign is a task with a beginning and an end, so it lives in a
        dialog. As a permanent form above the table it buried the campaigns you
        actually came here to check on.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setCreating(true)}>
          <Plus /> New campaign
        </Button>
      </div>

      <CampaignDialog open={creating} onOpenChange={setCreating} lists={state.lists} />

      <Card>
        <CardHeader>
          <CardTitle>Campaigns</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={state.campaigns}
            searchColumn="name"
            searchPlaceholder="Search campaigns"
            onRowClick={c => router.push(`/campaigns/${c.id}`)}
            empty={<Empty>No campaigns yet.</Empty>}
          />
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Every per-row action behind one trigger. The delete and send-now items render
 * a `ConfirmButton` directly rather than a `DropdownMenuItem` — selecting a real
 * item closes (and unmounts) the menu immediately, which would tear down the
 * confirmation dialog before it could open. Left unstyled-as-a-button here, they
 * only close the menu once their own action actually finishes.
 */
function CampaignRowMenu({ campaign: c }: { campaign: CampaignRow }) {
  const [open, setOpen] = useState(false)
  const running = c.status === 'running'
  // A drained campaign is `done`, and "Start" on it reads as though it would send
  // the whole list again. The action is the same PATCH either way.
  const done = c.status === 'done'

  const toggleRunning = useWrite(
    () => api(`/campaigns/${c.id}`, { method: 'PATCH', body: { action: running ? 'pause' : 'start' } }),
    { invalidate: ['/campaigns'] },
  )

  const sendNow = useWrite(
    () => api<{ due: number }>(`/campaigns/${c.id}`, { method: 'PATCH', body: { action: 'send_now' } }),
    {
      invalidate: ['/campaigns'],
      onSuccess: res => {
        toast.success(`${res.due} messages moved to the front of the queue`)
        setOpen(false)
      },
    },
  )

  const remove = useWrite(() => api(`/campaigns/${c.id}`, { method: 'DELETE' }), {
    invalidate: ['/campaigns'],
    onSuccess: () => setOpen(false),
  })

  const startStopButton = (
    <Button size="sm" variant="outline" disabled={toggleRunning.isPending} onClick={() => toggleRunning.mutate()}>
      {running ? <Pause /> : <Play />}
      {running ? 'Pause' : done ? 'Start again' : 'Start'}
    </Button>
  )

  return (
    <ButtonGroup>
      {/* Pausing is the action you reach for mid-campaign, so it stays visible
          rather than hiding behind the menu. Pause and Start say what they do, so
          only "Start again" carries hover text: what it re-queues is not obvious. */}
      {done ? (
        <Tip asChild tooltip="Queues the next message for everyone on the list who is still new or active. Anyone already messaged, replied or opted out is left alone, so nobody is contacted twice.">
          {startStopButton}
        </Tip>
      ) : (
        startStopButton
      )}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" aria-label={`More actions for ${c.name}`}>
            <DotsThree weight="bold" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <ConfirmButton
            variant="ghost"
            className={menuItemClass}
            title="Send every queued message now?"
            description="Skips the pacing that makes sending look human. Caps still apply, but a burst is the fastest way to get a number banned. Only use this to catch up a late campaign."
            confirmLabel="Send now"
            onConfirm={() => sendNow.mutateAsync()}
          >
            <PaperPlaneRight /> Send queued messages now
          </ConfirmButton>

          <DropdownMenuItem asChild>
            <a
              href={`/api/export?campaign=${c.id}`}
              download
              className={buttonVariants({ variant: 'ghost', className: menuItemClass })}
            >
              <DownloadSimple /> Export results
            </a>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <ConfirmButton
            variant="ghost"
            destructive
            className={menuItemClass}
            title="Delete this campaign?"
            description={`Deleting "${c.name}" drops every queued message. Sent messages stay in your history. This can't be undone.`}
            confirmLabel="Delete campaign"
            onConfirm={() => remove.mutateAsync()}
          >
            <Trash /> Delete campaign
          </ConfirmButton>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  )
}

