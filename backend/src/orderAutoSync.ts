import { eq } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { logger } from './logger'
import { isConfigured } from './config'
import { importShopifyOrders, type ShopifyOrdersImportResult } from './shopify'

/**
 * Background Shopify order sync.
 *
 * Webhooks are the instant path, but they cannot be the only one:
 *   - the desktop app runs on localhost, which Shopify can never reach;
 *   - a sleeping Render instance drops deliveries while it wakes;
 *   - a deployment can simply miss a delivery.
 *
 * So orders are also pulled on a timer: once shortly after boot (to catch what
 * happened while the server/app was off) and then every interval, using
 * `updated_at_min` from the last successful run with a small overlap so an
 * order edited during the previous run is never skipped.
 *
 * Every delivery path (webhook, manual Sync Orders, this timer) funnels through
 * `importShopifyOrders`, which is insert-guarded and coalesces concurrent runs,
 * so the same order is never imported or stock-deducted twice.
 */

export const DEFAULT_ORDER_SYNC_INTERVAL_SECONDS = 90
export const MIN_ORDER_SYNC_INTERVAL_SECONDS = 30
export const MAX_ORDER_SYNC_INTERVAL_SECONDS = 60 * 60
/** Re-read this much history on every poll: cheap, and closes race gaps. */
export const ORDER_SYNC_OVERLAP_MS = 5 * 60 * 1000
/** Let the instance settle (DNS, DB pool) before the first catch-up run. */
export const ORDER_SYNC_STARTUP_DELAY_MS = 10_000

export const ORDER_SYNC_LAST_SUCCESS_KEY = 'orderAutoSyncLastSuccessAt'
export const ORDER_SYNC_INTERVAL_KEY = 'orderAutoSyncIntervalSeconds'

export type OrderSyncImportResult = Pick<ShopifyOrdersImportResult, 'ok' | 'imported' | 'updated' | 'errors'> & {
  message?: string
}

export type OrderAutoSyncRunResult = {
  ok: boolean
  /** Nothing ran: Shopify is not configured, disabled, or already running. */
  skipped: boolean
  reason?: string
  imported?: number
  updated?: number
  durationMs?: number
  /** true when this run was an incremental poll (a watermark existed). */
  incremental?: boolean
  /** The `updated_at_min` actually sent to Shopify (null = full pull). */
  updatedAtMin?: string | null
}

export type OrderAutoSyncDeps = {
  isConfigured: () => boolean
  readWatermark: () => Promise<string | null>
  writeWatermark: (iso: string) => Promise<void>
  importOrders: (options: { updatedAtMin: string | null }) => Promise<OrderSyncImportResult>
  now: () => number
}

