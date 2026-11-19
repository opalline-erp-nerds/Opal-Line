import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Cancellation / refund lifecycle, end to end against the real dashboard
// queries.
//
// The money must leave every card the moment a sale is cancelled, and only the
// settled refund amount may reduce a still-live sale:
//   • Shopify order cancelled  → its invoice stops counting (the invoice row
//     still says paid; the cancellation lives on the order);
//   • ERP order cancelled      → its linked invoice stops counting too;
//   • reopening an order       → the same invoice counts again;
//   • uninvoiced ERP order     → disappears from revenue and order counts;
//   • completed refund         → reduces revenue by the refunded amount only
//     (a refund linked to a return is already netted by the credit note).
// Dashboard KPIs, Sales Overview, Sales Insights and receivables must all tell
// the same story after each step.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database —
// the same contract as the other dashboard tests.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')
const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const round2 = (n: number) => Math.round(n * 100) / 100
const rupees = (v: string | undefined): number => {
  const cleaned = (v ?? '').replace(/[₹,\s]/g, '').replace('−', '-')
  return cleaned === '' ? 0 : Number(cleaned)
}

test(
  'cancelled orders and refunds immediately leave every dashboard total',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    const { eq, inArray } = await import('drizzle-orm')
    assert.ok(db, 'test database client did not initialize')

    const marker = `cancel-${Date.now()}`
    const now = localNaive(new Date())
    const shopOrderId = `${marker}-order-shop`
    const erpOrderId = `${marker}-order-erp`
    const openOrderId = `${marker}-order-open`
    const refundOrderId = `${marker}-order-refund`
    const shopInvoiceId = `${marker}-inv-shop`
    const erpInvoiceId = `${marker}-inv-erp`
    const refundInvoiceId = `${marker}-inv-refund`
    const refundId = `${marker}-refund`

    const invoices = [
      // Shopify invoice: the order row is the money record, this is its copy.
      { id: shopInvoiceId, number: `${marker}-SHOP`, shopifyOrder: `#${marker}-shop`, date: now, grandTotal: 1000, status: 'paid', paymentStatus: 'paid' },
      // ERP invoice: the invoice row is the money record.
      { id: erpInvoiceId, number: `${marker}-ERP`, shopifyOrder: null, date: now, grandTotal: 500, status: 'issued', paymentStatus: 'pending' },
      // Shopify invoice with a partial refund against it.
      { id: refundInvoiceId, number: `${marker}-REFUND`, shopifyOrder: `#${marker}-refund`, date: now, grandTotal: 400, status: 'paid', paymentStatus: 'paid' },
    ]
    const orders = [
      { id: shopOrderId, shopifyId: `#${marker}-shop`, internalId: `SO-${marker}-shop`, customer: `${marker} Buyer`, value: 1000, payment: 'paid', invoice: `${marker}-SHOP`, status: 'imported', date: now, items: 1, lineItems: [] },
      { id: refundOrderId, shopifyId: `#${marker}-refund`, internalId: `SO-${marker}-refund`, customer: `${marker} Buyer`, value: 400, payment: 'paid', invoice: `${marker}-REFUND`, status: 'imported', date: now, items: 1, lineItems: [] },
      { id: erpOrderId, shopifyId: `MO-${marker}-erp`, internalId: `MO-${marker}-erp`, customer: `${marker} Buyer`, value: 500, payment: 'pending', invoice: `${marker}-ERP`, status: 'confirmed', date: now, items: 1, lineItems: [] },
      // A sale that exists only as an order row.
      { id: openOrderId, shopifyId: `MO-${marker}-open`, internalId: `MO-${marker}-open`, customer: `${marker} Buyer`, value: 250, payment: 'pending', invoice: null, status: 'confirmed', date: now, items: 1, lineItems: [] },
    ]
    const refunds = [
      {
        id: refundId,
        number: `RF-${marker}`,
        shopifyOrder: `#${marker}-refund`,
        invoiceNumber: `${marker}-REFUND`,
        source: 'shopify',
        status: 'completed',
        amount: 100,
        refundedAmount: 100,
        processedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]

    let server: Server | null = null
    try {
      const app = express()
      app.use(dashboardRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        assert.equal(res.status, 200, `${path} responded ${res.status}`)
        return (await res.json()) as any
      }
      const totals = (points: Array<Record<string, number>>) =>
        points.reduce(
          (acc, p) => ({
            revenue: acc.revenue + Number(p.revenue ?? 0),
            orders: acc.orders + Number(p.orders ?? 0),
            shopifyRevenue: acc.shopifyRevenue + Number(p.shopifyRevenue ?? 0),
            erpRevenue: acc.erpRevenue + Number(p.erpRevenue ?? 0),
          }),
          { revenue: 0, orders: 0, shopifyRevenue: 0, erpRevenue: 0 },
        )
      const delta = (after: number, before: number) => round2(after - before)
      const kpi = (cards: unknown, key: string) =>
        (cards as Array<Record<string, string>>).find((c) => c.key === key)

      const snapshot = async () => {
        const [cards, chart, insights, payment, aging] = await Promise.all([
          get('/dashboard/kpis?period=today'),
          get('/dashboard/sales-overview?period=today'),
          get('/dashboard/sales-insights?period=today'),
          get('/dashboard/payment-status?period=today&source=all'),
          get('/dashboard/aging'),
        ])
        return {
          sales: rupees(kpi(cards, 'sales')?.value),
          orders: Number(kpi(cards, 'orders')?.value),
          invoices: Number(kpi(cards, 'invoices')?.value),
          chart: totals(chart),
          insights: insights.current.all as { revenue: number; orders: number },
          paymentTotal: Number(payment.total ?? 0),
          outstanding: Number(aging.total ?? 0),
        }
      }

      const before = await snapshot()
      await db!.insert(schema.salesInvoices).values(invoices)
      await db!.insert(schema.salesOrders).values(orders)
      await db!.insert(schema.refunds).values(refunds)

      const live = await snapshot()

      // ── Live state: both platforms plus a settled partial refund ──────────
      assert.equal(delta(live.sales, before.sales), 2050, 'sales = Shopify ₹1000 + ₹400 − refund ₹100 + ERP ₹500 + uninvoiced ₹250')
      assert.equal(delta(live.orders, before.orders), 4, 'four live orders')
      assert.equal(delta(live.invoices, before.invoices), 3, 'three live invoices')
      assert.equal(delta(live.chart.shopifyRevenue, before.chart.shopifyRevenue), 1300, 'Shopify = order ₹1000 + order ₹400 − refund ₹100')
      assert.equal(delta(live.chart.erpRevenue, before.chart.erpRevenue), 750, 'ERP = invoice ₹500 + uninvoiced order ₹250')
      assert.equal(delta(live.chart.revenue, before.chart.revenue), 2050)
      assert.equal(delta(live.insights.revenue, before.insights.revenue), 2050, 'Sales Overview card agrees with the KPI')
      assert.equal(delta(live.insights.orders, before.insights.orders), 4)
      assert.equal(delta(live.outstanding, before.outstanding), 500, 'only the ERP invoice is receivable')

      // ── Cancel the Shopify order: its paid invoice must go too ────────────
      await db!
        .update(schema.salesOrders)
        .set({ status: 'cancelled', cancelledAt: now })
        .where(eq(schema.salesOrders.id, shopOrderId))
      const afterShopifyCancel = await snapshot()
      assert.equal(delta(afterShopifyCancel.sales, before.sales), 1050, 'Shopify cancellation removes ₹1000 from revenue')
      assert.equal(delta(afterShopifyCancel.orders, before.orders), 3, 'the cancelled order leaves the order count')
      assert.equal(delta(afterShopifyCancel.invoices, before.invoices), 2, 'its invoice leaves the invoice count')
      assert.equal(delta(afterShopifyCancel.chart.shopifyRevenue, before.chart.shopifyRevenue), 300, 'Shopify keeps only the refunded order net of its refund')
      // Payment Status also carries the uninvoiced ERP order (₹250 pending), so
      // only the cancelled ₹1000 invoice leaves its total.
      assert.equal(delta(afterShopifyCancel.paymentTotal, before.paymentTotal), 1150, "payment status drops the cancelled order's invoice")
      assert.equal(delta(afterShopifyCancel.outstanding, before.outstanding), 500, 'the unpaid ERP invoice is still receivable')

      // ── Cancel the ERP order whose invoice was paid in the ERP ────────────
      await db!
        .update(schema.salesOrders)
        .set({ status: 'cancelled', cancelledAt: now })
        .where(eq(schema.salesOrders.id, erpOrderId))
      const afterErpCancel = await snapshot()
      assert.equal(delta(afterErpCancel.sales, before.sales), 550, 'Shopify ₹300 + open ERP order ₹250 remain')
      assert.equal(delta(afterErpCancel.outstanding, before.outstanding), 0, 'the cancelled ERP invoice is no longer receivable')
      assert.equal(delta(afterErpCancel.orders, before.orders), 2, 'only the refund order and the open ERP order remain')
      assert.equal(delta(afterErpCancel.invoices, before.invoices), 1, 'only the refund invoice remains')
      assert.equal(delta(afterErpCancel.insights.revenue, before.insights.revenue), 550, 'Sales Overview agrees after both cancellations')

      // ── Reopen the Shopify order: the same sale counts again ──────────────
      await db!
        .update(schema.salesOrders)
        .set({ status: 'imported', cancelledAt: null })
        .where(eq(schema.salesOrders.id, shopOrderId))
      const reopened = await snapshot()
      assert.equal(delta(reopened.sales, before.sales), 1550, 'reopening restores Shopify ₹1000 + ₹400 − ₹100 and keeps ERP ₹250')
      assert.equal(delta(reopened.orders, before.orders), 3)
      assert.equal(delta(reopened.invoices, before.invoices), 2)

      // ── Cancel the uninvoiced ERP order: only its order row carries money ─
      await db!
        .update(schema.salesOrders)
        .set({ status: 'cancelled', cancelledAt: now })
        .where(eq(schema.salesOrders.id, openOrderId))
      const afterOpenCancel = await snapshot()
      assert.equal(delta(afterOpenCancel.sales, before.sales), 1300, "the uninvoiced order's ₹250 leaves with it")
      assert.equal(delta(afterOpenCancel.orders, before.orders), 2)
    } finally {
      await db!.delete(schema.refunds).where(inArray(schema.refunds.id, refunds.map((r) => r.id)))
      await db!.delete(schema.salesOrders).where(inArray(schema.salesOrders.id, orders.map((o) => o.id)))
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, invoices.map((i) => i.id)))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
