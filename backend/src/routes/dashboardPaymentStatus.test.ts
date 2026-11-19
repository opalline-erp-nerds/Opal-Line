import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Payment Status widget: one unified ledger over Shopify invoices, ERP invoices
// and ERP orders that have no invoice yet. The five rows (Paid, Pending, Failed,
// Overdue, Refunded) must add up to the donut total, so percentages sum to 100%.
// The test pins the accounting meanings:
//   refunded  = full-refund invoices + actual credit notes (never twice)
//   failed    = unpaid balance of an invoice/order whose payment attempt failed
//   overdue   = unpaid balance past its due date (and not failed)
//   paid      = money actually collected, net of refunds (a part-paid invoice
//               shows only what was retained, not its invoice total)
//   pending   = the remaining unpaid balance
// It also pins the reported bug: an ERP sale that exists only as an order row
// must appear here, or the card silently shows Shopify alone. Source filters
// follow the Sales Overview buttons, All = Shopify + ERP with no sale counted
// twice, and the total reconciles with Sales revenue:
//   total = salesRevenue + returns + refundedInvoiceGross.
//
// Assertions are deltas against a baseline fetched before the marker rows are
// inserted, so leftovers from an earlier crashed run cannot make the test lie.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardBuckets.test.ts.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')

const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

const round2 = (n: number) => Math.round(n * 100) / 100

