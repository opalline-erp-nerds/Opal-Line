/**
 * Order Pipeline: the one place that translates Shopify's order state into the
 * ERP order row (and reports what changed).
 *
 * The bulk import in `shopify.ts` is a pull; webhooks, the per-order refresh and
 * the reconciliation sweep all need the same mapping, from two different payload
 * shapes (REST webhook JSON and GraphQL nodes). Duplicating that mapping is what
 * produced the drift this module removes:
 *
 *   - `partially_refunded` was written as "refunded" (a partial refund looked
 *     like a full one),
 *   - a closed/archived order was written as "fulfilled" (archive ≠ fulfilment),
 *   - a partially fulfilled order lost the distinction entirely,
 *   - tracking and per-line fulfilled quantities were never stored, and
 *   - every order update reset the operator's ERP pipeline stage back to
 *     "imported".
 *
 * Rules encoded here:
 *   - Shopify's statuses are stored verbatim (`shopify_financial_status`,
 *     `shopify_fulfillment_status`). The ERP `status` column stays the
 *     operator's stage and is only moved by Shopify when the order is genuinely
 *     fulfilled / cancelled (or when a Shopify fulfilment is cancelled and the
 *     stage it set has to be recalculated).
 *   - Every apply is a DIFF: an identical payload writes nothing and emits no
 *     timeline event, so webhook retries are idempotent.
 *   - Nothing here touches stock. The import owns the one-time deduction; a
 *     state sync must never deduct (or restock) a second time.
 */
import { and, desc, eq, or } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from './db/client'
import * as s from './db/schema'
import { logger } from './logger'
import { adminGraphQL, type ShopifyGraphQLResult } from './shopifyRefunds'

export type LocalOrder = typeof s.salesOrders.$inferSelect

// ─── Stages ─────────────────────────────────────────────────────────────────

/**
 * The page's tabs, resolved to exactly one value per order.
 *
 * Shopify's own tabs overlap (an unfulfilled order is also "open"), which makes
 * counts impossible to reconcile. These buckets are disjoint:
 *   cancelled → archived → fulfilled → partially_fulfilled → in_progress →
 *   unfulfilled (paid, ready to ship) → open (new / not paid yet).
 *
 * `in_progress` is the ERP's own stage, deliberately kept separate from
 * Shopify's: confirming an order internally does not fulfil it in Shopify, and
 * a Shopify fulfilment does not erase the operator's stage.
 */
export type PipelineStage =
  | 'open'
  | 'in_progress'
  | 'unfulfilled'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'cancelled'
  | 'archived'

export interface StageInput {
  status?: string | null
  fulfillment?: string | null
  cancelledAt?: string | null
  closedAt?: string | null
  shopifyFulfillmentStatus?: string | null
  shopifyFinancialStatus?: string | null
}

/** Money was actually collected (an authorization is not a payment). */
const PAID_FINANCIAL_STATUSES = new Set(['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED'])

export function deriveStage(order: StageInput): PipelineStage {
  const erp = String(order.status ?? '').trim().toLowerCase()
  const native = String(order.shopifyFulfillmentStatus ?? '').trim().toUpperCase()
  const financial = String(order.shopifyFinancialStatus ?? '').trim().toUpperCase()

  const coarseFulfillment = String(order.fulfillment ?? '').toLowerCase()
  const coarsePayment = String((order as StageInput & { payment?: string | null }).payment ?? '').toLowerCase()
  if (order.cancelledAt || erp === 'cancelled') return 'cancelled'
  if (order.closedAt) return 'archived'
  if (native === 'FULFILLED' || (!native && coarseFulfillment === 'fulfilled') || erp === 'fulfilled') return 'fulfilled'
  if (native === 'PARTIALLY_FULFILLED' || (!native && coarseFulfillment === 'partial')) return 'partially_fulfilled'
  if (erp === 'confirmed' || erp === 'processing') return 'in_progress'
  if (native === 'IN_PROGRESS' || native === 'ON_HOLD' || native === 'SCHEDULED') return 'in_progress'
  // Paid but not shipped: the order is ready to fulfil. Legacy rows have no
  // native financial status yet, so retain their existing coarse payment.
  if ((PAID_FINANCIAL_STATUSES.has(financial) || (!financial && coarsePayment === 'paid')) && (native === 'UNFULFILLED' || !native)) return 'unfulfilled'
  return 'open'
}

// ─── Status mapping ─────────────────────────────────────────────────────────

const FINANCIAL_ENUM: Record<string, string> = {
  paid: 'PAID',
  pending: 'PENDING',
  authorized: 'AUTHORIZED',
  partially_paid: 'PARTIALLY_PAID',
  partially_refunded: 'PARTIALLY_REFUNDED',
  refunded: 'REFUNDED',
  voided: 'VOIDED',
  expired: 'EXPIRED',
}

/**
 * REST sends `partially_refunded`, GraphQL sends `PARTIALLY_REFUNDED`. Both
 * become the GraphQL enum so the stored value, the badge lookup and the
 * round-trip comparison all agree.
 */
export function normalizeFinancialStatus(value: unknown): string | null {
  const text = String(value ?? '').trim().replace(/[\s-]+/g, '_')
  if (!text) return null
  return FINANCIAL_ENUM[text.toLowerCase()] ?? text.toUpperCase()
}

