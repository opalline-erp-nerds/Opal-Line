import { db } from './db/client'
import * as schema from './db/schema'
import { eq } from 'drizzle-orm'
import { getConfiguredShopDomain, isProductSyncInProgress, syncProductsToDb } from './shopify'
import { logger } from './logger'
import { escapeHtml } from './htmlEscape'
import {
  DEFAULT_INTERVAL_SECONDS,
  formatAutoSyncInterval,
  readStoredIntervalSeconds,
  clampIntervalSeconds,
} from './productAutoSync.interval'
import {
  evaluateCatalogGuards,
  evaluateShopGuard,
  shouldPauseAutoSync,
  INTERVAL_WARN_BELOW_SECONDS,
  INTERVAL_SUGGEST_SECONDS,
  INTERVAL_ROUTINE_MAX_SECONDS,
} from './productAutoSync.guards'
import {
  getProductAutoSyncMeta,
  patchProductAutoSyncMeta,
  recordSuccessfulProductAutoSync,
} from './productAutoSync.metadata'

export { resolveAutoSyncIntervalSeconds, formatAutoSyncInterval } from './productAutoSync.interval'

export type ProductAutoSyncRunResult = {
  ok: boolean
  synced?: number
  created?: number
  updated?: number
  removed?: number
  skipped?: number
  failed?: number
  durationMs?: number
  message?: string
  warnings?: string[]
  skippedRun?: boolean
  paused?: boolean
  /** Manual runs only: what the ERP → Shopify push did after the pull. */
  push?: string
}

type RunRecord = {
  at: string
  ok: boolean
  created?: number
  updated?: number
  skipped?: number
  failed?: number
  durationMs?: number
  message?: string
}

/**
 * Product auto-sync scheduler — periodically pulls the live Shopify catalog
 * into the local DB. Interval is stored as autoSyncIntervalSeconds in
 * settings.notificationSettings (0 = disabled). Legacy autoSyncIntervalHours
 * is still read. Default 6 hours.
 */

let timer: NodeJS.Timeout | null = null
let lastRunAt: string | null = null
let nextRunAt: string | null = null
let lastResult: ProductAutoSyncRunResult | null = null
let consecutiveFailures = 0
let runHistory: RunRecord[] = []
let paused = false
let pauseWarning: string | null = null

export async function getAutoSyncIntervalSeconds(): Promise<number> {
  if (!db) return DEFAULT_INTERVAL_SECONDS
  try {
    const [row] = await db.select({ notificationSettings: schema.settings.notificationSettings }).from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
    return readStoredIntervalSeconds((row?.notificationSettings ?? null) as Record<string, unknown> | null)
  } catch {
    return DEFAULT_INTERVAL_SECONDS
  }
}

/** Rounded whole hours for older clients. Sub-hour intervals show as 0. */
export async function getAutoSyncIntervalHours(): Promise<number> {
  const seconds = await getAutoSyncIntervalSeconds()
  if (seconds <= 0) return 0
  return Math.floor(seconds / 3600)
}

export async function setAutoSyncIntervalSeconds(seconds: number): Promise<void> {
  if (!db) return
  const n = clampIntervalSeconds(seconds)
  const [row] = await db.select({ notificationSettings: schema.settings.notificationSettings }).from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
  const current = (row?.notificationSettings ?? {}) as Record<string, unknown>
  const hours = n === 0 ? 0 : Math.round((n / 3600) * 1000) / 1000
  await db
    .update(schema.settings)
    .set({
      notificationSettings: {
        ...current,
        autoSyncIntervalSeconds: n,
        autoSyncIntervalHours: hours,
      },
    })
    .where(eq(schema.settings.id, 'app'))
  if (n > 0) {
    consecutiveFailures = 0
    paused = false
    pauseWarning = null
    await patchProductAutoSyncMeta({ paused: false })
  }
}

export async function setAutoSyncIntervalHours(hours: number): Promise<void> {
  const h = Number.isFinite(hours) && hours >= 0 ? Math.floor(hours) : 0
  await setAutoSyncIntervalSeconds(h === 0 ? 0 : h * 3600)
}

function toRunResult(result: Awaited<ReturnType<typeof syncProductsToDb>>): ProductAutoSyncRunResult {
  return {
    ok: result.ok,
    synced: result.synced,
    created: result.created,
    updated: result.updated,
    removed: result.removed,
    skipped: result.skipped,
    failed: result.failed,
    durationMs: result.durationMs,
    message: result.message ?? result.errors?.[0],
    warnings: result.warnings,
    skippedRun: result.skippedRun,
  }
}

