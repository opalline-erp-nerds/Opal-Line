import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, isNotNull, ne, or, sql } from 'drizzle-orm'
import { db } from './db/client'
import * as s from './db/schema'
import { config, isConfigured } from './config'
import { logger } from './logger'
import {
  earnForShopifyOrder,
  getBalance,
  loyaltyTier,
  normalizeOrderRef,
  resolveConfig,
  reverseAward,
  type LoyaltyConfig,
} from './loyalty'

/**
 * Shopify side of loyalty.
 *
 * ERP → Shopify: each customer's balance is written to OUR OWN customer
 * metafields (namespace + key from loyalty settings, defaults opal_line /
 * loyalty_points, plus a derived `<key>_tier` and `<key>_synced_at`). Shopify
 * has no native loyalty-points API, and unrelated metafields are never touched.
 *
 * Shopify → ERP: paid orders earn through src/loyalty.ts, refunds reverse
 * points proportionally, cancellations reverse in full. Every attempt is
 * logged in sync_logs (entity `loyalty`) so failures are visible and retryable.
 */

const SYNC_ENTITY = 'loyalty'
const GRAPHQL_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 3

export interface ShopifyGraphQLResult<T> {
  ok: boolean
  data?: T
  error?: string
  /** HTTP 429 / GraphQL THROTTLED — the caller may retry later. */
  throttled?: boolean
}

async function adminGraphQL<T>(query: string, variables: Record<string, unknown> = {}): Promise<ShopifyGraphQLResult<T>> {
  if (!isConfigured()) return { ok: false, error: 'Shopify is not configured' }
  const url = `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/graphql.json`

  let lastError = 'Shopify request failed'
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': config.accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      })
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '1')
        await new Promise((resolve) => setTimeout(resolve, Math.max(500, retryAfter * 1000)))
        lastError = `Shopify rate limit (HTTP ${res.status})`
        continue
      }
      if (!res.ok) {
        lastError = `Shopify responded HTTP ${res.status}`
        if (res.status >= 500) continue
        return { ok: false, error: lastError }
      }
      const json = (await res.json()) as {
        data?: T
        errors?: Array<{ message?: string; extensions?: { code?: string } }>
      }
      if (json.errors?.length) {
        const message = json.errors.map((e) => e.message ?? 'GraphQL error').join('; ')
        const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED')
        if (throttled) {
          lastError = 'Shopify GraphQL throttled'
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
          continue
        }
        return { ok: false, error: message }
      }
      return { ok: true, data: json.data }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Shopify request failed'
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: lastError, throttled: /throttl|rate limit/i.test(lastError) }
}

async function recordSync(entry: {
  shopifyId?: string | null
  action: string
  status: 'success' | 'failed'
  error?: string | null
  detail?: string | null
}): Promise<void> {
  if (!db) return
  try {
    await db.insert(s.syncLogs).values({
      id: randomUUID(),
      entity: SYNC_ENTITY,
      shopifyId: entry.shopifyId ?? null,
      direction: 'erp->shopify',
      action: entry.action,
      status: entry.status,
      error: entry.error ?? null,
      retry: entry.status === 'failed',
      time: new Date().toISOString(),
    })
  } catch (err) {
    logger.warn({ err }, 'loyalty: could not write sync log')
  }
}

interface MetafieldsSetResponse {
  metafieldsSet: {
    metafields: Array<{ id: string; namespace: string; key: string; value: string }> | null
    userErrors: Array<{ field?: string[] | null; message: string; code?: string | null }>
  }
}

export interface LoyaltyPushResult {
  ok: boolean
  pushed: number
  failed: number
  errors: Array<{ customerId: string; name: string; shopifyId: string | null; error: string }>
}

/** Metafield keys written for a customer (points, tier, sync timestamp). */
export function loyaltyMetafieldKeys(cfg: Pick<LoyaltyConfig, 'metafieldKey'>) {
  const base = cfg.metafieldKey || 'loyalty_points'
  return { points: base, tier: `${base}_tier`, syncedAt: `${base}_synced_at` }
}

