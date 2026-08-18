'use client'

import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { usePathname } from 'next/navigation'
import { SECTIONS } from '@/components/app-sidebar'
import { usePoll, type DashboardState } from '@/lib/client.ts'

export function SiteHeader() {
  const pathname = usePathname()
  const title = SECTIONS.find(s => pathname.startsWith(s.href))?.title ?? 'Outreach'
  const { data: state } = usePoll<DashboardState>('/state', 5000)
  const online = (state?.senders ?? []).filter(s => s.state === 'online').length
  const sentToday = (state?.senders ?? []).reduce((a, s) => a + s.sent_today, 0)
  // Today's allowance belongs to the number, not to its socket. Filtering on
  // `state === 'online'` made the total collapse to zero whenever a connection
  // blipped, so a number that had sent one message read as "1/0 today".
  const capToday = (state?.senders ?? [])
    .filter(s => ['warming', 'active'].includes(s.status))
    .reduce((a, s) => a + s.cap_today, 0)
  const running = (state?.campaigns ?? []).filter(c => c.status === 'running').length

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <h1 className="text-base font-medium tracking-tighter">{title}</h1>
        {/*
          Hidden on a phone: three chips plus the page title do not fit 375px, and
          every number here is also on the page it summarises. The labels say what
          they are, so they carry no hover text.
        */}
        <div className="ml-auto hidden items-center gap-2 text-xs tabular-nums sm:flex">
          {state ? (
            <>
              <Badge
                variant="outline"
                className={online ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}
              >
                {online}/{state.senders.length} online
              </Badge>
              <Badge variant="outline">
                {sentToday}/{capToday} today
              </Badge>
              <Badge variant="outline">{running} running</Badge>
            </>
          ) : (
            <span className="text-muted-foreground text-xs">Loading status…</span>
          )}
        </div>
      </div>
    </header>
  )
}
