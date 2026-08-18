'use client'

import { AppSidebar } from '@/components/app-sidebar'
import { SiteHeader } from '@/components/site-header'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { usePathname } from 'next/navigation'

/**
 * The dashboard shell. Every section is a real route, so the URL is the source of
 * truth for what you are looking at — back, forward, refresh and shared links all
 * behave, which a single page switching on a query string never quite does.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // The inbox is a two-pane reading view and should fill the window; every other
  // section is content-height, so a short page ends where its content ends.
  const fillsHeight = usePathname().startsWith('/inbox')

  return (
    <SidebarProvider
      style={
        {
          '--sidebar-width': 'calc(var(--spacing) * 56)',
          '--header-height': 'calc(var(--spacing) * 12)',
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" />
      {/*
        `min-w-0` stops a wide child from stretching the shell past the viewport,
        and `overflow-x-clip` is the backstop behind that: wide content scrolls
        inside its own container (a table, the header strip), and nothing is ever
        allowed to turn into a sideways scroll of the whole page. Clip rather than
        hidden, so it creates no scroll container and vertical layout is untouched.
      */}
      <SidebarInset className="min-h-0 min-w-0 overflow-x-clip">
        {/*
          The status strip is wider than a phone. Letting it scroll on its own keeps
          every chip reachable there without the page moving with it.
        */}
        <div className="w-full shrink-0 overflow-x-auto">
          <SiteHeader />
        </div>
        <div className={`flex w-full min-w-0 flex-col gap-4 p-4 lg:p-6 ${fillsHeight ? 'min-h-0 flex-1' : ''}`}>
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