/** REST's `partial` and GraphQL's `PARTIALLY_FULFILLED` are the same state. */
export function normalizeFulfillmentStatus(value: unknown): string | null {
  const text = String(value ?? '').trim().replace(/[\s-]+/g, '_').toUpperCase()
  if (!text) return null
  if (text === 'PARTIAL') return 'PARTIALLY_FULFILLED'
  return text
}

/** ERP `payment` column: the coarse state the rest of the ERP already renders. */
export function erpPaymentFor(financial: string | null | undefined): string | null {
  switch (String(financial ?? '').toUpperCase()) {
    case 'REFUNDED':
    case 'VOIDED':
      return 'refunded'
    case 'PAID':
    case 'PARTIALLY_PAID':
    case 'PARTIALLY_REFUNDED':
      return 'paid'
    case 'PENDING':
    case 'AUTHORIZED':
    case 'EXPIRED':
      return 'pending'
    default:
      return null
  }
}

/** ERP `fulfillment` column. */
export function erpFulfillmentFor(status: string | null | undefined): string | null {
  switch (String(status ?? '').toUpperCase()) {
    case 'FULFILLED':
      return 'fulfilled'
    case 'PARTIALLY_FULFILLED':
      return 'partial'
    case 'IN_PROGRESS':
      return 'processing'
    case 'RESTOCKED':
      return 'returned'
    case 'UNFULFILLED':
    case 'ON_HOLD':
    case 'SCHEDULED':
    case 'PENDING_FULFILLMENT':
      return 'unfulfilled'
    default:
      return null
  }
}

// ─── Snapshots ──────────────────────────────────────────────────────────────

export interface SnapshotLine {
  shopifyLineItemId?: string
  sku: string
  title?: string
  quantity: number
  price?: number
  /** Units already fulfilled in Shopify (per line). */
  fulfilledQuantity?: number
}

export interface OrderSnapshot {
  name: string | null
  gid: string | null
  currency: string | null
  total: number | null
  financialStatus: string | null
  fulfillmentStatus: string | null
  cancelledAt: string | null
  closedAt: string | null
  tracking: { number: string | null; company: string | null; url: string | null }
  fulfillmentIds: string[]
  lines: SnapshotLine[] | null
}

function cleanText(value: unknown): string {
  return typeof value === 'string' && value.trim() && value.trim() !== 'undefined' ? value.trim() : ''
}

