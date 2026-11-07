/**
 * ERP → Shopify order actions.
 *
 * Everything here follows the same three rules:
 *
 *  1. Shopify is the authority. The quantities/amounts an action may use come
 *     from `fulfillmentOrders` (`remainingQuantity`), never from the local row,
 *     which can be stale by a webhook.
 *  2. Nothing is reported as done until Shopify returns the object (a
 *     fulfilment id, a cancel job, a closedAt) AND the fresh state has been read
 *     back and applied locally.
 *  3. A refusal is surfaced verbatim. Shopify's `userErrors` are the only
 *     honest explanation for "why can't I fulfil this line", so they are passed
 *     straight through to the operator instead of being rewritten.
 *
 * Cancellation is the one genuinely irreversible action: it is only ever
 * performed on an explicit request, with `refund` opt-in (money movement is
 * never a default) and `restock` opt-in. The local cancellation work (status,
 * one-time stock restore, loyalty reversal) is guarded by the cancelled state
 * itself, so the Shopify `orders/cancelled` webhook arriving afterwards — or
 * first — cannot repeat it.
 */
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from './db/client'
import * as s from './db/schema'
import { logger } from './logger'
import { adminGraphQL } from './shopifyRefunds'
import {
  fetchShopifyOrderState,
  refreshOrderFromShopify,
  type LocalOrder,
  type ShopifyOrderState,
} from './shopifyOrderPipeline'
import { resolveMovementLocation, restoreOrderLineStock } from './stock'