async function pushOne(customer: {
  id: string
  name: string
  shopifyId: string | null
  balance: number
}, cfg: LoyaltyConfig): Promise<{ ok: boolean; error?: string }> {
  if (!customer.shopifyId) return { ok: false, error: 'Customer has no Shopify ID' }
  const keys = loyaltyMetafieldKeys(cfg)

  const mutation = `
    mutation LoyaltyBalance($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value }
        userErrors { field message code }
      }
    }
  `
  const metafields = [
    {
      ownerId: `gid://shopify/Customer/${customer.shopifyId}`,
      namespace: cfg.metafieldNamespace,
      key: keys.points,
      type: 'number_integer',
      value: String(Math.max(0, Math.round(customer.balance))),
    },
    {
      ownerId: `gid://shopify/Customer/${customer.shopifyId}`,
      namespace: cfg.metafieldNamespace,
      key: keys.tier,
      type: 'single_line_text_field',
      value: loyaltyTier(customer.balance),
    },
    {
      ownerId: `gid://shopify/Customer/${customer.shopifyId}`,
      namespace: cfg.metafieldNamespace,
      key: keys.syncedAt,
      type: 'single_line_text_field',
      value: new Date().toISOString(),
    },
  ]

  const result = await adminGraphQL<MetafieldsSetResponse>(mutation, { metafields })
  if (!result.ok) return { ok: false, error: result.error ?? 'Shopify rejected the metafield update' }

  const userErrors = result.data?.metafieldsSet.userErrors ?? []
  if (userErrors.length > 0) {
    return { ok: false, error: userErrors.map((e) => e.message).join('; ') }
  }
  return { ok: true }
}

/**
 * Push balances to Shopify customer metafields.
 *
 * Off unless loyalty settings enable it: writing to a live store is a
 * deliberate action, and the default response must never touch customer data.
 */
export async function pushLoyaltyBalances(opts: {
  customerIds?: string[]
  force?: boolean
  limit?: number
} = {}): Promise<LoyaltyPushResult> {
  const result: LoyaltyPushResult = { ok: false, pushed: 0, failed: 0, errors: [] }
  if (!db) {
    result.errors.push({ customerId: '', name: '', shopifyId: null, error: 'Database unavailable' })
    return result
  }
  if (!isConfigured()) {
    result.errors.push({ customerId: '', name: '', shopifyId: null, error: 'Shopify is not configured' })
    return result
  }
  const cfg = await resolveConfig()
  if (!cfg.shopifySync && !opts.force) {
    result.errors.push({
      customerId: '',
      name: '',
      shopifyId: null,
      error: 'Shopify loyalty sync is disabled in loyalty settings',
    })
    return result
  }

  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 200)))
  const where = [isNotNull(s.customers.shopifyId)]
  if (opts.customerIds?.length) where.push(inArray(s.customers.id, opts.customerIds))

  const customers = await db
    .select({ id: s.customers.id, name: s.customers.name, shopifyId: s.customers.shopifyId })
    .from(s.customers)
    .where(and(...where))
    .limit(limit)

  for (const customer of customers) {
    const balance = await getBalance(customer.id)
    const push = await pushOne({ ...customer, balance }, cfg)
    if (push.ok) {
      result.pushed += 1
      await recordSync({ shopifyId: customer.shopifyId, action: 'push_balance', status: 'success' })
    } else {
      result.failed += 1
      result.errors.push({ customerId: customer.id, name: customer.name ?? '', shopifyId: customer.shopifyId, error: push.error ?? 'Unknown error' })
      await recordSync({ shopifyId: customer.shopifyId, action: 'push_balance', status: 'failed', error: push.error })
    }
  }

  result.ok = result.failed === 0
  logger.info({ pushed: result.pushed, failed: result.failed }, 'loyalty: balances pushed to Shopify metafields')
  return result
}

