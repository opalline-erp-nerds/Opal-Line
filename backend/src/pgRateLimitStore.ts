import type { Store, Options,  IncrementResponse } from 'express-rate-limit'
import { getRawClient } from './db/client'
import { logger } from './logger'

type RateLimitClientProvider = () => ReturnType<typeof getRawClient>

/**
 * Postgres-backed hit counter store for express-rate-limit.
 *
 * The default MemoryStore keeps counters in process memory, so restarting the
 * backend wipes every per-IP login/password-reset counter — an attacker can
 * simply wait for (or trigger) a restart to reset their budget. This store
 * keeps the counters in the `rate_limit_hits` table so they survive restarts.
 *
 * Fail-open: if the DB is unreachable the request passes through (the account
 * lockout in login_attempts still protects credentials independently).
 *
 * Table shape (bootstrap.ts):
 *   rate_limit_hits(key text PRIMARY KEY, count integer, reset_at timestamp)
 *
 * Counter semantics: a row is valid until `reset_at`; on first hit inside an
 * expired window the counter restarts at 1 with a fresh window.
 */
export class PgRateLimitStore implements Store {
  /** Window length, learned from middleware options in init(). */
  private windowMs = 0
  /** Distinct per-limiter key prefix (required public member of Store). */
  readonly prefix: string

  constructor(
    prefix: string,
    private readonly getClient: RateLimitClientProvider = getRawClient,
  ) {
    // Distinct prefix per limiter so login and password-reset budgets don't
    // share keys in the same table.
    this.prefix = prefix
  }

  init(options: Options): void {
    this.windowMs = options.windowMs
  }

  async increment(key: string): Promise<IncrementResponse> {
    const client = this.getClient()
    if (!client || !this.windowMs) {
      // No DB: fail open with a count that never blocks.
      return { totalHits: 0, resetTime: undefined }
    }
    const fullKey = `${this.prefix}:${key}`
    const windowEnd = new Date(Date.now() + this.windowMs)
    try {
      const rows = await client`
        INSERT INTO rate_limit_hits (key, count, reset_at)
        VALUES (${fullKey}, 1, ${windowEnd.toISOString()})
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN rate_limit_hits.reset_at > now() THEN rate_limit_hits.count + 1 ELSE 1 END,
          reset_at = CASE WHEN rate_limit_hits.reset_at > now() THEN rate_limit_hits.reset_at ELSE ${windowEnd.toISOString()}::timestamptz END
        RETURNING count, reset_at
      `
      const row = rows[0] as { count: number | string; reset_at: Date | string } | undefined
      const totalHits = Number(row?.count ?? 1)
      const resetTime = row?.reset_at ? new Date(row.reset_at) : windowEnd
      return { totalHits, resetTime }
    } catch (err) {
      // Documented fail-open contract: a DB outage must not lock every user
      // out. The credential lockout in login_attempts remains in force.
      logger.warn({ err, prefix: this.prefix }, 'Rate-limit DB query failed — failing open')
      return { totalHits: 0, resetTime: undefined }
    }
  }

  async decrement(key: string): Promise<void> {
    const client = this.getClient()
    if (!client) return
    const fullKey = `${this.prefix}:${key}`
    await client`
      UPDATE rate_limit_hits
      SET count = GREATEST(count - 1, 0)
      WHERE key = ${fullKey} AND reset_at > now()
    `.catch(() => undefined)
  }

  async resetKey(key: string): Promise<void> {
    const client = this.getClient()
    if (!client) return
    await client`DELETE FROM rate_limit_hits WHERE key = ${`${this.prefix}:${key}`}`.catch(() => undefined)
  }

  async resetAll(): Promise<void> {
    const client = this.getClient()
    if (!client) return
    await client`DELETE FROM rate_limit_hits WHERE key LIKE ${`${this.prefix}:%`}`.catch(() => undefined)
  }

  localKeys = false
}

/** Delete counters whose window has fully lapsed. Safe to call periodically. */
export async function pruneExpiredRateLimits(): Promise<void> {
  const client = getRawClient()
  if (!client) return
  await client`DELETE FROM rate_limit_hits WHERE reset_at <= now()`
    .catch(() => undefined)
}
