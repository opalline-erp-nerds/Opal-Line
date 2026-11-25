import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'

// Shopify order ingestion is idempotent across every delivery path.
//
// The webhook, the background order poll and the manual Sync Orders button all
// call `importShopifyOrders`, and Shopify retries deliveries it thinks failed.
// This pins the guarantees the automatic sync relies on:
//   1. the same order imported twice creates ONE sales_orders row, ONE invoice
//      and ONE stock movement;
//   2. a VARIANT line (its SKU lives on product_variants, its Shopify id on
//      shopify_variant_id) deducts that variant's bucket — the old parent-only
//      lookup skipped variant lines entirely;
//   3. a webhook delivery for an already-imported order changes no stock.
//
// Same scratch-DB contract as shopifyLocationMapping.test.ts: skipped without
// DASHBOARD_TEST_DATABASE_URL; with DASHBOARD_TEST_CREATE=1 this file
// provisions the throwaway database itself.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()
const shouldProvision = Boolean(testUrl) && process.env.DASHBOARD_TEST_CREATE === '1'

let provisioning: Promise<void> | null = null
function ensureScratchReady(): Promise<void> {
  provisioning ??= (async () => {
    if (!shouldProvision) return
    const pool = (await import('postgres')).default
    const admin = pool(testUrl!.replace(/\/[^/?]+(\?|$)/, '/postgres$1'), { max: 1 })
    try {
      const dbName = (testUrl as string).match(/\/([^/?]+)(?:[?#]|$)/)?.[1] as string
      const [present] = await admin.unsafe('select 1 from pg_database where datname = $1', [dbName])
      if (!present) await admin.unsafe(`create database "${dbName.replace(/"/g, '""')}"`)
    } finally {
      await admin.end({ timeout: 5 })
    }
    process.env.DATABASE_URL = testUrl
    const { bootstrapDatabase } = await import('./db/bootstrap')
    await bootstrapDatabase()
  })()
  return provisioning
}

const MOCK_HOST = 'mock-order-idem.myshopify.com'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function makeFetch(orders: () => unknown[]) {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
    if (url.hostname !== MOCK_HOST) throw new Error(`mock Shopify fetch: unexpected host "${url.hostname}"`)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push(`${method} ${url.pathname}`)
    if (url.pathname.endsWith('/orders.json')) return json(200, { orders: orders() })
    if (url.pathname.endsWith('/customers.json')) return json(200, { customers: [] })
    return json(404, { errors: `mock: no handler for ${method} ${url.pathname}` })
  }) as typeof fetch
  return { fetchImpl, calls }
}

test(
  'webhook + poll ingestion is idempotent and deducts the variant bucket (mock store, scratch DB)',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string
    // Point config at the mock store BEFORE any src module is imported
    // (config caches the shop at first import; backend/.env names the real one).
    process.env.SHOPIFY_STORE_URL = `https://${MOCK_HOST}`
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_mock_order_idem_test'
    process.env.SHOPIFY_API_VERSION = '2025-10'
    await ensureScratchReady()

    const { db, schema } = await import('./db/client')
    const shopify = await import('./shopify')
    const { applyShopifyOrderPayload } = await import('./shopifyOrderPipeline')
    assert.ok(db, 'test database client did not initialize')

    const marker = `ordidem-${Date.now()}`
    const parentSku = `${marker}-RING`
    const variantSku = `${marker}-RING-RED`
    const otherVariantSku = `${marker}-RING-BLUE`
    const productId = `${marker}-prod`
    const variantId = `${marker}-var`
    const otherVariantId = `${marker}-var-blue`
    const shopifyVariantId = '9001001'
    const orderNumber = Number(Date.now().toString().slice(-6))
    const orderName = `#${orderNumber}`
    // Distinct numeric Shopify id: the importer dedupes on order.id, so reusing
    // the same digits made the blank-SKU fixture collide with the first order.
    const blankSkuOrderName = `#B${orderNumber + 1}`

    const restOrder = (sku: string, qty: number, name = orderName) => {
      const number = Number(name.replace(/\D/g, '')) || Date.now()
      return {
        id: number,
        name,
        order_number: number,
        created_at: '2026-11-25T10:00:00Z',
        financial_status: 'pending',
        fulfillment_status: null,
        total_price: String(qty * 100),
        total_discounts: '0',
        currency: 'INR',
        tags: '',
        fulfillments: [],
        customer: { id: 4242, first_name: 'Idem', last_name: 'Tester', email: `${marker}@test.local` },
        line_items: [
          {
            id: 11,
            title: 'Variant Ring — Red',
            sku,
            variant_id: Number(shopifyVariantId),
            quantity: qty,
            price: '100.00',
            fulfillable_quantity: qty,
            location_id: null,
          },
        ],
      }
    }

    let mockOrders: unknown[] = [restOrder(variantSku, 2)]
    const mock = makeFetch(() => mockOrders)
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fetchImpl

    const quashes = (p: Promise<unknown>) => p.catch(() => undefined)

    // Self-healing: clear leftovers from an earlier failed run.
    await quashes(db.delete(schema.salesInvoices).where(eq(schema.salesInvoices.shopifyOrder, orderName)))
    await quashes(db.delete(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, orderName)))
    await quashes(db.delete(schema.stockMovements).where(eq(schema.stockMovements.refId, orderName)))
    await quashes(db.delete(schema.salesInvoices).where(eq(schema.salesInvoices.shopifyOrder, blankSkuOrderName)))
    await quashes(db.delete(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, blankSkuOrderName)))
    await quashes(db.delete(schema.stockMovements).where(eq(schema.stockMovements.refId, blankSkuOrderName)))
    await quashes(db.delete(schema.stockMovements).where(like(schema.stockMovements.sku, `${marker}%`)))
    await quashes(db.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, productId)))
    await quashes(db.delete(schema.productVariants).where(eq(schema.productVariants.productId, productId)))
    await quashes(db.delete(schema.products).where(eq(schema.products.id, productId)))
    await quashes(db.delete(schema.salesOrders).where(like(schema.salesOrders.shopifyId, orderName)))
    await quashes(db.delete(schema.salesInvoices).where(like(schema.salesInvoices.shopifyOrder, orderName)))

    const rateId = `${marker}-rate`
    await quashes(db.delete(schema.silverRates).where(eq(schema.silverRates.id, rateId)))

    try {
      // Auto-invoicing prices from Silver Rate Management; without a rate it
      // records a sync-log warning instead of raising an invoice.
      await db.insert(schema.silverRates).values({
        id: rateId,
        purity: 92.5,
        rate: 100,
        previousRate: 100,
        updatedAt: new Date().toISOString(),
        currency: 'INR',
        source: 'manual',
      })
      await db.insert(schema.products).values({
        id: productId,
        name: `Idem Ring ${marker}`,
        sku: parentSku,
        category: 'Tests',
        stock: 14,
        status: 'active',
      })
      await db.insert(schema.productVariants).values([
        {
          id: variantId,
          productId,
          title: 'Red',
          optionValues: ['Red'],
          sku: variantSku,
          shopifyVariantId,
          stock: 10,
        },
        {
          id: otherVariantId,
          productId,
          title: 'Blue',
          optionValues: ['Blue'],
          sku: otherVariantSku,
          shopifyVariantId: '9001002',
          stock: 4,
        },
      ])

      // ── 1. First import (the poll's catch-up run) ────────────────────────
      const first = await shopify.importShopifyOrders()
      assert.equal(first.errors.length, 0, first.errors.join('; '))
      assert.equal(first.imported, 1, 'the order is imported once')

      const [row] = await db.select().from(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, orderName))
      assert.ok(row, 'the sales order exists')
      const [variant] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantId))
      assert.equal(variant.stock, 8, 'the VARIANT bucket moved: 10 − 2 (a parent-only lookup skipped this)')
      const [parent] = await db.select().from(schema.products).where(eq(schema.products.id, productId))
      assert.equal(parent.stock, 12, 'the rollup follows the variant')
      const [otherAfterFirst] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, otherVariantId))
      assert.equal(otherAfterFirst.stock, 4, 'the unsold variant is untouched')

      const saleMovements = await db
        .select()
        .from(schema.stockMovements)
        .where(and(eq(schema.stockMovements.refId, orderName), eq(schema.stockMovements.type, 'sale_out')))
      assert.equal(saleMovements.length, 1, 'exactly one sale movement')
      assert.equal(saleMovements[0].variantId, variantId, 'the movement is pinned to the variant')
      assert.equal(saleMovements[0].sku, parentSku, 'the ledger row keeps the parent SKU')

      const invoicesAfterFirst = await db
        .select()
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, orderName))
      assert.equal(invoicesAfterFirst.length, 1, 'one invoice is raised')

      // ── 2. The poll runs again over the same window (overlap) ────────────
      const second = await shopify.importShopifyOrders({ updatedAtMin: new Date(Date.now() - 5 * 60_000).toISOString() })
      assert.equal(second.imported, 0, 'the duplicate is updated, not imported again')
      const [variantAfterPoll] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantId))
      assert.equal(variantAfterPoll.stock, 8, 'no second deduction')
      const saleMovementsAfterPoll = await db
        .select()
        .from(schema.stockMovements)
        .where(and(eq(schema.stockMovements.refId, orderName), eq(schema.stockMovements.type, 'sale_out')))
      assert.equal(saleMovementsAfterPoll.length, 1, 'still exactly one sale movement')

      // ── 3. A webhook delivery for the same, already-known order ──────────
      const applied = await applyShopifyOrderPayload(restOrder(variantSku, 2), { actor: 'shopify' })
      assert.equal(applied.ok, true, applied.error ?? '')
      assert.equal(applied.found, true, 'the pipeline matches the imported order instead of importing it')
      const [variantAfterWebhook] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantId))
      assert.equal(variantAfterWebhook.stock, 8, 'the webhook changed no stock')

      const orders = await db.select().from(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, orderName))
      assert.equal(orders.length, 1, 'one sales order, never two')
      const invoicesAfter = await db
        .select()
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, orderName))
      assert.equal(invoicesAfter.length, 1, 'one invoice, never two')

      // ── 4. Blank Shopify SKU: immutable variant id still resolves the bucket,
      //        and a cancellation after the payload was applied still restocks ──
      mockOrders = [restOrder(variantSku, 2), restOrder('', 3, blankSkuOrderName)]
      const blankImport = await shopify.importShopifyOrders()
      assert.equal(blankImport.errors.length, 0, blankImport.errors.join('; '))
      assert.equal(blankImport.imported, 1, 'the blank-SKU order is imported')
      const [blankRow] = await db.select().from(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, blankSkuOrderName))
      assert.ok(blankRow, 'the blank-SKU order exists')
      const storedLines = blankRow.lineItems as Array<{ sku?: string; shopifyVariantId?: string }> | null
      assert.equal(storedLines?.[0]?.sku, parentSku, 'the resolved parent SKU is stored for later restocks')
      assert.equal(storedLines?.[0]?.shopifyVariantId, shopifyVariantId)
      const [variantAfterBlank] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantId))
      assert.equal(variantAfterBlank.stock, 5, 'a blank SKU still deducts the variant bucket: 8 − 3')
      const [parentAfterBlank] = await db.select().from(schema.products).where(eq(schema.products.id, productId))
      assert.equal(parentAfterBlank.stock, 9, 'the parent rollup follows')
      const blankMovements = await db
        .select()
        .from(schema.stockMovements)
        .where(and(eq(schema.stockMovements.refId, blankSkuOrderName), eq(schema.stockMovements.type, 'sale_out')))
      assert.equal(blankMovements.length, 1, 'one sale movement for the blank-SKU order')
      assert.equal(blankMovements[0].sku, parentSku)
      assert.equal(blankMovements[0].variantId, variantId)

      const cancelledPayload = {
        ...restOrder('', 3, blankSkuOrderName),
        cancelled_at: new Date().toISOString(),
      }
      const cancelledEvent = await applyShopifyOrderPayload(cancelledPayload, { actor: 'shopify' })
      assert.equal(cancelledEvent.ok, true, cancelledEvent.error ?? '')
      assert.ok(cancelledEvent.changed?.includes('cancelled'), 'the payload applied the cancelled state')
      const { cancelLocalOrderOnce } = await import('./shopifyOrderActions')
      const restored = await cancelLocalOrderOnce(blankRow.id)
      assert.equal(restored.itemsRestored, 3, 'the restock runs even though the payload already marked it cancelled')
      const [variantAfterCancel] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantId))
      assert.equal(variantAfterCancel.stock, 8, 'the same variant bucket is restored')
      const [parentAfterCancel] = await db.select().from(schema.products).where(eq(schema.products.id, productId))
      assert.equal(parentAfterCancel.stock, 12, 'the parent rollup is restored')
      const [otherAfterCancel] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, otherVariantId))
      assert.equal(otherAfterCancel.stock, 4, 'the restock returns to the sold variant, not split across variants')
      const replay = await cancelLocalOrderOnce(blankRow.id)
      assert.equal(replay.itemsRestored, 0, 'a second cancellation never restocks twice')
      const [variantAfterReplay] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantId))
      assert.equal(variantAfterReplay.stock, 8)
    } finally {
      globalThis.fetch = originalFetch
      await quashes(db.delete(schema.stockMovements).where(eq(schema.stockMovements.refId, orderName)))
      await quashes(db.delete(schema.salesInvoices).where(eq(schema.salesInvoices.shopifyOrder, blankSkuOrderName)))
      await quashes(db.delete(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, blankSkuOrderName)))
      await quashes(db.delete(schema.stockMovements).where(eq(schema.stockMovements.refId, blankSkuOrderName)))
      await quashes(db.delete(schema.stockMovements).where(like(schema.stockMovements.sku, `${marker}%`)))
      await quashes(db.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, productId)))
      await quashes(db.delete(schema.salesInvoices).where(eq(schema.salesInvoices.shopifyOrder, orderName)))
      await quashes(db.delete(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, orderName)))
      await quashes(db.delete(schema.productVariants).where(eq(schema.productVariants.productId, productId)))
      await quashes(db.delete(schema.products).where(eq(schema.products.id, productId)))
      await quashes(db.delete(schema.silverRates).where(eq(schema.silverRates.id, rateId)))
    }
  },
)
