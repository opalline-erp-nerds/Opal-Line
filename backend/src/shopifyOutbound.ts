/**
 * Durable outbound Shopify work (ERP → Shopify).
 *
 * Inbound sync (Shopify → ERP) is a pull that runs on webhooks and a schedule.
 * Outbound had no equivalent: an ERP product/price/stock edit reached Shopify
 * only when a screen happened to call a push endpoint, and when that call
 * failed the error was swallowed by the UI. The store therefore drifted — and
 * the next inbound pull wrote Shopify's older values back over the edit.
 *
 * Every ERP write now records an intent in `shopify_sync_jobs` (the same
 * database the change was committed to, so a transaction that rolls back takes
 * its job with it) and this worker drains them:
 *
 *   - one job per (kind, product) — idempotency_key — so repeated edits
 *     coalesce instead of queueing N pushes;
 *   - attempts + backoff, so a Shopify outage is retried rather than lost;
 *   - each outcome is written to `sync_logs`, which the Shopify → Sync Logs
 *     screen already renders per resource (success / failed / retry / error).
 *
 * The Shopify calls themselves are the existing, tested ones in src/shopify.ts
 * (pushProductsToShopify / pushProductPriceToShopify / pushInventoryToShopify);
 * nothing about the integration is rebuilt here.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db, schema } from './db/client'
import { isConfigured } from './config'
import { logger } from './logger'
import type { Tx } from './stock'

export type OutboundKind = 'product' | 'price' | 'inventory'

/** Give up after this many failed attempts; the job then stays visible as failed. */
export const MAX_OUTBOUND_ATTEMPTS = 6
const BASE_RETRY_MS = 30_000
const MAX_RETRY_MS = 60 * 60 * 1000
/** How often the worker looks for due jobs. */
const TICK_MS = 15_000
/** Jobs handled per tick, so one huge backlog cannot monopolise the process. */
const BATCH = 10

/** A product is genuinely listed only with a numeric Shopify id (never a `#MO-` placeholder). */
export function isListedOnShopify(shopifyId: string | null | undefined): boolean {
  const value = String(shopifyId ?? '').trim()
  return value !== '' && !value.startsWith('#')
}

export function outboundJobKey(kind: OutboundKind, productId: string): string {
  return `${kind}:${productId}`
}

/** Exponential backoff from an attempt count (1 → 30s, 2 → 1m, … capped at 1h). */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.floor(Number(attempts) || 1))
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(n - 1, 11))
}

export interface QueueShopifyJobInput {
  kind: OutboundKind
  productId: string
  /** Pass the caller's transaction so the intent commits with the change. */
  tx?: Tx
  /** Optional note shown in the sync log when the job is created. */
  reason?: string
}

export interface QueuedShopifySync {
  queued: OutboundKind[]
  skipped?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Record (or re-arm) one outbound intent. Never throws: a queue write must not
 * turn a successful ERP save into an error — the caller logs the false return.
 */
export async function enqueueShopifyJob(input: QueueShopifyJobInput): Promise<boolean> {
  const client = input.tx ?? db
  if (!client) return false
  if (!isConfigured()) return false
  const productId = String(input.productId ?? '').trim()
  if (!productId) return false
  const at = nowIso()
  try {
    await client
      .insert(schema.shopifySyncJobs)
      .values({
        id: randomUUID(),
        idempotencyKey: outboundJobKey(input.kind, productId),
        kind: input.kind,
        productId,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        lastError: null,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: schema.shopifySyncJobs.idempotencyKey,
        set: {
          // A newer edit supersedes an older pending/failed job. `updated_at`
          // also lets the worker notice that the row was re-armed mid-run.
          status: 'pending',
          attempts: 0,
          nextAttemptAt: at,
          lastError: null,
          updatedAt: at,
        },
      })
    return true
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, kind: input.kind, productId, reason: input.reason },
      'Shopify outbound: could not queue job',
    )
    return false
  }
}

/**
 * Queue whatever an ERP product edit changed. Content covers title,
 * description, vendor, tags, images, collection and the option/variant set;
 * price covers selling/compare-at price (simple products are not touched by
 * the content push, which is why the two are separate jobs).
 */
export async function queueProductOutbound(
  product: { id: string; shopifyId?: string | null },
  changes: { content?: boolean; price?: boolean; inventory?: boolean },
): Promise<QueuedShopifySync> {
  if (!isConfigured()) return { queued: [], skipped: 'Shopify is not configured' }
  if (!isListedOnShopify(product.shopifyId)) {
    return { queued: [], skipped: 'not listed on Shopify' }
  }
  const queued: OutboundKind[] = []
  if (changes.content) {
    if (await enqueueShopifyJob({ kind: 'product', productId: product.id, reason: 'ERP product edit' })) queued.push('product')
  }
  if (changes.price) {
    if (await enqueueShopifyJob({ kind: 'price', productId: product.id, reason: 'ERP price edit' })) queued.push('price')
  }
  if (changes.inventory) {
    if (await enqueueShopifyJob({ kind: 'inventory', productId: product.id, reason: 'ERP variant stock edit' })) queued.push('inventory')
  }
  if (queued.length === 0 && (changes.content || changes.price || changes.inventory)) {
    return { queued, skipped: 'could not queue the Shopify push' }
  }
  return { queued }
}

