import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'
import http from 'node:http'

// ERP location ↔ Shopify location mapping.
//
// Pins the whole feature against a faithful in-memory Admin API mock:
//   1. mapping configuration — persisted as Shopify's NUMERIC location id,
//      verified against the store (existing locations only), unique per store
//      location, clearable, and unreachable through the generic PATCH;
//   2. location-wise inventory push — each mapped ERP location mirrors ITS OWN
//      per-product balance to its Shopify location; an unmapped location that
//      holds stock produces a clear error + sync log and is never pushed; the
//      global rollup is never written over a store location (no overwrite);
//   3. retry — a failed level set is recorded with retry: true and succeeds on
//      the next run;
//   4. order deduction — a Shopify order deducts from the MAPPED ERP location
//      exactly once (row insert guard), the row records that location for
//      reversals, and a duplicate import/webhook retry deducts nothing more;
//   5. unmapped and pre-ledger order locations fall back to the default store,
//      with a clear sync log for the unmapped case;
//   6. legacy behaviour — with no mappings at all the old first-location push
//      is unchanged.
//
// Same scratch-DB contract as stockTransfers.test.ts: skipped without
// DASHBOARD_TEST_DATABASE_URL; with DASHBOARD_TEST_CREATE=1 this file
// provisions the configured throwaway database itself.
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

const MOCK_HOST = 'mock-location-map.myshopify.com'

interface LevelSetCall {
  inventory_item_id: number
  location_id: number
  available: number
}

/** In-memory Admin API: GraphQL locations, products, orders, level sets. */
function makeMock(skus: [string, string, string]) {
  const calls: Array<{ method: string; path: string; body: any }> = []
  const unmatched: string[] = []
  const levelSets: LevelSetCall[] = []
  let failLevelSets = 0 // >0 → the next N level-set calls answer 500

  const storeLocations = [
    { id: 'gid://shopify/Location/555', name: 'Shop Location' },
    { id: 'gid://shopify/Location/777', name: 'My Custom Location' },
    { id: 'gid://shopify/Location/888', name: 'Chennai Counter' },
  ]

  const mockProduct = (id: number, sku: string, itemId: number) => ({
    id,
    title: `Product ${sku}`,
    handle: `product-${sku.toLowerCase()}`,
    body_html: '',
    vendor: 'Opal Line',
    product_type: '',
    tags: '',
    status: 'active',
    options: [] as unknown[],
    images: [] as unknown[],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    admin_graphql_api_id: `gid://shopify/Product/${id}`,
    variants: [
      {
        id: id + 100_000,
        product_id: id,
        title: 'Default Title',
        option1: null,
        option2: null,
        option3: null,
        sku,
        barcode: null,
        price: '100.00',
        compare_at_price: null,
        inventory_management: 'shopify',
        taxable: true,
        inventory_item_id: itemId,
        position: 1,
        inventory_quantity: 0,
      },
    ],
  })

  const products = [
    mockProduct(71_001, skus[0], 7001),
    mockProduct(71_002, skus[1], 7002),
    mockProduct(71_003, skus[2], 7003),
  ]

  // Orders are swapped in by the test before each import run.
  let orders: any[] = []

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== MOCK_HOST) {
      throw new Error(`mock Shopify fetch: unexpected host "${url.hostname}" (network access in tests is forbidden)`)
    }
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const pathname = url.pathname

    // GraphQL: the locations query behind the mapping UI.
    if (pathname.endsWith('/graphql.json')) {
      calls.push({ method, path: 'graphql', body })
      const query = String(body?.query ?? '')
      if (query.includes('locations(')) {
        return json(200, { data: { locations: { nodes: storeLocations } } })
      }
      return json(200, { data: {} })
    }

    const match = pathname.match(/^\/admin\/api\/[^/]+\/(.+)\.json$/)
    if (!match) {
      unmatched.push(`${method} ${pathname}`)
      return json(404, { errors: `mock: unhandled path ${pathname}` })
    }
    const parts = match[1].split('/')
    calls.push({ method, path: parts.join('/'), body })

    if (parts.length === 1 && parts[0] === 'products' && method === 'GET') {
      return json(200, { products })
    }
    if (parts.length === 1 && parts[0] === 'locations' && method === 'GET') {
      return json(200, { locations: storeLocations.map((l) => ({ id: Number(l.id.split('/').pop()), name: l.name })) })
    }
    if (parts.length === 1 && parts[0] === 'inventory_levels' && method === 'GET') {
      return json(200, { inventory_levels: [] })
    }
    if (parts.length === 2 && parts[0] === 'inventory_levels' && parts[1] === 'set' && method === 'POST') {
      if (failLevelSets > 0) {
        failLevelSets--
        return json(500, { errors: 'mock inventory_levels/set failure' })
      }
      levelSets.push({
        inventory_item_id: Number(body?.inventory_item_id),
        location_id: Number(body?.location_id),
        available: Number(body?.available),
      })
      return json(201, { inventory_level: body })
    }
    if (parts.length === 2 && parts[0] === 'inventory_items' && method === 'PUT') {
      return json(200, { inventory_item: { id: Number(parts[1]), tracked: true } })
    }
    if (parts.length === 1 && parts[0] === 'custom_collections' && method === 'GET') {
      return json(200, { custom_collections: [] })
    }
    if (parts.length === 1 && parts[0] === 'smart_collections' && method === 'GET') {
      return json(200, { smart_collections: [] })
    }
    if (parts.length === 1 && parts[0] === 'collects' && method === 'GET') {
      return json(200, { collects: [] })
    }
    if (parts.length === 1 && parts[0] === 'orders' && method === 'GET') {
      return json(200, { orders })
    }
    if (parts.length === 1 && parts[0] === 'customers' && method === 'GET') {
      return json(200, { customers: [] })
    }

    unmatched.push(`${method} ${parts.join('/')}`)
    return json(404, { errors: `mock: no handler for ${method} ${parts.join('/')}` })
  }

  return {
    fetchImpl,
    calls,
    unmatched,
    levelSets,
    setOrders: (next: any[]) => { orders = next },
    failNextLevelSets: (n: number) => { failLevelSets = n },
  }
}

