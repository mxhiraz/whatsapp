'use client'

import { Suspense } from 'react'
import { InboxPanel } from '@/components/inbox-panel'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The panel reads the filter and the open conversation from the URL, and
 * `useSearchParams` has to sit inside a Suspense boundary or the whole route opts
 * out of prerendering.
 */
export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <InboxPanel />
    </Suspense>
  )
}