/**
 * Product ids with outbound work still in flight. The inbound catalog pull
 * consults this so Shopify's older copy cannot overwrite an ERP edit that is
 * queued but not yet pushed (the push/pull echo loop).
 */
export async function pendingShopifyProductIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  if (!db) return ids
  try {
    const rows = await db
      .select({ productId: schema.shopifySyncJobs.productId })
      .from(schema.shopifySyncJobs)
      .where(inArray(schema.shopifySyncJobs.status, ['pending', 'running']))
      .groupBy(schema.shopifySyncJobs.productId)
    for (const r of rows) {
      if (r.productId) ids.add(r.productId)
    }
  } catch {
    // Table missing on a mid-upgrade install: behave as "nothing pending".
  }
  return ids
}

export interface OutboundTickResult {
  processed: number
  failed: number
  deferred: number
}

interface JobRow {
  id: string
  kind: string
  productId: string
  attempts: number
  updatedAt: string | null
}

interface JobOutcome {
  ok: boolean
  skipped?: boolean
  message?: string
  /** The shared sync lock was busy — try again shortly without burning an attempt. */
  retryLater?: boolean
}

const ACTION_BY_KIND: Record<OutboundKind, string> = {
  product: 'Update',
  price: 'Price Update',
  inventory: 'Stock Update',
}

const LOG_ENTITY_BY_KIND: Record<OutboundKind, string> = {
  product: 'Product',
  price: 'Price',
  inventory: 'Inventory',
}

function isKind(value: string): value is OutboundKind {
  return value === 'product' || value === 'price' || value === 'inventory'
}

/** Run one job through the existing push functions and normalise the outcome. */
async function runJob(job: JobRow): Promise<JobOutcome & { sku?: string | null }> {
  if (!db) return { ok: false, message: 'Database is not configured' }
  const [row] = await db
    .select({ id: schema.products.id, sku: schema.products.sku, shopifyId: schema.products.shopifyId })
    .from(schema.products)
    .where(eq(schema.products.id, job.productId))
    .limit(1)
  if (!row) return { ok: true, skipped: true, message: 'The product no longer exists' }
  if (!isListedOnShopify(row.shopifyId)) {
    return { ok: true, skipped: true, message: `Skipped ${row.sku}: not listed on Shopify yet`, sku: row.sku }
  }
  if (!isKind(job.kind)) return { ok: true, skipped: true, message: `Unknown job kind "${job.kind}"`, sku: row.sku }

  const shopify = await import('./shopify')
  const kind = job.kind as OutboundKind
  const result =
    kind === 'product'
      ? await shopify.pushProductsToShopify([row.id])
      : kind === 'price'
        ? await shopify.pushProductPriceToShopify(row.id)
        : await shopify.pushInventoryToShopify([row.id])

  const message = result.message ?? result.errors?.[0]
  // The push functions share one process-wide lock with the pull. Busy is not
  // a failure: reschedule without spending an attempt.
  if (!result.ok && message && /sync is already in progress/i.test(message)) {
    return { ok: false, retryLater: true, message, sku: row.sku }
  }
  if (result.ok && kind === 'product') {
    const created = Number((result as { created?: number }).created ?? 0)
    const updated = Number((result as { updated?: number }).updated ?? 0)
    const skipped = Number((result as { skipped?: number }).skipped ?? 0)
    if (created + updated === 0) {
      return { ok: true, skipped: true, message: `Skipped ${row.sku}: nothing to push (${skipped} skipped)`, sku: row.sku }
    }
  }
  if (result.ok && kind !== 'product' && Number((result as { updated?: number }).updated ?? 0) === 0) {
    return { ok: true, skipped: true, message: `Skipped ${row.sku}: ${message ?? 'no matching Shopify record'}`, sku: row.sku }
  }
  return {
    ok: result.ok,
    message: result.ok ? undefined : message ?? 'Shopify push failed',
    sku: row.sku,
  }
}

async function recordJobLog(job: JobRow, outcome: JobOutcome & { sku?: string | null }): Promise<void> {
  if (!isKind(job.kind)) return
  try {
    const shopify = await import('./shopify')
    // Named for the exported symbol (upstream renamed it from `persistLog`);
    // calling it directly means a future rename fails the typecheck instead of
    // being swallowed by the catch below and silently dropping outbound logs.
    await shopify.persistShopifySyncLog({
      entity: LOG_ENTITY_BY_KIND[job.kind],
      shopifyId: outcome.sku ?? job.productId,
      direction: 'out',
      action: ACTION_BY_KIND[job.kind],
      status: outcome.ok ? (outcome.skipped ? 'skipped' : 'success') : 'failed',
      error: outcome.message,
      retry: !outcome.ok,
    })
  } catch {
    // Sync logging must never break the worker.
  }
}