const CANCEL_REASONS = ['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'STAFF', 'OTHER'] as const
export type CancelReason = (typeof CANCEL_REASONS)[number]

export interface OrderActionResult {
  ok: boolean
  error?: string
  message?: string
  fulfillmentId?: string
  fulfillmentStatus?: string
  changed?: string[]
  order?: {
    cancelledAt: string | null
    closedAt: string | null
    financialStatus: string | null
    fulfillmentStatus: string | null
  }
  state?: ShopifyOrderState
}

const FULFILLMENT_CREATE = `#graphql
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status trackingInfo { number company url } }
      userErrors { field message }
    }
  }
`

const FULFILLMENT_TRACKING_UPDATE = `#graphql
  mutation FulfillmentTrackingUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
    fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
      fulfillment { id trackingInfo { number company url } }
      userErrors { field message }
    }
  }
`

const ORDER_CANCEL = `#graphql
  mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason, $restock: Boolean, $notifyCustomer: Boolean, $staffNote: String, $refundMethod: OrderCancelRefundMethodInput) {
    orderCancel(orderId: $orderId, reason: $reason, restock: $restock, notifyCustomer: $notifyCustomer, staffNote: $staffNote, refundMethod: $refundMethod) {
      job { id done }
      orderCancelUserErrors { field message }
    }
  }
`

const ORDER_CLOSE = `#graphql
  mutation OrderClose($input: OrderCloseInput!) {
    orderClose(input: $input) {
      order { id name closedAt }
      userErrors { field message }
    }
  }
`

function userErrors(payload: unknown): string | null {
  const value = payload as {
    userErrors?: Array<{ field?: string[]; message?: string }>
    orderCancelUserErrors?: Array<{ field?: string[]; message?: string }>
  } | null
  const errors = value?.userErrors ?? value?.orderCancelUserErrors
  if (!Array.isArray(errors) || errors.length === 0) return null
  return errors
    .map((e) => {
      const field = Array.isArray(e?.field) && e.field.length ? `${e.field.join('.')}: ` : ''
      return `${field}${e?.message ?? 'Shopify rejected the request'}`
    })
    .join('; ')
    .slice(0, 500)
}

async function logSync(
  local: LocalOrder,
  action: string,
  status: 'success' | 'failed',
  error: string | null,
  direction: 'in' | 'out' = 'out',
): Promise<void> {
  if (!db) return
  try {
    await db.insert(s.syncLogs).values({
      id: randomUUID(),
      entity: 'Order',
      shopifyId: local.shopifyId,
      direction,
      action,
      status,
      time: new Date().toISOString(),
      error,
    })
  } catch (err) {
    logger.warn({ err }, 'Order Pipeline: sync log could not be written')
  }
}

async function loadLocal(orderId: string): Promise<LocalOrder | null> {
  if (!db) return null
  const [row] = await db.select().from(s.salesOrders).where(eq(s.salesOrders.id, orderId)).limit(1)
  return row ?? null
}

function orderSummary(state: ShopifyOrderState): OrderActionResult['order'] {
  return {
    cancelledAt: state.cancelledAt ?? null,
    closedAt: state.closedAt ?? null,
    financialStatus: state.financialStatus ?? null,
    fulfillmentStatus: state.fulfillmentStatus ?? null,
  }
}

/** One fresh state read for the fulfil/tracking dialogs (no side effects). */
export async function getOrderFulfillmentPlan(
  orderId: string,
): Promise<{ ok: boolean; error?: string; state?: ShopifyOrderState }> {
  const local = await loadLocal(orderId)
  if (!local) return { ok: false, error: 'Order not found' }
  const state = await fetchShopifyOrderState(orderId)
  if (!state.ok) return { ok: false, error: state.error ?? 'Shopify request failed' }
  return { ok: true, state }
}

/**
 * Allocate requested SKU quantities to Shopify fulfillment-order lines.
 *
 * Pure and exported so the allocation rules are testable: a request may never
 * allocate more than a fulfillment order line has remaining, and a SKU the
 * store does not let us fulfil is reported rather than silently dropped.
 */
export function allocateFulfillmentLines(
  available: Array<{ fulfillmentOrderId: string; fulfillmentOrderLineItemId: string; sku: string; remaining: number }>,
  requested: Array<{ sku: string; quantity: number }>,
): { ok: true; groups: Array<{ fulfillmentOrderId: string; lines: Array<{ id: string; quantity: number }> }> } | { ok: false; error: string } {
  const wanted = new Map<string, number>()
  for (const item of requested) {
    const sku = String(item?.sku ?? '').trim()
    const qty = Math.floor(Number(item?.quantity ?? 0))
    if (!sku) return { ok: false, error: 'Every line needs a SKU' }
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: `Quantity for ${sku} must be at least 1` }
    wanted.set(sku, (wanted.get(sku) ?? 0) + qty)
  }
  if (wanted.size === 0) return { ok: false, error: 'Select at least one item to fulfil' }

  const groups = new Map<string, Array<{ id: string; quantity: number }>>()
  for (const [sku, qty] of wanted) {
    let left = qty
    const matching = available.filter((l) => l.sku === sku)
    if (matching.length === 0) {
      return { ok: false, error: `${sku} is not waiting to be fulfilled in Shopify (it may already be fulfilled or refunded)` }
    }
    const canFulfil = matching.reduce((sum, l) => sum + Math.max(0, l.remaining), 0)
    if (canFulfil < qty) {
      return { ok: false, error: `${sku}: only ${canFulfil} of ${qty} unit(s) can still be fulfilled in Shopify` }
    }
    for (const line of matching) {
      if (left <= 0) break
      const take = Math.min(left, Math.max(0, line.remaining))
      if (take <= 0) continue
      const list = groups.get(line.fulfillmentOrderId) ?? []
      list.push({ id: line.fulfillmentOrderLineItemId, quantity: take })
      groups.set(line.fulfillmentOrderId, list)
      left -= take
    }
  }

  return {
    ok: true,
    groups: [...groups.entries()].map(([fulfillmentOrderId, lines]) => ({ fulfillmentOrderId, lines })),
  }
}

export interface FulfillRequest {
  items: Array<{ sku: string; quantity: number }>
  trackingNumber?: string | null
  trackingCompany?: string | null
  trackingUrl?: string | null
  notifyCustomer?: boolean
}

/**
 * Create a fulfilment in Shopify — complete or partial, depending on the items
 * chosen. This is the only place a shipment is reported to Shopify, and the
 * result is only reported as success once Shopify returns a fulfilment id.
 */