/** Interval from env/settings. 0 disables the timer; values are clamped. */
export function parseOrderSyncIntervalSeconds(raw: unknown, fallback = DEFAULT_ORDER_SYNC_INTERVAL_SECONDS): number {
  if (raw === null || raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  if (n === 0) return 0
  return Math.min(MAX_ORDER_SYNC_INTERVAL_SECONDS, Math.max(MIN_ORDER_SYNC_INTERVAL_SECONDS, Math.floor(n)))
}

/**
 * The `updated_at_min` for a poll: the watermark minus the overlap window.
 * A missing/invalid watermark means a full pull (first run, or state lost).
 */
export function orderSyncUpdatedAtMin(
  watermark: string | null | undefined,
  nowMs: number,
  overlapMs = ORDER_SYNC_OVERLAP_MS,
): string | null {
  if (!watermark) return null
  const at = Date.parse(watermark)
  if (!Number.isFinite(at)) return null
  // Never ask for the future (a clock jump would otherwise stall the poll).
  const since = Math.min(at, nowMs) - overlapMs
  return new Date(since).toISOString()
}

async function readNotificationSettings(): Promise<Record<string, unknown>> {
  if (!db) return {}
  const [row] = await db
    .select({ notificationSettings: schema.settings.notificationSettings })
    .from(schema.settings)
    .where(eq(schema.settings.id, 'app'))
    .limit(1)
  return (row?.notificationSettings ?? {}) as Record<string, unknown>
}

async function readWatermark(): Promise<string | null> {
  try {
    const settings = await readNotificationSettings()
    const value = settings[ORDER_SYNC_LAST_SUCCESS_KEY]
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
  } catch {
    // No settings row yet / DB unavailable: a full pull is a safe fallback.
    return null
  }
}

async function writeWatermark(iso: string): Promise<void> {
  if (!db) return
  try {
    const current = await readNotificationSettings()
    await db
      .update(schema.settings)
      .set({ notificationSettings: { ...current, [ORDER_SYNC_LAST_SUCCESS_KEY]: iso } })
      .where(eq(schema.settings.id, 'app'))
  } catch (err) {
    // Losing the watermark only costs an extra full pull next time.
    logger.warn({ err }, 'Order auto-sync: could not store the sync watermark')
  }
}

const defaultDeps = (): OrderAutoSyncDeps => ({
  isConfigured,
  readWatermark,
  writeWatermark,
  importOrders: (options) => importShopifyOrders(options),
  now: () => Date.now(),
})

/**
 * One pull. Never throws: a Shopify outage must not kill the timer.
 * The watermark only advances on success, so a failed run retries the same
 * window instead of silently skipping those orders.
 */
export async function runOrderAutoSyncOnce(deps: OrderAutoSyncDeps): Promise<OrderAutoSyncRunResult> {
  if (!deps.isConfigured()) {
    return { ok: true, skipped: true, reason: 'Shopify is not configured' }
  }
  const started = deps.now()
  const watermark = await deps.readWatermark()
  const updatedAtMin = orderSyncUpdatedAtMin(watermark, started)
  const incremental = Boolean(updatedAtMin)

  try {
    const result = await deps.importOrders({ updatedAtMin })
    const durationMs = deps.now() - started
    // The importer reports ok=true even when individual orders failed. Those
    // failures must not advance the watermark, or the next poll starts after
    // them and the affected orders are never retried.
    const partialFailure = result.ok && (result.errors?.length ?? 0) > 0
    if (!result.ok || partialFailure) {
      const message = result.message ?? result.errors?.[0] ?? 'Order import failed'
      logger.warn({ updatedAtMin, durationMs, message, partialFailure }, 'Order auto-sync failed')
      return { ok: false, skipped: false, reason: message, imported: result.imported, updated: result.updated, durationMs, incremental, updatedAtMin }
    }
    // Watermark is the RUN START, not the run end: orders created while the
    // import was paging must fall inside the next window (minus the overlap).
    await deps.writeWatermark(new Date(started).toISOString())
    logger.info(
      { imported: result.imported, updated: result.updated, durationMs, incremental },
      'Order auto-sync completed',
    )
    return {
      ok: true,
      skipped: false,
      imported: result.imported,
      updated: result.updated,
      durationMs,
      incremental,
      updatedAtMin,
    }
  } catch (err) {
    const durationMs = deps.now() - started
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err, updatedAtMin, durationMs }, 'Order auto-sync crashed — timer continues')
    return { ok: false, skipped: false, reason: message, durationMs, incremental, updatedAtMin }
  }
}

// ── Concurrency ────────────────────────────────────────────────────────────
// Timer ticks can overlap a slow run (or a wake-up catch-up can still be in
// flight when the next tick fires). The second caller waits for the first run
// and receives its result instead of starting a duplicate import.
let inFlight: Promise<OrderAutoSyncRunResult> | null = null

export function isOrderAutoSyncRunning(): boolean {
  return inFlight !== null
}

/** @internal test seam — drops the lock between cases. */
export function __resetOrderAutoSyncState(): void {
  inFlight = null
  timer = null
  schedulerGeneration++
  lastRunAt = null
  lastResult = null
  nextRunAt = null
  consecutiveFailures = 0
}

