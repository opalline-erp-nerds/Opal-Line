// ERP is the source of truth for the product catalogue.
//
// Every regression in this file is a real incident shape: an inbound sync
// moved Shopify's copy of a product over the ERP row, so the next push
// exported the store's own stale value back and the edit was gone. The
// contract enforced here is one-directional per domain:
//
//   catalogue (ERP -> Shopify): name, description, SKU/variant mapping, price,
//                               compare-at, stock, images, product type, tags,
//                               collection membership
//   orders     (Shopify -> ERP): orders, their line items, the customer on the
//                               order, fulfilment and tracking
//
// Same scratch-DB convention as shopifyOutbound.test.ts: skipped without
// DATABASE_URL, never touches a real catalog, and never talks to a real store
// (the fetch mock refuses any host that is not its own).
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_erp_authority_test'
const MOCK_HOST = 'mock-erp-authority.myshopify.com'

// CI sets REQUIRE_DB_TESTS=1 on the dedicated step: a runner that lost its
// database must fail loudly rather than report green on a suite that never
// executed (same guard as shopifyOutbound.test.ts).
if (process.env.REQUIRE_DB_TESTS === '1' && !baseDbUrl) {
  throw new Error('REQUIRE_DB_TESTS=1 but DATABASE_URL is not set — the ERP-authority suite would have been skipped')
}

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

