import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import * as schema from './db/schema'

/*
 * Dispatch workflow regression tests — run against a SCRATCH database that is
 * a body-double of DATABASE_URL (same credentials, database name suffixed
 * _dispatch_test), bootstrapped with the app's own idempotent bootstrap so it
 * carries the exact schema. Skipped when no DATABASE_URL is configured, so
 * `npm test` still passes on machines without a database.
 *
 * What is pinned here (the defects this suite exists for):
 *  - cancelled orders are rejected, delivered shipments are not re-dispatched
 *    (silently downgrading 'delivered' → 'dispatched' used to be possible)
 *  - repeated dispatch is an upsert: one shipment row per order, invoice
 *    raised exactly once, no duplicate fulfilment
 *  - shipment + order fulfilment + timeline land atomically
 *  - confirming delivery is idempotent: the second call changes nothing and
 *    adds no duplicate 'Delivered' event
 */

// Derive the scratch URL from DATABASE_URL before anything imports db/client.
const sourceUrl = process.env.DATABASE_URL?.trim()
const scratchUrl = sourceUrl
  ? sourceUrl.replace(/\/[^/?]+(\?|$)/, (_m, q: string) => `/_dispatch_shipments_test${q}`)
  : ''

test(
  'dispatch workflow: eligibility, duplicate protection, idempotent delivery',
  { skip: scratchUrl ? false : 'DATABASE_URL is not set', timeout: 120_000 },
  async () => {
    // 1. Create the scratch database if needed (connect to the maintenance db).
    const admin = postgres(sourceUrl!.replace(/\/[^/?]+(\?|$)/, (_m, q: string) => `/postgres${q}`), {
      max: 1,
      connect_timeout: 5,
    })
    try {
      const exists = (await admin.unsafe(
        `select 1 from pg_database where datname = '_dispatch_shipments_test'`,
      )) as Array<Record<string, unknown>>
      if (exists.length === 0) {
        // Can't parameterise CREATE DATABASE — the name is a fixed literal.
        await admin.unsafe(`CREATE DATABASE "_dispatch_shipments_test"`)
      }
    } finally {
      await admin.end({ timeout: 5 })
    }

    // 2. Point the db client at the scratch database (before importing it),
    //    then bootstrap the schema exactly how the app does on first run.
    process.env.DATABASE_URL = scratchUrl
    process.env.LOYALTY_ENABLED = 'false'
    const { bootstrapDatabase, resetBootstrapForTests } = await import('./db/bootstrap')
    resetBootstrapForTests()
    await bootstrapDatabase()

    const { db, schema } = await import('./db/client')
    const { dispatchOrder, confirmShipmentDelivered, DispatchError } = await import('./dispatch')
    assert.ok(db, 'scratch db client did not initialize')

    const marker = `disp-${Date.now()}`
    const actor = { userId: 'test', ip: null }

    // Silver rate + catalogue product so the auto-invoice can price and
    // snapshot the order line.
    const sku = `${marker}-SKULNE`
    const productId = `${marker}-prod`
    await db!.insert(schema.silverRates).values({
      id: randomUUID(),
      purity: 92.5,
      rate: 62,
      previousRate: 60,
      updatedAt: new Date().toISOString(),
      change: 2,
      changePercent: 3.33,
      currency: 'INR',
      updatedBy: 'test',
      source: 'manual',
    })
    await db!.insert(schema.products).values({
      id: productId,
      name: 'Dispatch Test Ring',
      sku,
      category: 'test',
      netWeight: 10,
      makingCharge: 5,
    })

    const orderId = `${marker}-order`
    await db!.insert(schema.salesOrders).values({
      id: orderId,
      shopifyId: `#${marker}`,
      internalId: `SO-${marker}`,
      customer: `${marker} Buyer`,
      value: 1000,
      payment: 'paid',
      fulfillment: 'unfulfilled',
      invoice: null,
      status: 'imported',
      date: new Date().toISOString(),
      items: 1,
      tags: 'manual-order',
      currency: 'INR',
      discount: 0,
      lineItems: [{ title: 'Dispatch Test Ring', sku, quantity: 1, price: 1000 }],
    })

    try {
      // ── Eligibility: cancelled orders are rejected before anything is written ──
      const cancelledId = `${marker}-cancelled`
      await db!.insert(schema.salesOrders).values({
        id: cancelledId,
        shopifyId: `#${marker}c`,
        internalId: `SO-${marker}c`,
        customer: 'Cancelled Buyer',
        value: 100,
        payment: 'pending',
        fulfillment: 'unfulfilled',
        invoice: null,
        status: 'cancelled',
        date: new Date().toISOString(),
        items: 1,
        tags: 'manual-order',
        currency: 'INR',
        discount: 0,
        lineItems: [{ title: 'x', sku: null, quantity: 1, price: 100 }],
      })
      await assert.rejects(
        () => dispatchOrder(cancelledId, { courier: 'BlueDart' }, actor),
        (err: unknown) => err instanceof DispatchError && err.status === 400,
        'cancelled orders must not be dispatchable',
      )
      const [cancelledShipment] = await db!
        .select()
        .from(schema.shipments)
        .where(eqShipmentOrder(cancelledId))
      assert.equal(cancelledShipment, undefined, 'no shipment row may be written for a cancelled order')

      // ── First dispatch: shipment + fulfilment + timeline + one invoice ──
      const first = await dispatchOrder(orderId, { courier: 'BlueDart', trackingNumber: 'AWB-1' }, actor)
      assert.equal(first.created, true)
      assert.equal(first.orderStatus, 'processing') // imported → processing once dispatched

      const shipmentRows = await db!.select().from(schema.shipments).where(eqShipmentOrder(orderId))
      assert.equal(shipmentRows.length, 1, 'exactly one shipment row per order')
      assert.equal(shipmentRows[0].status, 'dispatched')
      assert.equal(shipmentRows[0].trackingNumber, 'AWB-1')

      const [order] = await db!.select().from(schema.salesOrders).where(eqOrder(orderId))
      assert.equal(order.fulfillment, 'fulfilled')

      // Invoice raised automatically, exactly once.
      assert.ok(first.invoiceNumber, 'auto-invoice must fire on dispatch')
      const invoices = await db!
        .select()
        .from(schema.salesInvoices)
        .where(eqInvoiceOrder(orderId))
      assert.equal(invoices.length, 1)
      assert.equal(invoices[0].number, first.invoiceNumber)

      // Timeline event recorded.
      const events = await db!.select().from(schema.orderEvents).where(eqEvent(orderId))
      assert.equal(
        events.filter((e) => e.event === 'Dispatched').length,
        1,
        'one Dispatched event',
      )

      // ── Tracking correction must not erase the rest of the shipment ──
      // First give the shipment everything: courier, notes and expected date.
      await dispatchOrder(
        orderId,
        { courier: 'Delhivery', trackingNumber: 'AWB-KEEP-1', expectedDelivery: '2026-11-05', notes: 'fragile' },
        actor,
      )
      // Now correct ONLY the tracking id — no other field in the payload.
      const correct = await dispatchOrder(orderId, { trackingNumber: 'AWB-CORRECTED' }, actor)
      assert.equal(correct.updated, true)
      const [corrected] = await db!.select().from(schema.shipments).where(eqShipmentOrder(orderId))
      assert.equal(corrected.trackingNumber, 'AWB-CORRECTED', 'the corrected AWB is stored')
      assert.equal(corrected.courier, 'Delhivery', 'partial update keeps the courier')
      assert.equal(corrected.notes, 'fragile', 'partial update keeps the notes')
      assert.equal(corrected.status, 'dispatched', 'status untouched by a partial update')
      assert.ok(
        String(corrected.expectedDelivery ?? '').startsWith('2026-11-05'),
        'partial update keeps the expected delivery date (re-dispatch used to null it)',
      )
      // An EXPLICIT null clears a field; an omitted key never does.
      await dispatchOrder(orderId, { expectedDelivery: null }, actor)
      const [cleared] = await db!.select().from(schema.shipments).where(eqShipmentOrder(orderId))
      assert.equal(cleared.expectedDelivery, null, 'explicit null clears the expected date')
      assert.equal(cleared.notes, 'fragile', 'clearing one field keeps the others')

      // ── Duplicate protection: updating the same order is an upsert ──
      const second = await dispatchOrder(orderId, { courier: 'Delhivery', trackingNumber: 'AWB-2' }, actor)
      assert.equal(second.created, false)
      assert.equal(second.updated, true)
      assert.equal(second.invoiceNumber, first.invoiceNumber, 'no duplicate invoice on re-dispatch')

      const shipmentRows2 = await db!.select().from(schema.shipments).where(eqShipmentOrder(orderId))
      assert.equal(shipmentRows2.length, 1, 're-dispatch must not create a second shipment row')
      assert.equal(shipmentRows2[0].courier, 'Delhivery')
      assert.equal(shipmentRows2[0].trackingNumber, 'AWB-2')

      const invoices2 = await db!.select().from(schema.salesInvoices).where(eqInvoiceOrder(orderId))
      assert.equal(invoices2.length, 1, 'still exactly one invoice')

      // ── Delivery: sets 'delivered' once, then is idempotent ──
      const deliveredFirst = await confirmShipmentDelivered(shipmentRows2[0].id, actor)
      assert.equal(deliveredFirst.alreadyDelivered, false)
      assert.ok(deliveredFirst.shipment.deliveredAt)

      const deliveredSecond = await confirmShipmentDelivered(shipmentRows2[0].id, actor)
      assert.equal(deliveredSecond.alreadyDelivered, true, 'second confirm must be a no-op')

      const eventRows = await db!.select().from(schema.orderEvents).where(eqEvent(orderId))
      assert.equal(eventRows.filter((e) => e.event === 'Delivered').length, 1, 'no duplicate Delivered event')

      // ── A delivered shipment can never be re-dispatched ──
      await assert.rejects(
        () => dispatchOrder(orderId, { courier: 'Ekart' }, actor),
        (err: unknown) => err instanceof DispatchError,
        'delivered shipments must not be re-dispatchable',
      )
      const afterRows = await db!.select().from(schema.shipments).where(eqShipmentOrder(orderId))
      assert.equal(afterRows[0].status, 'delivered', 'status stays delivered after the rejected re-dispatch')
      assert.equal(afterRows.length, 1)
      const invoicesFinal = await db!.select().from(schema.salesInvoices).where(eqInvoiceOrder(orderId))
      assert.equal(invoicesFinal.length, 1)

      // Clean the tables this test wrote (leave the tables themselves).
      await db!.delete(schema.salesInvoiceItems).where(inItems(invoicesFinal[0].id))
      await db!.delete(schema.salesInvoices).where(eqInvoiceOrder(orderId))
      await db!.update(schema.salesOrders).set({ invoice: null }).where(eqOrder(orderId))
      await db!.delete(schema.orderEvents).where(eqEvent(orderId))
      await db!.delete(schema.shipments).where(eqShipmentOrder(orderId))
      await db!.delete(schema.salesOrders).where(eqOrder(orderId))
      await db!.delete(schema.salesOrders).where(eqOrder(cancelledId))
      await db!.delete(schema.products).where(eqProduct(productId))
    } finally {
      // Silver rate rows only exist in the scratch DB: leave them.
    }
  },
)

const eqShipmentOrder = (orderId: string) => eq(schema.shipments.orderId, orderId)
const eqOrder = (orderId: string) => eq(schema.salesOrders.id, orderId)
const eqInvoiceOrder = (orderId: string) => eq(schema.salesInvoices.shopifyOrder, `#${orderId.replace(/-order$/, '')}`)
const eqEvent = (orderId: string) => eq(schema.orderEvents.orderId, orderId)
const inItems = (invoiceId: string) => inArray(schema.salesInvoiceItems.invoiceId, [invoiceId])
const eqProduct = (productId: string) => eq(schema.products.id, productId)
