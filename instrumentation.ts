/**
 * Boots the sending side once per server process: migrate, re-link every number
 * that already has stored credentials, then start the send loop. Guarded on
 * globalThis so a dev-server hot reload doesn't open a second set of sockets.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const g = globalThis as typeof globalThis & { __waBooted?: boolean }
  if (g.__waBooted) return
  g.__waBooted = true

  const { migrate, pool } = await import('./lib/db.ts')
  const { resumeAll } = await import('./lib/wa.ts')
  const { installShutdown, startEngine } = await import('./lib/engine.ts')

  await migrate()

  /*
   * One sending process per database. The WhatsApp sessions live in Postgres now, so
   * two processes sharing a database share the credentials too — and two live sockets
   * on one set of credentials is exactly what WhatsApp answers with 440 conflict, the
   * online/closed ping-pong that loses numbers. A `next dev` left running beside the
   * container is enough to cause it.
   *
   * The lock is held on a connection that is deliberately never returned to the pool,
   * because Postgres releases session locks when the connection closes and the pool
   * retires idle clients. A crashed process therefore frees it on its own. Losing the
   * race is not fatal: the dashboard still serves, only the sending side stands down.
   */
  const lock = await pool.connect()
  const held = await lock.query<{ locked: boolean }>(`select pg_try_advisory_lock(hashtext('wa-engine')) as locked`)
  if (!held.rows[0]?.locked) {
    lock.release()
    console.error('[boot] another instance of this app is already using this database: not linking numbers or sending')
    return
  }

  installShutdown() // also installs the process-level error handlers

  /*
   * The engine starts even if re-linking fails. Numbers that cannot come back are
   * reported on their own rows; refusing to start the loop over one of them would
   * stop every other number from sending too.
   */
  try {
    await resumeAll()
  } catch (e) {
    console.error(`[boot] could not resume numbers: ${(e as Error).message}`)
  }
  startEngine()
}