function num(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function gidFrom(kind: string, gid: unknown, id: unknown): string | null {
  if (typeof gid === 'string' && gid.startsWith('gid://')) return gid
  return id != null && String(id).trim() ? `gid://shopify/${kind}/${String(id).trim()}` : null
}

function trackingFromFulfillments(
  fulfillments: Array<{ status?: unknown; trackingInfo?: { number?: unknown; company?: unknown; url?: unknown } | null; tracking_number?: unknown; tracking_company?: unknown; tracking_url?: unknown }>,
): { number: string | null; company: string | null; url: string | null } {
  // The newest fulfilment that actually carries a number wins; a cancelled
  // fulfilment's tracking is history, not the shipment's current tracking.
  for (const f of [...fulfillments].reverse()) {
    if (String(f?.status ?? '').trim().toLowerCase() === 'cancelled') continue
    const number = cleanText(f?.trackingInfo?.number ?? f?.tracking_number)
    if (!number) continue
    return {
      number,
      company: cleanText(f?.trackingInfo?.company ?? f?.tracking_company) || null,
      url: cleanText(f?.trackingInfo?.url ?? f?.tracking_url) || null,
    }
  }
  return { number: null, company: null, url: null }
}

/** Snapshot from a Shopify REST order payload (webhooks, REST import). */
export function snapshotFromRestOrder(raw: unknown): OrderSnapshot {
  const o = (raw ?? {}) as Record<string, any>
  const fulfillments: any[] = Array.isArray(o.fulfillments) ? o.fulfillments : []
  const lines: any[] = Array.isArray(o.line_items) ? o.line_items : []
  return {
    name: cleanText(o.name) || null,
    gid: gidFrom('Order', o.admin_graphql_api_id, o.id),
    currency: cleanText(o.currency) || cleanText(o.presentment_currency) || null,
    total: num(o.total_price),
    financialStatus: normalizeFinancialStatus(o.financial_status),
    fulfillmentStatus: normalizeFulfillmentStatus(o.fulfillment_status ?? 'unfulfilled'),
    // Webhook order payloads are complete, so a null here means "not cancelled"
    // / "not closed" — never "unknown".
    cancelledAt: cleanText(o.cancelled_at) || null,
    closedAt: cleanText(o.closed_at) || null,
    tracking: trackingFromFulfillments(fulfillments),
    fulfillmentIds: fulfillments
      .map((f) => gidFrom('Fulfillment', f?.admin_graphql_api_id, f?.id))
      .filter((x): x is string => Boolean(x)),
    lines: lines.length
      ? lines.map((li) => {
          const quantity = Math.max(0, Number(li?.quantity ?? 0))
          const fulfillable = num(li?.fulfillable_quantity)
          return {
            shopifyLineItemId: gidFrom('LineItem', li?.admin_graphql_api_id, li?.id) ?? undefined,
            sku: cleanText(li?.sku),
            title: cleanText(li?.title) || undefined,
            quantity,
            price: num(li?.price) ?? undefined,
            // fulfillable_quantity is what is LEFT; fulfilled is the difference.
            fulfilledQuantity: fulfillable == null ? undefined : Math.max(0, Math.min(quantity, quantity - fulfillable)),
          }
        })
      : null,
  }
}

/**
 * Snapshot from a GraphQL order node that was selected with
 * `ORDER_STATE_FIELDS` below. Per-line fulfilled counts are derived from the
 * fulfillment orders (total − remaining), which stays correct across partial
 * fulfilments, cancelled fulfilments and splits.
 */
export function snapshotFromGraphqlOrder(node: unknown): OrderSnapshot | null {
  const o = (node ?? {}) as Record<string, any>
  if (!o.id) return null
  const fulfillments: any[] = Array.isArray(o.fulfillments) ? o.fulfillments : o.fulfillments?.nodes ?? []
  const fulfillmentOrders: any[] = o.fulfillmentOrders?.nodes ?? []

  const byLineId = new Map<string, { total: number; remaining: number }>()
  for (const fo of fulfillmentOrders) {
    for (const li of fo?.lineItems?.nodes ?? []) {
      const lineId = cleanText(li?.lineItem?.id)
      if (!lineId) continue
      const prev = byLineId.get(lineId) ?? { total: 0, remaining: 0 }
      prev.total += Math.max(0, Number(li?.totalQuantity ?? 0))
      prev.remaining += Math.max(0, Number(li?.remainingQuantity ?? 0))
      byLineId.set(lineId, prev)
    }
  }

  const lineNodes: any[] = o.lineItems?.nodes ?? []
  const lines = lineNodes.length
    ? lineNodes.map((li) => {
        const quantity = Math.max(0, Number(li?.quantity ?? 0))
        const lineId = cleanText(li?.id)
        const sku = cleanText(li?.sku)
        const agg = byLineId.get(lineId)
        const fulfilled = agg ? Math.max(0, Math.min(quantity, agg.total - agg.remaining)) : undefined
        return {
          shopifyLineItemId: lineId || undefined,
          sku,
          title: cleanText(li?.name) || undefined,
          quantity,
          price: num(li?.originalUnitPriceSet?.shopMoney?.amount) ?? undefined,
          fulfilledQuantity: fulfilled,
        }
      })
    : null

  return {
    name: cleanText(o.name) || null,
    gid: cleanText(o.id) || null,
    currency: cleanText(o.totalPriceSet?.shopMoney?.currencyCode) || cleanText(o.currencyCode) || null,
    total: num(o.totalPriceSet?.shopMoney?.amount),
    financialStatus: normalizeFinancialStatus(o.displayFinancialStatus),
    fulfillmentStatus: normalizeFulfillmentStatus(o.displayFulfillmentStatus ?? 'UNFULFILLED'),
    cancelledAt: cleanText(o.cancelledAt) || null,
    closedAt: cleanText(o.closedAt) || null,
    tracking: trackingFromFulfillments(fulfillments),
    fulfillmentIds: fulfillments.map((f) => cleanText(f?.id)).filter(Boolean),
    lines,
  }
}

/** The selection used by every single-order / sweep query in this module. */
export const ORDER_STATE_FIELDS = `#graphql
  id
  name
  createdAt
  cancelledAt
  closedAt
  displayFinancialStatus
  displayFulfillmentStatus
  currencyCode
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 100) {
    nodes { id name sku quantity originalUnitPriceSet { shopMoney { amount } } }
  }
  # Order.fulfillments is a plain list in this API version. Asking for nodes
  # fails the whole query, so tracking never loaded.
  fulfillments(first: 20) {
    id
    status
    trackingInfo { number company url }
  }
  fulfillmentOrders(first: 20) {
    nodes {
      id
      status
      requestStatus
      supportedActions { action }
      lineItems(first: 100) {
        nodes { id sku totalQuantity remainingQuantity lineItem { id name sku } }
      }
    }
  }
`

// ─── Patch building (pure) ──────────────────────────────────────────────────

export type OrderPatch = Partial<typeof s.salesOrders.$inferInsert>

export interface PatchResult {
  patch: OrderPatch
  /** Machine keys of what actually differs — used for timeline events. */
  changes: string[]
}

/**
 * Compare a Shopify snapshot with the local row and return ONLY the columns
 * that differ. An unchanged payload produces an empty patch, which is what
 * makes duplicate webhook deliveries free (no write, no event).
 */
export function buildOrderPatch(local: LocalOrder, snap: OrderSnapshot, nowIso = new Date().toISOString()): PatchResult {
  const patch: OrderPatch = {}
  const changes: string[] = []

  const setText = (key: keyof OrderPatch, next: string | null, change: string) => {
    const current = (local as Record<string, unknown>)[key as string]
    if (String(current ?? '') === String(next ?? '')) return
    ;(patch as Record<string, unknown>)[key as string] = next
    if (!changes.includes(change)) changes.push(change)
  }

  if (snap.gid) setText('shopifyGid', snap.gid, 'gid')
  if (snap.currency) setText('currency', snap.currency.toUpperCase(), 'currency')

  if (snap.total != null) {
    const next = round2(snap.total)
    const current = round2(Number(local.value ?? 0))
    if (Math.abs(next - current) > 0.005) {
      patch.value = next
      changes.push('total')
    }
  }

  if (snap.financialStatus) {
    setText('shopifyFinancialStatus', snap.financialStatus, 'financial')
    const payment = erpPaymentFor(snap.financialStatus)
    // A pending -> paid move is a real change; refunds are reconciled by the
    // refund ledger, so this must not fight it (both agree on "refunded").
    if (payment && String(local.payment ?? '') !== payment) {
      patch.payment = payment
      if (!changes.includes('financial')) changes.push('financial')
    }
  }

  if (snap.fulfillmentStatus) {
    const previousNative = String(local.shopifyFulfillmentStatus ?? '').toUpperCase()
    setText('shopifyFulfillmentStatus', snap.fulfillmentStatus, 'fulfillment')
    const fulfillment = erpFulfillmentFor(snap.fulfillmentStatus)
    if (fulfillment && String(local.fulfillment ?? '') !== fulfillment) {
      patch.fulfillment = fulfillment
      if (!changes.includes('fulfillment')) changes.push('fulfillment')
    }
    // Only a real transition is an event. Pushing 'fulfilled' on every delivery
    // (as an unconditional check would) makes a retried webhook raise the invoice
    // and email the customer again for an order that already shipped.
    const nativeChanged = previousNative !== snap.fulfillmentStatus
    if (nativeChanged && snap.fulfillmentStatus === 'PARTIALLY_FULFILLED' && !changes.includes('partial')) changes.push('partial')
    if (nativeChanged && snap.fulfillmentStatus === 'FULFILLED' && !changes.includes('fulfilled')) {
      changes.push('fulfilled')
      // 'fulfilled' is also the first-sync label for a legacy row whose previous
      // state was unknown. Side effects (invoice, customer email) must wait for a
      // transition from a KNOWN unfulfilled/partial state.
      if (previousNative && !changes.includes('became-fulfilled')) changes.push('became-fulfilled')
    }
    if (previousNative === 'FULFILLED' && snap.fulfillmentStatus !== 'FULFILLED' && !changes.includes('unfulfilled')) {
      changes.push('unfulfilled')
    }
  }

  // Lifecycle. Snapshot nulls are authoritative (an order can be reopened with
  // orderOpen), so the column is cleared when Shopify says it is.
  if (String(local.cancelledAt ?? '') !== String(snap.cancelledAt ?? '')) {
    patch.cancelledAt = snap.cancelledAt
    changes.push(snap.cancelledAt ? 'cancelled' : 'uncancelled')
  }
  if (String(local.closedAt ?? '') !== String(snap.closedAt ?? '')) {
    patch.closedAt = snap.closedAt
    changes.push(snap.closedAt ? 'archived' : 'reopened')
  }

  // Tracking: only ever write a real number. A payload without tracking (e.g.
  // a partial fulfilment of one line) must not blank the shipment already known.
  if (snap.tracking.number) {
    const current = String(local.trackingNumber ?? '')
    if (current !== snap.tracking.number) {
      patch.trackingNumber = snap.tracking.number
      patch.trackingCompany = snap.tracking.company
      patch.trackingUrl = snap.tracking.url
      changes.push('tracking')
    } else if (String(local.trackingCompany ?? '') !== String(snap.tracking.company ?? '')) {
      patch.trackingCompany = snap.tracking.company
      changes.push('tracking')
    }
  }

  if (snap.fulfillmentIds.length) {
    const current = Array.isArray(local.fulfillmentIds) ? (local.fulfillmentIds as string[]) : []
    const merged = [...new Set([...current.map(String), ...snap.fulfillmentIds])]
    if (merged.length !== current.length) {
      patch.fulfillmentIds = merged
      if (!changes.includes('fulfillment')) changes.push('fulfillment')
    }
  }

  // Per-line fulfilled quantities (the "partially fulfilled quantities" view).
  if (snap.lines?.length) {
    const stored = Array.isArray(local.lineItems) ? (local.lineItems as Array<Record<string, unknown>>) : []
    let linesChanged = false
    const merged = stored.map((li) => {
      const sku = cleanText(li.sku)
      const lineId = cleanText(li.shopifyLineItemId)
      const match = snap.lines!.find((l) => (lineId && l.shopifyLineItemId === lineId) || (!lineId && cleanText(l.sku) === sku))
      if (!match) return li
      const next: Record<string, unknown> = {
        ...li,
        ...(match.shopifyLineItemId ? { shopifyLineItemId: match.shopifyLineItemId } : {}),
        ...(match.title ? { title: match.title } : {}),
        ...(match.quantity >= 0 ? { quantity: match.quantity } : {}),
        ...(match.price != null ? { price: match.price } : {}),
      }
      if (match.fulfilledQuantity != null) {
        next.fulfilledQuantity = Math.max(0, Math.min(match.fulfilledQuantity, match.quantity))
      }
      const changed = JSON.stringify(next) !== JSON.stringify(li)
      if (changed) linesChanged = true
      return next
    })
    // Products Shopify added after the first import still belong on the order.
    for (const l of snap.lines) {
      const alreadyStored = merged.some((li) =>
        (l.shopifyLineItemId && cleanText(li.shopifyLineItemId) === l.shopifyLineItemId) ||
        (!l.shopifyLineItemId && cleanText(li.sku) === cleanText(l.sku)),
      )
      if (!cleanText(l.sku) || alreadyStored) continue
      merged.push({ shopifyLineItemId: l.shopifyLineItemId, title: l.title ?? '', sku: l.sku, quantity: l.quantity, price: l.price ?? 0, fulfilledQuantity: l.fulfilledQuantity ?? 0 })
      linesChanged = true
    }
    if (linesChanged) {
      patch.lineItems = merged
      if (!changes.includes('lines')) changes.push('lines')
    }
  }

  // ERP stage. Shopify may only move it for a genuine fulfilment/cancellation.
  const erp = String(local.status ?? '').toLowerCase()
  let nextStatus: string | null = null
  if (snap.cancelledAt) nextStatus = 'cancelled'
  else if (erp === 'cancelled') nextStatus = 'cancelled'
  else if (snap.fulfillmentStatus === 'FULFILLED') nextStatus = 'fulfilled'
  // A fulfilment cancelled in Shopify must recalculate the stage it set — but a
  // stage the operator set by hand is not ours to undo.
  else if (erp === 'fulfilled' && String(local.shopifyFulfillmentStatus ?? '').toUpperCase() === 'FULFILLED') nextStatus = 'processing'
  if (nextStatus && nextStatus !== (local.status ?? '')) {
    patch.status = nextStatus
    changes.push('status')
  }

  if (changes.length > 0) patch.shopifySyncedAt = nowIso
  return { patch, changes }
}

// ─── Persistence ────────────────────────────────────────────────────────────

export interface ApplyResult {
  ok: boolean
  found: boolean
  updated: boolean
  changed: string[]
  orderId?: string
  error?: string
}

async function insertEvent(orderId: string, event: string, details: string, actor: string): Promise<void> {
  // Dynamic import: routes/db imports this module for its endpoints, so a
  // static import would close the cycle.
  try {
    const { insertOrderEvent } = await import('./routes/db')
    await insertOrderEvent(orderId, event, details, actor)
  } catch (err) {
    logger.warn({ err, orderId }, 'Order Pipeline: timeline event could not be written')
  }
}

export function describeChanges(changes: string[], snap: OrderSnapshot): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const tracking = snap.tracking.number ? ` — tracking ${snap.tracking.number}${snap.tracking.company ? ` (${snap.tracking.company})` : ''}` : ''
  if (changes.includes('cancelled')) out.push(['Cancelled', `Order cancelled in Shopify${tracking}`])
  if (changes.includes('archived')) out.push(['Archived', 'Order closed (archived) in Shopify'])
  if (changes.includes('reopened')) out.push(['Reopened', 'Order reopened in Shopify'])
  if (changes.includes('uncancelled')) out.push(['Reopened', 'Cancellation reversed in Shopify'])
  if (changes.includes('fulfilled')) out.push(['Fulfilled', `Shopify fulfilment complete${tracking}`])
  if (changes.includes('partial')) out.push(['Partially Fulfilled', `Part of the order was fulfilled in Shopify${tracking}`])
  if (changes.includes('unfulfilled')) out.push(['Fulfilment Cancelled', 'A Shopify fulfilment was cancelled — the order is open again'])
  if (changes.includes('tracking') && !changes.includes('fulfilled') && !changes.includes('partial')) {
    out.push(['Tracking Updated', `Shopify tracking${tracking}`])
  }
  if (changes.includes('financial')) out.push(['Payment Updated', `Shopify payment status: ${snap.financialStatus ?? 'unknown'}`])
  return out
}