async function runInternal(manual: boolean, allowRemovals: boolean): Promise<ProductAutoSyncRunResult> {
  if (isProductSyncInProgress()) {
    return { ok: true, skippedRun: true, skipped: 1, message: 'Product sync already in progress' }
  }
  if (!manual && paused) {
    return {
      ok: false,
      paused: true,
      message: pauseWarning ?? 'Auto-sync is paused after repeated failures. Run a manual sync or change the interval to resume.',
    }
  }

  const meta = await getProductAutoSyncMeta()
  if (!manual && meta.paused) {
    paused = true
    pauseWarning =
      pauseWarning ??
      'Auto-sync is paused after repeated failures. Run a manual sync or change the interval to resume.'
    return { ok: false, paused: true, message: pauseWarning }
  }

  const configuredShop = getConfiguredShopDomain()
  const incremental = !manual && Boolean(meta.lastSuccessAt)
  const fullCatalog = manual || !incremental
  const updatedAtMin = incremental ? meta.lastSuccessAt : null

  const preShop = evaluateShopGuard(configuredShop, meta.shopDomain)
  if (!preShop.ok && preShop.skipFailures) {
    const msg = preShop.reason
    lastRunAt = new Date().toISOString()
    lastResult = { ok: true, skippedRun: true, skipped: 1, message: msg, warnings: [msg] }
    recordRun(lastResult)
    return lastResult
  }

  const result = await syncProductsToDb({
    mode: manual ? 'full' : 'auto',
    allowRemovals: manual && allowRemovals,
    mergeVariants: true,
    updatedAtMin,
    catalogGuard: (liveCount, isFull) => {
      const verdict = evaluateCatalogGuards({
        configuredShop,
        storedShop: meta.shopDomain,
        fullCatalog: isFull,
        liveCount,
        lastFullCount: meta.lastFullCount,
      })
      return verdict.ok ? null : { ok: false as const, reason: verdict.reason }
    },
  })

  const out = toRunResult(result)
  lastRunAt = new Date().toISOString()
  lastResult = out

  if (result.skippedRun) {
    recordRun(out)
    return out
  }

  if (result.ok) {
    consecutiveFailures = 0
    paused = false
    pauseWarning = null
    await recordSuccessfulProductAutoSync(result.synced, fullCatalog)
    logger.info(
      { synced: result.synced, created: result.created, updated: result.updated, durationMs: result.durationMs, manual },
      'Product auto-sync completed',
    )
    recordRun(out)
    return out
  }

  consecutiveFailures++
  logger.warn({ err: result.errors?.[0], consecutiveFailures }, 'Product auto-sync failed')
  recordRun(out)
  await maybeAlertSyncFailures()
  if (shouldPauseAutoSync(consecutiveFailures)) {
    paused = true
    pauseWarning = `Auto-sync paused after ${consecutiveFailures} failed runs in a row. Fix Shopify connectivity and run Sync Now, or change the interval to resume.`
    await patchProductAutoSyncMeta({ paused: true })
    out.paused = true
    out.warnings = [...(out.warnings ?? []), pauseWarning]
    out.message = pauseWarning
  }
  return out
}

function recordRun(out: ProductAutoSyncRunResult): void {
  runHistory = [
    {
      at: new Date().toISOString(),
      ok: out.ok && !out.skippedRun,
      created: out.created,
      updated: out.updated,
      skipped: out.skipped,
      failed: out.failed,
      durationMs: out.durationMs,
      message: out.message,
    },
    ...runHistory,
  ].slice(0, 50)
}

/** Scheduled tick — incremental when possible, never removes local rows. */
export async function runScheduledProductAutoSync(): Promise<ProductAutoSyncRunResult> {
  try {
    return await runInternal(false, false)
  } catch (err) {
    lastRunAt = new Date().toISOString()
    lastResult = { ok: false, message: err instanceof Error ? err.message : 'Unknown error', failed: 1 }
    consecutiveFailures++
    recordRun(lastResult)
    await maybeAlertSyncFailures()
    return lastResult
  }
}

