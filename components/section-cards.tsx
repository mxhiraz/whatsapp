'use client'

import { Card } from '@/components/ui/card'
import { Tip } from '@/components/shared'
import { pct, type DashboardState } from '@/lib/client.ts'
import { cn } from '@/lib/utils'

/** Nothing-yet marker: an en dash, never an em dash. */
const DASH = '–'

/**
 * One headline number per card: label, figure, one line of context.
 *
 * An earlier revision split each card into a header block and a differently
 * shaded footer, which read as two stacked cards, and printed policy thresholds
 * on the surface ("below 60% counts as a soft ban"). Those explanations live in
 * the label's tooltip now: permanently on screen they were only noise.
 */
function Tile({
  label,
  tooltip,
  value,
  caption,
  tone,
}: {
  label: string
  tooltip: string
  value: string
  caption: string
  tone?: 'good' | 'warn'
}) {
  const isEmpty = value === DASH
  return (
    <Card className="gap-0 p-4">
      <Tip tooltip={tooltip} className="text-muted-foreground w-fit text-xs">
        {label}
      </Tip>
      <div
        className={cn(
          'mt-1.5 tabular-nums',
          // An empty metric shouldn't shout: a muted dash reads as "nothing yet",
          // where a full-size one reads as broken.
          isEmpty ? 'text-muted-foreground/60 text-xl' : 'text-2xl',
          !isEmpty && tone === 'good' && 'text-emerald-600 dark:text-emerald-400',
          !isEmpty && tone === 'warn' && 'text-amber-600 dark:text-amber-400',
        )}
      >
        {value}
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{caption}</p>
    </Card>
  )
}

export function SectionCards({ state }: { state: DashboardState }) {
  const online = state.senders.filter(s => s.state === 'online')
  const sendable = online.filter(s => ['warming', 'active'].includes(s.status))
  const sentToday = state.senders.reduce((total, s) => total + s.sent_today, 0)
  const capToday = sendable.reduce((total, s) => total + s.cap_today, 0)
  const resting = state.senders.filter(s => s.status === 'paused' || s.state === 'banned').length

  const totals = state.campaigns.reduce(
    (acc, c) => ({
      sent: acc.sent + c.sent,
      replied: acc.replied + c.replied,
      delivered: acc.delivered + c.delivered,
    }),
    { sent: 0, replied: 0, delivered: 0 },
  )
  const replyRate = totals.sent ? totals.replied / totals.sent : 0
  const week = state.series.slice(-7).reduce((total, day) => total + day.sent, 0)
  // Below the sample size the rate is noise, so it is shown as "not yet judged".
  const enoughToJudge = totals.sent >= state.policy.minReplySamples
  const replyHealthy = replyRate >= state.policy.replyRateWarn

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Tile
        label="Numbers online"
        tooltip="Linked numbers connected right now. A paused or blocked number cannot send."
        value={`${online.length}/${state.senders.length}`}
        caption={resting ? `${resting} paused or blocked` : 'All linked numbers healthy'}
        tone={resting ? 'warn' : undefined}
      />
      <Tile
        label="Sent today"
        tooltip="Messages sent today across every number, against today's combined cap."
        value={capToday ? `${sentToday}/${capToday}` : String(sentToday)}
        caption={`${week} in the last 7 days`}
      />
      <Tile
        label="Reply rate"
        tooltip={`Share of contacted people who answered. Below ${pct(state.policy.replyRateWarn)} is a warning, and below ${pct(state.policy.replyRatePause)} pauses the number after ${state.policy.minReplySamples} sends.`}
        value={enoughToJudge ? pct(replyRate) : DASH}
        caption={
          enoughToJudge
            ? `${totals.replied} answered`
            : `${totals.sent} of ${state.policy.minReplySamples} sends needed to judge`
        }
        tone={enoughToJudge ? (replyHealthy ? 'good' : 'warn') : undefined}
      />
      <Tile
        label="Delivered"
        tooltip="Share that reached the recipient's phone. Low delivery usually means dead contacts, not a problem with your number."
        value={totals.sent ? pct(totals.delivered / totals.sent) : DASH}
        caption={totals.sent ? `${totals.delivered} of ${totals.sent} landed` : 'Nothing sent yet'}
      />
    </div>
  )
}