export async function applyOrderSnapshot(
  local: LocalOrder,
  snap: OrderSnapshot,
  opts: { actor?: string } = {},
): Promise<{ updated: boolean; changes: string[] }> {
  if (!db) return { updated: false, changes: [] }
  // Row lock and recompute inside the transaction: orders/updated and
  // fulfillments/create can arrive concurrently with two different webhook
  // delivery ids. Without this lock both would observe the same old row and
  // write duplicate timeline events (or overwrite partial quantities).
  const applied = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(s.salesOrders).where(eq(s.salesOrders.id, local.id)).limit(1).for('update')
    if (!current) return { updated: false, changes: [] as string[] }
    const { patch, changes } = buildOrderPatch(current, snap)
    if (changes.length === 0) return { updated: false, changes }
    await tx.update(s.salesOrders).set(patch).where(eq(s.salesOrders.id, current.id))
    return { updated: true, changes }
  })
  if (!applied.updated) return applied
  for (const [event, details] of describeChanges(applied.changes, snap)) {
    await insertEvent(local.id, event, details, opts.actor ?? 'shopify')
  }
  logger.info({ orderId: local.id, order: local.internalId ?? local.shopifyId, changes: applied.changes }, 'Order Pipeline: local order updated from Shopify')
  return applied
}

