import test from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray } from 'drizzle-orm'

/**
 * End-to-end (database) regression for the "new Shopify order appears
 * Cancelled" incident.
 *
 * The webhook handler applies a Shopify snapshot through `applyShopifyOrderPayload`.
 * This test exercises that exact path:
 *
 *   - a Shopify-origin row left cancelled without a cancellation timestamp is
 *     stale, and a live payload must return it to the New pipeline;
 *   - a genuine Shopify `cancelled_at` still cancels it;
 *   - a locally cancelled manual ERP order is not reopened by a Shopify sync.
 *
 * Skipped unless DASHBOARD_TEST_DATABASE_URL is set. Rows are removed again.
 */
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'a live Shopify order clears a stale cancellation, a real one is respected',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string
    process.env.LOYALTY_ENABLED = 'false'

    const { db, schema } = await import('./db/client')
    const { applyShopifyOrderPayload } = await import('./shopifyOrderPipeline')
    assert.ok(db, 'test database client did not initialize')

    const marker = `recon-${Date.now()}`
    const shopOrderId = `shopify-${marker}-shop`
    const manualOrderId = `shopify-${marker}-manual`
    const shopName = `#SW${marker}`
    const manualName = `#MW${marker}`
    const shopGid = `gid://shopify/Order/${marker}-shop`
    const manualGid = `gid://shopify/Order/${marker}-manual`
    const now = new Date().toISOString()

    const payload = (overrides: Record<string, unknown> = {}) => ({
      id: 900000 + Number(String(Date.now()).slice(-4)),
      name: shopName,
      admin_graphql_api_id: shopGid,
      created_at: now,
      cancelled_at: null,
      cancel_reason: null,
      closed_at: null,
      financial_status: 'paid',
      fulfillment_status: null,
      currency: 'INR',
      total_price: '1000.00',
      total_discounts: '0.00',
      tags: '',
      line_items: [
        {
          id: 910001,
          admin_graphql_api_id: 'gid://shopify/LineItem/910001',
          title: 'Silver Ring',
          sku: `${marker}-SKU`,
          quantity: 1,
          fulfillable_quantity: 1,
          price: '1000.00',
        },
      ],
      ...overrides,
    })

    const baseRow = {
      customer: 'Test Buyer',
      value: 1000,
      payment: 'paid',
      fulfillment: 'unfulfilled',
      invoice: null,
      date: now,
      items: 1,
      currency: 'INR',
      tags: null,
      shopifyFinancialStatus: 'PAID',
      shopifyFulfillmentStatus: 'UNFULFILLED',
      lineItems: [{
        title: 'Silver Ring',
        sku: `${marker}-SKU`,
        quantity: 1,
        price: 1000,
        fulfilledQuantity: 0,
      }],
    }

    try {
      // ── The incident: cancelled row, no cancellation timestamp ────────────
      await db.insert(schema.salesOrders).values({
        ...baseRow,
        id: shopOrderId,
        shopifyId: shopName,
        internalId: `SO-${marker}`,
        shopifyGid: shopGid,
        status: 'cancelled',
        cancelledAt: null,
      } as any)

      const reopened = await applyShopifyOrderPayload(payload(), { actor: 'test' })
      assert.equal(reopened.ok, true, reopened.error ?? 'order payload was not applied')
      assert.equal(reopened.found, true)
      assert.equal(reopened.updated, true)
      assert.ok(reopened.changed?.includes('status'), `expected a status change, got ${reopened.changed}`)
      assert.ok(reopened.changed?.includes('status-reopened'))
      assert.ok(!reopened.changed?.includes('cancelled'), 'a live payload is not a cancellation')

      const [afterLive] = await db
        .select({ status: schema.salesOrders.status, cancelledAt: schema.salesOrders.cancelledAt })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.id, shopOrderId))
      assert.equal(afterLive.status, 'imported', 'a new Shopify order is New, never Cancelled')
      assert.equal(afterLive.cancelledAt, null)

      // ── A genuine Shopify cancellation is respected ──────────────────────
      const cancelledAt = '2026-11-19T10:00:00Z'
      const cancelled = await applyShopifyOrderPayload(
        payload({ cancelled_at: cancelledAt, closed_at: cancelledAt }),
        { actor: 'test' },
      )
      assert.equal(cancelled.ok, true, cancelled.error ?? 'cancellation payload was not applied')
      assert.ok(cancelled.changed?.includes('cancelled'))
      const [afterCancel] = await db
        .select({ status: schema.salesOrders.status, cancelledAt: schema.salesOrders.cancelledAt })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.id, shopOrderId))
      assert.equal(afterCancel.status, 'cancelled')
      assert.ok(afterCancel.cancelledAt, 'the verified cancellation timestamp is stored')

      // A redelivery of the same cancellation writes nothing (no webhook loop).
      const redelivered = await applyShopifyOrderPayload(
        payload({ cancelled_at: cancelledAt, closed_at: cancelledAt }),
        { actor: 'test' },
      )
      assert.equal(redelivered.updated, false, 'a retried webhook must not rewrite the row')
      assert.deepEqual(redelivered.changed, [])

      // ── Manual ERP cancellations must survive a Shopify sync ─────────────
      await db.insert(schema.salesOrders).values({
        ...baseRow,
        id: manualOrderId,
        shopifyId: `MO-${marker}`,
        internalId: `MO-${marker}`,
        tags: 'manual-order',
        shopifyGid: manualGid,
        status: 'cancelled',
        cancelledAt: null,
      } as any)

      const manual = await applyShopifyOrderPayload(
        payload({ name: manualName, admin_graphql_api_id: manualGid }),
        { actor: 'test' },
      )
      assert.equal(manual.ok, true, manual.error ?? 'manual order payload was not applied')
      const [afterManual] = await db
        .select({ status: schema.salesOrders.status })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.id, manualOrderId))
      assert.equal(afterManual.status, 'cancelled', 'an intentional ERP cancellation is not reopened')
    } finally {
      await db.delete(schema.orderEvents).where(inArray(schema.orderEvents.orderId, [shopOrderId, manualOrderId]))
      await db.delete(schema.salesOrders).where(inArray(schema.salesOrders.id, [shopOrderId, manualOrderId]))
    }
  },
)
