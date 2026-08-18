'use client'

import { Fragment, useCallback, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CalendarCheck,
  ChatCircleDots,
  MagnifyingGlass,
  PaperPlaneRight,
  Prohibit,
  ThumbsDown,
  ThumbsUp,
  WhatsappLogo,
} from '@phosphor-icons/react/dist/ssr'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Empty as EmptyState,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from '@/components/ui/item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ConfirmButton } from '@/components/confirm'
import { Empty, Pill, Tip } from '@/components/shared'
import { ago, api, phone, usePoll, useWrite, type ChatLine, type Interest, type ThreadRow } from '@/lib/client.ts'
import { cn } from '@/lib/utils'

/**
 * What each triage mark is called on screen. The list used to reuse the status
 * pill, which rendered a booked meeting as "read": the right colour, the wrong
 * word.
 */
const INTEREST: Partial<Record<Interest, string>> = {
  positive: 'interested',
  meeting: 'meeting',
  negative: 'not interested',
  neutral: 'unclear',
}

const FILTERS: { key: string; label: string; tooltip?: string }[] = [
  { key: 'unread', label: 'Unread' },
  { key: 'all', label: 'All' },
  // These two are the only ones a reader cannot work out from the word alone.
  { key: 'interested', label: 'Interested', tooltip: 'Conversations you marked interested or meeting booked.' },
  {
    key: 'opted_out',
    label: 'Opted out',
    tooltip: 'Contacts who asked you to stop. They are on the never-contact list.',
  },
]

export function InboxPanel() {
  /*
   * The filter and the open conversation live in the URL, so a reload keeps your
   * place and a conversation can be linked to. `replace` rather than `push` keeps
   * flipping filters out of the back-button history.
   */
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const filter = params.get('filter') ?? 'unread'
  const active = params.get('thread')

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString())
      if (value) next.set(key, value)
      else next.delete(key)
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [params, pathname, router],
  )

  const setFilter = useCallback((v: string) => setParam('filter', v === 'unread' ? null : v), [setParam])
  const setActive = useCallback((v: string | null) => setParam('thread', v), [setParam])

  const [search, setSearch] = useState('')
  const { data: threads } = usePoll<ThreadRow[]>(`/inbox?filter=${filter}&q=${encodeURIComponent(search)}`, 6000)
  const rows = threads ?? []
  /*
    The open conversation is a row of the list, and opening one marks it read, which
    drops it out of the unread list it came from. So the row that was opened is
    remembered as a fallback: without it, reading an unread reply closed the
    conversation on itself, which on a phone (where the conversation is the whole
    screen) reads as being thrown back to the list. The live row still wins whenever
    the list has one, so marks and blocks keep updating in place.
  */
  const [opened, setOpened] = useState<ThreadRow | null>(null)
  const current = rows.find(t => t.lead_phone === active) ?? (opened?.lead_phone === active ? opened : undefined)

  /*
    `before` is the timestamp of the newest message we had actually seen when the row
    was opened. Without it the server marks everything unread for that number as
    read, so a reply landing between the click and the request is marked read and
    disappears from the badge without anyone having read it.
  */
  const markRead = useWrite(
    ({ phone: lead, before }: { phone: string; before: string }) =>
      api('/inbox', { method: 'PATCH', body: { phone: lead, read: true, before } }),
    { invalidate: ['/inbox'] },
  )

  const open = (t: ThreadRow) => {
    setOpened(t)
    setActive(t.lead_phone)
    if (t.unread) markRead.mutate({ phone: t.lead_phone, before: t.last_at })
  }

  return (
    /*
      Two panes side by side from `lg`. Below that they take turns: the list until a
      conversation is open, then the conversation with a way back. Which pane shows
      is read straight off `?thread=` rather than held in state, so back, forward and
      a shared link all land on the same pane.
    */
    <div className="grid min-h-0 w-full flex-1 gap-3 lg:grid-cols-[320px_1fr]">
      <Card className={cn('flex min-h-0 flex-col gap-3 overflow-hidden py-3', current && 'hidden lg:flex')}>
        <CardHeader className="gap-2 px-3">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={filter}
            onValueChange={v => v && setFilter(v)}
            className="w-full"
          >
            {FILTERS.map(f => {
              const item = (
                <ToggleGroupItem value={f.key} className="flex-1 px-1.5 text-[11px]">
                  {f.label}
                </ToggleGroupItem>
              )
              return f.tooltip ? (
                <Tip asChild key={f.key} tooltip={f.tooltip}>
                  {item}
                </Tip>
              ) : (
                <Fragment key={f.key}>{item}</Fragment>
              )
            })}
          </ToggleGroup>
          <InputGroup>
            <InputGroupAddon>
              <MagnifyingGlass weight="duotone" />
            </InputGroupAddon>
            <InputGroupInput
              value={search}
              placeholder="Search name or number"
              onChange={e => setSearch(e.target.value)}
              className="text-xs"
            />
          </InputGroup>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 p-0">
          <ScrollArea className="h-full">
            <ItemGroup className="gap-0">
              {rows.map((t, i) => (
                <Fragment key={t.lead_phone}>
                  {i > 0 ? <ItemSeparator className="my-0" /> : null}
                  <Item
                    role="button"
                    tabIndex={0}
                    size="sm"
                    variant={active === t.lead_phone ? 'muted' : 'default'}
                    className="hover:bg-muted/50 cursor-pointer rounded-none"
                    onClick={() => open(t)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        open(t)
                      }
                    }}
                  >
                    <ItemContent>
                      <ItemTitle className="w-full justify-between gap-2">
                        <span className={cn('tabular-nums', t.unread > 0 && 'font-semibold')}>
                          {phone(t.lead_phone)}
                        </span>
                        <span className="text-muted-foreground text-xs font-normal tabular-nums">
                          {ago(t.last_at)}
                        </span>
                      </ItemTitle>
                      <ItemDescription className="line-clamp-1 text-xs">
                        {t.name ?? 'Name unknown'}
                        {t.list ? ` · ${t.list}` : ''}
                      </ItemDescription>
                      {t.last_body ? (
                        <ItemDescription className="line-clamp-1 text-xs opacity-70">{t.last_body}</ItemDescription>
                      ) : null}
                    </ItemContent>
                    <ItemActions className="self-start">
                      {t.unread > 0 ? (
                        <Badge className="h-4 px-1.5 text-[10px] tabular-nums">{t.unread}</Badge>
                      ) : null}
                      {t.interest && INTEREST[t.interest] ? (
                        <Badge variant="outline" className="text-[11px] font-medium">
                          {INTEREST[t.interest]}
                        </Badge>
                      ) : null}
                      {t.blocked ? <Pill value="opted_out" /> : null}
                    </ItemActions>
                  </Item>
                </Fragment>
              ))}
            </ItemGroup>
            {/* Loading is stated in words: an empty list would otherwise claim
                "no unread replies" before the first response has landed. */}
            {threads === null ? <Empty>Loading conversations…</Empty> : null}
            {threads !== null && rows.length === 0 ? (
              <Empty>{filter === 'unread' ? 'No unread replies.' : 'No conversations yet.'}</Empty>
            ) : null}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Keyed by contact so switching threads resets the draft and note naturally. */}
      {current ? (
        <Thread key={current.lead_phone} thread={current} onBack={() => setActive(null)} />
      ) : (
        // With nothing open, a phone shows the list alone: a placeholder pane under it
        // would be a second screenful of nothing.
        <Card className="hidden min-h-0 items-center justify-center lg:flex">
          <EmptyState className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChatCircleDots weight="duotone" />
              </EmptyMedia>
              <EmptyTitle className="tracking-tighter">Nothing open</EmptyTitle>
              <EmptyDescription>
                {rows.length
                  ? 'Pick a conversation on the left to read it and reply.'
                  : 'Replies to your campaigns show up here.'}
              </EmptyDescription>
            </EmptyHeader>
          </EmptyState>
        </Card>
      )}
    </div>
  )
}