export async function findLocalOrder(refs: { name?: string | null; gid?: string | null }): Promise<LocalOrder | null> {
  if (!db) return null
  const name = cleanText(refs.name)
  const gid = cleanText(refs.gid)
  if (!name && !gid) return null
  const clauses = []
  if (name) clauses.push(eq(s.salesOrders.shopifyId, name))
  if (gid) clauses.push(eq(s.salesOrders.shopifyGid, gid))
  if (!clauses.length) return null
  const [row] = await db.select().from(s.salesOrders).where(clauses.length === 1 ? clauses[0] : or(...clauses)).limit(1)
  return row ?? null
}

/** Apply a REST order payload (any `orders/*` webhook). */
export async function applyShopifyOrderPayload(raw: unknown, opts: { actor?: string } = {}): Promise<ApplyResult> {
  if (!db) return { ok: false, found: false, updated: false, changed: [], error: 'Database is not configured' }
  const snap = snapshotFromRestOrder(raw)
  if (!snap.name && !snap.gid) return { ok: false, found: false, updated: false, changed: [], error: 'The payload carries no order reference' }
  const local = await findLocalOrder({ name: snap.name, gid: snap.gid })
  if (!local) return { ok: true, found: false, updated: false, changed: [] }
  const res = await applyOrderSnapshot(local, snap, opts)
  return { ok: true, found: true, updated: res.updated, changed: res.changes, orderId: local.id }
}