/** The store's copy: deliberately different from the ERP in every owned field. */
function makeShopifyState() {
  const product = {
    id: 9_100_001,
    title: 'Shopify title that must never win',
    handle: 'erp-gold-ring',
    body_html: '<p>Shopify description that must never win</p>',
    vendor: 'Shopify vendor',
    product_type: 'Shopify type',
    tags: 'shopify-only-tag',
    status: 'active',
    options: [] as unknown[],
    images: [] as unknown[],
    variants: [
      {
        id: 9_200_001,
        product_id: 9_100_001,
        title: 'Default Title',
        sku: 'ERP-001',
        price: '3000.00', // ERP says 3500
        compare_at_price: null as string | null,
        inventory_management: 'shopify',
        taxable: true,
        inventory_item_id: 9_300_001,
        position: 1,
        inventory_quantity: 7, // ERP says 10
      },
    ],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    admin_graphql_api_id: 'gid://shopify/Product/9100001',
  }
  const levels = new Map<number, number>([[9_300_001, 7]])
  const calls: Array<{ method: string; path: string; body: any }> = []
  let failProductPut = 0 // >0 -> the next product PUT answers 500, then clears

  const orders = [
    {
      id: 7_700_001,
      name: '#1001',
      email: 'asha@example.com',
      created_at: '2026-01-05T10:00:00Z',
      updated_at: '2026-01-05T10:00:00Z',
      processed_at: '2026-01-05T10:00:00Z',
      financial_status: 'paid',
      fulfillment_status: null,
      currency: 'INR',
      total_price: '3500.00',
      subtotal_price: '3500.00',
      total_discount: '0.00',
      total_tax: '0.00',
      total_price_usd: '42.00',
      note: '',
      tags: '',
      note_attributes: [],
      discount_codes: [],
      payment_gateway_names: ['shopify_payments'],
      refunds: [],
      cancel_reason: null,
      closed_at: null,
      confirmed: true,
      landing_site: null,
      referring_site: null,
      source_name: 'web',
      customer: { id: 5_500_001, first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com', orders_count: 1, total_spent: '3500.00' },
      billing_address: {
        first_name: 'Asha',
        last_name: 'Rao',
        address1: '1 Main Street',
        address2: '',
        city: 'Bengaluru',
        province: 'Karnataka',
        zip: '560001',
        country: 'India',
        phone: '9999999999',
      },
      shipping_address: {
        first_name: 'Asha',
        last_name: 'Rao',
        address1: '1 Main Street',
        address2: '',
        city: 'Bengaluru',
        province: 'Karnataka',
        zip: '560001',
        country: 'India',
        phone: '9999999999',
      },
      line_items: [
        {
          id: 7_800_001,
          product_id: 9_100_001,
          variant_id: 9_200_001,
          title: 'Shopify title that must never win',
          sku: 'ERP-001',
          variant_title: null,
          quantity: 1,
          price: '3500.00',
          grams: 0,
          fulfillment_status: null,
          taxable: true,
          requires_shipping: true,
          gift_card: false,
        },
      ],
    },
  ]

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const serializeProduct = () => ({
    ...product,
    variants: product.variants.map((v) => ({ ...v, inventory_quantity: levels.get(v.inventory_item_id) ?? 0 })),
  })

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== MOCK_HOST) {
      throw new Error(`mock Shopify fetch: unexpected host "${url.hostname}" (network access in tests is forbidden)`)
    }
    const match = url.pathname.match(/^\/admin\/api\/[^/]+\/(.+)\.json$/)
    if (!match) return json(404, { errors: `mock: unhandled path ${url.pathname}` })
    const path = match[1]
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path, body })

    if (path === 'products' && method === 'GET') return json(200, { products: [serializeProduct()] })
    if (path === `products/${product.id}` && method === 'GET') return json(200, { product: serializeProduct() })
    if (path === 'custom_collections' && method === 'GET') return json(200, { custom_collections: [] })
    if (path === 'smart_collections' && method === 'GET') return json(200, { smart_collections: [] })
    if (path === 'collects' && method === 'GET') return json(200, { collects: [] })
    if (path === 'orders' && method === 'GET') return json(200, { orders })
    if (path === 'customers' && method === 'GET') return json(200, { customers: [] })

    if (path === `products/${product.id}` && method === 'PUT') {
      if (failProductPut > 0) {
        failProductPut--
        return json(500, { errors: 'Internal Server Error' })
      }
      const input2 = body?.product ?? {}
      if (typeof input2.title === 'string') product.title = input2.title
      if (typeof input2.body_html === 'string') product.body_html = input2.body_html
      if (typeof input2.vendor === 'string') product.vendor = input2.vendor
      if (typeof input2.product_type === 'string') product.product_type = input2.product_type
      product.updated_at = new Date().toISOString()
      return json(200, { product: serializeProduct() })
    }
    if (path === `variants/${product.variants[0].id}` && method === 'PUT') {
      const input2 = body?.variant ?? {}
      if (input2.price != null) product.variants[0].price = String(input2.price)
      if (input2.compare_at_price != null) product.variants[0].compare_at_price = String(input2.compare_at_price)
      return json(200, { variant: { ...product.variants[0], inventory_quantity: levels.get(9_300_001) ?? 0 } })
    }
    if (path === 'locations' && method === 'GET') return json(200, { locations: [{ id: 1, name: 'Main Store' }] })
    if (path === 'inventory_levels' && method === 'GET') {
      return json(200, {
        inventory_levels: [...levels.entries()].map(([inventory_item_id, available]) => ({
          inventory_item_id,
          location_id: 1,
          available,
        })),
      })
    }
    if (path === `inventory_items/${9_300_001}` && method === 'PUT') return json(200, { inventory_item: { id: 9_300_001, tracked: true } })
    if (path === 'inventory_levels/set' && method === 'POST') {
      const { inventory_item_id, available } = body ?? {}
      levels.set(Number(inventory_item_id), Number(available))
      return json(200, { inventory_level: { inventory_item_id, location_id: 1, available } })
    }

    return json(404, { errors: `mock: no handler for ${method} ${path}` })
  }

  return {
    fetchImpl,
    calls,
    product,
    levels,
    level: () => levels.get(9_300_001) ?? -1,
    failNextProductPut: () => {
      failProductPut = 1
    },
    resetCalls: () => {
      calls.length = 0
    },
  }
}