/** Push one customer's balance after a change (no-op unless sync is enabled). */
export async function pushCustomerLoyalty(customerId: string): Promise<void> {
  try {
    const cfg = await resolveConfig()
    if (!cfg.shopifySync || !isConfigured() || !db) return
    const [customer] = await db
      .select({ id: s.customers.id, name: s.customers.name, shopifyId: s.customers.shopifyId })
      .from(s.customers)
      .where(eq(s.customers.id, customerId))
      .limit(1)
    if (!customer?.shopifyId) return
    const balance = await getBalance(customerId)
    const push = await pushOne({ ...customer, balance }, cfg)
    await recordSync({
      shopifyId: customer.shopifyId,
      action: 'push_balance',
      status: push.ok ? 'success' : 'failed',
      error: push.ok ? null : push.error,
    })
  } catch (err) {
    logger.warn({ err, customerId }, 'loyalty: metafield push failed (non-fatal)')
  }
}

export interface LoyaltySyncStatus {
  enabled: boolean
  shopifyConfigured: boolean
  namespace: string
  key: string
  lastSyncedAt: string | null
  lastFailureAt: string | null
  successes24h: number
  failures24h: number
  pendingRetries: number
  recentErrors: Array<{ time: string | null; shopifyId: string | null; error: string | null }>
}

/** Sync health for the Loyalty page (last sync, failures, retry queue). */
export async function getLoyaltySyncStatus(): Promise<LoyaltySyncStatus> {
  const cfg = await resolveConfig()
  const keys = loyaltyMetafieldKeys(cfg)
  const status: LoyaltySyncStatus = {
    enabled: cfg.shopifySync,
    shopifyConfigured: isConfigured(),
    namespace: cfg.metafieldNamespace,
    key: keys.points,
    lastSyncedAt: null,
    lastFailureAt: null,
    successes24h: 0,
    failures24h: 0,
    pendingRetries: 0,
    recentErrors: [],
  }
  if (!db) return status

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const [totals] = await db
    .select({
      successes: sql<string>`count(*) filter (where ${s.syncLogs.status} = 'success')`,
      failures: sql<string>`count(*) filter (where ${s.syncLogs.status} = 'failed')`,
      lastSuccess: sql<string | null>`max(case when ${s.syncLogs.status} = 'success' then ${s.syncLogs.time} end)`,
      lastFailure: sql<string | null>`max(case when ${s.syncLogs.status} = 'failed' then ${s.syncLogs.time} end)`,
      retries: sql<string>`count(*) filter (where ${s.syncLogs.status} = 'failed' and ${s.syncLogs.retry} = true)`,
    })
    .from(s.syncLogs)
    .where(and(eq(s.syncLogs.entity, SYNC_ENTITY), gte(s.syncLogs.time, since)))

  status.successes24h = Number(totals?.successes ?? 0)
  status.failures24h = Number(totals?.failures ?? 0)
  status.pendingRetries = Number(totals?.retries ?? 0)
  status.lastSyncedAt = totals?.lastSuccess ? String(totals.lastSuccess) : null
  status.lastFailureAt = totals?.lastFailure ? String(totals.lastFailure) : null

  const failures = await db
    .select({ time: s.syncLogs.time, shopifyId: s.syncLogs.shopifyId, error: s.syncLogs.error })
    .from(s.syncLogs)
    .where(and(eq(s.syncLogs.entity, SYNC_ENTITY), eq(s.syncLogs.status, 'failed')))
    .orderBy(desc(s.syncLogs.time))
    .limit(5)
  status.recentErrors = failures.map((f) => ({
    time: f.time ? String(f.time) : null,
    shopifyId: f.shopifyId ?? null,
    error: f.error ?? null,
  }))
  return status
}