// ─── GraphQL reads ──────────────────────────────────────────────────────────

export interface FulfillableLine {
  fulfillmentOrderId: string
  fulfillmentOrderLineItemId: string
  sku: string
  name: string
  /** Units still fulfillable on this fulfillment order. */
  remaining: number
  /** Units on the order line (across fulfillment orders). */
  total: number
}

export interface ShopifyOrderState {
  ok: boolean
  error?: string
  orderId?: string
  orderGid?: string
  orderName?: string
  currency?: string
  financialStatus?: string | null
  fulfillmentStatus?: string | null
  cancelledAt?: string | null
  closedAt?: string | null
  tracking?: { number: string | null; company: string | null; url: string | null }
  fulfillments?: Array<{ id: string; status: string; tracking: { number: string | null; company: string | null; url: string | null } | null }>
  lines?: FulfillableLine[]
  snapshot?: OrderSnapshot
  raw?: unknown
}

const STATE_QUERY = `#graphql
  query OrderState($id: ID!) {
    order(id: $id) { ${ORDER_STATE_FIELDS} }
  }
`

const STATE_BY_NAME_QUERY = `#graphql
  query OrderStateByName($q: String!) {
    orders(first: 1, query: $q) { nodes { ${ORDER_STATE_FIELDS} } }
  }
`

function stateFromNode(node: any): ShopifyOrderState {
  const snapshot = snapshotFromGraphqlOrder(node)
  if (!snapshot) return { ok: false, error: 'Shopify returned no order' }
  const lines: FulfillableLine[] = []
  for (const fo of node?.fulfillmentOrders?.nodes ?? []) {
    const open = ['OPEN', 'IN_PROGRESS', 'SCHEDULED', 'ON_HOLD'].includes(String(fo?.status ?? '').toUpperCase())
    if (!open) continue
    for (const li of fo?.lineItems?.nodes ?? []) {
      const remaining = Math.max(0, Number(li?.remainingQuantity ?? 0))
      if (remaining <= 0) continue
      lines.push({
        fulfillmentOrderId: String(fo.id),
        fulfillmentOrderLineItemId: String(li.id),
        sku: cleanText(li?.sku ?? li?.lineItem?.sku),
        name: cleanText(li?.lineItem?.name ?? li?.sku) || 'Item',
        remaining,
        total: Math.max(0, Number(li?.totalQuantity ?? 0)),
      })
    }
  }
  return {
    ok: true,
    orderGid: snapshot.gid ?? undefined,
    orderName: snapshot.name ?? undefined,
    currency: snapshot.currency ?? undefined,
    financialStatus: snapshot.financialStatus,
    fulfillmentStatus: snapshot.fulfillmentStatus,
    cancelledAt: snapshot.cancelledAt,
    closedAt: snapshot.closedAt,
    tracking: snapshot.tracking,
    fulfillments: (Array.isArray(node?.fulfillments) ? node.fulfillments : node?.fulfillments?.nodes ?? []).map((f: any) => ({
      id: String(f?.id ?? ''),
      status: String(f?.status ?? ''),
      tracking: f?.trackingInfo
        ? { number: cleanText(f.trackingInfo.number) || null, company: cleanText(f.trackingInfo.company) || null, url: cleanText(f.trackingInfo.url) || null }
        : null,
    })),
    lines,
    snapshot,
    raw: node,
  }
}

/**
 * Authoritative live state for one local order. The `lines` come from Shopify's
 * fulfillment orders, so the fulfil dialog can only ever offer quantities
 * Shopify says are still fulfillable.
 */
export async function fetchShopifyOrderState(localOrderId: string): Promise<ShopifyOrderState> {
  if (!db) return { ok: false, error: 'Database is not configured' }
  const [local] = await db.select().from(s.salesOrders).where(eq(s.salesOrders.id, localOrderId)).limit(1)
  if (!local) return { ok: false, error: 'Order not found' }
  return fetchShopifyOrderStateFor(local)
}

