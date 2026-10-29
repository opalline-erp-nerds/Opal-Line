import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from './db/client'
import * as s from './db/schema'
import { logger } from './logger'

/**
 * Shipment dispatch / delivery — shared by the routes and the regression
 * tests. Kept in one place so the rules are the same whether the caller is
 * the UI, an API client, or a test harness:
 *
 *  - A cancelled order cannot be dispatched (nothing went out).
 *  - A delivered shipment cannot be re-dispatched (its status would silently
 *    downgrade and the delivery date would be lost).
 *  - Dispatch is an upsert per order: repeated clicks, retries and refreshes
 *    update the one shipment instead of piling up rows, and the auto-invoice
 *    it raises stays idempotent (createInvoiceForOrderRow claims the order's
 *    invoice column inside its own transaction).
 *  - Shipment upsert → order fulfilment → timeline event run in ONE
 *    transaction, so a crash cannot leave a shipment without a fulfilled
 *    order (or the reverse).
 *
 * Shipment statuses stay exactly what the schema/pages know: 'dispatched'
 * and 'delivered' (the column default 'pending' appears when a row is
 * seeded by other flows). No new transition is invented here.
 */

export interface DispatchInput {
  courier?: string | null
  trackingNumber?: string | null
  expectedDelivery?: string | null
  notes?: string | null
}

export interface DispatchActor {
  userId?: string | null
  ip?: string | null
}