/** Re-push every customer whose last sync attempt failed. */
export async function retryFailedLoyaltySync(): Promise<LoyaltyPushResult> {
  if (!db) return { ok: false, pushed: 0, failed: 0, errors: [{ customerId: '', name: '', shopifyId: null, error: 'Database unavailable' }] }
  const failures = await db
    .select({ shopifyId: s.syncLogs.shopifyId })
    .from(s.syncLogs)
    .where(and(eq(s.syncLogs.entity, SYNC_ENTITY), eq(s.syncLogs.status, 'failed'), eq(s.syncLogs.retry, true)))
    .orderBy(desc(s.syncLogs.time))
    .limit(200)

  const shopifyIds = [...new Set(failures.map((f) => f.shopifyId).filter((x): x is string => Boolean(x)))]
  if (shopifyIds.length === 0) return { ok: true, pushed: 0, failed: 0, errors: [] }

  const customers = await db
    .select({ id: s.customers.id })
    .from(s.customers)
    .where(inArray(s.customers.shopifyId, shopifyIds))

  const result = await pushLoyaltyBalances({ customerIds: customers.map((c) => c.id), limit: customers.length })
  if (result.ok) {
    await db
      .update(s.syncLogs)
      .set({ retry: false })
      .where(and(eq(s.syncLogs.entity, SYNC_ENTITY), eq(s.syncLogs.status, 'failed')))
  }
  return result
}

// ─── Shopify → ERP ─────────────────────────────────────────────────────────

/**
 * Award points for paid Shopify orders that have no local invoice.
 *
 * Orders with invoices earn through the invoice path (see
 * earnForInvoice), so this only fills the gap: orders imported while
 * invoicing failed, or paid orders recorded before invoicing existed.
 */
export async function awardLoyaltyForShopifyOrders(opts: { limit?: number; orderNames?: string[] } = {}): Promise<{
  awarded: number
  skipped: number
  points: number
}> {
  if (!db) return { awarded: 0, skipped: 0, points: 0 }
  const cfg = await resolveConfig()
  if (!cfg.enabled) return { awarded: 0, skipped: 0, points: 0 }

  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 100)))
  const where = [
    isNotNull(s.salesOrders.shopifyId),
    ne(s.salesOrders.status, 'cancelled'),
    inArray(s.salesOrders.payment, ['paid', 'partially_refunded']),
  ]
  if (opts.orderNames?.length) {
    where.push(inArray(s.salesOrders.shopifyId, opts.orderNames.map((n) => normalizeOrderRef(n))))
  }

  const orders = await db
    .select({
      shopifyId: s.salesOrders.shopifyId,
      value: s.salesOrders.value,
      payment: s.salesOrders.payment,
      status: s.salesOrders.status,
      date: s.salesOrders.date,
      customerShopifyId: s.salesOrders.customerShopifyId,
      customerEmail: s.salesOrders.customerEmail,
      customerPhone: s.salesOrders.customerPhone,
      customer: s.salesOrders.customer,
    })
    .from(s.salesOrders)
    .where(and(...where))
    .orderBy(desc(s.salesOrders.date))
    .limit(limit)

  let awarded = 0
  let skipped = 0
  let points = 0
  for (const order of orders) {
    if (!order.shopifyId) continue
    const result = await earnForShopifyOrder({
      name: order.shopifyId,
      total: order.value,
      financialStatus: order.payment,
      customerShopifyId: order.customerShopifyId,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      customerName: order.customer,
    })
    if (result) {
      awarded += 1
      points += result.points
    } else {
      skipped += 1
    }
  }
  if (awarded > 0) logger.info({ awarded, points, skipped }, 'loyalty: Shopify orders awarded points')
  return { awarded, skipped, points }
}

interface ShopifyRefundPayload {
  id?: number | string
  order_id?: number | string
  created_at?: string
  note?: string | null
  refund_line_items?: Array<{ subtotal?: string | number | null; quantity?: number | null }>
  transactions?: Array<{ amount?: string | number | null; kind?: string | null }>
  order?: { name?: string; id?: number | string }
}

