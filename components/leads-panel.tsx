'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createColumnHelper } from '@tanstack/react-table'
import { toast } from 'sonner'
import { Check, DownloadSimple, FileArrowUp, Plus, Trash, UserPlus } from '@phosphor-icons/react/dist/ssr'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ConfirmButton } from '@/components/confirm'
import { DataTable, PlainHeader, SortableHeader } from '@/components/data-table/data-table'
import { type TableFeatures } from '@/components/data-table/features'
import { ImportDialog } from '@/components/import-dialog'
import { Empty, Tip } from '@/components/shared'
import { api, useWrite, type DashboardState, type ListRow } from '@/lib/client.ts'

const helper = createColumnHelper<TableFeatures, ListRow>()

/**
 * One of the five per-list counts: a right-aligned number with an explained,
 * sortable header.
 *
 * The accessor is declared as returning `unknown` because the shared header takes
 * a column whose cell value is untyped; the cell reads the row itself instead.
 */
const count = (
  id: Exclude<keyof ListRow, 'list'>,
  title: string,
  /** Omitted where the heading already says it. */
  tooltip: string | undefined,
  /** Where this count starts earning its width. Omit to always show it. */
  from?: 'sm' | 'md' | 'lg',
  className = '',
) =>
  helper.accessor((l): unknown => l[id], {
    id,
    meta: from ? { className: `hidden ${from}:table-cell` } : undefined,
    header: ({ column }) => <SortableHeader column={column} title={title} tooltip={tooltip} align="right" />,
    cell: ({ row }) => <div className={`text-right tabular-nums ${className}`}>{row.original[id]}</div>,
  })

/**
 * Contacts is a view of your lists, plus two ways to add to them. Both adding
 * flows are dialogs: they are tasks with an end, and as permanent forms they
 * pushed the thing you came to look at (your lists) off the screen. Clicking a
 * row opens that list at /contacts/[list], a real page you can link to.
 */
export function LeadsPanel({ state }: { state: DashboardState }) {
  const [importing, setImporting] = useState(false)
  const [addingOne, setAddingOne] = useState(false)
  const router = useRouter()
  const lists = state.lists.map(l => l.list)

  // Built here rather than at module scope because the actions column renders a
  // component of this file's own.
  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor((l): unknown => l.list, {
          id: 'list',
          header: ({ column }) => <SortableHeader column={column} title="List" />,
          cell: ({ row }) => <span className="font-medium whitespace-normal">{row.original.list}</span>,
        }),
        // The list name, its size and its actions are what a phone can hold. The
        // four outcome counts come back one breakpoint at a time.
        count('total', 'Contacts', undefined),
        count('contacted', 'Messaged', 'Contacts messaged at least once by any campaign.', 'sm'),
        count(
          'replied',
          'Answered',
          'Contacts who replied. Their follow-ups were cancelled automatically.',
          'md',
          'text-sky-600 dark:text-sky-400',
        ),
        count(
          'opted_out',
          'Opted out',
          'Contacts who asked to stop. They are on the block list and are never messaged again.',
          'lg',
        ),
        count(
          'invalid',
          'No WhatsApp',
          'Numbers with no WhatsApp account, found when we checked before the first send.',
          'lg',
        ),
        helper.display({
          id: 'actions',
          enableSorting: false,
          enableHiding: false,
          header: () => <PlainHeader title="Actions" align="right" />,
          // Rows navigate on click, so the buttons have to keep the click to themselves.
          cell: ({ row }) => (
            <div className="text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
              {/* Icon only, so `aria-label` is the accessible name rather than decoration. */}
              <a
                href={`/api/export?list=${encodeURIComponent(row.original.list)}`}
                download
                aria-label={`Export ${row.original.list}`}
                className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              >
                <DownloadSimple />
              </a>
              <DeleteListButton list={row.original.list} total={row.original.total} />
            </div>
          ),
        }),
      ]),
    [],
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setImporting(true)}>
          <FileArrowUp /> Import a CSV
        </Button>
        <Button variant="outline" onClick={() => setAddingOne(true)}>
          <UserPlus /> Add one contact
        </Button>
      </div>

      <ImportDialog open={importing} onOpenChange={setImporting} knownLists={lists} />
      <AddContactDialog open={addingOne} onOpenChange={setAddingOne} knownLists={lists} />

      <Card>
        <CardHeader>
          <CardTitle>Your lists</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={state.lists}
            searchColumn="list"
            searchPlaceholder="Search lists"
            onRowClick={row => router.push(`/contacts/${encodeURIComponent(row.list)}`)}
            empty={
              <Empty>
                <FileArrowUp weight="duotone" className="text-muted-foreground/50 mx-auto mb-2 size-8" />
                <EmptyTitle>No contacts yet</EmptyTitle>
                <EmptyDescription>
                  Import a CSV to make your first list, or add one contact by hand.
                </EmptyDescription>
              </Empty>
            }
          />
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Deleting a whole list. Its own component so the write is a mutation rather than a
 * hook called from inside a table cell.
 */
