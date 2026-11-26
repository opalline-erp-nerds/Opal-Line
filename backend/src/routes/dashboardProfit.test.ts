import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { eq, inArray } from 'drizzle-orm'

/**
 * Owner Insights profit route, end to end on a scratch database.
 *
 * Deltas are measured against a baseline fetched BEFORE the marker rows are
 * inserted, so leftovers from a crashed run cannot make the assertions lie.
 * Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
 * the schema applied (never the real/dev database).
 */
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')
const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const delta = (a: number, b: number) => Math.round((a - b) * 100) / 100

interface ProfitResponse {
  months: Array<{
    month: string
    revenue: number
    cogs: number
    grossProfit: number
    netProfit: number
    invoices: number
    purchases: number
  }>
  totals: { revenue: number; cogs: number; grossProfit: number; expenses: number; netProfit: number; purchases?: number }
  bestSellers: Array<{ sku: string; variant: string | null; qty: number; revenue: number; profit: number }>
  costAnomalies: Array<{ sku: string }>
  locationId: string | null
  basis: string
}

test(
  'profit analytics uses unit cost, reverses return COGS, ignores drafts and scopes by store',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `pi-${Date.now()}`
    const locA = `${marker}-loc-a`
    const locB = `${marker}-loc-b`
    const productId = `${marker}-product`
    const variantId = `${marker}-variant`
    const pieceId = `${marker}-piece`
    const skuWeight = `${marker}-W`
    const skuVariant = `${marker}-V`
    const skuPiece = `${marker}-P`
    const invoiceA = `${marker}-inv-a`
    const invoiceB = `${marker}-inv-b`
    const draftId = `${marker}-draft`
    const cancelledId = `${marker}-cancelled`
    const returnId = `${marker}-return`
    const purchaseId = `${marker}-purchase`
    const invoiceIds = [invoiceA, invoiceB, draftId, cancelledId]

    let server: Server | null = null
    try {
      const app = express()
      app.use(dashboardRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (location = ''): Promise<ProfitResponse> => {
        const query = `/dashboard/profit?months=3${location ? `&locationId=${encodeURIComponent(location)}` : ''}`
        const res = await fetch(`http://127.0.0.1:${port}${query}`)
        const text = await res.text()
        assert.equal(res.status, 200, text)
        return JSON.parse(text) as ProfitResponse
      }

      const baseAll = await get()
      const baseA = await get(locA)
      const baseB = await get(locB)
      assert.equal(baseAll.basis, 'ex-gst')

      const now = localNaive(new Date())
      await db!.insert(schema.inventoryLocations).values([
        { id: locA, name: `${marker} Store A`, type: 'store', city: '', manager: '' },
        { id: locB, name: `${marker} Store B`, type: 'store', city: '', manager: '' },
      ])
      await db!.insert(schema.products).values([
        {
          id: productId,
          name: `${marker} Ring`,
          sku: skuWeight,
          category: 'Rings',
          costPrice: 100,
          sellingPrice: 600,
        },
        {
          id: pieceId,
          name: `${marker} Gift`,
          sku: skuPiece,
          category: 'Gifts',
          costPrice: 45,
          sellingPrice: 90,
          pieceRateProduct: true,
        },
      ])
      await db!.insert(schema.productVariants).values({
        id: variantId,
        productId,
        sku: skuVariant,
        title: 'Red',
        optionValues: [{ name: 'Colour', values: ['Red'] }],
        costPrice: 150,
      })

      const insertInvoice = (
        id: string,
        number: string,
        status: string,
        subtotal: number,
        items: Array<{ sku: string; product: string; qty: number; amount: number; variantId?: string }>,
        locationId: string,
      ) =>
        db!.transaction(async (tx) => {
          await tx.insert(schema.salesInvoices).values({
            id,
            number,
            status,
            paymentStatus: 'paid',
            date: now,
            subtotal,
            gst: 3,
            gstAmount: Math.round(subtotal * 0.03 * 100) / 100,
            grandTotal: subtotal * 1.03,
            silverValue: 0,
            makingCharge: 0,
          })
          let n = 0
          for (const line of items) {
            n += 1
            await tx.insert(schema.salesInvoiceItems).values({
              id: `${id}-item-${n}`,
              invoiceId: id,
              sku: line.sku,
              product: line.product,
              variantId: line.variantId ?? null,
              qty: line.qty,
              amount: line.amount,
              locationId,
              silverRate: 200,
              weight: 9.2,
            })
          }
        })

      // Store A: weight line (2 × ₹100) + variant line (1 × ₹150) = ₹350 COGS.
      await insertInvoice(
        invoiceA, `${marker}-A`, 'paid', 1000,
        [
          { sku: skuWeight, product: `${marker} Ring`, qty: 2, amount: 600 },
          { sku: skuVariant, product: `${marker} Ring`, qty: 1, amount: 400, variantId },
        ],
        locA,
      )
      // Store B: piece-rate line, qty × ₹45 = ₹45 COGS.
      await insertInvoice(
        invoiceB, `${marker}-B`, 'paid', 500,
        [{ sku: skuPiece, product: `${marker} Gift`, qty: 1, amount: 500 }],
        locB,
      )
      // A draft and a cancellation never sold anything, even though their
      // headers and item rows look like revenue.
      await insertInvoice(
        draftId, `${marker}-DRAFT`, 'draft', 900,
        [{ sku: skuWeight, product: `${marker} Ring`, qty: 3, amount: 900 }],
        locA,
      )
      await insertInvoice(
        cancelledId, `${marker}-CANCELLED`, 'cancelled', 700,
        [{ sku: skuWeight, product: `${marker} Ring`, qty: 2, amount: 700 }],
        locA,
      )

      // A credit note reverses ₹300 incl GST (₹291.26 ex GST) and one unit's
      // ₹100 of COGS — not the whole invoice and not its sales price.
      await db!.insert(schema.salesReturns).values({
        id: returnId,
        number: `${marker}-RETURN`,
        invoiceId: invoiceA,
        status: 'processed',
        date: now,
        amount: 300,
        returnItems: [{ sku: skuWeight, qty: 1, amount: 300 }],
      })

      // Stock sitting in inventory is NOT an expense of the period. An
      // unrelated bulk purchase must not create a negative gross profit.
      await db!.insert(schema.purchaseInvoices).values({
        id: purchaseId,
        number: `${marker}-PO`,
        date: now,
        locationId: locA,
        cost: 500000,
        total: 515000,
        status: 'received',
      })

      // Revenue: A 1000 + B 500 - return 291.26 = 1208.74 (ex GST).
      // COGS: A 350 + B 45 - returned 100 = 295.
      const afterAll = await get()
      assert.equal(delta(afterAll.totals.revenue, baseAll.totals.revenue), 1208.74)
      assert.equal(delta(afterAll.totals.cogs, baseAll.totals.cogs), 295)
      assert.equal(delta(afterAll.totals.grossProfit, baseAll.totals.grossProfit), 913.74)
      const latestMonth = afterAll.months[afterAll.months.length - 1]
      assert.ok(delta(latestMonth.purchases, baseAll.months[baseAll.months.length - 1].purchases) >= 500000)
      assert.ok(afterAll.totals.grossProfit > 0, 'a bulk purchase must never turn profit negative')
      assert.equal(delta(latestMonth.invoices, baseAll.months[baseAll.months.length - 1].invoices), 2)

      const row = afterAll.bestSellers.find((b) => b.sku === skuWeight)
      assert.ok(row, 'the weight-based SKU appears in best sellers')
      assert.equal(row.qty, 1, 'the returned unit is removed from best sellers')
      // ₹600 sold − ₹291.26 returned ex GST − ₹100 COGS returned = ₹208.74.
      assert.equal(row.profit, 208.74, 'best-seller profit uses the same cost and return basis as the top KPIs')
      const variantRow = afterAll.bestSellers.find((b) => b.sku === skuVariant)
      assert.equal(variantRow?.variant, 'Red')
      assert.equal(variantRow?.profit, 250, 'variant profit uses variant cost')
      const rankedProfit = Math.round(afterAll.bestSellers.reduce((sum, b) => sum + b.profit, 0) * 100) / 100
      assert.equal(rankedProfit, afterAll.totals.grossProfit, 'best-seller profits reconcile with the top-line gross profit')

      const afterA = await get(locA)
      assert.equal(delta(afterA.totals.revenue, baseA.totals.revenue), 708.74)
      assert.equal(delta(afterA.totals.cogs, baseA.totals.cogs), 250)
      assert.equal(afterA.bestSellers.some((b) => b.sku === skuPiece), false)
      assert.equal(afterA.locationId, locA)

      const afterB = await get(locB)
      assert.equal(delta(afterB.totals.revenue, baseB.totals.revenue), 500)
      assert.equal(delta(afterB.totals.cogs, baseB.totals.cogs), 45)
      assert.equal(afterB.bestSellers.some((b) => b.sku === skuWeight), false)
    } finally {
      await db!.delete(schema.salesReturns).where(eq(schema.salesReturns.id, returnId))
      await db!.delete(schema.salesInvoiceItems).where(inArray(schema.salesInvoiceItems.invoiceId, invoiceIds))
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, invoiceIds))
      await db!.delete(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.id, purchaseId))
      await db!.delete(schema.productVariants).where(eq(schema.productVariants.id, variantId))
      await db!.delete(schema.products).where(inArray(schema.products.id, [productId, pieceId]))
      await db!.delete(schema.inventoryLocations).where(inArray(schema.inventoryLocations.id, [locA, locB]))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