/** Value refunded by a Shopify refund payload (line subtotals, else transactions). */
export function refundValueFromPayload(payload: ShopifyRefundPayload | null | undefined): number {
  if (!payload) return 0
  const lineValue = (payload.refund_line_items ?? []).reduce((sum, li) => sum + Math.max(0, Number(li?.subtotal ?? 0)), 0)
  if (lineValue > 0) return Math.round(lineValue * 100) / 100
  const txValue = (payload.transactions ?? [])
    .filter((t) => !t?.kind || String(t.kind).toLowerCase() !== 'void')
    .reduce((sum, t) => sum + Math.max(0, Number(t?.amount ?? 0)), 0)
  return Math.round(txValue * 100) / 100
}

/**
 * Handle a `refunds/create` webhook: reverse the points for the value returned.
 * Idempotent per Shopify refund id — a retried delivery posts nothing new.
 */
export async function handleShopifyRefund(
  payload: ShopifyRefundPayload,
): Promise<{ ok: boolean; reversed: number; reason?: string }> {
  if (!db) return { ok: false, reversed: 0, reason: 'Database unavailable' }
  let orderName = payload.order?.name ? normalizeOrderRef(payload.order.name) : ''
  if (!orderName && payload.order_id != null) {
    const [local] = await db
      .select({ shopifyId: s.salesOrders.shopifyId })
      .from(s.salesOrders)
      .where(or(eq(s.salesOrders.id, `shopify-${payload.order_id}`), eq(s.salesOrders.shopifyId, normalizeOrderRef(payload.order_id))))
      .limit(1)
    orderName = local?.shopifyId ?? ''
  }
  if (!orderName) return { ok: false, reversed: 0, reason: 'Refund is not linked to a known order' }

  const value = refundValueFromPayload(payload)
  const result = await reverseAward({
    orderName,
    value: value > 0 ? value : null,
    refundId: payload.id != null ? String(payload.id) : null,
    reason: `Reversed for Shopify refund${payload.id != null ? ` #${payload.id}` : ''} on ${orderName}`,
  })
  if (!result) return { ok: true, reversed: 0 }
  logger.info({ orderName, value, points: result.points }, 'loyalty: refund reversed points')
  return { ok: true, reversed: Math.abs(result.points) }
}

/**
 * Handle `orders/cancelled`: reverse everything still awarded for the order.
 */
export async function handleShopifyOrderCancelled(orderName: string): Promise<{ reversed: number }> {
  const name = normalizeOrderRef(orderName)
  if (!name) return { reversed: 0 }
  const result = await reverseAward({
    orderName: name,
    reason: `Reversed — Shopify order ${name} was cancelled`,
  })
  return { reversed: result ? Math.abs(result.points) : 0 }
}

/** Read the balance stored on Shopify for a customer (for reconciliation). */
export async function readShopifyLoyaltyBalance(shopifyId: string): Promise<{ ok: boolean; value: number | null; error?: string }> {
  if (!isConfigured()) return { ok: false, value: null, error: 'Shopify is not configured' }
  const cfg = await resolveConfig()
  const keys = loyaltyMetafieldKeys(cfg)
  const url = `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/customers/${encodeURIComponent(shopifyId)}/metafields.json?namespace=${encodeURIComponent(cfg.metafieldNamespace)}`
  try {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': config.accessToken } })
    if (!res.ok) return { ok: false, value: null, error: `Shopify responded HTTP ${res.status}` }
    const json = (await res.json()) as { metafields?: Array<{ key?: string; value?: string }> }
    const found = (json.metafields ?? []).find((m) => m.key === keys.points)
    if (!found) return { ok: true, value: null }
    const parsed = Number(found.value)
    return { ok: true, value: Number.isFinite(parsed) ? parsed : null }
  } catch (err) {
    return { ok: false, value: null, error: err instanceof Error ? err.message : 'Shopify request failed' }
  }
}

/** After a loyalty movement, push the new balance (when sync is enabled). */
export async function afterLoyaltyChange(customerId: string): Promise<void> {
  await pushCustomerLoyalty(customerId)
}
