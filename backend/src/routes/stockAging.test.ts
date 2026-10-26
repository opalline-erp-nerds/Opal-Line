import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { inArray } from 'drizzle-orm'

// Aging Unsold Stock reads the stock ledger FIFO and joins the newest sale from
// both billing channels. The assertions below pin the parts a wrong query would
// silently get wrong:
//   - a recent restock must NOT make a partly-consumed old lot look fresh,
//   - a product with no ledger history falls back to its creation date instead
//     of vanishing from the report,
//   - cancelled invoices never count as "last sold",
//   - the summary bands sum to the rows they describe, and
//   - unknown bucket filters are a 400 rather than an empty list.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardAging.test.ts.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')

const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

test(
  'aging unsold stock reconstructs FIFO age and last-sold dates',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dbRouter } = await import('./db')
    assert.ok(db, 'test database client did not initialize')

    const marker = `stockaging-${Date.now()}`
    const day = 86_400_000
    const ago = (d: number) => localNaive(new Date(Date.now() - d * day))

    const userId = `${marker}-admin`
    const oldProduct = `${marker}-old`
    const recentProduct = `${marker}-recent`
    const fallbackProduct = `${marker}-fallback`
    const agedProduct = `${marker}-aged`
    const cancelledProduct = `${marker}-cancelled`
    const products = [
      { id: oldProduct, name: 'Aging Old Lot Ring', sku: `${marker}-OLD`, category: `${marker}-cat` },
      { id: recentProduct, name: 'Aging Recent Chain', sku: `${marker}-RECENT`, category: `${marker}-cat` },
      {
        id: fallbackProduct,
        name: 'Aging Legacy Bangle',
        sku: `${marker}-LEGACY`,
        category: `${marker}-cat`,
        stock: 1,
        createdAt: ago(45).slice(0, 10),
      },
      { id: agedProduct, name: 'Aging Slow Bangle', sku: `${marker}-AGED`, category: `${marker}-cat` },
      { id: cancelledProduct, name: 'Aging Cancelled Ring', sku: `${marker}-CANCELLED`, category: `${marker}-cat` },
    ]
    const movements: Array<{ id: string; productId: string | null; sku: string | null; type: string; qty: number; date: string }> = [
      // 10 in, 3 on hand → the 5-unit lot from 200 days ago is fully sold and
      // the remaining units came in 10 days ago.
      { id: `${marker}-mv-old-1`, productId: oldProduct, sku: `${marker}-OLD`, type: 'opening', qty: 5, date: ago(200) },
      { id: `${marker}-mv-old-2`, productId: oldProduct, sku: `${marker}-OLD`, type: 'purchase_in', qty: 5, date: ago(10) },
      // Never restocked, so its whole balance is 120 days old.
      { id: `${marker}-mv-aged`, productId: agedProduct, sku: `${marker}-AGED`, type: 'opening', qty: 2, date: ago(120) },
      // Two lots: the newest sale is the one that decides "last sold".
      { id: `${marker}-mv-recent-1`, productId: recentProduct, sku: `${marker}-RECENT`, type: 'opening', qty: 4, date: ago(50) },
      { id: `${marker}-mv-cancelled`, productId: cancelledProduct, sku: `${marker}-CANCELLED`, type: 'opening', qty: 1, date: ago(45) },
    ]
    const invoiceId = `${marker}-inv`
    const cancelledInvoiceId = `${marker}-inv-cancelled`
    const orderId = `${marker}-order`

    let server: Server | null = null
    try {
      await db!.insert(schema.users).values({
        id: userId,
        name: 'Aging Tester',
        email: `${marker}-tester@test.local`,
        role: 'Super Admin',
        status: 'active',
      })
      await db!.insert(schema.products).values(products)
      // Give the products that have ledger history a balance too.
      await db!.update(schema.products).set({ stock: 3 }).where(inArray(schema.products.id, [oldProduct, recentProduct, agedProduct, cancelledProduct]))
      await db!.insert(schema.stockMovements).values(movements)
      await db!.insert(schema.salesInvoices).values([
        { id: invoiceId, number: `${marker}-INV`, status: 'paid', date: ago(60) },
        { id: cancelledInvoiceId, number: `${marker}-INV-VOID`, status: 'cancelled', date: ago(5) },
      ])
      await db!.insert(schema.salesInvoiceItems).values([
        { id: `${marker}-inv-item`, invoiceId, sku: `${marker}-OLD`, qty: 7 },
        { id: `${marker}-inv-void-item`, invoiceId: cancelledInvoiceId, sku: `${marker}-CANCELLED`, qty: 1 },
      ])
      await db!.insert(schema.salesOrders).values({
        id: orderId,
        date: ago(20),
        status: 'unfulfilled',
        lineItems: [{ sku: `${marker}-OLD`, quantity: 2 }],
      })

      const app = express()
      app.use((req, _res, next) => {
        ;(req as { userId?: string }).userId = userId
        next()
      })
      app.use(dbRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        return { status: res.status, body: (await res.json()) as any }
      }

      const after = await get(`/inventory/aging?q=${encodeURIComponent(marker)}`)
      assert.equal(after.status, 200)

      const rows: any[] = after.body.data
      const row = (sku: string) => rows.find((r) => r.sku === sku)
      const oldRow = row(`${marker}-OLD`)
      assert.ok(oldRow, 'the partly sold product is present')
      assert.equal(oldRow.quantity, 3)
      assert.equal(oldRow.agingBucket, 'd0_30', 'remaining units came from the 10-day lot')
      const soldDays = Math.round((Date.now() - new Date(oldRow.lastSoldDate).getTime()) / day)
      assert.ok(Math.abs(soldDays - 20) <= 1, 'newest sale across invoices and orders wins')

      const agedRow = row(`${marker}-AGED`)
      assert.ok(agedRow)
      assert.equal(agedRow.agingBucket, 'd91_180', '120-day-old stock lands in 91-180')
      assert.equal(agedRow.lastSoldDate, null, 'never sold is reported as null, not today')

      const fallbackRow = row(`${marker}-LEGACY`)
      assert.ok(fallbackRow, 'a pre-ledger balance is not dropped')
      assert.equal(fallbackRow.agingBucket, 'd31_60', 'falls back to createdAt for its entry date')

      const cancelledRow = row(`${marker}-CANCELLED`)
      assert.ok(cancelledRow)
      assert.equal(cancelledRow.lastSoldDate, null, 'a cancelled invoice does not count as a sale')

      // Filters are applied server-side for export clients.
      const byBucket = await get(`/inventory/aging?q=${encodeURIComponent(marker)}&bucket=d91_180`)
      assert.equal(byBucket.status, 200)
      assert.deepEqual(byBucket.body.data.map((r: any) => r.sku), [`${marker}-AGED`])
      const byCategory = await get(`/inventory/aging?category=${encodeURIComponent(`${marker}-cat`)}&bucket=d31_60`)
      assert.ok(byCategory.body.data.some((r: any) => r.sku === `${marker}-LEGACY`))

      // Summary bands and totals agree with the rows they describe.
      const buckets: any[] = after.body.buckets
      assert.equal(buckets.reduce((sum, b) => sum + b.count, 0), after.body.totals.products)
      assert.equal(buckets.reduce((sum, b) => sum + b.quantity, 0), after.body.totals.quantity)
      assert.equal(after.body.totals.neverSold, rows.filter((r) => !r.lastSoldDate).length)

      const bad = await get('/inventory/aging?bucket=Nope')
      assert.equal(bad.status, 400, 'unknown bucket is a client error')
    } finally {
      await db!.delete(schema.salesInvoiceItems).where(inArray(schema.salesInvoiceItems.invoiceId, [invoiceId, cancelledInvoiceId])).catch(() => undefined)
      await db!.delete(schema.salesInvoices).where(inArray(schema.salesInvoices.id, [invoiceId, cancelledInvoiceId])).catch(() => undefined)
      await db!.delete(schema.salesOrders).where(inArray(schema.salesOrders.id, [orderId])).catch(() => undefined)
      await db!.delete(schema.stockMovements).where(inArray(schema.stockMovements.id, movements.map((m) => m.id))).catch(() => undefined)
      await db!.delete(schema.products).where(inArray(schema.products.id, products.map((p) => p.id))).catch(() => undefined)
      await db!.delete(schema.users).where(inArray(schema.users.id, [userId])).catch(() => undefined)
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