export async function fetchShopifyOrderStateFor(local: LocalOrder): Promise<ShopifyOrderState> {
  if (local.shopifyGid) {
    const res = await adminGraphQL<{ order: any }>(STATE_QUERY, { id: local.shopifyGid })
    if (!res.ok) return { ok: false, error: res.error ?? 'Shopify request failed' }
    const node = res.data?.order
    if (!node) return { ok: false, error: 'That order no longer exists in Shopify' }
    return stateFromNode(node)
  }
  const name = cleanText(local.shopifyId)
  if (!name) return { ok: false, error: 'This order is not linked to a Shopify order' }
  // A legacy row imported before `shopify_gid` existed: find it by name once,
  // then the gid is persisted by the next apply.
  const res = await adminGraphQL<{ orders: { nodes: any[] } }>(STATE_BY_NAME_QUERY, { q: `name:${name}` })
  if (!res.ok) return { ok: false, error: res.error ?? 'Shopify request failed' }
  const node = res.data?.orders?.nodes?.[0]
  if (!node) return { ok: false, error: `Order ${name} was not found in Shopify` }
  return stateFromNode(node)
}

/** Re-read one order from Shopify and apply it locally. */
export async function refreshOrderFromShopify(localOrderId: string, opts: { actor?: string } = {}): Promise<ApplyResult> {
  if (!db) return { ok: false, found: false, updated: false, changed: [], error: 'Database is not configured' }
  const [local] = await db.select().from(s.salesOrders).where(eq(s.salesOrders.id, localOrderId)).limit(1)
  if (!local) return { ok: false, found: false, updated: false, changed: [], error: 'Order not found' }
  const state = await fetchShopifyOrderStateFor(local)
  if (!state.ok || !state.snapshot) {
    return { ok: false, found: true, updated: false, changed: [], orderId: local.id, error: state.error ?? 'Shopify request failed' }
  }
  const res = await applyOrderSnapshot(local, state.snapshot, opts)
  return { ok: true, found: true, updated: res.updated, changed: res.changes, orderId: local.id }
}

/**
 * Apply the order referenced by a `fulfillments/*` webhook.
 *
 * The webhook body carries `order_id` but no order name, and no line detail
 * that survives a fulfilment cancellation — so the canonical state is read back
 * from Shopify and applied. One API call per event, idempotent by construction.
 */
export async function applyFulfillmentWebhook(raw: unknown, opts: { actor?: string } = {}): Promise<ApplyResult> {
  if (!db) return { ok: false, found: false, updated: false, changed: [], error: 'Database is not configured' }
  const body = (raw ?? {}) as Record<string, any>
  const orderId = body.order_id ?? body.orderId
  if (orderId == null) return { ok: false, found: false, updated: false, changed: [], error: 'Fulfillment webhook has no order id' }
  const gid = `gid://shopify/Order/${String(orderId)}`
  // Legacy local rows may predate shopify_gid. Query the order by its stable gid
  // first; its returned name then lets us match the pre-existing display-name
  // key. No REST id → order-name assumption is made.
  const res = await adminGraphQL<{ order: any }>(STATE_QUERY, { id: gid })
  if (!res.ok) return { ok: false, found: false, updated: false, changed: [], error: res.error ?? 'Shopify request failed' }
  const snap = snapshotFromGraphqlOrder(res.data?.order)
  if (!snap) return { ok: true, found: false, updated: false, changed: [] }
  const local = await findLocalOrder({ gid, name: snap.name })
  if (!local) return { ok: true, found: false, updated: false, changed: [] }
  const applied = await applyOrderSnapshot(local, snap, opts)
  return { ok: true, found: true, updated: applied.updated, changed: applied.changes, orderId: local.id }
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

export interface ReconcileResult {
  ok: boolean
  checked: number
  updated: number
  unchanged: number
  missing: number
  errors: string[]
  checkedAt: string
}

const RECENT_ORDERS_QUERY = `#graphql
  query RecentOrders($first: Int!, $after: String, $q: String!) {
    orders(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_STATE_FIELDS} }
    }
  }
`

/**
 * Orders per Shopify request. Each order carries 100 line items and 20
 * fulfillment orders, and Shopify rejects a single query above 1000 cost
 * points — 250 orders in one request failed with "Query cost is 1388".
 */
const RECONCILE_PAGE_SIZE = 15

interface RecentOrdersPage {
  orders?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
    nodes: Array<Record<string, unknown>>
  }
}

/**
 * Bring recent orders level with Shopify.
 *
 * This is the backstop for a missed webhook: it re-reads the last N days of
 * orders and applies only what differs. It never imports new orders (the full
 * import owns creation + stock deduction) and never touches stock.
 */
export async function reconcileShopifyOrders(opts: { days?: number; limit?: number } = {}): Promise<ReconcileResult> {
  const startedAt = Date.now()
  const checkedAt = new Date().toISOString()
  const result: ReconcileResult = { ok: false, checked: 0, updated: 0, unchanged: 0, missing: 0, errors: [], checkedAt }
  if (!db) {
    result.errors.push('Database is not configured')
    return result
  }

  const days = Math.max(1, Math.min(365, opts.days ?? 30))
  const limit = Math.max(1, Math.min(250, opts.limit ?? 100))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  let after: string | null = null
  let pages = 0
  const maxPages = Math.ceil(limit / RECONCILE_PAGE_SIZE) + 1
  while (result.checked < limit && pages < maxPages) {
    pages++
    const remaining = limit - result.checked
    const res: ShopifyGraphQLResult<RecentOrdersPage> = await adminGraphQL<RecentOrdersPage>(RECENT_ORDERS_QUERY, {
      first: Math.min(RECONCILE_PAGE_SIZE, remaining),
      after,
      q: `status:any updated_at:>=${since}`,
    })
    if (!res.ok) {
      result.errors.push(res.error ?? 'Shopify request failed')
      break
    }
    const page = res.data?.orders
    for (const node of page?.nodes ?? []) {
      const snap = snapshotFromGraphqlOrder(node)
      if (!snap) continue
      result.checked++
      try {
        const local = await findLocalOrder({ name: snap.name, gid: snap.gid })
        if (!local) {
          result.missing++
          continue
        }
        const applied = await applyOrderSnapshot(local, snap, { actor: 'shopify-sync' })
        if (applied.updated) result.updated++
        else result.unchanged++
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : 'Failed to apply an order')
      }
    }
    if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break
    after = page.pageInfo.endCursor
  }

  result.ok = result.errors.length === 0
  await persistReconcileLog(result, startedAt)
  return result
}