export class DispatchError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** Transaction handle drizzle hands to db.transaction callbacks (types as
 * the loose handle the repo's other transaction consumers accept). */
type Tx = any

async function eventInTx(
  tx: Tx,
  orderId: string,
  event: string,
  details: string,
  actor: string,
): Promise<void> {
  await tx.insert(s.orderEvents).values({
    id: randomUUID(),
    orderId,
    event,
    details,
    actor,
    createdAt: new Date().toISOString(),
  })
}

export interface DispatchResult {
  shipmentId: string
  orderStatus: string
  created: boolean
  updated: boolean
  invoiceNumber: string | null
}

/**
 * Mark an order dispatched: upsert its shipment row, fulfil the order,
 * record the timeline event, then (after the transaction commits, best
 * effort) auto-raise the sales invoice and notify the customer.
 */
export async function dispatchOrder(
  orderId: unknown,
  input: DispatchInput,
  actor: DispatchActor,
): Promise<DispatchResult> {
  if (!db) throw new DispatchError('Database unavailable', 503)
  const id = String(orderId ?? '').trim()
  if (!id) throw new DispatchError('orderId is required')

  const [order] = await db.select().from(s.salesOrders).where(eq(s.salesOrders.id, id)).limit(1)
  if (!order) throw new DispatchError('Order not found', 404)
  if (order.status === 'cancelled') {
    throw new DispatchError('Cancelled orders cannot be dispatched')
  }

  const [existing] = await db.select().from(s.shipments).where(eq(s.shipments.orderId, id)).limit(1)
  if (existing?.status === 'delivered') {
    throw new DispatchError('This order has already been delivered — it cannot be dispatched again')
  }

  /** Upsert contract so a partial correction (e.g. a corrected AWB sent
   * alone) never erases the rest of the shipment: a key ABSENT from the
   * input keeps the stored value; a PRESENT key always wins, with an empty
   * string or null meaning "clear it". Without this, re-dispatching to
   * update the tracking silently nulled the notes and expected date too. */
  const keepIfAbsent = (fallback: string | null, incoming: unknown): string | null => {
    if (incoming === undefined) return fallback
    const str = String(incoming ?? '').trim()
    return str || null
  }
  const courier = keepIfAbsent(existing?.courier ?? null, input?.courier)
  const trackingNumber = keepIfAbsent(existing?.trackingNumber ?? null, input?.trackingNumber)
  const notes = keepIfAbsent(existing?.notes ?? null, input?.notes)
  const expected =
    input === undefined || input.expectedDelivery === undefined
      ? existing?.expectedDelivery
        ? String(existing.expectedDelivery).slice(0, 10)
        : null
      : input.expectedDelivery
        ? String(input.expectedDelivery).slice(0, 10) || null
        : null
  const values = {
    orderRef: order.internalId ?? order.shopifyId ?? id,
    customer: order.customer,
    courier,
    trackingNumber,
    status: 'dispatched',
    dispatchedAt: new Date().toISOString(),
    expectedDelivery: expected,
    notes,
  }

  // One transaction: the shipment, the fulfilled order and the timeline
  // event all land or none does.
  let updatedOrderStatus: string | null = null
  let updatedOrderRow: typeof s.salesOrders.$inferSelect | null = null
  await db.transaction(async (tx) => {
    if (existing) {
      await tx.update(s.shipments).set(values).where(eq(s.shipments.id, existing.id))
    } else {
      await tx.insert(s.shipments).values({ id: randomUUID(), orderId: id, ...values })
    }
    // Keep order fulfilment in sync.
    const [updated] = await tx
      .update(s.salesOrders)
      .set({
        fulfillment: 'fulfilled',
        status: order.status === 'imported' ? 'processing' : order.status,
      })
      .where(eq(s.salesOrders.id, id))
      .returning()
    if (updated) {
      updatedOrderRow = updated
      updatedOrderStatus = String(updated.status ?? order.status)
    }
    await eventInTx(
      tx,
      id,
      'Dispatched',
      `Dispatched via ${courier ?? 'courier'}${trackingNumber ? ` — tracking ${trackingNumber}` : ''}`,
      actor.userId ?? 'system',
    )
  })

  // Dispatch means the goods went out — the sales invoice is raised
  // automatically (idempotent, same pipeline as the manual button). It runs
  // after the transaction because it performs its own inserts and rolls
  // back independently.
  let invoiceNumber: string | null = null
  const finalOrder: typeof s.salesOrders.$inferSelect | null = updatedOrderRow
  if (finalOrder) {
    try {
      const { autoInvoiceFulfilledOrder } = await import('./routes/db')
      invoiceNumber = await autoInvoiceFulfilledOrder(finalOrder, actor)
    } catch (err) {
      logger.error({ err, orderId: id }, 'dispatch auto-invoice failed')
    }
  }

  // Customer notification with tracking details (best-effort, never blocks).
  void import('./statusNotifications')
    .then((m) => m.notifyOrderFulfilled({ ...order, trackingId: trackingNumber, carrier: courier }))
    .catch(() => undefined)

  return {
    shipmentId: existing?.id ?? '',
    orderStatus: updatedOrderStatus || order.status || '',
    created: !existing,
    updated: Boolean(existing),
    invoiceNumber,
  }
}

/**
 * Confirm delivery. Idempotent: confirming an already-delivered shipment is
 * a no-op success, so refreshes and retries never duplicate the timeline
 * event or the customer notification.
 */
export async function confirmShipmentDelivered(
  shipmentId: unknown,
  actor: DispatchActor,
): Promise<{ shipment: typeof s.shipments.$inferSelect; alreadyDelivered: boolean }> {
  if (!db) throw new DispatchError('Database unavailable', 503)
  const id = String(shipmentId ?? '').trim()
  if (!id) throw new DispatchError('shipment id is required')

  const [ship] = await db.select().from(s.shipments).where(eq(s.shipments.id, id)).limit(1)
  if (!ship) throw new DispatchError('Shipment not found', 404)
  if (ship.status === 'delivered') {
    return { shipment: ship, alreadyDelivered: true }
  }

  const [updated] = await db
    .update(s.shipments)
    .set({ status: 'delivered', deliveredAt: new Date().toISOString() })
    .where(eq(s.shipments.id, id))
    .returning()

  await db.insert(s.orderEvents).values({
    id: randomUUID(),
    orderId: ship.orderId,
    event: 'Delivered',
    details: `Delivery confirmed${ship.trackingNumber ? ` (tracking ${ship.trackingNumber})` : ''}`,
    actor: actor.userId ?? 'system',
    createdAt: new Date().toISOString(),
  })

  // Customer notification (fire-and-forget).
  void import('./statusNotifications')
    .then((m) => m.notifyOrderDelivered({
      internalId: ship.orderRef,
      customer: ship.customer,
      trackingId: ship.trackingNumber,
      courier: ship.courier,
    }))
    .catch(() => undefined)

  return { shipment: updated ?? ship, alreadyDelivered: false }
}

/** Whether an order still needs to go out (the rule the UI and API agree on). */
export function isDispatchable(
  orderPick: { status: string | null },
  shipmentStatus: string | null | undefined,
): boolean {
  return orderPick.status !== 'cancelled' && shipmentStatus !== 'delivered'
}