/**
 * Drain due jobs once. Exported for tests and for a manual flush; the server
 * calls it on a timer (startShopifyOutboundWorker).
 */
export async function runOutboundShopifyJobs(limit = BATCH): Promise<OutboundTickResult> {
  const result: OutboundTickResult = { processed: 0, failed: 0, deferred: 0 }
  if (!db || !isConfigured()) return result

  let due: Array<{ id: string }>
  try {
    // `next_attempt_at` is a timestamp written from an ISO (UTC) string, so the
    // stored wall clock is UTC. Compare it with the UTC wall clock in SQL:
    // reading it back gives a timezone-less string that JS would parse as local
    // time, which would make backoff depend on the server's timezone.
    due = await db
      .select({ id: schema.shopifySyncJobs.id })
      .from(schema.shopifySyncJobs)
      .where(
        and(
          eq(schema.shopifySyncJobs.status, 'pending'),
          or(
            isNull(schema.shopifySyncJobs.nextAttemptAt),
            lte(schema.shopifySyncJobs.nextAttemptAt, sql`(now() at time zone 'utc')`),
          ),
        ),
      )
      .orderBy(asc(schema.shopifySyncJobs.nextAttemptAt), asc(schema.shopifySyncJobs.createdAt))
      .limit(Math.max(1, Math.min(limit, 100)))
  } catch {
    // Table not created yet (mid-upgrade) — try again next tick.
    return result
  }
  if (due.length === 0) return result

  for (const candidate of due) {
    const claimedAt = nowIso()
    let claimed: JobRow[]
    try {
      claimed = await db
        .update(schema.shopifySyncJobs)
        .set({ status: 'running', attempts: sql`${schema.shopifySyncJobs.attempts} + 1`, updatedAt: claimedAt })
        .where(and(eq(schema.shopifySyncJobs.id, candidate.id), eq(schema.shopifySyncJobs.status, 'pending')))
        .returning({
          id: schema.shopifySyncJobs.id,
          kind: schema.shopifySyncJobs.kind,
          productId: schema.shopifySyncJobs.productId,
          attempts: schema.shopifySyncJobs.attempts,
          updatedAt: schema.shopifySyncJobs.updatedAt,
        })
    } catch {
      continue
    }
    const job = claimed[0]
    if (!job) continue

    let outcome: JobOutcome & { sku?: string | null }
    try {
      outcome = await runJob(job)
    } catch (err) {
      outcome = { ok: false, message: err instanceof Error ? err.message : 'Shopify push failed' }
    }

    // Only settle the job if it was not re-armed (a newer ERP edit) while this
    // attempt was running; re-arming resets `attempts`, so the claimed attempt
    // number identifies this run. A re-armed job is left pending by design.
    const settleWhere = and(
      eq(schema.shopifySyncJobs.id, job.id),
      eq(schema.shopifySyncJobs.status, 'running'),
      eq(schema.shopifySyncJobs.attempts, job.attempts),
    )

    if (outcome.ok) {
      await db
        .update(schema.shopifySyncJobs)
        .set({ status: 'done', lastError: null, updatedAt: nowIso() })
        .where(settleWhere)
      result.processed++
      await recordJobLog(job, outcome)
      continue
    }

    if (outcome.retryLater) {
      await db
        .update(schema.shopifySyncJobs)
        .set({
          status: 'pending',
          attempts: sql`greatest(${schema.shopifySyncJobs.attempts} - 1, 0)`,
          nextAttemptAt: new Date(Date.now() + BASE_RETRY_MS).toISOString(),
          updatedAt: nowIso(),
        })
        .where(settleWhere)
      result.deferred++
      continue
    }

    const exhausted = job.attempts >= MAX_OUTBOUND_ATTEMPTS
    await db
      .update(schema.shopifySyncJobs)
      .set({
        status: exhausted ? 'failed' : 'pending',
        lastError: outcome.message ?? 'Shopify push failed',
        nextAttemptAt: exhausted
          ? null
          : new Date(Date.now() + retryDelayMs(job.attempts)).toISOString(),
        updatedAt: nowIso(),
      })
      .where(settleWhere)
    result.failed++
    await recordJobLog(job, { ...outcome, ok: false })
    logger.warn(
      { kind: job.kind, productId: job.productId, attempts: job.attempts, exhausted, err: outcome.message },
      'Shopify outbound: push failed',
    )
  }
  return result
}

let timer: NodeJS.Timeout | null = null
let ticking = false

export function startShopifyOutboundWorker(): void {
  if (timer) return
  timer = setInterval(() => {
    // Skip overlapping ticks; one slow Shopify call must not pile up work.
    if (ticking) return
    ticking = true
    void runOutboundShopifyJobs()
      .catch((err) => logger.warn({ err }, 'Shopify outbound: tick failed'))
      .finally(() => {
        ticking = false
      })
  }, TICK_MS)
  timer.unref()
  logger.debug({ intervalMs: TICK_MS }, 'Shopify outbound worker started')
}

export function stopShopifyOutboundWorker(): void {
  if (timer) clearInterval(timer)
  timer = null
}
