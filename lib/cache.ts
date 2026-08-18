import assert from 'node:assert/strict'

/**
 * Tiny in-process TTL cache with in-flight de-duplication.
 *
 * The dashboard polls /api/state every 5s from every open tab, and the send loop
 * asks for sender health on every tick. Without this, ten tabs meant ten full
 * aggregate passes over `messages` per poll. With it, concurrent callers share
 * one query and the result is reused for `ms`.
 *
 * Deliberately process-local: this is a single-process app, so an external cache
 * would be one more thing to run for no gain. Swap it out if you ever shard the
 * engine across processes — not before.
 */

/** Clears for caches registered with `{ onWrite: true }`. See `invalidate()`. */
const onWrite = new Set<() => void>()

/**
 * Drops every cache that tracks something an operator can change from the UI.
 *
 * A TTL alone is the wrong tool for those: the browser invalidates its own query
 * cache the instant a write returns, so the refetch that follows a Pause lands
 * inside the TTL window every single time and shows the operator the state they
 * just changed away from. Writes call this so the next read is a real read.
 */
export function invalidate(): void {
  for (const clear of onWrite) clear()
}

export function ttlCache<T>(
  ms: number,
  fn: () => Promise<T>,
  opts: { onWrite?: boolean } = {},
): (() => Promise<T>) & { clear: () => void } {
  let value: T | undefined
  let at = 0
  let inFlight: Promise<T> | null = null
  /**
   * Bumped by every clear. A fetch that was already in flight when the cache was
   * cleared read the database before the write committed, so committing its result
   * would re-cache the stale answer for another full TTL — the exact staleness the
   * clear existed to remove.
   */
  let generation = 0

  const get = async (): Promise<T> => {
    if (value !== undefined && Date.now() - at < ms) return value
    if (inFlight) return inFlight // a concurrent caller is already fetching
    const started = generation
    inFlight = fn()
      .then(result => {
        if (started === generation) {
          value = result
          at = Date.now()
        }
        return result
      })
      .finally(() => { inFlight = null })
    return inFlight
  }

  get.clear = () => { value = undefined; at = 0; generation++ }
  if (opts.onWrite) onWrite.add(get.clear)
  return get
}

if (import.meta.filename === process.argv[1]) {
  let value = 'first'
  let calls = 0
  const cached = ttlCache(60_000, async () => { calls++; return value }, { onWrite: true })

  assert.equal(await cached(), 'first')
  value = 'second'
  assert.equal(await cached(), 'first', 'served from cache inside the TTL')
  assert.equal(calls, 1)

  invalidate()
  assert.equal(await cached(), 'second', 'a write drops the cache instead of waiting out the TTL')

  // The race the dashboard actually hits: a poll is already in flight (and has
  // already read the old row) when the operator's write lands. Its result must not
  // be cached, or Pause reads as "running" for another full TTL.
  let release: (v: string) => void = () => {}
  const slow = ttlCache(60_000, () => new Promise<string>(r => { release = r }))
  const inFlight = slow()
  slow.clear()
  release('stale')
  assert.equal(await inFlight, 'stale', 'the caller that asked for it still gets an answer')
  release = () => {}
  const after = slow()
  release('fresh')
  assert.equal(await after, 'fresh', 'the cleared fetch did not re-cache what the write replaced')

  console.log('cache.ts ok')
}
