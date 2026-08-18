'use client'

import {
  AddressBook,
  ChartLineUp,
  ChatCircleDots,
  Gear,
  PaperPlaneRight,
  SimCard,
} from '@phosphor-icons/react/dist/ssr'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { usePoll, type DashboardState } from '@/lib/client.ts'
import { cn } from '@/lib/utils'

/**
 * Icons are duotone at 18px on purpose: Phosphor's regular weight renders wiry at
 * sidebar size, and the two-tone fill gives each item a silhouette you can tell
 * apart at a glance instead of six similar outlines.
 */
export const SECTIONS = [
  { href: '/numbers', title: 'Numbers', icon: SimCard },
  { href: '/contacts', title: 'Contacts', icon: AddressBook },
  { href: '/campaigns', title: 'Campaigns', icon: PaperPlaneRight },
  { href: '/inbox', title: 'Inbox', icon: ChatCircleDots },
  { href: '/activity', title: 'Activity', icon: ChartLineUp },
  { href: '/settings', title: 'Settings', icon: Gear },
] as const

export type SectionHref = (typeof SECTIONS)[number]['href']


export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname()
  /*
   * On a phone the sidebar is a sheet over the page, and it does not close itself.
   * Left open it covers the section you just tapped, so navigating closes it. On
   * desktop `openMobile` is not what is showing, so this is a no-op there.
   */
  const { setOpenMobile } = useSidebar()
  const { data } = usePoll<DashboardState>('/state', 5000)
  const state: DashboardState | null = data
  /**
   * Counts render as plain muted numbers rather than badges. A badge reads as
   * "this needs attention", which is true of unread replies and misleading for
   * "you have three numbers linked" — so only the inbox count is coloured.
   */
  const counts: Partial<Record<string, number>> = {
    '/numbers': state?.senders.length,
    '/contacts': state?.lists.reduce((total, list) => total + list.total, 0),
    '/campaigns': state?.campaigns.filter(c => c.status === 'running').length,
    '/inbox': state?.replies.length,
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      {/*
        1.125rem is where the nav icons start: SidebarGroup adds p-2 and the menu
        button adds pl-2.5 for its leading icon. Matching it here puts the wordmark
        on the same left edge as every section below it.
      */}
      <SidebarHeader className="px-[1.125rem] py-3">
        <span className="text-sm font-semibold tracking-tight">WA Outreach</span>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="py-0">
          <SidebarGroupContent>
            <SidebarMenu>
              {SECTIONS.map(section => {
                const count = counts[section.href]
                const isUnread = section.href === '/inbox' && Boolean(count)
                return (
                  <SidebarMenuItem key={section.href}>
                    <SidebarMenuButton
                      asChild
                      tooltip={section.title}
                      isActive={pathname.startsWith(section.href)}
                      className="h-9 text-[15px]"
                    >
                      <Link href={section.href} onClick={() => setOpenMobile(false)}>
                        <section.icon weight="duotone" className="size-5" />
                        <span>{section.title}</span>
                        {count ? (
                          <span
                            className={cn(
                              'ml-auto text-[11px] tabular-nums',
                              isUnread ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
                            )}
                          >
                            {count}
                          </span>
                        ) : null}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