export async function createOrderFulfillment(orderId: string, req: FulfillRequest): Promise<OrderActionResult> {
  const local = await loadLocal(orderId)
  if (!local) return { ok: false, error: 'Order not found' }
  if (!local.shopifyId) return { ok: false, error: 'This order is not linked to Shopify' }

  const state = await fetchShopifyOrderState(orderId)
  if (!state.ok) return { ok: false, error: state.error ?? 'Shopify request failed' }
  if (state.cancelledAt) return { ok: false, error: 'A cancelled order cannot be fulfilled in Shopify' }
  if (state.closedAt) return { ok: false, error: 'This order is archived in Shopify — reopen it there before fulfilling' }
  if (!state.orderGid) return { ok: false, error: 'Shopify did not return the order id' }

  const allocation = allocateFulfillmentLines(state.lines ?? [], req.items ?? [])
  if (!allocation.ok) return { ok: false, error: allocation.error }

  const number = String(req.trackingNumber ?? '').trim()
  const company = String(req.trackingCompany ?? '').trim()
  const url = String(req.trackingUrl ?? '').trim()
  const fulfillment: Record<string, unknown> = {
    lineItemsByFulfillmentOrder: allocation.groups.map((g) => ({
      fulfillmentOrderId: g.fulfillmentOrderId,
      fulfillmentOrderLineItems: g.lines,
    })),
  }
  // Shopify rejects trackingInfo without a number; company/url are optional.
  if (number) fulfillment.trackingInfo = { number, ...(company ? { company } : {}), ...(url ? { url } : {}) }
  if (req.notifyCustomer != null) fulfillment.notifyCustomer = Boolean(req.notifyCustomer)

  const res = await adminGraphQL<any>(FULFILLMENT_CREATE, { fulfillment })
  if (!res.ok) {
    await logSync(local, 'Fulfillment Create', 'failed', res.error ?? 'Shopify request failed')
    return { ok: false, error: res.error ?? 'Shopify request failed' }
  }
  const err = userErrors(res.data?.fulfillmentCreate)
  if (err) {
    await logSync(local, 'Fulfillment Create', 'failed', err)
    return { ok: false, error: err }
  }
  const created = res.data?.fulfillmentCreate?.fulfillment
  if (!created?.id) {
    const message = 'Shopify accepted the request but returned no fulfillment id — nothing was recorded'
    await logSync(local, 'Fulfillment Create', 'failed', message)
    return { ok: false, error: message }
  }

  await logSync(local, 'Fulfillment Create', 'success', null)
  // Read back: the new status (partial vs fulfilled), the tracking and the
  // per-line fulfilled quantities all come from Shopify, not from the request.
  const refreshed = await refreshOrderFromShopify(orderId, { actor: 'erp' })
  const after = refreshed.ok ? await fetchShopifyOrderState(orderId) : null
  const unitCount = allocation.groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.quantity, 0), 0)
  return {
    ok: true,
    fulfillmentId: String(created.id),
    fulfillmentStatus: String(created.status ?? ''),
    changed: refreshed.changed ?? [],
    order: after?.ok ? orderSummary(after) : undefined,
    state: after?.ok ? after : undefined,
    message: `${unitCount} unit(s) fulfilled in Shopify${number ? ` · tracking ${number}` : ''}`,
  }
}

export interface TrackingRequest {
  trackingNumber: string
  trackingCompany?: string | null
  trackingUrl?: string | null
  notifyCustomer?: boolean
}

/**
 * Set tracking on the order's most recent live fulfilment.
 *
 * A tracking number belongs to a shipment, so it is updated on the fulfilment
 * that is actually shipping — not written onto the order row alone, which is
 * what made ERP tracking invisible to the customer's Shopify notifications.
 */
export async function updateOrderTracking(orderId: string, req: TrackingRequest): Promise<OrderActionResult> {
  const local = await loadLocal(orderId)
  if (!local) return { ok: false, error: 'Order not found' }
  const number = String(req.trackingNumber ?? '').trim()
  if (!number) return { ok: false, error: 'A tracking number is required' }

  const state = await fetchShopifyOrderState(orderId)
  if (!state.ok) return { ok: false, error: state.error ?? 'Shopify request failed' }
  const live = (state.fulfillments ?? []).filter((f) => f.status.toUpperCase() !== 'CANCELLED')
  const target = live[live.length - 1]
  if (!target?.id) {
    return { ok: false, error: 'This order has no Shopify fulfillment yet — create a fulfillment first' }
  }

  const trackingInfoInput: Record<string, string> = { number }
  const company = String(req.trackingCompany ?? '').trim()
  const url = String(req.trackingUrl ?? '').trim()
  if (company) trackingInfoInput.company = company
  if (url) trackingInfoInput.url = url

  const res = await adminGraphQL<any>(FULFILLMENT_TRACKING_UPDATE, {
    fulfillmentId: target.id,
    trackingInfoInput,
    notifyCustomer: Boolean(req.notifyCustomer),
  })
  if (!res.ok) {
    await logSync(local, 'Tracking Update', 'failed', res.error ?? 'Shopify request failed')
    return { ok: false, error: res.error ?? 'Shopify request failed' }
  }
  const err = userErrors(res.data?.fulfillmentTrackingInfoUpdate)
  if (err) {
    await logSync(local, 'Tracking Update', 'failed', err)
    return { ok: false, error: err }
  }
  const updated = res.data?.fulfillmentTrackingInfoUpdate?.fulfillment
  if (!updated?.id) {
    const message = 'Shopify accepted the request but returned no fulfillment — tracking was not changed'
    await logSync(local, 'Tracking Update', 'failed', message)
    return { ok: false, error: message }
  }

  await logSync(local, 'Tracking Update', 'success', null)
  const refreshed = await refreshOrderFromShopify(orderId, { actor: 'erp' })
  return {
    ok: true,
    fulfillmentId: String(updated.id),
    changed: refreshed.changed ?? [],
    order: orderSummary(state),
    message: `Tracking ${number} saved to Shopify`,
  }
}

