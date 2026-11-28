import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Totals reconciliation: with one range selected, every Dashboard total tells
// the same story —
//   • Sales KPI  == analytics "Total Sales" == Financial Net Revenue
//                == sum of the Sales Overview chart points
//   • Sales KPI + returns == payment-status total − refunded segment
//   • Top products / Top category rank only the invoices the Sales KPI counts
// The seed of the historical disagreement was NOT_VOIDED checking `status`
// alone: an invoice with status='paid' but payment_status='refunded' was
// counted as sales while the payment widget reported the same money as
// refunded. Cancelled invoices must appear in none of them.
//
// Assertions are deltas against baselines fetched before the marker rows are
// inserted, so leftovers from an earlier crashed run cannot make the test lie.
// The chart sums whole buckets (no per-bucket floor), so its delta equals the
// KPI delta whenever the window is not floored at zero — markers keep the
// window positive.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardSecurity.test.ts.
// (Separate file on purpose: each test file runs in its own process, and a
// test that closes the pool in its finally would break a second test in the
// same file.)
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')

const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

const rupees = (v: string | undefined): number => {
  // KPI money strings carry paise now (₹1,48,382.44) and a Unicode minus for
  // negatives; parse the displayed amount, not just its digits.
  const cleaned = (v ?? '').replace(/[₹,\s]/g, '').replace('−', '-')
  return cleaned === '' ? 0 : Number(cleaned)
}

test(
  'dashboard totals reconcile: Sales, payments, chart, Net Revenue and rankings agree',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `recon-${Date.now()}`
    const sku = `RECON-${marker}`
    const category = `Recon Cat ${marker}`
    const productId = `${marker}-product`
    // Magnitudes sit far above any real catalogue revenue so the marker SKU is
    // guaranteed to appear in the limited top-products payload on any database.
    const PAID_GT = 9_000_000 // counts everywhere
    const REFUNDED_GT = 5_000_000 // status paid, payment refunded → sales must skip, payment shows refunded
    const CANCELLED_GT = 7_000_000 // counts nowhere
    const RETURN = 3_000_000 // against the paid invoice
    const paidId = `${marker}-inv-paid`
    const refundedId = `${marker}-inv-refunded-ps`
    const cancelledId = `${marker}-inv-cancelled`
    const returnId = `${marker}-return`

    const invoiceIds = [paidId, refundedId, cancelledId]

    let server: Server | null = null
    try {
      const app = express()
      app.use(dashboardRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        return { status: res.status, body: (await res.json()) as any }
      }
      const find = (body: unknown, key: string, field = 'key') =>
        (body as Array<Record<string, any>>).find((x) => x[field] === key)
      const sumRevenue = (points: Array<{ revenue: number }>) => points.reduce((a, p) => a + Number(p.revenue ?? 0), 0)
      const productRevenue = (rows: unknown, needle: string, field: string) => {
        const hit = (rows as Array<Record<string, any>>).find((r) => String(r.sku ?? r.category ?? '') === needle)
        return Number(hit?.[field] ?? 0)
      }
      const snapshot = async () => ({
        sales: rupees(find(await (await get('/dashboard/kpis?period=last30')).body, 'sales')?.value),
        totalSales: rupees(find((await get('/dashboard/analytics?period=last30')).body, 'Total Sales', 'label')?.value),
        netRevenue: Number((await get('/dashboard/financial?period=last30')).body.netRevenue ?? -1),
        chart: sumRevenue((await get('/dashboard/sales-overview?period=last30')).body),
        pay: (await get('/dashboard/payment-status?period=last30')).body as { total: number; segments: Array<{ status: string; value: number }> },
        topProduct: productRevenue((await get('/dashboard/top-products?period=last30')).body, sku, 'revenue'),
        topCategory: productRevenue((await get('/dashboard/top-category?period=last30')).body, category, 'revenue'),
      })

      const before = await snapshot()
      assert.ok(before.netRevenue >= 0, 'financial endpoint answered')

      await db!.insert(schema.products).values({
        id: productId,
        name: `Recon Product ${marker}`,
        sku,
        category,
        status: 'active',
      })
      const now = localNaive(new Date())
      await db!.insert(schema.salesInvoices).values([
        { id: paidId, number: `${marker}-PAID`, grandTotal: PAID_GT, paymentStatus: 'paid', status: 'paid', date: now },
        { id: refundedId, number: `${marker}-REFUNDED-PS`, grandTotal: REFUNDED_GT, paymentStatus: 'refunded', status: 'paid', date: now },
        { id: cancelledId, number: `${marker}-CANCELLED`, grandTotal: CANCELLED_GT, paymentStatus: 'pending', status: 'cancelled', date: now },
      ])
      await db!.insert(schema.salesInvoiceItems).values([
        { id: `${marker}-item-paid`, invoiceId: paidId, product: `Recon Product ${marker}`, sku, qty: 2, weight: 10, amount: PAID_GT },
        { id: `${marker}-item-refunded`, invoiceId: refundedId, product: `Recon Product ${marker}`, sku, qty: 1, weight: 5, amount: REFUNDED_GT },
        { id: `${marker}-item-cancelled`, invoiceId: cancelledId, product: `Recon Product ${marker}`, sku, qty: 3, weight: 15, amount: CANCELLED_GT },
      ])
      await db!.insert(schema.salesReturns).values({
        id: returnId,
        number: `${marker}-RETURN`,
        invoiceId: paidId,
        amount: RETURN,
        status: 'completed',
        date: now,
      })

      const after = await snapshot()
      const seg = (s: { segments: Array<{ status: string; value: number }> }, key: string) =>
        Number(s.segments.find((x) => x.status === key)?.value ?? 0)

      const salesD = after.sales - before.sales
      const payD = after.pay.total - before.pay.total
      const refundedD = seg(after.pay, 'refunded') - seg(before.pay, 'refunded')
      const paidD = seg(after.pay, 'paid') - seg(before.pay, 'paid')
      const chartD = after.chart - before.chart

      // Sales KPI: paid invoice only, less the return — refunded/cancelled skip it.
      assert.equal(salesD, PAID_GT - RETURN, 'Sales KPI counts the paid invoice minus the return only')

      assert.equal(after.totalSales - before.totalSales, salesD, 'analytics Total Sales uses the same basis as the Sales KPI')
      assert.equal(after.netRevenue - before.netRevenue, salesD, 'Financial Net Revenue uses the same basis as the Sales KPI')
      assert.equal(chartD, salesD, 'the Sales Overview chart sums back to the Sales KPI')

      assert.equal(payD, PAID_GT + REFUNDED_GT, 'payment total covers the paid and refunded-by-payment invoices (cancelled excluded)')
      assert.equal(paidD, PAID_GT, 'paid segment grew by the paid invoice only')
      assert.equal(refundedD, REFUNDED_GT, 'the payment_status=refunded invoice lands in the Refunded segment')
      assert.equal(
        salesD + RETURN,
        payD - refundedD,
        'Sales KPI + returns == payment total − refunded: the two widgets describe one set of invoices',
      )

      assert.equal(after.topProduct - before.topProduct, PAID_GT, 'top products rank only the invoice the Sales KPI counts')
      assert.equal(after.topCategory - before.topCategory, PAID_GT, 'top category follows the same invoices as top products')
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.salesInvoiceItems).where(inArray(schema.salesInvoiceItems.invoiceId, invoiceIds))
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, invoiceIds))
      await db!.delete(schema.salesReturns).where(inArray(schema.salesReturns.id, [returnId]))
      await db!.delete(schema.products).where(inArray(schema.products.id, [productId]))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
