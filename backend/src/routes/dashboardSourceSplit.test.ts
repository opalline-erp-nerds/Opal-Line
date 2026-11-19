import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Sales Overview splits: the three filter buttons must read one ledger —
//   All Sales == Shopify Sales + ERP Sales   (revenue and order count)
// with every sale counted exactly once. The cases that used to drift:
//   • an ERP order that already owns an invoice must not add its value again;
//   • a cancelled/refunded invoice must count in no filter;
//   • the ranking must reuse the same source filter as the chart, and must not
//     merge an already-invoiced ERP order's lines into its SKU a second time.
//
// Assertions are deltas against baselines fetched before the marker rows are
// inserted, so leftovers on a shared scratch database cannot make the test lie.
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as the other dashboard tests.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')
const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

test(
  'sales overview splits shopify and erp without double counting',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `split-${Date.now()}`
    const now = localNaive(new Date())
    const shopSku = `SPLIT-SHOP-${marker}`
    const erpSku = `SPLIT-ERP-${marker}`
    const shopInvoice = `${marker}-inv-shop`
    const erpInvoice = `${marker}-inv-erp`
    const voidInvoice = `${marker}-inv-cancelled`
    const shopOrder = `${marker}-order-shop`
    const erpOrder = `${marker}-order-erp`
    const invoicedErpOrder = `${marker}-order-erp-invoiced`

    // Magnitudes sit far above real catalogue revenue so the marker SKUs rank
    // inside the limited top-products payload on any database.
    const SHOP_REVENUE = 9_000_000
    const ERP_INVOICE = 5_000_000
    const ERP_ORDER_VALUE = 3_000_000 // uninvoiced: revenue lives on the order
    const ALREADY_INVOICED = 1_000_000 // order value that must not be added again

    const invoices = [
      {
        id: shopInvoice,
        number: `${marker}-SHOP`,
        shopifyOrder: `#${marker}`,
        customer: `${marker} Shopify Buyer`,
        grandTotal: SHOP_REVENUE,
        status: 'paid',
        paymentStatus: 'paid',
        date: now,
      },
      {
        id: erpInvoice,
        number: `${marker}-ERP`,
        shopifyOrder: null,
        customer: `${marker} ERP Buyer`,
        grandTotal: ERP_INVOICE,
        status: 'issued',
        paymentStatus: 'pending',
        date: now,
      },
      {
        // Voided: must appear in no filter and no ranking.
        id: voidInvoice,
        number: `${marker}-VOID`,
        shopifyOrder: `#${marker}-void`,
        customer: `${marker} Void Buyer`,
        grandTotal: 7_000_000,
        status: 'cancelled',
        paymentStatus: 'cancelled',
        date: now,
      },
    ]
    const items = [
      { id: `${marker}-item-shop`, invoiceId: shopInvoice, product: 'Split Shop Ring', sku: shopSku, qty: 1, weight: 10, amount: SHOP_REVENUE },
      { id: `${marker}-item-erp`, invoiceId: erpInvoice, product: 'Split ERP Chain', sku: erpSku, qty: 1, weight: 20, amount: ERP_INVOICE },
      { id: `${marker}-item-void`, invoiceId: voidInvoice, product: 'Split Void Bangle', sku: `VOID-${marker}`, qty: 1, weight: 5, amount: 7_000_000 },
    ]
    const orders = [
      {
        id: shopOrder,
        shopifyId: `#${marker}`,
        internalId: `SO-${marker}`,
        customer: `${marker} Shopify Buyer`,
        value: SHOP_REVENUE,
        payment: 'paid',
        invoice: `${marker}-SHOP`,
        status: 'imported',
        date: now,
        items: 1,
        lineItems: [],
      },
      {
        // ERP sale that exists only as an order line.
        id: erpOrder,
        shopifyId: `MO-${marker}`,
        internalId: `MO-${marker}`,
        customer: `${marker} ERP Buyer`,
        value: ERP_ORDER_VALUE,
        payment: 'pending',
        invoice: null,
        status: 'confirmed',
        date: now,
        items: 3,
        lineItems: [{ sku: erpSku, title: 'Split ERP Chain', quantity: 3, weight: 30, amount: ERP_ORDER_VALUE }],
      },
      {
        // ERP order that already owns an invoice: its order value and lines
        // must not be counted on top of the invoice.
        id: invoicedErpOrder,
        shopifyId: `MO-${marker}-inv`,
        internalId: `MO-${marker}-inv`,
        customer: `${marker} ERP Buyer`,
        value: ALREADY_INVOICED,
        payment: 'pending',
        invoice: `${marker}-ERP`,
        status: 'confirmed',
        date: now,
        items: 1,
        lineItems: [{ sku: erpSku, title: 'Split ERP Chain', quantity: 1, weight: 10, amount: ALREADY_INVOICED }],
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
            shopifyOrders: acc.shopifyOrders + Number(p.shopifyOrders ?? 0),
            erpRevenue: acc.erpRevenue + Number(p.erpRevenue ?? 0),
            erpOrders: acc.erpOrders + Number(p.erpOrders ?? 0),
          }),
          { revenue: 0, orders: 0, shopifyRevenue: 0, shopifyOrders: 0, erpRevenue: 0, erpOrders: 0 },
        )
      const delta = (before: number, after: number) => Math.round((after - before) * 100) / 100
      const productRevenue = (rows: unknown, sku: string) => {
        const hit = (rows as Array<Record<string, any>>).find((r) => String(r.sku ?? '').toLowerCase() === sku.toLowerCase())
        return Number(hit?.revenue ?? 0)
      }

      // Baseline before the marker rows exist, so the deltas below are exactly
      // what they contributed whatever else lives on a shared scratch database.
      const base = totals(await get('/dashboard/sales-overview?period=last30'))

      await db!.insert(schema.salesInvoices).values(invoices)
      await db!.insert(schema.salesInvoiceItems).values(items)
      await db!.insert(schema.salesOrders).values(orders)

      const points = await get('/dashboard/sales-overview?period=last30')
      const after = totals(points)

      assert.equal(delta(base.shopifyRevenue, after.shopifyRevenue), SHOP_REVENUE, 'Shopify revenue is the Shopify invoice only')
      assert.equal(
        delta(base.erpRevenue, after.erpRevenue),
        ERP_INVOICE + ERP_ORDER_VALUE,
        'ERP revenue is its invoices plus uninvoiced orders, and never the already-invoiced order value',
      )
      assert.equal(delta(base.shopifyOrders, after.shopifyOrders), 1, 'one Shopify order')
      assert.equal(delta(base.erpOrders, after.erpOrders), 2, 'two ERP orders, including the invoiced one (as an order, not as extra revenue)')
      assert.equal(
        delta(base.revenue, after.revenue),
        SHOP_REVENUE + ERP_INVOICE + ERP_ORDER_VALUE,
        'All Sales is Shopify + ERP revenue with every sale counted once',
      )
      assert.equal(delta(base.orders, after.orders), 3, 'All Sales is Shopify + ERP order counts')
      assert.equal(
        Math.round((after.shopifyRevenue + after.erpRevenue - after.revenue) * 100) / 100,
        0,
        'All Sales == Shopify + ERP holds on the database-wide totals, not just the delta',
      )
      assert.equal(after.orders, after.shopifyOrders + after.erpOrders, 'order counts add up the same way')

      // The KPI cards must read the same figures as the chart.
      const insights = (await get('/dashboard/sales-insights?period=last30')).current
      assert.equal(Math.round(insights.all.revenue * 100) / 100, Math.round(after.revenue * 100) / 100, 'All card revenue == chart')
      assert.equal(Math.round(insights.shopify.revenue * 100) / 100, Math.round(after.shopifyRevenue * 100) / 100, 'Shopify card revenue == chart')
      assert.equal(Math.round(insights.erp.revenue * 100) / 100, Math.round(after.erpRevenue * 100) / 100, 'ERP card revenue == chart')
      assert.equal(insights.all.orders, after.orders)
      assert.equal(insights.shopify.orders, after.shopifyOrders)
      assert.equal(insights.erp.orders, after.erpOrders)

      // Rankings follow the same source split and dedupe.
      const topAll = await get('/dashboard/top-products?period=last30&source=all')
      const topShopify = await get('/dashboard/top-products?period=last30&source=shopify')
      const topErp = await get('/dashboard/top-products?period=last30&source=erp')
      assert.equal(productRevenue(topAll, shopSku), SHOP_REVENUE, 'All ranks the Shopify SKU')
      assert.equal(productRevenue(topAll, erpSku), ERP_INVOICE + ERP_ORDER_VALUE, 'All ranks the ERP SKU once, invoiced order value excluded')
      assert.equal(productRevenue(topShopify, shopSku), SHOP_REVENUE, 'Shopify filter ranks its own SKU')
      assert.equal(productRevenue(topShopify, erpSku), 0, 'Shopify filter excludes ERP SKUs')
      assert.equal(productRevenue(topErp, erpSku), ERP_INVOICE + ERP_ORDER_VALUE, 'ERP filter ranks its own SKU')
      assert.equal(productRevenue(topErp, shopSku), 0, 'ERP filter excludes Shopify SKUs')
      assert.equal(productRevenue(topAll, `VOID-${marker}`), 0, 'cancelled invoices are absent from the ranking')

      // An unknown source is rejected, not silently treated as All.
      const bad = await fetch(`http://127.0.0.1:${port}/dashboard/top-products?period=last30&source=amazon`)
      assert.equal(bad.status, 400)
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.salesOrders).where(inArray(schema.salesOrders.id, orders.map((o) => o.id)))
      await db!.delete(schema.salesInvoiceItems).where(inArray(schema.salesInvoiceItems.id, items.map((i) => i.id)))
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, invoices.map((i) => i.id)))
      server?.close()
    }
  },
)