test(
  'payment status covers shopify + erp, splits failed/overdue and reconciles',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `pay-${Date.now()}`
    const now = localNaive(new Date())
    const yesterday = localNaive(new Date(Date.now() - 86400000))
    const invoices = [
      // A Shopify invoice, so the platform filters have something on each side.
      { id: `${marker}-shop`, number: `${marker}-SHOP`, shopifyOrder: `#${marker}-shop`, date: now, grandTotal: 600, status: 'paid', paymentStatus: 'paid' },
      // Paid.
      { id: `${marker}-paid`, number: `${marker}-PAID`, date: now, grandTotal: 1000, status: 'paid', paymentStatus: 'paid' },
      // Overdue invoice that is still 'pending' payment: the overdue bucket wins
      // over the pending catch-all.
      { id: `${marker}-overdue`, number: `${marker}-OVERDUE`, date: now, grandTotal: 400, status: 'overdue', paymentStatus: 'pending' },
      // Explicit gateway failure → Failed, not added again as Pending.
      { id: `${marker}-failed`, number: `${marker}-FAILED`, date: now, grandTotal: 300, status: null, paymentStatus: 'failed' },
      // Open invoices with no failure: plain pending, partial and a null status.
      { id: `${marker}-pending`, number: `${marker}-PENDING`, date: now, grandTotal: 250, status: null, paymentStatus: 'pending' },
      { id: `${marker}-partial`, number: `${marker}-PARTIAL`, date: now, grandTotal: 150, status: null, paymentStatus: 'partial' },
      { id: `${marker}-due`, number: `${marker}-DUE`, date: now, grandTotal: 200, status: null, paymentStatus: null },
      // Partly paid with a credit note: ₹400 collected, ₹150 refunded, so the
      // segment must show the actual ₹250 retained and the ₹600 balance.
      { id: `${marker}-partpay`, number: `${marker}-PART-PAY`, date: now, grandTotal: 1000, status: 'issued', paymentStatus: 'partial' },
      // Refunded invoice (status), and one flagged only through payment_status.
      { id: `${marker}-refunded`, number: `${marker}-REFUNDED`, date: now, grandTotal: 700, status: 'refunded', paymentStatus: 'refunded' },
      { id: `${marker}-refunded-ps`, number: `${marker}-REFUNDED-PS`, date: now, grandTotal: 500, status: 'paid', paymentStatus: 'refunded' },
      // Void: cancelled, and a paid row dated outside today's window.
      { id: `${marker}-cancelled`, number: `${marker}-CANCELLED`, date: now, grandTotal: 900, status: 'cancelled', paymentStatus: 'paid' },
      { id: `${marker}-old`, number: `${marker}-OLD`, date: yesterday, grandTotal: 5000, status: 'paid', paymentStatus: 'paid' },
    ]
    const payments = [
      { id: `${marker}-pay-ok`, ref: `${marker}-pay-ok`, invoice: `${marker}-PART-PAY`, amount: 400, status: 'success', date: now },
      { id: `${marker}-pay-refund`, ref: `${marker}-pay-refund`, invoice: `${marker}-PART-PAY`, amount: -150, status: 'refunded', date: now },
    ]
    // ERP sales that exist only on the order row — the money the old widget
    // dropped. `invoiced` points at an invoice already counted above, so its
    // value must not be added a second time; the cancelled order must vanish.
    const orders = [
      { id: `${marker}-order-paid`, shopifyId: `MO-${marker}-paid`, internalId: `MO-${marker}-paid`, customer: `${marker} Buyer`, value: 800, payment: 'paid', invoice: null, status: 'confirmed', date: now, items: 1, lineItems: [] },
      { id: `${marker}-order-pending`, shopifyId: `MO-${marker}-pending`, internalId: `MO-${marker}-pending`, customer: `${marker} Buyer`, value: 200, payment: 'pending', invoice: null, status: 'confirmed', date: now, items: 1, lineItems: [] },
      { id: `${marker}-order-refunded`, shopifyId: `MO-${marker}-refunded`, internalId: `MO-${marker}-refunded`, customer: `${marker} Buyer`, value: 150, payment: 'refunded', invoice: null, status: 'confirmed', date: now, items: 1, lineItems: [] },
      { id: `${marker}-order-invoiced`, shopifyId: `MO-${marker}-invoiced`, internalId: `MO-${marker}-invoiced`, customer: `${marker} Buyer`, value: 900, payment: 'pending', invoice: `${marker}-PAID`, status: 'confirmed', date: now, items: 1, lineItems: [] },
      // A deleted invoice's number left on the order: the order is the only
      // remaining money record and must still appear, not disappear from the
      // widget while Sales counts it.
      { id: `${marker}-order-stale`, shopifyId: `MO-${marker}-stale`, internalId: `MO-${marker}-stale`, customer: `${marker} Buyer`, value: 333, payment: 'paid', invoice: `${marker}-MISSING`, status: 'confirmed', date: now, items: 1, lineItems: [] },
      { id: `${marker}-order-cancelled`, shopifyId: `MO-${marker}-cancelled`, internalId: `MO-${marker}-cancelled`, customer: `${marker} Buyer`, value: 400, payment: 'paid', invoice: null, status: 'cancelled', date: now, items: 1, lineItems: [] },
    ]

    let server: Server | null = null
    try {
      const app = express()
      app.use(dashboardRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const pay = async (source: 'all' | 'shopify' | 'erp') => {
        const path = `/dashboard/payment-status?period=today&source=${source}`
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        assert.equal(res.status, 200, `${path} responded ${res.status}`)
        return (await res.json()) as any
      }
      const segment = (payload: any, status: string) =>
        payload.segments.find((s: any) => s.status === status) ?? { value: -1, count: -1 }
      const delta = (after: number, before: number) => round2(after - before)
      const deltaSeg = (before: any, after: any, status: string) =>
        delta(segment(after, status).value, segment(before, status).value)

      const before = { all: await pay('all'), shopify: await pay('shopify'), erp: await pay('erp') }
      await db!.insert(schema.salesInvoices).values(invoices)
      await db!.insert(schema.payments).values(payments)
      await db!.insert(schema.salesOrders).values(orders)
      const after = { all: await pay('all'), shopify: await pay('shopify'), erp: await pay('erp') }

      // ── Five rows, in the agreed order and with the agreed labels ─────────
      assert.deepEqual(
        after.all.segments.map((s: any) => s.status),
        ['paid', 'pending', 'failed', 'overdue', 'refunded'],
        'segments must be Paid, Pending, Failed, Overdue, Refunded',
      )
      assert.deepEqual(
        after.all.segments.map((s: any) => s.label),
        ['Paid', 'Pending', 'Failed', 'Overdue', 'Refunded'],
      )

      // ── Each marker row lands in exactly one segment (All scope) ─────────
      assert.equal(deltaSeg(before.all, after.all, 'paid'), 2983, 'paid = invoices collected (₹1600) + retained part-payment (₹250) + paid ERP orders (₹800 + ₹333 stale-invoice order)')
      assert.equal(delta(segment(after.all, 'paid').count, segment(before.all, 'paid').count), 5, 'three paid invoices + two paid ERP orders')
      assert.equal(deltaSeg(before.all, after.all, 'pending'), 1400, 'pending = open invoices (₹1200) + pending ERP order (₹200)')
      assert.equal(delta(segment(after.all, 'pending').count, segment(before.all, 'pending').count), 5)
      assert.equal(deltaSeg(before.all, after.all, 'failed'), 300, 'failed = the unpaid failed invoice only, never counted again as pending')
      assert.equal(delta(segment(after.all, 'failed').count, segment(before.all, 'failed').count), 1)
      assert.equal(deltaSeg(before.all, after.all, 'overdue'), 400, 'overdue = the past-due unpaid invoice')
      assert.equal(delta(segment(after.all, 'overdue').count, segment(before.all, 'overdue').count), 1)
      assert.equal(deltaSeg(before.all, after.all, 'refunded'), 1500, 'refunded = two full refunds + the ₹150 credit note + the ₹150 refunded ERP order')
      assert.equal(delta(segment(after.all, 'refunded').count, segment(before.all, 'refunded').count), 4)

      // ── Cancelled, out-of-window and already-invoiced rows change nothing ─
      assert.equal(delta(after.all.total, before.all.total), 6583, 'total gains the ten live in-window invoices plus four orders whose money lives only on the order row')

      // ── The donut centre equals the sum of its rows ──────────────────────
      const sum = after.all.segments.reduce((acc: number, s: any) => acc + s.value, 0)
      assert.equal(Math.round(sum), Math.round(after.all.total), 'segments must sum to the centred total')

      // ── Shopify-only and ERP-only scopes, and All = Shopify + ERP ────────
      assert.equal(deltaSeg(before.shopify, after.shopify, 'paid'), 600, 'Shopify scope reads the Shopify invoice only')
      assert.equal(deltaSeg(before.shopify, after.shopify, 'pending'), 0, 'Shopify scope excludes ERP invoices')
      assert.equal(delta(after.shopify.total, before.shopify.total), 600, 'Shopify total excludes ERP orders and invoices')
      assert.equal(deltaSeg(before.erp, after.erp, 'paid'), 2383, 'ERP scope reads ERP invoices and orders without a live invoice')
      assert.equal(deltaSeg(before.erp, after.erp, 'pending'), 1400)
      assert.equal(deltaSeg(before.erp, after.erp, 'failed'), 300)
      assert.equal(deltaSeg(before.erp, after.erp, 'overdue'), 400)
      assert.equal(deltaSeg(before.erp, after.erp, 'refunded'), 1500)
      assert.equal(delta(after.erp.total, before.erp.total), 5983, 'ERP total excludes the Shopify invoice')
      assert.equal(
        round2(delta(after.shopify.total, before.shopify.total) + delta(after.erp.total, before.erp.total)),
        delta(after.all.total, before.all.total),
        'All = Shopify + ERP for the widget total',
      )
      for (const status of ['paid', 'pending', 'failed', 'overdue', 'refunded']) {
        assert.equal(
          round2(deltaSeg(before.shopify, after.shopify, status) + deltaSeg(before.erp, after.erp, status)),
          deltaSeg(before.all, after.all, status),
          `${status} adds up across platforms`,
        )
      }

      // ── Reconciliation with Sales revenue ────────────────────────────────
      // Sales counts live invoices + uninvoiced ERP orders − returns; this
      // widget additionally shows fully-refunded invoices as Refunded.
      assert.equal(delta(after.all.salesRevenue, before.all.salesRevenue), 5233, 'sales revenue delta = Shopify invoice ₹600 + ERP invoices ₹3300 + order-only sales ₹1333')
      assert.equal(delta(after.all.refundedInvoiceGross, before.all.refundedInvoiceGross), 1350, 'two fully-refunded invoices ₹1200 + the refunded ERP order ₹150')
      assert.equal(delta(after.all.returns, before.all.returns), 0)
      assert.equal(
        delta(after.all.total, before.all.total),
        round2(
          delta(after.all.salesRevenue, before.all.salesRevenue)
          + delta(after.all.returns, before.all.returns)
          + delta(after.all.refundedInvoiceGross, before.all.refundedInvoiceGross),
        ),
        'donut total = sales revenue + returns + refunded invoices',
      )

      // An unknown source is rejected, not silently treated as All.
      const bad = await fetch(`http://127.0.0.1:${port}/dashboard/payment-status?period=today&source=amazon`)
      assert.equal(bad.status, 400)
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.salesOrders).where(inArray(schema.salesOrders.id, orders.map((o) => o.id)))
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, invoices.map((i) => i.id)))
      await db!.delete(schema.payments).where(inArray(schema.payments.id, payments.map((p) => p.id)))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
