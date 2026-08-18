'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Empty, Stat, Tip } from '@/components/shared'
import { pct, type DashboardState } from '@/lib/client.ts'
import { cn } from '@/lib/utils'

/** En dash, not an em dash: it reads as "nothing here yet" without shouting. */
const DASH = '–'

export function ActivityPanel({ state }: { state: DashboardState }) {
  // Delivered and reply rate are deliberately absent: the cards at the top of this
  // page already show both, and the same number twice on one screen is clutter.
  const totals = state.campaigns.reduce(
    (a, c) => ({
      sent: a.sent + c.sent,
      pending: a.pending + c.pending,
      read: a.read + c.read,
      issues: a.issues + c.failed + c.skipped,
    }),
    { sent: 0, pending: 0, read: 0, issues: 0 },
  )
  const rate = (n: number) => (totals.sent ? pct(n / totals.sent) : DASH)
  const p = state.policy

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="tracking-tighter">All campaigns</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Metric label="Sent" value={totals.sent} />
          <Metric label="Queued" value={totals.pending} />
          <Metric
            tooltip="Share of sent messages the contact opened, shown by two ticks turning blue in WhatsApp."
            label="Read"
            value={rate(totals.read)}
          />
          <Metric
            tooltip="Messages that failed to send, plus ones a safety rule held back."
            label="Failed or skipped"
            value={totals.issues}
          />
          <Metric
            tooltip="Contacts on the never-contact list. They are never messaged again."
            label="Opted out"
            value={state.blocked}
          />
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="tracking-tighter">
              <Tip tooltip="What the sending engine did in the last few minutes. Amber lines are warnings.">
                Engine log
              </Tip>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-64 px-4 pb-4 sm:h-[420px]">
              <div className="space-y-1 text-[11px]">
                {state.log.map((l, i) => (
                  <div
                    key={i}
                    className={cn(
                      'flex gap-2',
                      l.level === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                    )}
                  >
                    <span className="tabular-nums opacity-60">{l.at.slice(11, 19)}</span>
                    <span>{l.msg}</span>
                  </div>
                ))}
              </div>
              {state.log.length === 0 ? <Empty>Nothing happening right now.</Empty> : null}
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="tracking-tighter">
              <Tip tooltip="Limits the app applies on its own so your numbers look like a person, not a robot.">
                Safety rules in force
              </Tip>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* A definition list, so each rule is a title plus one plain sentence. */}
            <ItemGroup>
              <Rule label="Warmup">
                Starts at {p.warmupStartPerDay} new contacts a day and grows {Math.round((p.warmupGrowth - 1) * 100)}%
                each day, never past {p.hardMaxPerDay} a day.
              </Rule>
              <Rule label="Daily target">
                Each number aims for {pct(p.dailyTargetJitter[0])}–{pct(p.dailyTargetJitter[1])} of its cap, re-rolled
                every day.
              </Rule>
              <Rule label="Timing">
                Gaps between sends vary instead of running on a fixed interval, with typing simulation and delayed read
                receipts. Sending is fastest 10:00–14:00 and up to 2.5× slower near the edges of the window.
              </Rule>
              <Rule label="Micro-breaks">
                Rests {p.breakMinutes[0]}–{p.breakMinutes[1]} minutes after every {p.breakEvery[0]}–{p.breakEvery[1]}{' '}
                sends.
              </Rule>
              <Rule label="Duplicate copy">
                At most {p.maxIdenticalPerWindow} identical messages per number every {p.duplicateWindowHours}h. The
                wording is re-rolled first, then the send waits.
              </Rule>
              <Rule label="Reply rate">
                Below {pct(p.replyRateWarn)} is a warning. Below {pct(p.replyRatePause)} pauses the number for{' '}
                {p.softBanPauseHours}h, once it has {p.minReplySamples} sends to judge by.
              </Rule>
              <Rule label="Delivery rate">
                Below {pct(p.deliveryFloor)} triggers the same {p.softBanPauseHours}h pause.
              </Rule>
              <Rule label="Health score">
                Each problem adds points: blocked by WhatsApp +{p.penalty.forbidden}, logged out +{p.penalty.logged_out},
                temporarily locked +{p.penalty.timelock}, failed send +{p.penalty.send_failed}, keeps disconnecting +
                {p.penalty.disconnect}. At {p.health.medium} sending slows down; at {p.health.critical} the number
                pauses {p.criticalPauseHours}h and warms up again from day 1.
              </Rule>
              <Rule label="Opt-out">
                A reply saying stop or unsubscribe blocks that contact everywhere and cancels their queued messages.
              </Rule>
            </ItemGroup>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/**
 * A headline number. Hover text only where the label cannot carry the definition:
 * "Sent" is a plain count, "Read" is a share of it and has to say so.
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

function Rule({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Item size="sm" className="items-start rounded-none px-0">
      <ItemContent>
        <ItemTitle className="text-xs">{label}</ItemTitle>
        <ItemDescription className="line-clamp-none text-xs">{children}</ItemDescription>
      </ItemContent>
    </Item>
  )
}
