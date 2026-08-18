'use client'

import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Check, FileArrowUp, Warning } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tip } from '@/components/shared'
import { api, useWrite, type ImportPreview, type ParsedContact } from '@/lib/client.ts'
import { clearDraft, setDraft, useDraft } from '@/lib/store.ts'

/** Shown where a column has no example value. */
const DASH = '–'

const ROLES = [
  { value: 'phone', label: 'Phone number' },
  { value: 'name', label: 'Name' },
  { value: 'skip', label: "Don't import" },
]

/** Extra columns keep their own {{tag}}, so the options list is per column. */
const roleOptions = (header: string) => [
  ...ROLES.slice(0, 2),
  { value: `var:${header}`, label: `Use as {{${header}}}` },
  ROLES[2],
]

/**
 * Whether a saved mapping still describes this file: one role per column, and every
 * {{tag}} naming a header the file actually has. A file of the same width with
 * different headers is a different file, and our own guess is the better start there.
 */
const fitsFile = (roles: string[], preview: ImportPreview) =>
  roles.length === preview.columns.length &&
  roles.every(
    (role, i) => ['phone', 'name', 'skip'].includes(role) || role === `var:${preview.columns[i].header}`,
  )

/** "delhi_founders.csv" → "delhi founders", used as the default list name. */
const nameFromFile = (fileName: string) =>
  fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()

/**
 * Importing a file is a task with a beginning and an end, so it belongs in a
 * dialog rather than as a permanent form on the page. Two steps: choose the file,
 * then check the columns and tick the rows you actually want.
 */