/** Manual Sync Now — full catalog; removals only when allowRemovals is true. */
export async function runManualProductAutoSync(allowRemovals = false): Promise<ProductAutoSyncRunResult> {
  try {
    const out = await runInternal(true, allowRemovals)
    if (out.ok && !out.skippedRun) {
      consecutiveFailures = 0
      paused = false
      pauseWarning = null
      await patchProductAutoSyncMeta({ paused: false })
      if (!timer) schedule()
      // A manual "Full Sync Now" also ships the ERP catalogue to the store:
      // the pull discovers and links, the push delivers. Scheduled runs stay
      // pull-only — ordinary ERP edits already reach Shopify through the queue.
      try {
        const { queueCatalogOutbound, flushOutboundShopifyJobs } = await import('./shopifyOutbound')
        const queued = await queueCatalogOutbound(['product', 'price', 'inventory'], 'Full Sync Now')
        const flushed = await flushOutboundShopifyJobs()
        out.push = `${queued.queued} queued, ${flushed.processed} pushed${flushed.failed > 0 ? `, ${flushed.failed} failed` : ''}`
      } catch {
        // The pull result is what the caller reports; a push problem is
        // already recorded in Sync Logs by the worker.
      }
    }
    return out
  } catch (err) {
    lastRunAt = new Date().toISOString()
    lastResult = { ok: false, message: err instanceof Error ? err.message : 'Unknown error', failed: 1 }
    recordRun(lastResult)
    return lastResult
  }
}

/** @deprecated Use runScheduledProductAutoSync or runManualProductAutoSync */
export async function runProductAutoSync(): Promise<ProductAutoSyncRunResult> {
  return runScheduledProductAutoSync()
}

/** Email after 2 consecutive failures; re-alert every further failure. */
async function maybeAlertSyncFailures(): Promise<void> {
  if (consecutiveFailures < 2) return
  try {
    const email = process.env.NOTIFICATION_EMAIL?.trim()
    if (!email) return
    const { sendEmail } = await import('./notifications')
    const sent = await sendEmail({
      to: email,
      subject: `⚠️ Product auto-sync failed ${consecutiveFailures}× in a row`,
      html: `<p>The Shopify product auto-sync has failed <strong>${consecutiveFailures}</strong> times in a row.</p><p>Last error: <code>${escapeHtml(lastResult?.message ?? 'unknown')}</code></p><p>Check the Sync page in the ERP for details, or run a manual sync.</p>`,
    })
    if (sent) logger.warn({ failures: consecutiveFailures }, 'Sync-failure alert emailed')
  } catch (err) {
    logger.warn({ err }, 'Sync-failure alert failed')
  }
}

export function getAutoSyncHistory(): RunRecord[] {
  return runHistory
}

function schedule(): void {
  timer = null
  void (async () => {
    const seconds = await getAutoSyncIntervalSeconds()
    if (seconds <= 0) {
      logger.debug('Product auto-sync disabled (interval = 0)')
      nextRunAt = null
      return
    }
    if (paused) {
      logger.warn('Product auto-sync is paused — scheduler idle until interval is changed or manual sync succeeds')
      nextRunAt = null
      return
    }
    await runScheduledProductAutoSync()
    const delayMs = seconds * 1000
    nextRunAt = new Date(Date.now() + delayMs).toISOString()
    timer = setTimeout(schedule, delayMs)
    timer.unref()
  })()
}

export function startProductAutoSync(): void {
  if (timer) return
  void getProductAutoSyncMeta().then((m) => {
    paused = m.paused
    if (m.paused) {
      pauseWarning =
        pauseWarning ??
        'Auto-sync is paused after repeated failures. Run a manual sync or change the interval to resume.'
    }
    schedule()
  })
}

export function stopProductAutoSync(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

export async function getAutoSyncStatus(): Promise<{
  intervalSeconds: number
  intervalHours: number
  intervalLabel: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastResult: ProductAutoSyncRunResult | null
  paused: boolean
  pauseWarning: string | null
  consecutiveFailures: number
  intervalWarning: string | null
}> {
  const seconds = await getAutoSyncIntervalSeconds()
  const intervalWarning =
    seconds > 0 && seconds < INTERVAL_WARN_BELOW_SECONDS
      ? `Intervals under 5 minutes increase Shopify API usage. Consider ${formatAutoSyncInterval(INTERVAL_SUGGEST_SECONDS)}–${formatAutoSyncInterval(INTERVAL_ROUTINE_MAX_SECONDS)}; webhooks catch edits between runs.`
      : null
  return {
    intervalSeconds: seconds,
    intervalHours: seconds <= 0 ? 0 : Math.floor(seconds / 3600),
    intervalLabel: formatAutoSyncInterval(seconds),
    enabled: seconds > 0,
    nextRunAt: paused ? null : nextRunAt,
    lastRunAt,
    lastResult,
    paused,
    pauseWarning,
    consecutiveFailures,
    intervalWarning,
  }
}