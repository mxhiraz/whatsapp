'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * One query client for the app.
 *
 * Created in state rather than at module scope so a fast refresh in development
 * doesn't leave two clients fighting over the same cache.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The dashboard polls, so data is briefly stale by design. This stops
            // two components asking for the same endpoint from firing two requests.
            staleTime: 2_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  )
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
