'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Check,
  DownloadSimple,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
} from '@phosphor-icons/react/dist/ssr'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { ConfirmButton } from '@/components/confirm'
import { DataTable, PlainHeader, SortableHeader } from '@/components/data-table/data-table'
import { type TableFeatures } from '@/components/data-table/features'
import { Empty, Pill, Tip } from '@/components/shared'
import { api, useWrite, type DashboardState, type Lead, type ListRow } from '@/lib/client.ts'
import { DeleteListButton } from '@/components/leads-panel'

/** Matches the cap in GET /api/leads: past this, only the newest contacts come back. */
const MAX_ROWS = 500

/** Shown where a contact has no value for a column. */
const DASH = '–'

const helper = createColumnHelper<TableFeatures, Lead>()

/**
 * One contact list on its own page, reached from the lists table. It was a dialog
 * before, which meant the URL never changed: a refresh threw you back to the list
 * of lists and there was no link to send anyone.
 */
export function ListDetailPanel({ list, state }: { list: string; state: DashboardState }) {
  const row = state.lists.find(l => l.list === list) ?? null

  if (!row) {
    return (
      <Card>
        <CardContent className="py-10">
          <Empty>That list no longer exists.</Empty>
          <div className="mt-4 flex justify-center">
            <Button asChild variant="secondary" size="sm">
              <Link href="/contacts">
                <ArrowLeft /> Back to contacts
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Keyed by list name: opening a different list remounts the body with fresh
  // search state instead of syncing leftover state across lists via an effect.
  return <ListDetailBody key={row.list} row={row} />
}

function ListDetailBody({ row }: { row: ListRow }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [editing, setEditing] = useState<Lead | null>(null)
  const list = row.list

  // Wait for a pause in typing before firing a request, so a fast typist doesn't
  // queue a network call per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250)
    return () => clearTimeout(t)
  }, [q])

  const { data, isLoading } = useQuery({
    queryKey: ['/leads', list, debouncedQ],
    queryFn: () => api<Lead[]>(`/leads?list=${encodeURIComponent(list)}&q=${encodeURIComponent(debouncedQ)}`),
  })
  const contacts = data ?? []
  // The API caps an unsearched list, so the sub-line has to say so rather than
  // quietly reporting the capped number as the whole list.
  const capped = !debouncedQ && row.total > MAX_ROWS

  // Built here rather than at module scope because the per-row actions open the
  // edit dialog.
  const columns = useMemo(
    () =>
      helper.columns([
        // Accessors are declared as returning `unknown` because the shared header
        // takes a column whose cell value is untyped; cells read the row itself.
        helper.accessor((c): unknown => c.phone, {
          id: 'phone',
          header: ({ column }) => <SortableHeader column={column} title="Number" />,
          cell: ({ row }) => (
            <>
              <span className="text-sm tabular-nums">+{row.original.phone}</span>
              {/* Below `sm` the name column is hidden, so the name rides along with
                  the number it belongs to rather than dropping off the screen. */}
              {row.original.name ? (
                <div className="text-muted-foreground text-xs sm:hidden">{row.original.name}</div>
              ) : null}
            </>
          ),
        }),
        helper.accessor((c): unknown => c.name ?? '', {
          id: 'name',
          meta: { className: 'hidden sm:table-cell' },
          header: ({ column }) => <SortableHeader column={column} title="Name" />,
          cell: ({ row }) => <span className="text-sm">{row.original.name || DASH}</span>,
        }),
        helper.display({
          id: 'vars',
          meta: { className: 'hidden md:table-cell' },
          enableSorting: false,
          header: () => <PlainHeader title="Extra fields" tooltip="Your own columns, usable as {{tags}} in copy." />,
          cell: ({ row }) => {
            const extras = Object.entries(row.original.vars)
            return (
              <div className="text-muted-foreground max-w-56 truncate text-xs">
                {extras.length ? extras.map(([k, v]) => `${k}: ${v}`).join(' · ') : DASH}
              </div>
            )
          },
        }),
        helper.accessor((c): unknown => c.status, {
          id: 'status',
          header: ({ column }) => <SortableHeader column={column} title="Status" />,
          cell: ({ row }) => (
            <div className="space-x-1 whitespace-nowrap">
              <Pill value={row.original.status} />
              {row.original.interest !== 'unset' ? <Pill value={row.original.interest} /> : null}
            </div>
          ),
        }),
        helper.display({
          id: 'actions',
          enableSorting: false,
          enableHiding: false,
          header: () => <PlainHeader title="Actions" align="right" />,
          cell: ({ row }) => (
            <div className="text-right whitespace-nowrap">
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit +${row.original.phone}`}
                onClick={() => setEditing(row.original)}
              >
                <PencilSimple />
              </Button>
              <DeleteContactButton id={row.original.id} phone={row.original.phone} list={list} />
            </div>
          ),
        }),
      ]),
    [list],
  )

  return (
    <div className="space-y-4">
      {/* A breadcrumb rather than a back button: it names where you are as well as
          where you came from, and matches the URL you can now link to. */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/contacts">Contacts</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{list}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tighter">{list}</h1>
        <Tip
          tooltip={
            capped
              ? `This list has ${row.total} contacts, which is more than one page can show. Search to reach the rest.`
              : 'Contacts currently shown in the table below.'
          }
          className="text-muted-foreground text-xs tabular-nums"
        >
          {capped
            ? `Newest ${MAX_ROWS} of ${row.total}`
            : `${contacts.length} contact${contacts.length === 1 ? '' : 's'}`}
        </Tip>
        <div className="ml-auto flex items-center gap-1">
          <a
            href={`/api/export?list=${encodeURIComponent(list)}`}
            download
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            <DownloadSimple /> Export
          </a>
          <DeleteListButton
            list={list}
            total={row.total}
            label={<><Trash /> Delete list</>}
            size="sm"
            onDeleted={() => router.push('/contacts')}
          />
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4">
          <InputGroup>
            <InputGroupAddon>
              <MagnifyingGlass />
            </InputGroupAddon>
            <InputGroupInput
              value={q}
              aria-label="Search this list"
              onChange={e => setQ(e.target.value)}
              placeholder="Search by name or number"
            />
          </InputGroup>

          {/* No `searchColumn`: search is the server-side box above, which looks
              through the whole list rather than only the rows on this page. */}
          <DataTable
            columns={columns}
            data={contacts}
            empty={
              isLoading ? (
                <Empty>Loading contacts…</Empty>
              ) : (
                <Empty>
                  <EmptyTitle>{debouncedQ ? 'Nothing matches your search' : 'No contacts in this list'}</EmptyTitle>
                  <EmptyDescription>
                    {debouncedQ
                      ? 'Try part of a name, or the last few digits of a number.'
                      : 'Import a CSV or add one contact from the contacts page.'}
                  </EmptyDescription>
                </Empty>
              )
            }
          />
        </CardContent>
      </Card>

      <EditContactDialog contact={editing} onOpenChange={open => !open && setEditing(null)} />
    </div>
  )
}

/** Deleting one contact. Its own component so the write can be a real mutation. */
function DeleteContactButton({ id, phone, list }: { id: number; phone: string; list: string }) {
  const remove = useWrite(() => api(`/leads/${id}`, { method: 'DELETE' }), { invalidate: ['/leads'] })

  return (
    <ConfirmButton
      destructive
      size="icon"
      aria-label={`Delete +${phone}`}
      title="Delete this contact?"
      description={`+${phone} will be removed from "${list}".`}
      confirmLabel="Delete"
      onConfirm={() => remove.mutateAsync()}
    >
      <Trash />
    </ConfirmButton>
  )
}

/**
 * Edits one contact's number, name and extra fields. A small dialog rather than
 * an inline row, since a row edit would need to fit an open-ended list of fields.
 */
function EditContactDialog({
  contact,
  onOpenChange,
}: {
  contact: Lead | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={contact !== null} onOpenChange={onOpenChange}>
      {/* Header, scrolling body, pinned footer. The form's own fragment supplies the
          last two grid rows, so an open-ended list of extra fields scrolls inside the
          dialog instead of pushing Save off a phone screen. */}
      <DialogContent className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit contact</DialogTitle>
        </DialogHeader>
        {/* Keyed by contact id: opening a different contact remounts the form with
            fresh initial state instead of syncing props into state via an effect. */}
        {contact ? (
          <EditContactForm key={contact.id} contact={contact} onSaved={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function EditContactForm({ contact, onSaved }: { contact: Lead; onSaved: () => void }) {
  const [phoneNumber, setPhoneNumber] = useState(contact.phone)
  const [name, setName] = useState(contact.name ?? '')
  const [extras, setExtras] = useState(() => Object.entries(contact.vars).map(([key, value]) => ({ key, value })))

  const submit = useWrite(
    () => {
      const vars = Object.fromEntries(
        extras.filter(x => x.key.trim() && x.value.trim()).map(x => [x.key, x.value]),
      )
      return api(`/leads/${contact.id}`, { method: 'PATCH', body: { phone: phoneNumber, name, vars } })
    },
    {
      invalidate: ['/leads'],
      onSuccess: () => {
        toast.success('Contact updated')
        onSaved()
      },
    },
  )

  return (
    <>
      <div className="min-h-0 space-y-4 overflow-y-auto pr-3">
        <Field>
          <FieldLabel htmlFor="edit-phone">Number</FieldLabel>
          <Input
            id="edit-phone"
            autoFocus
            inputMode="tel"
            value={phoneNumber}
            onChange={e => setPhoneNumber(e.target.value)}
            className="font-mono"
          />
          <FieldDescription>Include the country code, without the plus sign.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="edit-name">Name</FieldLabel>
          <Input id="edit-name" value={name} onChange={e => setName(e.target.value)} />
          <FieldDescription>Optional. Used wherever your copy has {'{{name}}'}.</FieldDescription>
        </Field>

        {extras.map((extra, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input
              value={extra.key}
              aria-label="Field name"
              placeholder="Field"
              onChange={e => setExtras(extras.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
            />
            <Input
              value={extra.value}
              aria-label="Field value"
              placeholder="Value"
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
        <Button onClick={() => submit.mutate()} disabled={submit.isPending || !phoneNumber.trim()}>
          <Check /> {submit.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </>
  )
}
