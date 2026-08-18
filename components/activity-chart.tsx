'use client'

import { useState } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tip } from '@/components/shared'
import type { DashboardState } from '@/lib/client.ts'

const config = {
  sent: { label: 'Sent', color: 'var(--chart-1)' },
  replies: { label: 'Replies', color: 'var(--chart-2)' },
} satisfies ChartConfig

const RANGES = [
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
] as const

export function ActivityChart({ state }: { state: DashboardState }) {
  const [range, setRange] = useState<string>('30')
  const data = state.series.slice(-Number(range))
  const sent = data.reduce((a, d) => a + d.sent, 0)
  const replies = data.reduce((a, d) => a + d.replies, 0)

  return (
    <Card className="@container/card">
      {/*
        One column below `sm`: the title is a sentence of numbers and the range
        picker is 150px wide, and side by side at 375px neither had room.
      */}
      <CardHeader className="grid-cols-1 sm:grid-cols-[1fr_auto]">
        <CardDescription>
          <Tip tooltip="Messages sent each day, and replies that came back that same day." className="w-fit">
            Sends and replies
          </Tip>
        </CardDescription>
        <CardTitle className="text-2xl font-semibold tracking-tighter tabular-nums">
          {sent} sent · {replies} replies
        </CardTitle>
        <CardAction className="col-start-1 row-start-3 justify-self-start sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-self-end">
          <ToggleGroup
            type="single"
            value={range}
            onValueChange={v => v && setRange(v)}
            variant="outline"
            size="sm"
            spacing={0}
          >
            {RANGES.map(r => (
              <ToggleGroupItem key={r.key} value={r.key}>
                {r.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <ChartContainer config={config} className="aspect-auto h-[240px] w-full px-2 pb-4 sm:px-4 lg:px-6">
        <AreaChart data={data}>
          <defs>
            {Object.entries(config).map(([key, cfg]) => (
              <linearGradient key={key} id={`fill-${key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={cfg.color} stopOpacity={0.8} />
                <stop offset="95%" stopColor={cfg.color} stopOpacity={0.1} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} />
          {/*
            Both series are counts, so they cannot be negative. The axis is pinned
            at zero to say so, but the floor alone would only crop a wrong curve:
            the fix is the curve type on the areas below.
          */}
          <YAxis hide domain={[0, 'auto']} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={v => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                labelFormatter={v => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                indicator="dot"
              />
            }
          />
          {/*
            `monotone`, not `natural`. Recharts' natural and basis curves are splines
            that overshoot their own data points, so a 0, 0, 1 run of days bulged the
            line below the baseline on the way up: a negative number of messages,
            which is not a thing that can happen. Monotone interpolation never leaves
            the range of the values it joins, so every point on the curve is a number
            the data actually supports.
          */}
          {/*
            Not stacked. Replies are a subset of sends, so stacking them would draw a
            total that means nothing; two overlapping areas from the same baseline let
            you read each series against the axis. The previous code passed different
            stackIds, which silently did this anyway.
          */}
          <Area dataKey="sent" type="monotone" fill="url(#fill-sent)" stroke="var(--chart-1)" />
          <Area dataKey="replies" type="monotone" fill="url(#fill-replies)" stroke="var(--chart-2)" />
        </AreaChart>
      </ChartContainer>
    </Card>
  )
}
