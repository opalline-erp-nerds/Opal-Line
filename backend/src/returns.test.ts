// Returns (RMA) and refunds regression tests.
//
// Runs against the REAL schema in a THROWAWAY scratch database
// (opal_line_returns_test), the same pattern as loyalty.test.ts, and skips when
// DATABASE_URL is unset. Covered:
//   - a return can only take what is still returnable (partial, multi-product,
//     duplicate SKUs in one payload, unknown SKU)
//   - a retried submission with the same idempotency key replays, not duplicates
//   - the status machine refuses illegal jumps
//   - receiving restocks ONLY accepted units, and rejecting after receipt
//     reverses exactly that restock (no double inventory)
//   - a refund is keyed by Shopify's refund id: the same webhook twice is one row
//   - partial refunds accumulate; the order only becomes `refunded` when the
//     completed refunds cover it
//   - the refund sync log records every attempt
import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import postgres from 'postgres'

// A receipt mirrors stock to Shopify in production. These tests use a scratch
// database but the developer's real .env, so the mirror is disabled here.
process.env.OPAL_DISABLE_SHOPIFY_PUSH = '1'

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_returns_test'

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

test(
  'returns and refunds (real schema, scratch DB)',
  { skip: baseDbUrl ? false : 'DATABASE_URL is not set — needs a local PostgreSQL to create the scratch database' },
  async () => {
    const admin = postgres(baseDbUrl, { max: 1 })
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`)
    } finally {
      await admin.end({ timeout: 5 })
    }

    process.env.DATABASE_URL = scratchUrl(baseDbUrl)
    let raw: postgres.Sql | null = null

    try {
      const { bootstrapDatabase } = await import('./db/bootstrap')
      const boot = await bootstrapDatabase()
      assert.equal(boot.tablesCreated, true, 'fresh scratch schema must be created')

      const { getRawClient } = await import('./db/client')
      raw = getRawClient()
      assert.ok(raw, 'scratch database must be connected')

      const returns = await import('./returns')
      const { syncRefundFromWebhook } = await import('./shopifyRefunds')

      // ── Fixtures: one paid Shopify order with two products ────────────────
      const lineItems = [
        { sku: 'SKU-A', title: 'Silver Ring', quantity: 2, price: 1500, amount: 3000 },
        { sku: 'SKU-B', title: 'Silver Chain', quantity: 1, price: 2000, amount: 2000 },
      ]
      await raw.unsafe(
        `INSERT INTO sales_orders (id, shopify_id, customer, customer_email, value, currency, payment, status, date, line_items)
         VALUES ('ord-1', '#7001', 'Asha Rao', 'asha@example.com', 5000, 'USD', 'paid', 'imported', now(), $1::jsonb)`,
        [JSON.stringify(lineItems)],
      )
      // A real product so the restock path has somewhere to land.
      await raw.unsafe(
        `INSERT INTO products (id, sku, name, category, stock, selling_price)
         VALUES ('prod-b', 'SKU-B', 'Silver Chain', 'Chains', 10, 2000)`,
      )

      // ── 1. Eligibility: ordered − already returned ────────────────────────
      const status = await returns.getOrderReturnStatus('ord-1')
      assert.equal(status.ok, true)
      if (!status.ok) return
      assert.deepEqual(
        status.lines.map((l) => [l.sku, l.ordered, l.returned, l.remaining]),
        [
          ['SKU-A', 2, 0, 2],
          ['SKU-B', 1, 0, 1],
        ],
      )

      const overReturn = await returns.createSalesReturn({
        orderId: 'ord-1',
        items: [{ sku: 'SKU-A', qty: 3 }],
      })
      assert.equal(overReturn.ok, false)
      assert.match(overReturn.ok ? '' : overReturn.error, /Only 2 of Silver Ring/)

      const unknown = await returns.createSalesReturn({ orderId: 'ord-1', items: [{ sku: 'NOPE', qty: 1 }] })
      assert.equal(unknown.ok, false)
      assert.match(unknown.ok ? '' : unknown.error, /Unknown product/)

      // Duplicate SKUs in one payload are summed before the check.
      const split = await returns.createSalesReturn({
        orderId: 'ord-1',
        items: [
          { sku: 'SKU-A', qty: 2 },
          { sku: 'sku-a', qty: 1 },
        ],
      })
      assert.equal(split.ok, false, 'splitting one SKU across two entries cannot bypass the limit')

      // ── 2. Create a partial return, and replay it idempotently ────────────
      const first = await returns.createSalesReturn({
        orderId: 'ord-1',
        items: [{ sku: 'SKU-A', qty: 1 }],
        reason: 'damaged',
        notes: 'scratched band',
        idempotencyKey: 'ret-key-1',
      })
      assert.equal(first.ok, true)
      if (!first.ok) return
      assert.equal(first.amount, 1500, 'one ring at its order price')
      assert.equal(first.replayed, false)
      // The return takes its money's currency from the original order.
      const [firstReturnRow] = await raw.unsafe(`SELECT currency FROM sales_returns WHERE id = $1`, [first.id])
      assert.equal(firstReturnRow.currency, 'USD')

      const replay = await returns.createSalesReturn({
        orderId: 'ord-1',
        items: [{ sku: 'SKU-A', qty: 1 }],
        idempotencyKey: 'ret-key-1',
      })
      assert.equal(replay.ok, true)
      if (!replay.ok) return
      assert.equal(replay.replayed, true, 'a retried submission replays the same return')
      assert.equal(replay.id, first.id)

      const afterFirst = await returns.getOrderReturnStatus('ord-1')
      assert.equal(afterFirst.ok, true)
      if (!afterFirst.ok) return
      assert.equal(afterFirst.lines.find((l) => l.sku === 'SKU-A')?.remaining, 1, 'one ring is still returnable')

      // ── 3. Status machine ─────────────────────────────────────────────────
      assert.equal(returns.isValidReturnTransition('requested', 'received'), false)
      assert.equal(returns.isValidReturnTransition('requested', 'approved'), true)
      assert.equal(returns.isValidReturnTransition('completed', 'approved'), false)

      const illegal = await returns.setSalesReturnStatus(first.id, 'received')
      assert.equal(illegal.ok, false)
      assert.match(illegal.ok ? '' : illegal.error, /Cannot move a requested return to received/)

      const approved = await returns.setSalesReturnStatus(first.id, 'approved')
      assert.equal(approved.ok, true)

      // ── 4. Receiving restocks only the accepted units ─────────────────────
      const received = await returns.setSalesReturnStatus(first.id, 'received', {
        inspection: [{ sku: 'SKU-A', received: 1, accepted: 0, damaged: 1 }],
      })
      assert.equal(received.ok, true)
      if (!received.ok) return
      assert.equal(received.restocked, 0, 'a damaged unit is not restocked')
      assert.deepEqual(received.inspection, [{ sku: 'SKU-A', received: 1, accepted: 0, damaged: 1 }])

      // A second return of the other product, received in full, does restock.
      const second = await returns.createSalesReturn({
        orderId: 'ord-1',
        items: [{ sku: 'SKU-B', qty: 1 }],
        reason: 'changed_mind',
      })
      assert.equal(second.ok, true)
      if (!second.ok) return
      await returns.setSalesReturnStatus(second.id, 'approved')
      const receivedB = await returns.setSalesReturnStatus(second.id, 'received', {
        inspection: [{ sku: 'SKU-B', received: 1, accepted: 1, damaged: 0 }],
      })
      assert.equal(receivedB.ok, true)
      if (!receivedB.ok) return
      assert.equal(receivedB.restocked, 1)
      // The receipt reports its Shopify mirror attempt (disabled here) instead
      // of silently claiming the store was updated.
      assert.ok(receivedB.inventory, 'a receipt reports the Shopify inventory outcome')
      assert.equal(receivedB.inventory?.ok, false)

      const [stockAfterReceive] = await raw.unsafe(`SELECT stock FROM products WHERE sku = 'SKU-B'`)
      assert.equal(Number(stockAfterReceive.stock), 11, 'accepted unit is back in stock')

      // Rejecting after receipt reverses exactly that restock.
      const rejected = await returns.setSalesReturnStatus(second.id, 'rejected')
      assert.equal(rejected.ok, true)
      const [stockAfterReject] = await raw.unsafe(`SELECT stock FROM products WHERE sku = 'SKU-B'`)
      assert.equal(Number(stockAfterReject.stock), 10, 'rejecting a received return undoes its restock')

      // ── 5. Refunds are keyed by Shopify's refund id ───────────────────────
      const refundOne = await returns.recordRefund({
        shopifyRefundId: '900001',
        shopifyOrder: '#7001',
        source: 'shopify',
        status: 'completed',
        amount: 1500,
        items: [{ sku: 'SKU-A', product: 'Silver Ring', quantity: 1, amount: 1500 }],
        action: 'webhook',
      })
      assert.ok(refundOne)
      assert.equal(refundOne?.created, true)
      assert.equal(refundOne?.number.startsWith('RF'), true)

      const refundOneAgain = await returns.recordRefund({
        shopifyRefundId: '900001',
        shopifyOrder: '#7001',
        source: 'shopify',
        status: 'completed',
        amount: 1500,
      })
      assert.equal(refundOneAgain?.created, false, 'the same Shopify refund is never inserted twice')
      assert.equal(refundOneAgain?.id, refundOne?.id)

      const [refundCount] = await raw.unsafe(`SELECT count(*)::int AS n FROM refunds WHERE shopify_refund_id = '900001'`)
      assert.equal(refundCount.n, 1)
      // No currency on the payload: it is read from the original order, never
      // defaulted to the ERP's own rupee book.
      const [refundOneRow] = await raw.unsafe(`SELECT currency FROM refunds WHERE shopify_refund_id = '900001'`)
      assert.equal(refundOneRow.currency, 'USD')

      const [lineCount] = await raw.unsafe(
        `SELECT count(*)::int AS n FROM refund_line_items WHERE refund_id = $1`,
        [refundOne!.id],
      )
      assert.equal(lineCount.n, 1, 'a repeated delivery does not duplicate the line items')

      // ── 6. Partial refunds accumulate; full coverage flips the order ──────
      let totals = await returns.refundTotalsForOrder('#7001')
      assert.equal(totals.refunded, 1500)
      assert.equal(totals.count, 1)

      let reconciled = await returns.reconcileOrderPaymentAfterRefund('#7001')
      assert.equal(reconciled.payment, 'paid', 'a partial refund leaves the order paid')

      await returns.recordRefund({
        shopifyRefundId: '900002',
        shopifyOrder: '#7001',
        source: 'shopify',
        status: 'completed',
        amount: 3500,
      })
      totals = await returns.refundTotalsForOrder('#7001')
      assert.equal(totals.refunded, 5000, 'refunds add up across deliveries')

      reconciled = await returns.reconcileOrderPaymentAfterRefund('#7001')
      assert.equal(reconciled.payment, 'refunded', 'the order is refunded once the refunds cover it')
      const [orderRow] = await raw.unsafe(`SELECT payment FROM sales_orders WHERE id = 'ord-1'`)
      assert.equal(orderRow.payment, 'refunded')

      // ── 7. Webhook ingestion is idempotent and maps the payload ───────────
      const webhook = {
        id: 900003,
        order_id: 7001,
        created_at: new Date().toISOString(),
        note: 'issued in Shopify admin',
        refund_line_items: [
          { line_item_id: 555, quantity: 1, subtotal: '2000', total_tax: '0', line_item: { name: 'Silver Chain', sku: 'SKU-B' } },
        ],
        transactions: [{ id: 777, amount: '2000', kind: 'refund', gateway: 'razorpay', status: 'success' }],
        order: { name: '#7001', email: 'asha@example.com', currency: 'INR' },
      }
      const firstDelivery = await syncRefundFromWebhook(webhook, { action: 'webhook' })
      assert.equal(firstDelivery.ok, true)
      assert.equal(firstDelivery.duplicate, false)
      assert.equal(firstDelivery.amount, 2000)

      const retriedDelivery = await syncRefundFromWebhook(webhook, { action: 'webhook' })
      assert.equal(retriedDelivery.ok, true)
      assert.equal(retriedDelivery.duplicate, true, 'a Shopify retry updates the same refund')
      assert.equal(retriedDelivery.refundId, firstDelivery.refundId)

      const [webhookRows] = await raw.unsafe(`SELECT count(*)::int AS n FROM refunds WHERE shopify_refund_id = '900003'`)
      assert.equal(webhookRows.n, 1)

      const [webhookRefund] = await raw.unsafe(
        `SELECT customer, customer_email, payment_method, status, amount FROM refunds WHERE shopify_refund_id = '900003'`,
      )
      assert.equal(webhookRefund.customer, 'Asha Rao', 'the ERP order supplies the customer')
      assert.equal(webhookRefund.customer_email, 'asha@example.com')
      assert.equal(webhookRefund.payment_method, 'razorpay')
      assert.equal(webhookRefund.status, 'completed')
      assert.equal(Number(webhookRefund.amount), 2000)

      // ── 8. Every attempt is logged ────────────────────────────────────────
      const [events] = await raw.unsafe(
        `SELECT count(*)::int AS n FROM refund_sync_events WHERE refund_id = $1`,
        [String(firstDelivery.refundId)],
      )
      assert.ok(events.n >= 2, 'both the first delivery and the retry are logged')

      // A multi-currency order is refunded in the customer's presentment
      // currency, which the refund transaction carries. The transaction wins
      // over the order's shop currency so the amount is never mislabelled.
      const multiCurrency = await syncRefundFromWebhook(
        {
          id: 900004,
          order_id: 7001,
          refund_line_items: [],
          transactions: [{ id: 778, amount: '9354', kind: 'refund', currency: 'CAD', status: 'success' }],
          order: { name: '#7001', currency: 'USD' },
        },
        { action: 'webhook' },
      )
      assert.equal(multiCurrency.ok, true)
      const [multiRow] = await raw.unsafe(`SELECT currency, amount FROM refunds WHERE shopify_refund_id = '900004'`)
      assert.equal(multiRow.currency, 'CAD')
      assert.equal(Number(multiRow.amount), 9354)

      // ── 9. The gid and the numeric id are the same refund ─────────────────
      const viaGid = await returns.recordRefund({
        shopifyRefundId: 'gid://shopify/Refund/910001',
        shopifyOrder: '#7001',
        source: 'erp',
        amount: 100,
      })
      const viaNumeric = await returns.recordRefund({
        shopifyRefundId: '910001',
        shopifyOrder: '#7001',
        source: 'shopify',
        amount: 100,
      })
      assert.equal(viaNumeric?.id, viaGid?.id, 'a gid and its numeric id are one refund, not two')
      const [gidRows] = await raw.unsafe(`SELECT count(*)::int AS n FROM refunds WHERE shopify_refund_id = '910001'`)
      assert.equal(gidRows.n, 1)

      // ── 10. Pure inspection rules ─────────────────────────────────────────
      assert.deepEqual(returns.normalizeInspection([{ sku: 'A', qty: 2 }], [{ sku: 'A', received: 5, damaged: 1 }]), [
        { sku: 'A', received: 2, accepted: 1, damaged: 1 },
      ])
      assert.deepEqual(returns.normalizeInspection([{ sku: 'A', qty: 2 }], []), [
        { sku: 'A', received: 2, accepted: 2, damaged: 0 },
      ])
      assert.deepEqual(returns.inspectionTotals([{ received: 3, accepted: 2, damaged: 1 }]), {
        received: 3,
        accepted: 2,
        damaged: 1,
      })
      assert.equal(returns.normalizeOrderRef('gid://shopify/Order/7001'), '#7001')
      assert.equal(returns.normalizeOrderRef('7001'), '#7001')
      assert.equal(returns.normalizeOrderRef('shopify-7001'), '#7001')
      assert.equal(returns.normalizeRefundId('gid://shopify/Refund/910001'), '910001')
      assert.equal(returns.normalizeRefundId('910001'), '910001')
      assert.equal(returns.normalizeRefundId(''), null)
    } finally {
      await raw?.end({ timeout: 5 }).catch(() => undefined)
    }
  },
)