function restOrder(name: string, sku: string, qty: number, locationId: number | null) {
  return {
    id: Number(name.replace('#', '')),
    name,
    order_number: Number(name.replace('#', '')),
    created_at: '2026-11-17T10:00:00Z',
    financial_status: 'pending',
    fulfillment_status: null,
    total_price: String(qty * 100),
    total_discounts: '0',
    currency: 'INR',
    tags: '',
    fulfillments: [],
    line_items: [
      {
        id: 11,
        title: 'Mapped Ring',
        sku,
        quantity: qty,
        price: '100.00',
        fulfillable_quantity: qty,
        location_id: locationId,
      },
    ],
  }
}

test(
  'location mapping, location-wise push, order deduction and unmapped handling (mock store, scratch DB)',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string
    // Point config at the mock store BEFORE any src module is imported
    // (config caches the shop at first import; backend/.env names the real one).
    process.env.SHOPIFY_STORE_URL = `https://${MOCK_HOST}`
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_mock_location_mapping_test'
    process.env.SHOPIFY_API_VERSION = '2025-10'
    await ensureScratchReady()

    const express = (await import('express')).default
    const { db, schema } = await import('./db/client')
    const { dbRouter } = await import('./routes/db')
    const shopify = await import('./shopify')
    const { applyStockMovement } = await import('./stock')
    assert.ok(db, 'test database client did not initialize')

    const quashes = (p: Promise<unknown>) => p.catch(() => undefined)

    // Self-healing: remove leftovers from any earlier (possibly failed) run
    // before seeding — otherwise a stale mapping on the same store location id
    // makes the unique index refuse the fresh one and the run fails at the
    // first assertion for no visible reason.
    await quashes(db.delete(schema.stockMovements).where(like(schema.stockMovements.sku, 'locmap-%')))
    await quashes(db.delete(schema.stockLevels).where(like(schema.stockLevels.productId, 'locmap-%')))
    await quashes(db.delete(schema.products).where(like(schema.products.id, 'locmap-%')))
    await quashes(db.delete(schema.inventoryLocations).where(like(schema.inventoryLocations.id, 'locmap-%')))
    await quashes(db.delete(schema.users).where(like(schema.users.id, 'locmap-%')))
    await quashes(
      db.update(schema.inventoryLocations)
        .set({ shopifyLocationId: null })
        .where(eq(schema.inventoryLocations.id, 'LOC-DEFAULT')),
    )

    const marker = `locmap-${Date.now()}`
    const userId = `${marker}-admin`
    const skuA = `${marker}-A`
    const skuB = `${marker}-B`
    const skuC = `${marker}-C`
    const skuD = `${marker}-D`

    // ── Seed: users, ERP locations, products, balances ─────────────────────
    await db.insert(schema.users).values({
      id: userId,
      name: 'Location Map Admin',
      email: `${marker}@test.local`,
      role: 'Super Admin',
      status: 'active',
    })
    await db.insert(schema.inventoryLocations).values([
      { id: `${marker}-loc-a`, name: `${marker} Main Store`, type: 'store', city: 'Chennai' },
      { id: `${marker}-loc-b`, name: `${marker} Branch Room`, type: 'warehouse', city: 'Pune' },
      { id: `${marker}-loc-c`, name: `${marker} Unmapped Godown`, type: 'warehouse', city: '' },
    ])
    const [locA, locB, locC] = [`${marker}-loc-a`, `${marker}-loc-b`, `${marker}-loc-c`]

    const listed: Record<string, { id: string; sku: string; stock: number }> = {}
    for (const [n, sku] of [['A', skuA], ['B', skuB], ['C', skuC]] as const) {
      const id = `${marker}-prod-${n}`
      listed[n] = { id, sku, stock: 0 }
      await db.insert(schema.products).values({
        id,
        name: `Mapped Product ${n}`,
        sku,
        category: 'Tests',
        stock: 0,
        status: 'active',
      })
    }
    // D: listed nowhere and never through the ledger (pre-ledger adoption case).
    const prodD = `${marker}-prod-D`
    await db.insert(schema.products).values({
      id: prodD,
      name: 'Pre-ledger Product',
      sku: skuD,
      category: 'Tests',
      stock: 6,
      status: 'active',
    })

    // A holds stock at BOTH mapped locations; C only at the unmapped one;
    // B only at the default store (so it has ledger history).
    await applyStockMovement({ sku: skuA, qty: 7, type: 'opening', locationId: locA })
    await applyStockMovement({ sku: skuA, qty: 3, type: 'opening', locationId: locB })
    await applyStockMovement({ sku: skuC, qty: 5, type: 'opening', locationId: locC })
    await applyStockMovement({ sku: skuB, qty: 6, type: 'opening' })

    let orderRef = ''

    const mock = makeMock([skuA, skuB, skuC])
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fetchImpl

    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = userId
      next()
    })
    app.use(dbRouter)
    const server = app.listen(0)
    const port = Number((server.address() as { port: number }).port)

    interface HttpResult { status: number; body: any }
    // node:http with a one-shot agent rather than fetch: fetch would go
    // through the Shopify mock installed below (and its keep-alive socket
    // trips a libuv teardown assertion on Windows).
    const req = (method: string, path: string, payload?: unknown): Promise<HttpResult> =>
      new Promise((resolve, reject) => {
        const data = payload === undefined ? null : JSON.stringify(payload)
        const request = http.request(
          {
            host: '127.0.0.1',
            port,
            path,
            method,
            agent: false,
            headers: data ? { 'Content-Type': 'application/json' } : {},
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => { body += chunk })
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode ?? 0, body: JSON.parse(body || '{}') as any })
              } catch {
                resolve({ status: res.statusCode ?? 0, body: {} })
              }
            })
          },
        )
        request.on('error', reject)
        if (data) request.write(data)
        request.end()
      })
    const levelsAt = async (productId: string, locationId: string): Promise<number> => {
      const [row] = await db
        .select({ qty: schema.stockLevels.qty })
        .from(schema.stockLevels)
        .where(and(eq(schema.stockLevels.productId, productId), eq(schema.stockLevels.locationId, locationId)))
        .limit(1)
      return Number(row?.qty ?? 0)
    }
    const rollupOf = async (productId: string): Promise<number> => {
      const [row] = await db.select({ stock: schema.products.stock }).from(schema.products).where(eq(schema.products.id, productId)).limit(1)
      return Number(row?.stock ?? 0)
    }
    const saleMovementsFor = async (refId: string) =>
      (await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.refId, refId)))
        .filter((m) => m.type === 'sale_out')

    try {
      // ── 1. Mapping configuration ─────────────────────────────────────────
      const storeList = await req('GET', '/inventory/locations/shopify')
      assert.equal(storeList.status, 200)
      assert.deepEqual(
        storeList.body.locations.map((l: any) => [l.shopifyLocationId, l.name]),
        [
          ['555', 'Shop Location'],
          ['777', 'My Custom Location'],
          ['888', 'Chennai Counter'],
        ],
        'existing store locations arrive via GraphQL, keyed by numeric id',
      )

      const mapA = await req('PATCH', `/inventory/locations/${locA}/shopify-location`, { shopifyLocationId: '555' })
      assert.equal(mapA.status, 200)
      assert.equal(mapA.body.shopifyLocationId, '555', 'the numeric Shopify id is persisted, never the name')
      const mapB = await req('PATCH', `/inventory/locations/${locB}/shopify-location`, { shopifyLocationId: '777' })
      assert.equal(mapB.status, 200)

      // Refusals: junk id, an id the store does not report, a duplicate owner,
      // an unknown ERP location, and the generic PATCH escape hatch.
      const junk = await req('PATCH', `/inventory/locations/${locA}/shopify-location`, { shopifyLocationId: 'abc' })
      assert.equal(junk.status, 400)
      assert.match(String(junk.body.error), /numeric/)
      const ghostStore = await req('PATCH', `/inventory/locations/${locA}/shopify-location`, { shopifyLocationId: '999999' })
      assert.equal(ghostStore.status, 400)
      assert.match(String(ghostStore.body.error), /does not exist/)
      const duplicate = await req('PATCH', `/inventory/locations/${locB}/shopify-location`, { shopifyLocationId: '555' })
      assert.equal(duplicate.status, 400)
      assert.match(String(duplicate.body.error), /already mapped/)
      const unknownErp = await req('PATCH', '/inventory/locations/no-such-location/shopify-location', { shopifyLocationId: '555' })
      assert.equal(unknownErp.status, 404)
      const generic = await req('PATCH', `/inventory/locations/${locA}`, { shopifyLocationId: '777' })
      assert.equal(generic.status, 400, 'the generic PATCH refuses unvalidated mappings')
      assert.match(String(generic.body.error), /shopify-location/)

      // Clearing works (clear → re-map), and C stays unmapped below.
      const clearA = await req('PATCH', `/inventory/locations/${locA}/shopify-location`, { shopifyLocationId: null })
      assert.equal(clearA.status, 200)
      assert.equal(clearA.body.shopifyLocationId, null)
      const remapA = await req('PATCH', `/inventory/locations/${locA}/shopify-location`, { shopifyLocationId: '555' })
      assert.equal(remapA.status, 200)
      assert.equal(remapA.body.shopifyLocationId, '555')
      // The seeded default store maps too, so the only unmapped holder of
      // stock below is the deliberately unmapped godown.
      const mapDefault = await req('PATCH', '/inventory/locations/LOC-DEFAULT/shopify-location', { shopifyLocationId: '888' })
      assert.equal(mapDefault.status, 200)

      // ── 2. Location-wise inventory push ──────────────────────────────────
      const push1 = await shopify.pushInventoryToShopify()
      const sets = mock.levelSets
      const aSets = sets.filter((s) => s.inventory_item_id === 7001)
      assert.deepEqual(
        aSets.map((s) => [s.location_id, s.available]).sort(),
        [[555, 7], [777, 3]],
        `each mapped location receives ITS OWN per-location balance (7 there, 3 here) — push: ${JSON.stringify(push1)}`,
      )
      assert.ok(
        !sets.some((s) => s.inventory_item_id === 7003),
        'stock at the unmapped ERP location is never pushed anywhere',
      )
      assert.deepEqual(
        sets.filter((s) => s.inventory_item_id === 7002).map((s) => [s.location_id, s.available]),
        [[888, 6]],
        'the mapped default store mirrors its own balance (6), not a chain total',
      )
      assert.ok(
        !sets.some((s) => s.available === 10),
        'the chain-wide rollup is never written over a store location',
      )
      assert.ok(
        push1.errors.some((e) => e.includes(`${marker} Unmapped Godown`) && e.includes('not mapped')),
        `a clear unmapped-location error is reported, got: ${push1.errors.join('; ')}`,
      )
      assert.equal(push1.errors.length, 1, 'only the deliberately unmapped location errors')
      const unmappedLog = await db
        .select()
        .from(schema.syncLogs)
        .where(eq(schema.syncLogs.action, 'Stock Update (skipped: unmapped location)'))
      assert.ok(unmappedLog.length >= 1, 'the skipped push is recorded in sync logs')
      assert.equal(unmappedLog[0].status, 'skipped')

      // ── 3. Retry after a failed level set ────────────────────────────────
      const beforeRetry = mock.levelSets.length
      mock.failNextLevelSets(1)
      const pushRetry = await shopify.pushInventoryToShopify()
      assert.ok(pushRetry.errors.some((e) => e.includes('mock inventory_levels/set failure')), 'the failure surfaces')
      const failedLogs = await db
        .select()
        .from(schema.syncLogs)
        .where(and(eq(schema.syncLogs.action, 'Stock Update'), eq(schema.syncLogs.status, 'failed')))
      assert.ok(failedLogs.some((l) => l.retry === true), 'a failed push is marked retryable in sync logs')
      const pushRetryOk = await shopify.pushInventoryToShopify()
      assert.ok(mock.levelSets.length > beforeRetry, 'the next run retries and the level set lands')
      assert.ok(
        !pushRetryOk.errors.some((e) => e.includes('mock inventory_levels/set failure')),
        'the retried push is clean',
      )

      // ── 4. Order deduction at the mapped location, exactly once ──────────
      orderRef = `#${marker.slice(-6)}1`
      mock.setOrders([restOrder(orderRef, skuA, 2, 777)])
      const import1 = await shopify.importShopifyOrders()
      assert.equal(import1.errors.length, 0, import1.errors.join('; '))
      assert.equal(import1.imported, 1, 'the order is imported once')

      const saleRows = await saleMovementsFor(orderRef)
      assert.equal(saleRows.length, 1, 'one sale_out movement for the order')
      assert.equal(saleRows[0].locationId, locB, 'the deduction lands on the MAPPED ERP location (777 → Branch Room)')
      assert.equal(Number(saleRows[0].qty), -2)
      assert.equal(await levelsAt(listed.A.id, locB), 1, '3 at the branch − 2 sold = 1')
      assert.equal(await levelsAt(listed.A.id, locA), 7, 'the other mapped location is untouched')
      assert.equal(await rollupOf(listed.A.id), 8, 'rollup 10 − 2 = 8 — the old arithmetic, now via the ledger')
      const [importedOrder] = await db
        .select({ locationId: schema.salesOrders.locationId })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.shopifyId, orderRef))
        .limit(1)
      assert.equal(importedOrder.locationId, locB, 'the row records the location so reversals follow it')

      // Duplicate delivery (webhook retry / overlapping manual sync): the
      // insert guard sends it down the update path — no second deduction.
      const import2 = await shopify.importShopifyOrders()
      assert.equal(import2.imported, 0, 'the duplicate is not imported again')
      assert.equal((await saleMovementsFor(orderRef)).length, 1, 'still exactly one deduction')
      assert.equal(await levelsAt(listed.A.id, locB), 1, 'the branch balance did not move twice')
      assert.equal(await rollupOf(listed.A.id), 8, 'the rollup did not move twice')

      // ── 5. Unmapped order location + pre-ledger product ──────────────────
      mock.setOrders([restOrder(`#${marker.slice(-6)}2`, skuB, 1, 999)])
      const unmappedRef = `#${marker.slice(-6)}2`
      const import3 = await shopify.importShopifyOrders()
      assert.equal(import3.imported, 1)
      const unmappedSale = await saleMovementsFor(unmappedRef)
      assert.equal(unmappedSale.length, 1)
      assert.equal(unmappedSale[0].locationId, 'LOC-DEFAULT', 'an unmapped store location falls back to the default store')
      assert.equal(await rollupOf(listed.B.id), 5, '6 − 1 = 5')
      const unmappedOrderLog = await db
        .select()
        .from(schema.syncLogs)
        .where(eq(schema.syncLogs.action, 'Order Stock (unmapped Shopify location)'))
      assert.ok(unmappedOrderLog.length >= 1, 'the unmapped order location is logged clearly')

      mock.setOrders([restOrder(`#${marker.slice(-6)}3`, skuD, 2, 777)])
      const preLedgerRef = `#${marker.slice(-6)}3`
      const import4 = await shopify.importShopifyOrders()
      assert.equal(import4.imported, 1)
      const preLedgerSale = await saleMovementsFor(preLedgerRef)
      assert.equal(preLedgerSale.length, 1)
      assert.equal(
        preLedgerSale[0].locationId,
        'LOC-DEFAULT',
        'a pre-ledger product adopts at the default store instead of starting a negative branch balance',
      )
      assert.equal(await rollupOf(prodD), 4, 'adoption 6 − 2 = 4 — the same arithmetic the old rollup write had')
      const [preLedgerOrder] = await db
        .select({ locationId: schema.salesOrders.locationId })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.shopifyId, preLedgerRef))
        .limit(1)
      assert.equal(preLedgerOrder.locationId, null, 'the row records the default store so restores follow it')

      // ── 6. Legacy mode: no mappings → the old first-location push ────────
      await req('PATCH', `/inventory/locations/${locA}/shopify-location`, { shopifyLocationId: null })
      await req('PATCH', `/inventory/locations/${locB}/shopify-location`, { shopifyLocationId: null })
      await req('PATCH', '/inventory/locations/LOC-DEFAULT/shopify-location', { shopifyLocationId: null })
      const beforeLegacy = mock.levelSets.length
      const legacyPush = await shopify.pushInventoryToShopify()
      assert.equal(legacyPush.ok, true, legacyPush.errors.join('; '))
      const legacySets = mock.levelSets.slice(beforeLegacy)
      const legacyFirst = legacySets.find((s) => s.inventory_item_id === 7001)
      assert.ok(legacyFirst, 'the legacy path still pushes the listed products')
      assert.equal(legacyFirst!.location_id, 555, 'legacy installs keep pushing to the first store location')
      assert.equal(
        legacyFirst!.available,
        await rollupOf(listed.A.id),
        'legacy mode pushes the global rollup exactly as before',
      )

      assert.deepEqual(mock.unmatched, [], 'every Admin API endpoint the flows touch is modelled by the mock')
    } finally {
      globalThis.fetch = originalFetch
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const quashes = (p: Promise<unknown>) => p.catch(() => undefined)
      await quashes(db.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, skuA)))
      await quashes(db.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, skuB)))
      await quashes(db.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, skuC)))
      await quashes(db.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, skuD)))
      await quashes(db.delete(schema.stockLevels).where(
        eq(schema.stockLevels.productId, listed.A.id),
      ))
      await quashes(db.delete(schema.stockLevels).where(
        eq(schema.stockLevels.productId, listed.B.id),
      ))
      await quashes(db.delete(schema.stockLevels).where(
        eq(schema.stockLevels.productId, listed.C.id),
      ))
      await quashes(db.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, prodD)))
      for (const sku of [skuA, skuB, skuC, skuD]) {
        await quashes(db.delete(schema.products).where(eq(schema.products.sku, sku)))
      }
      // Order-keyed sync logs carry the order ref, push logs carry the SKU.
      await quashes(db.delete(schema.syncLogs).where(like(schema.syncLogs.shopifyId, `${marker}%`)))
      await quashes(db.delete(schema.syncLogs).where(like(schema.syncLogs.shopifyId, `#${marker.slice(-6)}%`)))
      await quashes(db.delete(schema.salesOrders).where(like(schema.salesOrders.shopifyId, `#${marker.slice(-6)}%`)))
      await quashes(db.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.name, `${marker} Main Store`)))
      await quashes(db.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.name, `${marker} Branch Room`)))
      await quashes(db.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.name, `${marker} Unmapped Godown`)))
      // Never leave the seeded default store mapped — other suites (legacy
      // first-location pushes) would enter mapped mode and fail.
      await quashes(
        db.update(schema.inventoryLocations)
          .set({ shopifyLocationId: null })
          .where(eq(schema.inventoryLocations.id, 'LOC-DEFAULT')),
      )
      await quashes(db.delete(schema.users).where(eq(schema.users.id, userId)))
    }
  },
)