export async function runOrderAutoSync(deps: OrderAutoSyncDeps = defaultDeps()): Promise<OrderAutoSyncRunResult> {
  if (inFlight) return inFlight
  const run = runOrderAutoSyncOnce(deps).finally(() => {
    // Only the run that owns the lock may release it. Without this identity
    // check a slower caller's finally can clear a newer run's lock.
    if (inFlight === run) inFlight = null
  })
  inFlight = run
  return run
}

// ── Scheduler ──────────────────────────────────────────────────────────────
let timer: NodeJS.Timeout | null = null
/** Bumped by stop/reset so an in-flight tick cannot resurrect a stopped timer. */
let schedulerGeneration = 0
let lastRunAt: string | null = null
let nextRunAt: string | null = null
let lastResult: OrderAutoSyncRunResult | null = null
let consecutiveFailures = 0

export async function getOrderSyncIntervalSeconds(): Promise<number> {
  // The Settings value wins so an operator can change it at runtime; the env
  // var is the deployment default for headless instances.
  try {
    const settings = await readNotificationSettings()
    const stored = settings[ORDER_SYNC_INTERVAL_KEY]
    if (stored !== undefined && stored !== null && stored !== '') return parseOrderSyncIntervalSeconds(stored)
  } catch {
    /* fall through to the env/default */
  }
  return parseOrderSyncIntervalSeconds(process.env.ORDER_AUTO_SYNC_INTERVAL_SECONDS)
}

async function tick(generation: number, deps: OrderAutoSyncDeps): Promise<void> {
  if (generation !== schedulerGeneration) return
  timer = null
  lastRunAt = new Date().toISOString()
  lastResult = await runOrderAutoSync(deps)
  if (generation !== schedulerGeneration) return
  consecutiveFailures = lastResult.ok ? 0 : consecutiveFailures + 1
  if (consecutiveFailures > 0 && consecutiveFailures % 5 === 0) {
    logger.error({ consecutiveFailures, reason: lastResult.reason }, 'Order auto-sync has failed repeatedly — check Shopify connectivity')
  }

  let seconds = DEFAULT_ORDER_SYNC_INTERVAL_SECONDS
  try {
    seconds = await getOrderSyncIntervalSeconds()
  } catch {
    /* keep the default */
  }
  if (seconds <= 0 || generation !== schedulerGeneration) {
    nextRunAt = null
    logger.debug('Order auto-sync disabled (interval = 0)')
    return
  }
  schedule(seconds * 1000, generation, deps)
}

function schedule(delayMs: number, generation: number, deps: OrderAutoSyncDeps): void {
  if (timer) clearTimeout(timer)
  nextRunAt = new Date(Date.now() + delayMs).toISOString()
  timer = setTimeout(() => void tick(generation, deps), delayMs)
  timer.unref()
}

/**
 * Start the timer. Called after secrets are loaded so DB-stored credentials
 * count; a no-op when Shopify is not configured or the interval is 0.
 * `deps` is a test seam that keeps the timer's import off the network.
 */
export function startOrderAutoSync(options?: { startupDelayMs?: number; deps?: OrderAutoSyncDeps }): void {
  if (timer) return
  if (!isConfigured()) {
    logger.debug('Order auto-sync not started — Shopify is not configured')
    return
  }
  const generation = ++schedulerGeneration
  schedule(options?.startupDelayMs ?? ORDER_SYNC_STARTUP_DELAY_MS, generation, options?.deps ?? defaultDeps())
}

export function stopOrderAutoSync(): void {
  // Invalidate a tick that is already awaiting Shopify before it can reschedule.
  schedulerGeneration++
  if (timer) clearTimeout(timer)
  timer = null
  nextRunAt = null
}

export function getOrderAutoSyncStatus(): {
  running: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  lastResult: OrderAutoSyncRunResult | null
  consecutiveFailures: number
} {
  return { running: isOrderAutoSyncRunning(), lastRunAt, nextRunAt, lastResult, consecutiveFailures }
}