test(
  'ERP values win the catalogue, Shopify wins the orders',
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
    process.env.SHOPIFY_STORE_URL = `https://${MOCK_HOST}`
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_mock_erp_authority'
    process.env.SHOPIFY_API_VERSION = '2025-10'

    const mock = makeShopifyState()
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fetchImpl

    let rawClient: { end: (opts?: { timeout?: number }) => Promise<void> } | null | undefined
    try {
      const { bootstrapDatabase } = await import('./db/bootstrap')
      const boot = await bootstrapDatabase()
      assert.equal(boot.tablesCreated, true, 'fresh scratch schema must be created')

      const { db, getRawClient, schema: s } = await import('./db/client')
      assert.ok(db, 'scratch database must be connected')
      rawClient = getRawClient()

      const shopify = await import('./shopify')
      const outbound = await import('./shopifyOutbound')

      // The ERP row: every owned field differs from the store on purpose.
      const productId = randomUUID()
      await db.insert(s.products).values({
        id: productId,
        name: 'ERP Gold Ring',
        sku: 'ERP-001',
        category: 'Rings',
        description: 'ERP description',
        vendor: 'ERP Vendor',
        productType: 'Rings',
        purity: 92.5,
        netWeight: 4,
        makingCharge: 300,
        silverRate: 92.8,
        gst: 3,
        stock: 10, // store says 7
        sellingPrice: 3500, // store says 3000
        compareAtPrice: 4200,
        shopifyId: String(mock.product.id),
        shopifyStatus: 'synced',
        status: 'active',
        trackInventory: true,
        chargeOnTax: true,
        image: '/uploads/erp.jpg',
        images: ['/uploads/erp.jpg'],
        createdAt: '2026-01-01',
      })

      const readErp = async () => {
        const [row] = await db.select().from(s.products).where(eq(s.products.id, productId))
        return row
      }

      // ── 1+2+3. An inbound pull never writes the store's copy over the ERP ─
      const pull = await shopify.syncProductsToDb()
      assert.equal(pull.ok, true, `pull failed: ${pull.errors.join('; ')}`)
      const afterPull = await readErp()
      assert.equal(afterPull.name, 'ERP Gold Ring', 'the pull must not import the Shopify title')
      assert.equal(afterPull.description, 'ERP description', 'nor the description')
      assert.equal(afterPull.vendor, 'ERP Vendor', 'nor the vendor')
      assert.equal(Number(afterPull.sellingPrice), 3500, 'nor the price')
      assert.equal(Number(afterPull.stock), 10, 'nor the stock')
      assert.deepEqual(afterPull.images, ['/uploads/erp.jpg'], 'nor the images')
      assert.equal(afterPull.shopifyId, String(mock.product.id), 'the link is still refreshed')
      assert.equal(afterPull.shopifyStatus, 'synced')

      // ── Sync Now pushes the ERP values to the store instead ──────────────
      const queued = await outbound.queueCatalogOutbound(['product', 'price', 'inventory'], 'test sync')
      assert.equal(queued.queued, 1, 'the listed product is queued for push')
      const flushed = await outbound.flushOutboundShopifyJobs()
      assert.equal(flushed.failed, 0, `push failed: ${flushed.failed}`)
      assert.ok(flushed.processed >= 1, 'the queued jobs ran')

      // 1. price: ERP 3500 -> Shopify 3500
      assert.equal(mock.product.variants[0].price, '3500.00', 'the ERP price reaches the store')
      // 2. name: ERP name -> Shopify
      assert.equal(mock.product.title, 'ERP Gold Ring', 'the ERP name reaches the store')
      assert.equal(mock.product.body_html.includes('ERP description'), true, 'the ERP description reaches the store')
      // 3. stock: ERP 10 -> Shopify 10
      assert.equal(mock.level(), 10, 'the ERP stock reaches the store')

      // ── 5. Running the sync repeatedly never reverts anything ────────────
      for (let round = 0; round < 3; round++) {
        const again = await shopify.syncProductsToDb()
        assert.equal(again.ok, true, `repeat pull ${round} failed: ${again.errors.join('; ')}`)
        await outbound.queueCatalogOutbound(['product', 'price', 'inventory'], 'repeat sync')
        await outbound.flushOutboundShopifyJobs()
        const row = await readErp()
        assert.equal(row.name, 'ERP Gold Ring', `round ${round}: the name reverted`)
        assert.equal(Number(row.sellingPrice), 3500, `round ${round}: the price reverted`)
        assert.equal(Number(row.stock), 10, `round ${round}: the stock reverted`)
        assert.equal(mock.product.variants[0].price, '3500.00', `round ${round}: the store price reverted`)
        assert.equal(mock.level(), 10, `round ${round}: the store stock reverted`)
      }

      // ── 7. A failed push leaves ERP values intact and stays retryable ────
      mock.resetCalls()
      await db.update(s.products).set({ name: 'ERP Renamed Ring' }).where(eq(s.products.id, productId))
      await outbound.queueCatalogOutbound(['product'], 'rename after outage')
      mock.failNextProductPut()
      const failed = await outbound.flushOutboundShopifyJobs()
      assert.ok(failed.failed >= 1, 'the outage is reported as a failed job')
      const afterFailure = await readErp()
      assert.equal(afterFailure.name, 'ERP Renamed Ring', 'a failed push never writes anything back into the ERP')
      assert.equal(mock.product.title, 'ERP Gold Ring', 'the store still has the old name after the failed push')
      const [failedJob] = await db
        .select()
        .from(s.shopifySyncJobs)
        .where(eq(s.shopifySyncJobs.kind, 'product'))
      assert.equal(failedJob.status, 'pending', 'the job stays queued for retry')
      assert.ok(Number(failedJob.attempts) >= 1, 'the attempt was counted')
      assert.ok(String(failedJob.lastError ?? '').length > 0, 'the error is kept for the operator')

      // Make it due (what the backoff timer would do) and retry.
      await db
        .update(s.shopifySyncJobs)
        .set({ nextAttemptAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(s.shopifySyncJobs.kind, 'product'))
      const retried = await outbound.flushOutboundShopifyJobs()
      assert.equal(retried.failed, 0, 'the retry succeeds')
      assert.equal(mock.product.title, 'ERP Renamed Ring', 'the retry delivers the ERP value')
      const [settled] = await db.select().from(s.shopifySyncJobs).where(eq(s.shopifySyncJobs.kind, 'product'))
      assert.equal(settled.status, 'done', 'the retried job settles')

      // ── 6. Restarting the worker with pending jobs keeps ERP authority ───
      await db.update(s.products).set({ name: 'ERP After Restart', stock: 12 }).where(eq(s.products.id, productId))
      await outbound.queueCatalogOutbound(['product', 'inventory'], 'queued before restart')
      // Simulate the process dying mid-attempt: the claim is left behind.
      await db
        .update(s.shopifySyncJobs)
        .set({ status: 'running', attempts: 1, updatedAt: new Date().toISOString() })
        .where(eq(s.shopifySyncJobs.kind, 'product'))

      // The inbound pull during the outage still cannot touch the ERP row.
      const midRestart = await shopify.syncProductsToDb()
      assert.equal(midRestart.ok, true, `pull after restart failed: ${midRestart.errors.join('; ')}`)
      const duringOutage = await readErp()
      assert.equal(duringOutage.name, 'ERP After Restart', 'ERP stays authoritative while a job is in flight')
      assert.equal(Number(duringOutage.stock), 12)

      // The restarted worker re-arms the claim and finishes the push.
      const recovered = await outbound.recoverInterruptedOutboundJobs({ staleAfterMs: 0 })
      assert.equal(recovered, 1, 'the interrupted job is processable again')
      const afterRestart = await outbound.flushOutboundShopifyJobs()
      assert.ok(afterRestart.processed >= 1, 'the recovered job ran')
      assert.equal(mock.product.title, 'ERP After Restart', 'the recovered push delivered the ERP value')
      assert.equal(mock.level(), 12, 'the recovered push delivered the ERP stock')
      const finalRow = await readErp()
      assert.equal(finalRow.name, 'ERP After Restart', 'the ERP row is untouched by the recovery')

      // ── 4. Orders still flow the other way: Shopify -> ERP ───────────────
      const imported = await shopify.importShopifyOrders()
      assert.equal(imported.ok, true, `order import failed: ${imported.errors.join('; ')}`)
      assert.equal(imported.imported, 1, 'the new Shopify order was imported')
      const [order] = await db.select().from(s.salesOrders).where(eq(s.salesOrders.shopifyId, '#1001'))
      assert.ok(order, 'the order exists in the ERP')
      assert.equal(Number(order.value), 3500, 'the order total came from Shopify')
      assert.equal(String(order.customer ?? ''), 'Asha Rao', 'the order customer came from Shopify')
      // The catalogue pull that ran above must not have disturbed the ERP row.
      const afterOrder = await readErp()
      assert.equal(afterOrder.name, 'ERP After Restart', 'importing an order never touches the catalogue')
      // An imported sale is an ORDER event, not a catalogue overwrite: it
      // consumes ERP stock exactly once (the insert + FOR UPDATE guard in
      // importShopifyOrders) and never moves the store's level.
      assert.equal(Number(afterOrder.stock), 11, 'the imported sale consumed exactly one unit of ERP stock')
      assert.equal(mock.level(), 12, 'the order import never changes Shopify stock')
      // Re-running the import must not deduct the same sale a second time.
      const reimported = await shopify.importShopifyOrders()
      assert.equal(reimported.imported, 0, 'the order is not imported twice')
      const twice = await readErp()
      assert.equal(Number(twice.stock), 11, 'and the sale is not deducted twice')
      assert.equal(mock.level(), 12, 'and the store level is still untouched')
    } finally {
      globalThis.fetch = originalFetch
      try {
        await rawClient?.end({ timeout: 5 })
      } catch {
        /* pool may already be closed */
      }
      const admin2 = postgres(baseDbUrl, { max: 1 })
      try {
        await admin2.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      } catch {
        /* scratch cleanup is best-effort */
      }
      await admin2.end({ timeout: 5 })
    }
  },
)
