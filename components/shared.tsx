'use client'

import { Badge } from '@/components/ui/badge'
import {
  Empty as EmptyBox,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import {
  FieldDescription,
  FieldLabel as FieldLabelBase,
} from '@/components/ui/field'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const TONE: Record<string, string> = {
  online: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  active: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  sent: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  running: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  delivered: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  qr: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  warming: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  connecting: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  paused: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  // Finished, not stopped: sky reads as "nothing left to do here" where emerald
  // would still claim the campaign is working and amber would read as a problem.
  done: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  banned: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  failed: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  opted_out: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  replied: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  read: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
}

export function Pill({ value, title }: { value: string; title?: string }) {
  return (
    <Badge variant="outline" className={cn('text-[11px] font-medium', TONE[value])} title={title}>
      {value.replace('_', ' ')}
    </Badge>
  )
}

export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="min-w-24">
      <div className="text-2xl leading-tight font-semibold tabular-nums">{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
      {hint ? <div className="text-muted-foreground/70 text-[11px]">{hint}</div> : null}
    </div>
  )
}

/**
 * Empty state for a table or panel, built on the shadcn `Empty` block.
 *
 * `title` is the one-line summary; `children` carries the explanation and any
 * call to action. Passing only `children` still works, and renders as the
 * description alone.
 */
export function Empty({
  title,
  icon,
  children,
}: {
  title?: React.ReactNode
  icon?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <EmptyBox className="border-0 py-10">
      <EmptyHeader>
        {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        {title ? <EmptyTitle>{title}</EmptyTitle> : null}
        {/*
          Plain text is wrapped so it picks up the muted description styling, while
          callers that compose `EmptyTitle` / `EmptyDescription` themselves pass
          straight through instead of being nested inside a description.
        */}
        {typeof children === 'string' ? <EmptyDescription>{children}</EmptyDescription> : children}
      </EmptyHeader>
    </EmptyBox>
  )
}

/**
 * Wraps a label in a tooltip trigger.
 *
 * The underline only appears on hover: a dozen permanently dotted labels on one
 * screen reads as noise, while a cursor change plus an underline on approach is
 * enough of an affordance. Pass `asChild` when wrapping something already
 * interactive (a button, a tab) so Radix doesn't nest one button inside another.
 */
export function Tip({
  children,
  tooltip,
  className,
  asChild,
}: {
  children: React.ReactNode
  tooltip: string
  className?: string
  asChild?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        asChild={asChild}
        className={
          asChild
            ? className
            : cn(
                // `text-left` matters: the trigger is a button, and the UA stylesheet
                // centres button text, so any label long enough to wrap rendered
                // centred next to its left-aligned neighbours.
                'cursor-help text-left underline decoration-dotted decoration-transparent underline-offset-4 transition-colors',
                'hover:decoration-muted-foreground/60',
                className,
              )
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A form label with an optional unit hint and an optional tooltip, on top of the
 * shadcn `FieldLabel`. Kept as one component because nearly every field in the
 * app needs the same three pieces, and repeating the trio at each call site is
 * how the spacing drifted apart before.
 */
export function FieldLabel({
  children,
  hint,
  tooltip,
  htmlFor,
}: {
  children: React.ReactNode
  hint?: string
  tooltip?: string
  htmlFor?: string
}) {
  return (
    <FieldLabelBase htmlFor={htmlFor} className="mb-1.5 flex items-baseline gap-2 text-xs font-medium">
      {tooltip ? <Tip tooltip={tooltip}>{children}</Tip> : <span>{children}</span>}
      {hint ? <FieldDescription className="text-[11px]">{hint}</FieldDescription> : null}
    </FieldLabelBase>
  )
}