async function persistReconcileLog(result: ReconcileResult, startedAt: number): Promise<void> {
  if (!db) return
  try {
    await db.insert(s.syncLogs).values({
      id: randomUUID(),
      entity: 'Order',
      direction: 'in',
      action: 'Orders Reconciled',
      status: result.ok ? 'success' : 'failed',
      time: new Date().toISOString(),
      error: result.errors.length ? result.errors.join('; ').slice(0, 500) : null,
    })
  } catch (err) {
    logger.warn({ err }, 'Order Pipeline: reconcile log could not be written')
  }
  logger.info(
    { ...result, durationMs: Date.now() - startedAt },
    result.ok ? 'Order Pipeline: reconciliation finished' : 'Order Pipeline: reconciliation finished with errors',
  )
}

// ─── Status for the UI ──────────────────────────────────────────────────────

export interface OrderSyncStatus {
  configured: boolean
  lastSyncedAt: string | null
  syncedRecently: number
  counts: Record<PipelineStage | 'all', number>
  lastError: { at: string | null; message: string | null; action: string | null } | null
  stages: PipelineStage[]
}

export async function getOrderSyncStatus(): Promise<OrderSyncStatus> {
  const stages: PipelineStage[] = ['open', 'in_progress', 'unfulfilled', 'partially_fulfilled', 'fulfilled', 'cancelled', 'archived']
  const empty = { all: 0, open: 0, in_progress: 0, unfulfilled: 0, partially_fulfilled: 0, fulfilled: 0, cancelled: 0, archived: 0 } as Record<PipelineStage | 'all', number>
  if (!db) {
    return { configured: false, lastSyncedAt: null, syncedRecently: 0, counts: empty, lastError: null, stages }
  }

  const rows = await db
    .select({
      status: s.salesOrders.status,
      fulfillment: s.salesOrders.fulfillment,
      cancelledAt: s.salesOrders.cancelledAt,
      closedAt: s.salesOrders.closedAt,
      shopifyFulfillmentStatus: s.salesOrders.shopifyFulfillmentStatus,
      shopifyFinancialStatus: s.salesOrders.shopifyFinancialStatus,
      shopifySyncedAt: s.salesOrders.shopifySyncedAt,
    })
    .from(s.salesOrders)

  const counts = { ...empty }
  let lastSyncedAt: string | null = null
  let syncedRecently = 0
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const row of rows) {
    counts.all++
    counts[deriveStage(row)]++
    const synced = row.shopifySyncedAt
    if (synced) {
      if (!lastSyncedAt || synced > lastSyncedAt) lastSyncedAt = synced
      const t = Date.parse(synced)
      if (Number.isFinite(t) && t >= cutoff) syncedRecently++
    }
  }

  // Only ORDER sync failures belong on this banner (sync_logs also records
  // price updates and other jobs), and a failure older than the newest
  // successful order sync is stale.
  const [lastFailure] = await db
    .select({ time: s.syncLogs.time, error: s.syncLogs.error, action: s.syncLogs.action })
    .from(s.syncLogs)
    .where(and(eq(s.syncLogs.status, 'failed'), eq(s.syncLogs.entity, 'Order')))
    .orderBy(desc(s.syncLogs.time))
    .limit(1)
  const failureIsCurrent = Boolean(lastFailure) && (!lastSyncedAt || String(lastFailure!.time) > String(lastSyncedAt))

  return {
    configured: true,
    lastSyncedAt,
    syncedRecently,
    counts,
    lastError: failureIsCurrent ? { at: lastFailure!.time, message: lastFailure!.error, action: lastFailure!.action } : null,
    stages,
  }
}

/** Count orders in one page filter — used by tests and the status endpoint. */
export async function countOrdersByStage(): Promise<Record<string, number>> {
  if (!db) return {}
  const rows = await db
    .select({
      status: s.salesOrders.status,
      fulfillment: s.salesOrders.fulfillment,
      cancelledAt: s.salesOrders.cancelledAt,
      closedAt: s.salesOrders.closedAt,
      shopifyFulfillmentStatus: s.salesOrders.shopifyFulfillmentStatus,
      shopifyFinancialStatus: s.salesOrders.shopifyFinancialStatus,
    })
    .from(s.salesOrders)
  const counts: Record<string, number> = { all: rows.length }
  for (const row of rows) {
    const stage = deriveStage(row)
    counts[stage] = (counts[stage] ?? 0) + 1
  }
  return counts
}
