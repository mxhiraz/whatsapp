'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { usePoll, type DashboardState } from '@/lib/client.ts'

/**
 * Gives a section the dashboard state and a refresh function.
 *
 * Every section reads the same `/state` query and the query cache collapses those
 * into one request, so pages ask for what they need instead of the shell drilling
 * props down through the tree.
 */
export function Section({
  children,
}: {
  children: (state: DashboardState, refresh: () => void) => React.ReactNode
}) {
  const { data: state, refresh } = usePoll<DashboardState>('/state', 5000)

  // Skeletons in the shape of the content, so the page does not jump when it lands.
  if (!state) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return <div className="space-y-4">{children(state, refresh)}</div>
}