/**
 * Cancel an order in Shopify.
 *
 * `refund` moves money and `restock` moves stock, so both are explicit and both
 * default to false. The local side (status, one-time ERP stock restore, loyalty
 * reversal) is applied immediately afterwards so the pipeline is correct even
 * when webhooks are not registered yet.
 */
export async function cancelOrderInShopify(
  orderId: string,
  req: { reason?: string; restock?: boolean; refund?: boolean; notifyCustomer?: boolean; note?: string },
): Promise<OrderActionResult> {
  const local = await loadLocal(orderId)
  if (!local) return { ok: false, error: 'Order not found' }
  if (!local.shopifyId) return { ok: false, error: 'This order is not linked to Shopify' }

  const state = await fetchShopifyOrderState(orderId)
  if (!state.ok) return { ok: false, error: state.error ?? 'Shopify request failed' }
  if (state.cancelledAt) return { ok: false, error: 'This order is already cancelled in Shopify' }
  if (!state.orderGid) return { ok: false, error: 'Shopify did not return the order id' }

  const reason = CANCEL_REASONS.includes(String(req.reason ?? '').toUpperCase() as CancelReason)
    ? (String(req.reason).toUpperCase() as CancelReason)
    : 'OTHER'

  const res = await adminGraphQL<any>(ORDER_CANCEL, {
    orderId: state.orderGid,
    reason,
    restock: Boolean(req.restock),
    notifyCustomer: Boolean(req.notifyCustomer),
    staffNote: String(req.note ?? '').trim() || null,
    refundMethod: req.refund ? { originalPaymentMethodsRefund: true } : null,
  })
  if (!res.ok) {
    await logSync(local, 'Order Cancel', 'failed', res.error ?? 'Shopify request failed')
    return { ok: false, error: res.error ?? 'Shopify request failed' }
  }
  const err = userErrors(res.data?.orderCancel)
  if (err) {
    await logSync(local, 'Order Cancel', 'failed', err)
    return { ok: false, error: err }
  }
  const payload = res.data?.orderCancel
  const jobId = String(payload?.job?.id ?? '')
  if (!jobId) {
    const message = 'Shopify returned no cancellation job — the order is unchanged'
    await logSync(local, 'Order Cancel', 'failed', message)
    return { ok: false, error: message }
  }

  // Shopify cancellation is asynchronous. The mutation's job id proves Shopify
  // accepted it; read the order back until cancelledAt is authoritative (or
  // Shopify reports the job done without applying it). Never infer success from
  // a 200 response alone.
  let verified: ShopifyOrderState | null = null
  for (let attempt = 0; attempt < 8; attempt++) {
    verified = await fetchShopifyOrderState(orderId)
    if (verified.ok && verified.cancelledAt) break
    const jobDone = Boolean(payload?.job?.done)
    if (jobDone) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const confirmedState = verified
  const cancelledAt = confirmedState?.ok ? confirmedState.cancelledAt ?? null : null
  if (!cancelledAt || !confirmedState?.ok) {
    const message = verified?.error ?? 'Shopify accepted cancellation but has not confirmed it yet; refresh before retrying'
    await logSync(local, 'Order Cancel', 'failed', message)
    return { ok: false, error: message }
  }

  await logSync(local, 'Order Cancel', 'success', null)
  const localCancel = await cancelLocalOrderOnce(orderId)
  const refreshed = await refreshOrderFromShopify(orderId, { actor: 'erp' })
  try {
    const { handleShopifyOrderCancelled } = await import('./shopifyLoyalty')
    await handleShopifyOrderCancelled(local.shopifyId)
  } catch (loyaltyErr) {
    logger.warn({ err: loyaltyErr, orderId }, 'Order Pipeline: loyalty reversal after cancellation failed')
  }
  return {
    ok: true,
    changed: refreshed.changed ?? [],
    order: {
      cancelledAt,
      closedAt: confirmedState.closedAt ?? null,
      financialStatus: confirmedState.financialStatus ?? null,
      fulfillmentStatus: confirmedState.fulfillmentStatus ?? null,
    },
    message: `Cancelled in Shopify${localCancel.itemsRestored ? ` · ${localCancel.itemsRestored} unit(s) restored to ERP stock` : ''}${req.refund ? ' · refund requested' : ''}`,
  }
}

/**
 * Archive (close) an order in Shopify.
 *
 * `orderClose` refuses orders that still need work (unfulfilled/unpaid), and
 * that refusal is exactly the answer the operator needs — it is passed through.
 */
export async function archiveOrderInShopify(orderId: string): Promise<OrderActionResult> {
  const local = await loadLocal(orderId)
  if (!local) return { ok: false, error: 'Order not found' }
  const state = await fetchShopifyOrderState(orderId)
  if (!state.ok) return { ok: false, error: state.error ?? 'Shopify request failed' }
  if (state.closedAt) return { ok: false, error: 'This order is already archived in Shopify' }
  if (!state.orderGid) return { ok: false, error: 'Shopify did not return the order id' }

  const res = await adminGraphQL<any>(ORDER_CLOSE, { input: { id: state.orderGid } })
  if (!res.ok) {
    await logSync(local, 'Order Archive', 'failed', res.error ?? 'Shopify request failed')
    return { ok: false, error: res.error ?? 'Shopify request failed' }
  }
  const err = userErrors(res.data?.orderClose)
  if (err) {
    await logSync(local, 'Order Archive', 'failed', err)
    return { ok: false, error: err }
  }
  const closedAt = res.data?.orderClose?.order?.closedAt ?? null
  if (!closedAt) {
    const message = 'Shopify did not confirm the archive — the order is unchanged'
    await logSync(local, 'Order Archive', 'failed', message)
    return { ok: false, error: message }
  }

  await logSync(local, 'Order Archive', 'success', null)
  const refreshed = await refreshOrderFromShopify(orderId, { actor: 'erp' })
  return {
    ok: true,
    changed: refreshed.changed ?? [],
    order: { cancelledAt: state.cancelledAt ?? null, closedAt, financialStatus: state.financialStatus ?? null, fulfillmentStatus: state.fulfillmentStatus ?? null },
    message: 'Order archived in Shopify',
  }
}

/**
 * Cancel an order locally, exactly once.
 *
 * The ERP server has always restored order stock when the `orders/cancelled`
 * webhook arrived; cancelling from the ERP needs the same work, and running
 * both must not restock twice. The `status = 'cancelled'` transition inside a
 * row lock is the guard: whichever path gets there first does the restore.
 */
export async function cancelLocalOrderOnce(orderId: string): Promise<{ skipped: boolean; itemsRestored: number }> {
  if (!db) return { skipped: true, itemsRestored: 0 }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: s.salesOrders.id,
        status: s.salesOrders.status,
        lineItems: s.salesOrders.lineItems,
        locationId: s.salesOrders.locationId,
        cancelledAt: s.salesOrders.cancelledAt,
      })
      .from(s.salesOrders)
      .where(eq(s.salesOrders.id, orderId))
      .limit(1)
      .for('update')
    if (!row || row.status === 'cancelled' || row.cancelledAt) return { skipped: true, itemsRestored: 0 }

    const items = Array.isArray(row.lineItems) ? (row.lineItems as Array<{ sku?: string; quantity?: number }>) : []
    const locationId = await resolveMovementLocation(row.locationId as string | null, tx as never)
    let itemsRestored = 0
    for (const li of items) {
      const sku = String(li?.sku ?? '').trim()
      const qty = Math.max(0, Math.floor(Number(li?.quantity ?? 0)))
      if (!sku || qty <= 0) continue
      const restored = await restoreOrderLineStock({ tx, locationId, sku, qty })
      if (restored) itemsRestored += qty
    }
    await tx
      .update(s.salesOrders)
      .set({ status: 'cancelled', cancelledAt: new Date().toISOString() })
      .where(eq(s.salesOrders.id, orderId))
    return { skipped: false, itemsRestored }
  })
}
