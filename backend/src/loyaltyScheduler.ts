import { logger } from './logger'
import { createScheduler } from './lib/scheduler'
import { expirePoints, resolveConfig } from './loyalty'

/**
 * Daily loyalty points expiry (03:00 local).
 *
 * Expiry is a configured rule, not a button: when "points expire after N
 * months" is set, due points are written off automatically so balances — and
 * therefore the Shopify metafield balances — stay accurate without anyone
 * remembering to run it. Expiring is idempotent per lot, so an extra run (or a
 * restart) writes nothing twice. When expiry is not configured the job is a
 * no-op.
 */

/** Local 03:00 — the quietest hour for a ledger write. */
const RUN_HOUR = 3

export function msUntilNextRun(now: Date = new Date()): number {
  const next = new Date(now.getTime())
  next.setHours(RUN_HOUR, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

export interface LoyaltyExpiryRun {
  skipped: boolean
  expiredPoints: number
  lots: number
  customers: number
}

/** One expiry sweep (exported so it can be triggered by hand or in tests). */
export async function runLoyaltyExpiry(now: Date = new Date()): Promise<LoyaltyExpiryRun> {
  const config = await resolveConfig()
  if (!config.enabled || !config.expiryMonths) {
    return { skipped: true, expiredPoints: 0, lots: 0, customers: 0 }
  }
  const result = await expirePoints({ now })
  if (result.expiredPoints > 0) {
    logger.info(
      { expiredPoints: result.expiredPoints, lots: result.lots, customers: result.customers },
      'Loyalty points expired',
    )
  }
  return { skipped: false, ...result }
}

const scheduler = createScheduler({
  label: 'Loyalty points expiry',
  msUntilNextRun: () => msUntilNextRun(),
  run: () => runLoyaltyExpiry(),
  // Never let two sweeps overlap; each run writes ledger rows.
  mode: 'run-then-rearm',
  onError: (err) => logger.error({ err }, 'Loyalty expiry sweep failed'),
})

export function startLoyaltyExpiryScheduler(): void {
  if (scheduler.armed) return
  scheduler.schedule()
  logger.info(
    { next: new Date(Date.now() + msUntilNextRun()).toISOString() },
    'Loyalty expiry scheduler started (daily 03:00)',
  )
}

export function stopLoyaltyExpiryScheduler(): void {
  scheduler.stop()
}