export function ImportDialog({
  open,
  onOpenChange,
  knownLists,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  knownLists: string[]
}) {
  /*
    The list name, the country code and the column mapping are a draft, so closing
    this by mistake keeps them. The file itself is not: a CSV runs to megabytes,
    localStorage would throw on quota, and a browser cannot re-read a file on its
    own, so the parsed rows, the preview and the row selection stay in component
    state and are gone once the tab is.
  */
  const { list, cc, roles } = useDraft('import')
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const fileInput = useRef<HTMLInputElement>(null)

  /** Drops the file, not the settings: those are the part worth keeping. */
  const reset = () => {
    setCsv('')
    setFileName(null)
    setPreview(null)
    setChosen(new Set())
  }

  // A preview writes nothing (the POST is only how a whole file gets to the parser),
  // so there is nothing here to invalidate beyond the summary every write refreshes.
  const read = useWrite((body: Record<string, unknown>) => api<ImportPreview>('/leads', { body }))

  const doImport = useWrite(
    (body: Record<string, unknown>) => api<{ inserted: number; skipped: number }>('/leads', { body }),
    {
      invalidate: ['/leads'],
      onSuccess: res => {
        toast.success(
          res.skipped
            ? `${res.inserted} added to ${list}, ${res.skipped} skipped as duplicates or opted out`
            : `${res.inserted} added to ${list}`,
        )
        onOpenChange(false)
        reset()
        clearDraft('import')
      },
    },
  )

  const look = async (text: string, nextRoles?: string[]) => {
    if (!text.trim()) return
    try {
      let p = await read.mutateAsync({ csv: text, cc, list, roles: nextRoles, preview: true })
      let used = nextRoles ?? p.columns.map(c => c.role)
      // A mapping corrected by hand outranks our guess, but only on a file it still
      // fits. The preview is then asked for again, because the counts it reports
      // depend on which column is the phone.
      if (!nextRoles && fitsFile(roles, p) && roles.join() !== used.join()) {
        used = roles
        p = await read.mutateAsync({ csv: text, cc, list, roles: used, preview: true })
      }
      setPreview(p)
      setDraft('import', { roles: used })
      // Everything is selected by default: the common case is "import the file".
      setChosen(new Set(p.contacts.map(c => c.phone)))
    } catch {
      // The failure has already been reported once, from the mutation.
    }
  }

  const loadFile = async (file: File) => {
    const text = await file.text()
    setCsv(text)
    setFileName(file.name)
    // Falls back to the raw file name: a list name is required to import, and the
    // second step has no field to type one in, so it must never arrive there empty.
    if (!list.trim()) setDraft('import', { list: nameFromFile(file.name) || file.name })
    void look(text)
  }

  const setRole = (index: number, role: string) => {
    const next = roles.map((r, i) => (i === index ? role : r))
    // Only one column can be the phone, and only one can be the name.
    if (role === 'phone' || role === 'name') {
      next.forEach((r, i) => {
        if (i !== index && r === role) next[i] = `var:${preview!.columns[i].header}`
      })
    }
    void look(csv, next)
  }

  const toggle = (phone: string) => {
    const next = new Set(chosen)
    if (next.has(phone)) next.delete(phone)
    else next.add(phone)
    setChosen(next)
  }

  const busy = read.isPending || doImport.isPending

  /** With a picker, only the ticked rows are sent. Past the picker limit the whole
      file goes through the CSV path instead, which streams in one query. */
  const importBody = () =>
    preview?.truncated
      ? { list, cc, csv, roles }
      : { list, cc, contacts: (preview?.contacts ?? []).filter(c => chosen.has(c.phone)) }

  const phoneMapped = roles.includes('phone')

  /**
   * Why the import cannot run yet, or null when it can. One reason at a time, in
   * the order they have to be fixed: a disabled button with nothing next to it is
   * a dead end, and three warnings at once is no clearer than none.
   */
  const blocked =
    !phoneMapped
      ? 'Set one column to Phone number first.'
      : !list.trim()
        ? 'Give the list a name first.'
        : preview && !preview.truncated && chosen.size === 0
          ? 'Tick at least one row to import.'
          : null

  return (
    // Closing keeps the file and the mapping: the only way to start over is the
    // "Choose another file" button, which says so.
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        A three-part flex column: header, one scrolling body, pinned footer. The
        `overflow-hidden` is what keeps the footer and the body out of each other's
        way — without it a body that fails to shrink paints straight through the
        action row. `dvh` rather than `vh` so a mobile browser's toolbar counts, and
        the base `gap-6` drops to `gap-4` to buy back a row of content at 700px tall.
      */}
      <DialogContent className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{preview ? 'Check what we found' : 'Import contacts'}</DialogTitle>
          <DialogDescription>
            {preview
              ? `${preview.rows} ${preview.rows === 1 ? 'row' : 'rows'} read from ${fileName}. Fix anything we got wrong, then choose who to import.`
              : 'Any spreadsheet export works. Nothing is saved until you confirm.'}
          </DialogDescription>
        </DialogHeader>

        {/*
          Both steps share one scroll container, so neither can outgrow the dialog.
          `min-h-0` is the load-bearing half: without it a flex item refuses to
          shrink below its content and pushes the footer off the bottom instead.
          Radix wraps the content in a `display: table` div, which shrink-wraps and
          lets a wide table widen the whole body; forcing it back to `block` keeps
          every table's own `overflow-x-auto` in charge of its width.
        */}
        <div className="min-h-0 overflow-y-auto pr-3">
          {!preview ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <Field>
                  <FieldLabel htmlFor="import-list">List name</FieldLabel>
                  <Input
                    id="import-list"
                    value={list}
                    list="import-known-lists"
                    placeholder="e.g. Delhi founders"
                    onChange={e => setDraft('import', { list: e.target.value })}
                  />
                  <FieldDescription>Type a new name to start a list, or pick one you already have.</FieldDescription>
                  <datalist id="import-known-lists">
                    {knownLists.map(l => (
                      <option key={l} value={l} />
                    ))}
                  </datalist>
                </Field>
                <Field>
                  <FieldLabel htmlFor="import-cc">
                    <Tip tooltip="Added to any number in the file that is missing one.">Country code</Tip>
                  </FieldLabel>
                  <Input
                    id="import-cc"
                    inputMode="tel"
                    value={cc}
                    onChange={e => setDraft('import', { cc: e.target.value })}
                    className="font-mono"
                  />
                </Field>
              </div>

              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInput.current?.click()}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click()
                }}
                onDragOver={e => e.preventDefault()}
                onDrop={e => {
                  e.preventDefault()
                  const file = e.dataTransfer.files?.[0]
                  if (file) void loadFile(file)
                }}
                className="hover:bg-muted/40 flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed px-6 py-10 text-center transition-colors"
              >
                <FileArrowUp weight="duotone" className="text-muted-foreground size-7" />
                <p className="text-sm font-medium">{busy ? 'Reading your file…' : 'Drop a CSV here, or click to choose'}</p>
                <p className="text-muted-foreground text-xs">
                  CSV, TSV or plain text. Commas, semicolons or tabs. Headers optional.
                </p>
                <Input
                  ref={fileInput}
                  type="file"
                  accept=".csv,.txt,.tsv"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) void loadFile(file)
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="mb-2">
                  <p className="text-sm font-medium">Columns</p>
                  <p className="text-muted-foreground text-xs">
                    {busy
                      ? 'Reading your file…'
                      : 'We guessed what each column holds. Change anything we got wrong.'}
                  </p>
                  {/*
                    The amber footer hint is easy to miss next to a disabled button, and
                    colour on its own is not a signal, so the requirement is also stated
                    here in words with an icon, beside the control that satisfies it.
                  */}
                  {!phoneMapped ? (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                      <Warning weight="fill" className="size-3.5 shrink-0" />
                      Required: set one column to Phone number.
                    </p>
                  ) : null}
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Column</TableHead>
                      <TableHead>Example</TableHead>
                      <TableHead className="w-36 sm:w-52">
                        <Tip tooltip="One column must be the phone number. Any other column can become a {{tag}} for your message copy.">
                          Import as
                        </Tip>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.columns.map(c => (
                      <TableRow key={c.index}>
                        {/* A spreadsheet header can be a sentence, and a nowrap cell
                            would hold the whole table wider than the dialog. */}
                        <TableCell className="max-w-32 font-medium break-words whitespace-normal sm:max-w-none">
                          {c.header}
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-20 truncate text-xs sm:max-w-40">
                          {c.samples.filter(Boolean)[0] ?? DASH}
                        </TableCell>
                        <TableCell>
                          <Select value={roles[c.index]} onValueChange={v => setRole(c.index, v)}>
                            <SelectTrigger className="w-full" size="sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {roleOptions(c.header).map(o => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <ImportFacts preview={preview} phoneMapped={phoneMapped} />

              {preview.truncated ? (
                <p className="text-muted-foreground text-xs">
                  This file is too big to select rows one by one, so every usable row will be imported.
                </p>
              ) : preview.contacts.length ? (
                <RowPicker
                  contacts={preview.contacts}
                  chosen={chosen}
                  onToggle={toggle}
                  onAll={() => setChosen(new Set(preview.contacts.map(c => c.phone)))}
                  onNone={() => setChosen(new Set())}
                />
              ) : null}

              {/*
                Only worth listing when a phone column is mapped. With none mapped
                every row lands here with the same reason, which reads as 95 broken
                rows when the file is fine and the mapping is not.
              */}
              {phoneMapped && preview.bad.length ? (
                <div>
                  <p className="text-sm font-medium">Rows we could not read</p>
                  <p className="text-muted-foreground mb-2 text-xs">
                    These are left out. Fix them in your spreadsheet and import the file again if you need them.
                  </p>
                  <div className="space-y-1.5">
                    {preview.bad.map(b => (
                      <div key={b.line} className="text-muted-foreground text-xs">
                        <span className="tabular-nums">Row {b.line}</span>: {b.reason}
                        {/* The line itself is the one thing here that is literally file
                            content, so it is the one thing that keeps the mono font. */}
                        {b.raw ? <div className="text-muted-foreground/70 truncate font-mono">{b.raw}</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {preview ? (
          <DialogFooter className="shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <Button variant="ghost" onClick={reset} className="sm:mr-auto">
              <ArrowLeft /> Choose another file
            </Button>
            {/* One reason at a time, in the order the user has to fix them, so the
                disabled button below always says why it is disabled. */}
            {blocked ? (
              <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <Warning weight="fill" className="size-3.5 shrink-0" />
                {blocked}
              </span>
            ) : null}
            <Button onClick={() => doImport.mutate(importBody())} disabled={busy || Boolean(blocked)}>
              <Check />
              {doImport.isPending ? 'Importing…' : `Import ${preview.truncated ? preview.valid : chosen.size} contacts`}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The counts that decide whether an import is worth going ahead with, led by one
 * plain sentence so the decision can be made without reading the grid at all.
 */
function ImportFacts({ preview, phoneMapped }: { preview: ImportPreview; phoneMapped: boolean }) {
  const facts: { label: string; value: number; tooltip?: string; warn?: boolean }[] = [
    { label: 'Ready to import', value: preview.valid },
    {
      label: 'Repeated in the file',
      value: preview.duplicates,
      tooltip: 'The same number appears more than once in this file, so it is imported once.',
    },
    {
      label: 'Already in this list',
      value: preview.in_list,
      tooltip: 'Already in the list you are importing into, so they are left as they are.',
    },
    {
      label: 'In another list',
      value: preview.in_other_list,
      tooltip: "Already in one of your other lists. Campaigns won't message the same number twice during the cooldown.",
    },
    {
      label: 'Opted out',
      value: preview.blocked,
      tooltip: 'On your block list because they asked to stop, so they are never imported.',
      warn: preview.blocked > 0,
    },
    /**
     * "Could not read" is only true of a row when there is a phone column to read.
     * With none mapped, every row in the file lands in `bad` for one reason: the
     * mapping. Blaming the file for that is both wrong and alarming, so the tile
     * names the missing mapping instead.
     */
    phoneMapped
      ? {
          label: 'Could not read',
          value: preview.badCount,
          tooltip: 'Rows whose phone cell we could not make sense of. They are listed below with their line numbers.',
          warn: preview.badCount > 0,
        }
      : {
          label: 'Waiting on a phone column',
          value: preview.rows,
          tooltip: 'These rows were read fine. They cannot be imported until one column is set to Phone number.',
          warn: true,
        },
  ]

  // Only the numbers that are actually non-zero belong in the sentence: a
  // sentence listing five zeroes is harder to read than no sentence at all.
  const setAside = facts
    .slice(1)
    .filter(f => f.value > 0)
    .map(f => `${f.value} ${f.label.toLowerCase()}`)

  return (
    <div>
      <p className="text-sm font-medium">What this will do</p>
      {/*
        With no phone column mapped there is nothing to count, so the sentence says
        what is missing and where to fix it rather than reporting a row tally that
        makes a perfectly readable file look broken.
      */}
      {phoneMapped ? (
        <p className="mb-3 text-sm">
          {`${preview.valid} of ${preview.rows} ${preview.rows === 1 ? 'row is' : 'rows are'} ready to import.`}
          {setAside.length ? (
            <span className="text-muted-foreground">{` Set aside: ${setAside.join(', ')}.`}</span>
          ) : null}
        </p>
      ) : (
        <p className="mb-3 text-sm">
          None of these rows can be imported yet: no column is set as the phone number. Pick one under Import as
          above.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {facts.map(f => (
          <div key={f.label} className="flex items-baseline justify-between gap-2 rounded-md border px-3 py-2">
            {f.tooltip ? (
              <Tip tooltip={f.tooltip} className="text-muted-foreground text-xs">
                {f.label}
              </Tip>
            ) : (
              <span className="text-muted-foreground text-xs">{f.label}</span>
            )}
            <span
              className={
                f.warn ? 'text-sm tabular-nums text-amber-600 dark:text-amber-400' : 'text-sm tabular-nums'
              }
            >
              {f.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Per-row checkboxes, so a file can be imported in part rather than whole. */
function RowPicker({
  contacts,
  chosen,
  onToggle,
  onAll,
  onNone,
}: {
  contacts: ParsedContact[]
  chosen: Set<string>
  onToggle: (phone: string) => void
  onAll: () => void
  onNone: () => void
}) {
  const allChosen = chosen.size === contacts.length && contacts.length > 0
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Who to import</p>
        <span className="text-muted-foreground text-xs tabular-nums">
          {chosen.size} of {contacts.length} selected
        </span>
        <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={allChosen ? onNone : onAll}>
          {allChosen ? 'Select none' : 'Select all'}
        </Button>
      </div>
      <div className="max-h-72 overflow-auto rounded-md border">
        <Table>
          <TableBody>
            {contacts.map(c => {
              const extras = Object.entries(c.vars)
              return (
                <TableRow key={c.phone} className="cursor-pointer" onClick={() => onToggle(c.phone)}>
                  <TableCell className="w-10">
                    <Checkbox checked={chosen.has(c.phone)} aria-label={`Import ${c.phone}`} />
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">+{c.phone}</TableCell>
                  <TableCell className="max-w-28 truncate text-sm sm:max-w-none">{c.name ?? DASH}</TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-72 truncate text-xs sm:table-cell">
                    {extras.length ? extras.map(([k, v]) => `${k}: ${v}`).join(' · ') : ''}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
