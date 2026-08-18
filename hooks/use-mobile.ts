import * as React from "react"

const MOBILE_BREAKPOINT = 768

const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * Tracks the mobile breakpoint through `useSyncExternalStore`.
 *
 * The upstream shadcn version sets state inside an effect, which this project's
 * lint rules reject (it causes a cascading render on mount). A media query is an
 * external store, so subscribing to it directly is both the idiomatic React fix
 * and one less render. Re-running `shadcn add sidebar --overwrite` restores the
 * upstream file, so this rewrite has to be reapplied after that.
 */
const subscribe = (onChange: () => void): (() => void) => {
  const mql = window.matchMedia(query)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // Server render has no viewport; desktop is the safer default for a dashboard.
    () => false,
  )
}
