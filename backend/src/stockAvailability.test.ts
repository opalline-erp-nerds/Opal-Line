import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { eq } from 'drizzle-orm'

// Centralised stock validation for invoice creation.
//
// The rule under test: before an invoice is saved, the WHOLE basket is checked
// against on-hand stock with the products row-locked inside the invoice's own
// transaction. A shortfall must (a) reject with a structured 409, (b) roll the
// transaction back so no invoice row, item or stock movement is written, and
// (c) count duplicate line items of the same SKU together rather than letting
// each line pass on its own.
//
// Availability is the local ledger (products.stock / stock_levels) — the same
// ledger a Shopify pull writes into as a `shopify_sync` movement — so local and
// Shopify-synced stock are never summed twice.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardLowStock.test.ts.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'assertStockAvailable blocks an over-request and counts duplicate lines',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const { db, schema } = await import('./db/client')
    const { assertStockAvailable, applyStockMovement, InsufficientStockError, stockAt } = await import('./stock')
    assert.ok(db, 'test database client did not initialize')

    const marker = `stockchk-${Date.now()}`
    const sku = `${marker}-A`
    const productId = `${marker}-prod`

    try {
      await db!.insert(schema.products).values({ id: productId, name: 'Validated Ring', sku, category: 'Tests' })
      // Seed 5 units through the ledger so stock_levels and products.stock agree.
      await applyStockMovement({ sku, qty: 5, type: 'opening' })
      assert.equal(await stockAt(sku), 5, 'seeded balance is 5')

      // 4 requested against 5 on hand passes and writes nothing.
      await db!.transaction(async (tx) => {
        await assertStockAvailable(tx, [{ sku, qty: 4, name: 'Validated Ring' }])
      })

      // Duplicate lines: 3 + 3 = 6 > 5 must fail as ONE aggregate shortfall.
      await assert.rejects(
        db!.transaction(async (tx) => {
          await assertStockAvailable(tx, [
            { sku, qty: 3, name: 'Validated Ring' },
            { sku, qty: 3, name: 'Validated Ring' },
          ])
        }),
        (err: unknown) => {
          assert.ok(err instanceof InsufficientStockError, 'throws the structured error')
          assert.equal(err.code, 'INSUFFICIENT_STOCK')
          assert.equal(err.products.length, 1, 'aggregated into a single product row')
          assert.equal(err.products[0].available, 5)
          assert.equal(err.products[0].requested, 6, 'duplicate lines summed')
          assert.match(err.message, /Insufficient Stock — Available: 5, Requested: 6\./)
          return true
        },
      )

      // The failed check must not have moved stock.
      assert.equal(await stockAt(sku), 5, 'availability untouched after a blocked check')
    } finally {
      await db!.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, sku)).catch(() => undefined)
      await db!.delete(schema.products).where(eq(schema.products.id, productId)).catch(() => undefined)
    }
  },
)