export function DeleteListButton({
  list,
  total,
  /** Icon only in the lists table; icon and words on the list's own page. */
  label = <Trash />,
  size = 'icon',
  onDeleted,
}: {
  list: string
  total: number
  label?: React.ReactNode
  size?: 'icon' | 'sm'
  onDeleted?: () => void
}) {
  const remove = useWrite(() => api(`/leads?list=${encodeURIComponent(list)}`, { method: 'DELETE' }), {
    invalidate: ['/leads'],
    onSuccess: onDeleted,
  })

  return (
    <ConfirmButton
      destructive
      size={size}
      aria-label={size === 'icon' ? `Delete ${list}` : undefined}
      title="Delete this list?"
      description={`"${list}" and its ${total} contacts will be removed. Messages already sent stay in your campaign history.`}
      confirmLabel="Delete list"
      onConfirm={() => remove.mutateAsync()}
    >
      {label}
    </ConfirmButton>
  )
}

/**
 * One contact, typed in by hand. Only the number is required; a name and any extra
 * fields are optional, and each extra field becomes a {{tag}} usable in copy
 * exactly like an imported column.
 */
function AddContactDialog({
  open,
  onOpenChange,
  knownLists,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  knownLists: string[]
}) {
  const [list, setList] = useState(knownLists[0] ?? '')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [name, setName] = useState('')
  const [cc, setCc] = useState('91')
  const [extras, setExtras] = useState<{ key: string; value: string }[]>([])

  const submit = useWrite(
    async () => {
      const vars = Object.fromEntries(
        extras.filter(x => x.key.trim() && x.value.trim()).map(x => [x.key, x.value]),
      )
      const res = await api<{ inserted: number }>('/leads', {
        body: { list, cc, contacts: [{ phone: phoneNumber, name, vars }] },
      })
      if (!res.inserted) throw new Error('Already in this list, or on the block list')
      return res
    },
    {
      invalidate: ['/leads'],
      onSuccess: () => {
        toast.success(`Added to ${list}`)
        setPhoneNumber('')
        setName('')
        setExtras([])
        onOpenChange(false)
      },
    },
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Three rows with a scrolling middle: with a few extra fields added this form
          is taller than a phone, and the footer has to stay on screen. */}
      <DialogContent className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add one contact</DialogTitle>
          <DialogDescription>Only the number is required.</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <Field>
              <FieldLabel htmlFor="one-phone">Number</FieldLabel>
              <Input
                id="one-phone"
                autoFocus
                inputMode="tel"
                value={phoneNumber}
                placeholder="98765 43210"
                onChange={e => setPhoneNumber(e.target.value)}
                className="font-mono"
              />
              <FieldDescription>Just the digits. Spaces are fine.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="one-cc">
                <Tip tooltip="Added to the number if you leave it out.">Country code</Tip>
              </FieldLabel>
              <Input
                id="one-cc"
                inputMode="tel"
                value={cc}
                onChange={e => setCc(e.target.value)}
                className="font-mono"
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="one-name">Name</FieldLabel>
            <Input id="one-name" value={name} placeholder="Ada" onChange={e => setName(e.target.value)} />
            <FieldDescription>Optional. Used wherever your copy has {'{{name}}'}.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="one-list">List</FieldLabel>
            <Input
              id="one-list"
              value={list}
              list="add-known-lists"
              placeholder="e.g. Delhi founders"
              onChange={e => setList(e.target.value)}
            />
            <FieldDescription>Type a new name to start a list, or pick one you already have.</FieldDescription>
            <datalist id="add-known-lists">
              {knownLists.map(l => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </Field>

          {extras.map((extra, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                value={extra.key}
                aria-label="Field name"
                placeholder="Field, e.g. company"
                onChange={e => setExtras(extras.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
              />
              <Input
                value={extra.value}
                aria-label="Field value"
                placeholder="Value, e.g. Acme"
                onChange={e => setExtras(extras.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove this field"
                className="text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
                onClick={() => setExtras(extras.filter((_, j) => j !== i))}
              >
                <Trash />
              </Button>
            </div>
          ))}

          <Tip asChild tooltip="Extra fields become {{tags}} you can drop into your message copy.">
            <Button variant="ghost" size="sm" onClick={() => setExtras([...extras, { key: '', value: '' }])}>
              <Plus /> Add a field
            </Button>
          </Tip>
        </div>

        <DialogFooter>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending || !phoneNumber.trim() || !list.trim()}>
            <Check /> {submit.isPending ? 'Adding…' : 'Add contact'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