function Thread({ thread, onBack }: { thread: ThreadRow; onBack: () => void }) {
  const target = thread.lead_phone
  const { data: lines } = usePoll<ChatLine[]>(`/inbox?phone=${target}`, 5000)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState(thread.note ?? '')
  const queryClient = useQueryClient()

  /** Every cached conversation list, whatever filter or search produced it. */
  const lists = {
    predicate: (q: { queryKey: readonly unknown[] }) => String(q.queryKey[0]).startsWith('/inbox?filter'),
  }

  const mark = useWrite(
    (interest: Interest) => api('/inbox', { method: 'PATCH', body: { phone: target, interest } }),
    {
      invalidate: ['/inbox'],
      onSuccess: (_data, interest) => toast.success(`Marked ${INTEREST[interest] ?? interest}`),
      /*
        The one guess worth making here: a triage mark is a button that should light
        up under the finger, a wrong guess costs nothing, and putting the old mark
        back is the whole of the undo. Sending, importing and deleting are never
        optimistic, because there the guess would claim something happened.
      */
      optimistic: interest => {
        const previous = queryClient.getQueriesData<ThreadRow[]>(lists)
        queryClient.setQueriesData<ThreadRow[]>(lists, rows =>
          rows?.map(t => (t.lead_phone === target ? { ...t, interest } : t)),
        )
        return () => previous.forEach(([key, rows]) => queryClient.setQueryData(key, rows))
      },
    },
  )

  const saveNote = useWrite((body: string) => api('/inbox', { method: 'PATCH', body: { phone: target, note: body } }), {
    invalidate: ['/inbox'],
  })

  const reply = useWrite(() => api<{ from: string }>('/inbox', { body: { to: target, body: draft } }), {
    invalidate: ['/inbox'],
    onSuccess: r => {
      toast.success(`Sent from +${r.from}`)
      setDraft('')
    },
  })

  const block = useWrite(() => api('/blocklist', { body: { phones: target } }), {
    // Blocking opts the contact out of every list, so the lists' counts move too.
    invalidate: ['/inbox', '/leads'],
    onSuccess: () => toast.success('Blocked and opted out of every list'),
  })

  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader className="gap-3">
        {/* Below `lg` this pane is the whole screen, so it needs its own way back to
            the list. It clears `?thread=`, which is what closes the conversation. */}
        <Button variant="ghost" size="sm" className="-ml-2 w-fit lg:hidden" onClick={onBack}>
          <ArrowLeft /> Conversations
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="tracking-tighter tabular-nums">{phone(target)}</CardTitle>
          {thread.name ? <span className="text-muted-foreground text-sm">{thread.name}</span> : null}
          {thread.lead_status ? <Pill value={thread.lead_status} /> : null}
        </div>
        {/* Three marks in a group, and the group does not wrap inside itself. On a
            narrow pane the row scrolls rather than being clipped by the card. */}
        <div className="-mx-1 flex flex-wrap items-center gap-2 overflow-x-auto px-1">
          <ButtonGroup>
            <Button
              size="sm"
              variant={thread.interest === 'positive' ? 'default' : 'outline'}
              onClick={() => mark.mutate('positive')}
            >
              <ThumbsUp /> Interested
            </Button>
            <Button
              size="sm"
              variant={thread.interest === 'meeting' ? 'default' : 'outline'}
              onClick={() => mark.mutate('meeting')}
            >
              <CalendarCheck /> Meeting
            </Button>
            <Button
              size="sm"
              variant={thread.interest === 'negative' ? 'default' : 'outline'}
              onClick={() => mark.mutate('negative')}
            >
              <ThumbsDown /> Not interested
            </Button>
          </ButtonGroup>
          <Button size="sm" variant="ghost" asChild>
            <a href={`https://wa.me/${target}`} target="_blank" rel="noreferrer">
              <WhatsappLogo weight="duotone" /> Open in WhatsApp
            </a>
          </Button>
          <ConfirmButton
            size="sm"
            destructive
            disabled={thread.blocked}
            title="Block this contact?"
            description={`Blocking ${phone(target)} is permanent and removes them from every list.`}
            confirmLabel="Block contact"
            onConfirm={() => block.mutateAsync()}
          >
            <Prohibit /> {thread.blocked ? 'Blocked' : 'Block and opt out'}
          </ConfirmButton>
        </div>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <ScrollArea className="min-h-0 flex-1 pr-3">
          <div className="space-y-2">
            {(lines ?? []).map((l, i) => (
              <div key={i} className={cn('flex', l.dir === 'out' ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[75%] rounded-md px-3 py-2 text-sm',
                    l.dir === 'out' ? 'bg-primary text-primary-foreground' : 'bg-muted',
                  )}
                >
                  <div className="whitespace-pre-wrap">{l.body}</div>
                  <div
                    className={cn(
                      'mt-1 text-[10px] tabular-nums',
                      l.dir === 'out' ? 'text-primary-foreground/70' : 'text-muted-foreground',
                    )}
                  >
                    {ago(l.at)}
                    {l.via ? ` · ${phone(l.via)}` : ''}
                    {l.dir === 'out' && l.seen_at ? ' · read' : ''}
                  </div>
                </div>
              </div>
            ))}
            {lines === null ? <Empty>Loading messages…</Empty> : null}
            {lines?.length === 0 ? <Empty>No messages yet.</Empty> : null}
          </div>
        </ScrollArea>

        {thread.blocked ? (
          <Alert variant="destructive">
            <Prohibit weight="duotone" />
            <AlertTitle>This contact opted out</AlertTitle>
            <AlertDescription>You can still read the history, but nothing more can be sent to them.</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-2">
            <div className="flex items-end gap-2">
              <Textarea
                value={draft}
                rows={2}
                placeholder="Write a reply"
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) reply.mutate()
                }}
              />
              <Button onClick={() => reply.mutate()} disabled={reply.isPending || !draft.trim()}>
                <PaperPlaneRight /> {reply.isPending ? 'Sending…' : 'Send'}
              </Button>
            </div>
            {/* The shortcut was buried in the placeholder, where it vanished as soon
                as you started typing. Hidden on a phone, which has no ⌘ to press. */}
            <p className="text-muted-foreground hidden text-xs sm:block">
              <KbdGroup>
                <Kbd>⌘</Kbd>
                <Kbd>Enter</Kbd>
              </KbdGroup>{' '}
              to send
            </p>
          </div>
        )}

        <Field>
          <Tip asChild tooltip="Only you see this. It is never sent to the contact.">
            <FieldLabel htmlFor="thread-note" className="text-xs">
              Private note
            </FieldLabel>
          </Tip>
          <Input
            id="thread-note"
            value={note}
            placeholder="Anything worth remembering about this contact"
            className="h-8 text-xs"
            onChange={e => setNote(e.target.value)}
            onBlur={() => note !== (thread.note ?? '') && saveNote.mutate(note)}
          />
        </Field>
      </CardContent>
    </Card>
  )
}