test(
  'POST /invoices rejects an over-request with 409 and saves nothing',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string
    process.env.LOYALTY_ENABLED = 'false'

    const express = (await import('express')).default
    const { db, schema } = await import('./db/client')
    const { dbRouter } = await import('./routes/db')
    const { applyStockMovement, stockAt } = await import('./stock')
    assert.ok(db, 'test database client did not initialize')

    const marker = `stockinv-${Date.now()}`
    const sku = `${marker}-A`
    const productId = `${marker}-prod`
    const userId = `${marker}-admin`
    const rateId = `${marker}-rate`

    let server: Server | null = null
    try {
      await db!.insert(schema.users).values({
        id: userId,
        name: 'Stock Validator',
        email: `${marker}-tester@test.local`,
        role: 'Super Admin',
        status: 'active',
      })
      await db!.insert(schema.products).values({ id: productId, name: 'Invoice Ring', sku, category: 'Tests' })
      await applyStockMovement({ sku, qty: 2, type: 'opening' })
      // Invoice creation prices from Silver Rate Management: without a current
      // rate the route stops with 400 before it ever validates stock.
      await db!
        .insert(schema.silverRates)
        .values({ id: rateId, rate: 100, purity: 999, updatedAt: new Date().toISOString() })

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as { userId?: string }).userId = userId
        next()
      })
      app.use(dbRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)

      const post = async (path: string, body: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        return { status: res.status, body: (await res.json()) as any }
      }

      const number = `${marker}-INV`
      const body = {
        number,
        customer: 'Test Buyer',
        items: [{ product: 'Invoice Ring', sku, qty: 3, weight: 1, silverRate: 100, makingCharge: 0, amount: 100 }],
      }

      // 3 requested against 2 on hand → blocked.
      const blocked = await post('/invoices', body)
      assert.equal(blocked.status, 409, 'over-request is a conflict')
      assert.equal(blocked.body.code, 'INSUFFICIENT_STOCK')
      assert.equal(blocked.body.products[0].available, 2)
      assert.equal(blocked.body.products[0].requested, 3)

      // Nothing was saved and no stock moved.
      const [saved] = await db!.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.number, number)).limit(1)
      assert.equal(saved, undefined, 'no invoice row written')
      assert.equal(await stockAt(sku), 2, 'no stock deducted')

      // The same basket within stock succeeds and deducts exactly once.
      const ok = await post('/invoices', {
        ...body,
        number: `${number}-OK`,
        items: [{ ...body.items[0], qty: 2 }],
      })
      assert.equal(ok.status, 201, 'a fulfillable invoice is created')
      assert.equal(await stockAt(sku), 0, 'stock deducted exactly once')
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
      await db!.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.sku, sku)).catch(() => undefined)
      await db!.delete(schema.salesInvoices).where(eq(schema.salesInvoices.customer, 'Test Buyer')).catch(() => undefined)
      await db!.delete(schema.products).where(eq(schema.products.id, productId)).catch(() => undefined)
      await db!.delete(schema.silverRates).where(eq(schema.silverRates.id, rateId)).catch(() => undefined)
    }
  },
)

test(
  'concurrent invoices cannot oversell the last unit',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const { db, schema } = await import('./db/client')
    const { applyStockMovement, assertStockAvailable, InsufficientStockError, stockAt } = await import('./stock')
    assert.ok(db, 'test database client did not initialize')

    const marker = `stockconc-${Date.now()}`
    const sku = `${marker}-A`
    const productId = `${marker}-prod`

    try {
      await db!.insert(schema.products).values({ id: productId, name: 'Contended Ring', sku, category: 'Tests' })
      await applyStockMovement({ sku, qty: 1, type: 'opening' })

      // Two transactions race for the single unit. The FOR UPDATE lock on the
      // product serialises them: the first to acquire it sees 1 and proceeds,
      // the second sees 0 and is rejected — never both.
      const race = (delayMs: number) =>
        db!.transaction(async (tx) => {
          await new Promise((r) => setTimeout(r, delayMs))
          await assertStockAvailable(tx, [{ sku, qty: 1, name: 'Contended Ring' }])
          await applyStockMovement({ sku, qty: -1, type: 'sale_out', tx })
          return true
        })

      const results = await Promise.allSettled([race(0), race(1)])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      assert.equal(fulfilled.length, 1, 'exactly one invoice wins the unit')
      assert.equal(rejected.length, 1, 'the other is blocked')
      assert.ok(
        (rejected[0] as PromiseRejectedResult).reason instanceof InsufficientStockError,
        'the loser gets the structured stock error',
      )
      assert.equal(await stockAt(sku), 0, 'stock lands at zero, never negative')
    } finally {
      await db!.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, sku)).catch(() => undefined)
      await db!.delete(schema.products).where(eq(schema.products.id, productId)).catch(() => undefined)
    }
  },
)
