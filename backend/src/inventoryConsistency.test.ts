import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import http from 'node:http'
import { BACKUP_SCOPES } from './routes/backup'

// Inventory consistency: every stock write goes through applyStockMovement.
//
// This file pins the WRITE PATHS that used to bypass the ledger (CSV/bulk
// import, the Shopify catalog pull, the single-product pull, Products → Add
// Stock), the variant-aware stock count, how history names its variant, and
// the reconciliation report for balances that cannot be explained — including
// the promise that orphaned balances are reported and NEVER modified.
//
// Same scratch-DB contract as stockTransfers.test.ts: skipped without
// DASHBOARD_TEST_DATABASE_URL, and with DASHBOARD_TEST_CREATE=1 the file
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

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function seedHarness(marker: string) {
  process.env.DATABASE_URL = testUrl as string
  await ensureScratchReady()

  const express = (await import('express')).default
  const { db, schema } = await import('./db/client')
  const { dbRouter } = await import('./routes/db')
  const stock = await import('./stock')
  assert.ok(db, 'test database client did initialize')

  const userId = `${marker}-admin`
  const locA = `${marker}-loc-a`
  const locB = `${marker}-loc-b`

  await db.insert(schema.users).values({
    id: userId,
    name: 'Inventory Consistency Admin',
    email: `${marker}@test.local`,
    role: 'Super Admin',
    status: 'active',
  })
  await db.insert(schema.inventoryLocations).values([
    { id: locA, name: `${marker} Store`, type: 'store', city: 'Salem' },
    { id: locB, name: `${marker} Godown`, type: 'warehouse', city: 'Salem' },
  ])

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = userId
    next()
  })
  app.use(dbRouter)
  const server = app.listen(0)
  const port = Number((server.address() as { port: number }).port)

  const req = (method: string, path: string, payload?: unknown): Promise<HttpResult> =>
    new Promise((resolve, reject) => {
      const data = payload === undefined ? null : JSON.stringify(payload)
      const request = http.request(
        { host: '127.0.0.1', port, path, method, agent: false, headers: data ? { 'Content-Type': 'application/json' } : {} },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(body || '{}') as Record<string, unknown> })
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

  /** Balance of one bucket: variant, unattributed (null) or the whole product. */
  const bucket = async (productId: string, variantId: string | null, locationId?: string): Promise<number> => {
    const filters = [eq(schema.stockLevels.productId, productId)]
    if (variantId === null && variantId !== undefined) filters.push(isNull(schema.stockLevels.variantId))
    else if (variantId) filters.push(eq(schema.stockLevels.variantId, variantId))
    if (locationId) filters.push(eq(schema.stockLevels.locationId, locationId))
    const [row] = await db
      .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
      .from(schema.stockLevels)
      .where(and(...filters))
    return Number(row?.qty ?? 0)
  }

  /** What the product holds AT one location, across every variant. */
  const atLocation = async (productId: string, locationId: string): Promise<number> => {
    const [row] = await db
      .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
      .from(schema.stockLevels)
      .where(and(eq(schema.stockLevels.productId, productId), eq(schema.stockLevels.locationId, locationId)))
    return Number(row?.qty ?? 0)
  }

  /** products.stock (the rollup) and what the ledger actually holds. */
  const totals = async (productId: string): Promise<{ rollup: number; ledger: number; attributed: number; unattributed: number }> => {
    const [product] = await db
      .select({ stock: schema.products.stock })
      .from(schema.products)
      .where(eq(schema.products.id, productId))
      .limit(1)
    const rows = await db
      .select({ variantId: schema.stockLevels.variantId, qty: schema.stockLevels.qty })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productId, productId))
    const ledger = rows.reduce((sum, r) => sum + Number(r.qty ?? 0), 0)
    const attributed = rows.filter((r) => r.variantId).reduce((sum, r) => sum + Number(r.qty ?? 0), 0)
    return { rollup: Math.floor(Number(product?.stock ?? 0)), ledger, attributed, unattributed: ledger - attributed }
  }

  /** The invariant §5 asks for, asserted for one product. */
  const assertInvariant = async (productId: string, label: string): Promise<void> => {
    const t = await totals(productId)
    assert.equal(t.rollup, t.ledger, `${label}: products.stock equals its balances`)
    assert.equal(t.ledger, t.attributed + t.unattributed, `${label}: attributed + unattributed equals the ledger`)
    const variants = await db
      .select({ id: schema.productVariants.id, stock: schema.productVariants.stock })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.productId, productId))
    for (const v of variants) {
      const held = await bucket(productId, v.id)
      assert.equal(Number(v.stock ?? 0), held, `${label}: the counter for ${v.id} mirrors its own balances`)
    }
  }

  const cleanup = async (productIds: string[]) => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const quashes = (p: Promise<unknown>) => p.catch(() => undefined)
    if (productIds.length) {
      await quashes(db.delete(schema.stockMovements).where(inArray(schema.stockMovements.productId, productIds)))
      await quashes(db.delete(schema.stockLevels).where(inArray(schema.stockLevels.productId, productIds)))
      await quashes(db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, productIds)))
      await quashes(db.delete(schema.products).where(inArray(schema.products.id, productIds)))
    }
    await quashes(db.delete(schema.users).where(eq(schema.users.id, userId)))
    await quashes(db.delete(schema.inventoryLocations).where(inArray(schema.inventoryLocations.id, [locA, locB])))
  }

  return { db, schema, stock, req, userId, locA, locB, bucket, atLocation, totals, assertInvariant, cleanup }
}

// ─── 1 · CSV / bulk import ──────────────────────────────────────────────────

test(
  'CSV and bulk import reach stock through the ledger, never a column write',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `csvstock-${Date.now()}`
    const h = await seedHarness(marker)
    const { db, schema, stock, req, locA, locB, bucket, totals, assertInvariant, cleanup } = h
    const existingId = `${marker}-existing`
    const createdSku = `${marker}-CSV-NEW`
    const existingSku = `${marker}-CSV-EXISTING`

    try {
      // Existing product holding 8 at the store and 2 at the godown — the
      // import must move only the difference, never rebalance those two.
      await db.insert(schema.products).values({
        id: existingId, name: `${marker} Existing`, sku: existingSku, category: 'Tests', stock: 0,
      })
      await stock.applyStockMovement({ sku: existingSku, qty: 8, type: 'opening', locationId: locA })
      await stock.applyStockMovement({ sku: existingSku, qty: 2, type: 'opening', locationId: locB })
      assert.equal(await bucket(existingId, null, locA), 8)
      assert.equal(await bucket(existingId, null, locB), 2)

      // 1 · a NEW product created by the import, with a stock column.
      const created = await req('POST', '/products/bulk-import', {
        rows: [{ Name: `${marker} New From CSV`, SKU: createdSku, Stock: '5' }],
      })
      assert.equal(created.status, 200, JSON.stringify(created.body))
      assert.equal(created.body.created, 1, JSON.stringify(created.body))
      // The import mints its own id — resolve the row by the SKU it imported.
      const [createdRow] = await db
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(eq(schema.products.sku, createdSku))
        .limit(1)
      assert.ok(createdRow, 'the imported product exists')
      const createdTotals = await totals(createdRow.id)
      assert.equal(createdTotals.ledger, 5, `the CSV quantity arrives as a balance, not a bare column — ${JSON.stringify(created.body)}`)
      assert.equal(createdTotals.rollup, 5, 'and the rollup is recomputed from it')
      const createdRows = await db
        .select({ type: schema.stockMovements.type })
        .from(schema.stockMovements)
        .where(eq(schema.stockMovements.productId, createdRow.id))
      assert.equal(createdRows.length, 1, 'a new product is born inside the ledger with history')
      assert.equal(createdRows[0]?.type, 'opening')
      await assertInvariant(createdRow.id, 'imported product')

      // 2 · an EXISTING product with stock at two locations: target 4 means
      // delta −6, spread across the locations that hold it.
      const updated = await req('POST', '/products/import-csv', {
        csv: `name,sku,stock\n${marker} Existing,${existingSku},4`,
      })
      assert.equal(updated.status, 200, JSON.stringify(updated.body))
      const existingTotals = await totals(existingId)
      assert.equal(existingTotals.ledger, 4, 'the product total lands on the CSV target')
      assert.equal(existingTotals.rollup, 4, 'and the rollup agrees with it')
      assert.ok(
        (await bucket(existingId, null, locA)) >= 0 && (await bucket(existingId, null, locB)) >= 0,
        'no location is driven negative by the reduction',
      )
      assert.equal(
        (await bucket(existingId, null, locA)) + (await bucket(existingId, null, locB)),
        4,
        'both locations still add up to the target',
      )
      await assertInvariant(existingId, 'imported stock update')

      // 3 · a row WITHOUT a stock column leaves stock exactly as it was.
      const before = (await totals(existingId)).ledger
      const noStock = await req('POST', '/products/bulk-import', {
        rows: [{ Name: `${marker} Existing (renamed)`, SKU: existingSku }],
      })
      assert.equal(noStock.status, 200, JSON.stringify(noStock.body))
      assert.equal(noStock.body.updated, 1)
      assert.equal((await totals(existingId)).ledger, before, 'no stock column means stock is untouched')
    } finally {
      // Resolve the import's own id (it is minted server-side) so the row is
      // cleaned up even if an assertion failed before the lookup above.
      const ids = [existingId]
      try {
        const [row] = await db
          .select({ id: schema.products.id })
          .from(schema.products)
          .where(eq(schema.products.sku, createdSku))
          .limit(1)
        if (row) ids.push(row.id)
      } catch { /* nothing to clean beyond the known rows */ }
      await cleanup(ids)
    }
  },
)

// ─── 1 · Shopify pulls ──────────────────────────────────────────────────────

test(
  'the Shopify catalog pull creates a product inside the ledger',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `shoppull-${Date.now()}`
    const h = await seedHarness(marker)
    const { db, schema, bucket, totals, assertInvariant, cleanup } = h
    const { applyLiveCatalog, mergeProductVariantsFromShopify } = await import('./shopify')
    const productSku = `${marker}-SHOP`

    try {
      const live = {
        id: Number(`7${Date.now().toString().slice(-8)}`),
        gid: `gid://shopify/Product/${marker}`,
        title: `${marker} Pulled Ring`,
        handle: productSku.toLowerCase(),
        vendor: 'Mock Vendor',
        productType: 'Rings',
        description: '',
        collection: '',
        chargeOnTax: true,
        status: 'active',
        sku: productSku,
        barcode: null,
        price: '100',
        compareAtPrice: null,
        image: null,
        images: [],
        // The store's numbers: 4 Red + 3 White = 7 across the listing.
        inventoryQuantity: 7,
        inventoryItemId: 7000001,
        variantId: 7100001,
        options: [{ name: 'Colour', values: ['Red', 'White'] }],
        variants: [
          {
            id: 7100001,
            title: 'Red',
            option1: 'Red',
            option2: null,
            option3: null,
            sku: `${marker}-SHOP-RED`,
            barcode: null,
            price: '100',
            compareAtPrice: null,
            inventoryQuantity: 4,
            inventoryItemId: 8000001,
          },
          {
            id: 7100002,
            title: 'White',
            option1: 'White',
            option2: null,
            option3: null,
            sku: `${marker}-SHOP-WHT`,
            barcode: null,
            price: '100',
            compareAtPrice: null,
            inventoryQuantity: 3,
            inventoryItemId: 8000002,
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      await applyLiveCatalog([live], [], 92.8, {
        insert: async (values) => (await db.insert(schema.products).values(values).returning())[0],
        update: async () => undefined,
        saveVariantsMerge: async (productId, options, variants, preserve) => {
          await mergeProductVariantsFromShopify(
            db,
            productId,
            options,
            variants ?? [],
            preserve,
            new Set<string>(),
            new Set<string>(),
          )
        },
      })

      const [product] = await db
        .select({ id: schema.products.id, stock: schema.products.stock })
        .from(schema.products)
        .where(eq(schema.products.sku, productSku))
        .limit(1)
      assert.ok(product, 'the pulled product exists')
      const t = await totals(product.id)
      assert.equal(t.ledger, 7, 'the store quantity becomes a balance, not a column value')
      assert.equal(t.rollup, 7, 'and the rollup is recomputed from those balances')
      assert.equal(t.unattributed, 0, 'the pull attributes it to the variants it recorded')
      assert.equal(await bucket(product.id, null), 0, 'nothing is left unattributed')

      const variants = await db
        .select({ id: schema.productVariants.id, sku: schema.productVariants.sku, stock: schema.productVariants.stock })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.productId, product.id))
      assert.equal(variants.length, 2, 'both listing variants were recorded')
      const bySku = new Map(variants.map((v) => [v.sku, v]))
      assert.equal(await bucket(product.id, bySku.get(`${marker}-SHOP-RED`)!.id), 4, 'Red holds the store’s 4')
      assert.equal(await bucket(product.id, bySku.get(`${marker}-SHOP-WHT`)!.id), 3, 'White holds the store’s 3')

      const movements = await db
        .select({ type: schema.stockMovements.type })
        .from(schema.stockMovements)
        .where(eq(schema.stockMovements.productId, product.id))
      assert.ok(movements.length > 0, 'the pull left history')
      assert.ok(
        movements.every((m) => m.type === 'shopify_sync'),
        'and it is labelled as an inbound pull, which the outbound worker never echoes',
      )
      await assertInvariant(product.id, 'pulled product')
    } finally {
      const [product] = await db
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(eq(schema.products.sku, productSku))
        .limit(1)
      await cleanup(product ? [product.id] : [])
    }
  },
)

test(
  'a Shopify single-product pull moves the difference, not the column',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `shopone-${Date.now()}`
    const h = await seedHarness(marker)
    const { db, schema, stock, locA, locB, bucket, totals, assertInvariant, cleanup } = h
    const sku = `${marker}-ONE`
    const productId = `${marker}-one-product`

    try {
      await db.insert(schema.products).values({
        id: productId, name: `${marker} One`, sku, category: 'Tests', stock: 0,
      })
      await stock.applyStockMovement({ sku, qty: 6, type: 'opening', locationId: locA })
      await stock.applyStockMovement({ sku, qty: 4, type: 'opening', locationId: locB })

      // What the single-product pull does: the store's number is a TARGET
      // reached with a `shopify_sync` movement (the exact call index.ts makes).
      const next = await stock.setStockTotalTo({
        sku,
        target: 13,
        type: 'shopify_sync',
        refType: 'shopify_pull',
        note: 'stock pulled from Shopify (was 10)',
      })
      assert.equal(next, 13, 'the bucket lands on the store’s number')
      const t = await totals(productId)
      assert.equal(t.ledger, 13)
      assert.equal(t.rollup, 13)
      assert.ok(
        (await bucket(productId, null, locA)) >= 0 && (await bucket(productId, null, locB)) >= 0,
        'no location is driven negative by a pull',
      )
      assert.equal(
        (await bucket(productId, null, locA)) + (await bucket(productId, null, locB)),
        13,
        'the existing allocation is kept — only the difference moves',
      )
      const rows = await db
        .select({ type: schema.stockMovements.type })
        .from(schema.stockMovements)
        .where(eq(schema.stockMovements.productId, productId))
      assert.equal(rows.filter((r) => r.type === 'shopify_sync').length, 1, 'the pull is recorded as an inbound pull')
      await assertInvariant(productId, 'single pull')
    } finally {
      await cleanup([productId])
    }
  },
)

// ─── 1 · Products → Add Stock ───────────────────────────────────────────────

test(
  'Add Stock (no location) sets the product total through the ledger',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `addstock-${Date.now()}`
    const h = await seedHarness(marker)
    const { db, schema, stock, req, locA, locB, bucket, atLocation, totals, assertInvariant, cleanup } = h
    const singleId = `${marker}-single`
    const multiId = `${marker}-multi`
    const singleSku = `${marker}-SINGLE`
    const multiSku = `${marker}-MULTI`

    try {
      // Single-variant product: 3 at the store.
      await db.insert(schema.products).values({ id: singleId, name: `${marker} Single`, sku: singleSku, category: 'Tests', stock: 0 })
      await db.insert(schema.productVariants).values({
        id: `${singleId}-v`, productId: singleId, title: 'Default Title', optionValues: ['Default Title'],
        sku: `${singleSku}-V`, stock: 0, status: 'active',
      })
      await stock.applyStockMovement({ sku: singleSku, qty: 3, type: 'opening', locationId: locA })

      const single = await req('PATCH', `/products/${singleId}/stock`, { stock: 10 })
      assert.equal(single.status, 200, JSON.stringify(single.body))
      assert.equal(single.body.scope, 'total', 'no location means the whole product total')
      assert.equal(single.body.locationId, null)
      assert.equal(single.body.previous, 3, 'it reports what the ledger held before')
      assert.equal((await totals(singleId)).ledger, 10, 'the product now holds 10 everywhere')
      assert.equal(await bucket(singleId, `${singleId}-v`, locA), 10, 'the growth joined the stock that was there')
      await assertInvariant(singleId, 'add stock (single variant)')

      // Multi-variant product: Red 4 + White 3 at the store.
      await db.insert(schema.products).values({ id: multiId, name: `${marker} Multi`, sku: multiSku, category: 'Tests', stock: 0 })
      for (const [title, code, qty] of [['Red', 'RED', 4], ['White', 'WHT', 3]] as const) {
        await db.insert(schema.productVariants).values({
          id: `${multiId}-${code}`, productId: multiId, title, optionValues: [title],
          sku: `${multiSku}-${code}`, stock: 0, status: 'active',
        })
        await stock.applyStockMovement({ sku: `${multiSku}-${code}`, qty, type: 'opening', locationId: locA })
      }
      assert.equal((await totals(multiId)).ledger, 7)

      const up = await req('PATCH', `/products/${multiId}/stock`, { stock: 15 })
      assert.equal(up.status, 200, JSON.stringify(up.body))
      assert.equal((await totals(multiId)).ledger, 15, 'the total reaches the target')
      assert.equal(
        (await atLocation(multiId, locA)) + (await atLocation(multiId, locB)),
        15,
        'across both locations',
      )
      await assertInvariant(multiId, 'add stock (multi variant, up)')

      // A reduction must not leave a location negative.
      const down = await req('PATCH', `/products/${multiId}/stock`, { stock: 2 })
      assert.equal(down.status, 200, JSON.stringify(down.body))
      assert.equal((await totals(multiId)).ledger, 2, 'the total comes back down to the target')
      assert.ok(
        (await atLocation(multiId, locA)) >= 0 && (await atLocation(multiId, locB)) >= 0,
        'no location is driven negative',
      )
      await assertInvariant(multiId, 'add stock (multi variant, down)')

      // A location given still means ONE bucket (the product dialog's shape).
      const atStore = await req('PATCH', `/products/${multiId}/stock`, { stock: 5, locationId: locA })
      assert.equal(atStore.status, 200, JSON.stringify(atStore.body))
      assert.equal(await atLocation(multiId, locA), 5, 'only the named location moved')
      await assertInvariant(multiId, 'add stock (at one location)')
    } finally {
      await cleanup([singleId, multiId])
    }
  },
)

// ─── 2 · variant-aware stock count + scan ───────────────────────────────────

test(
  'stock counts name their variant, and scanning a variant label resolves it',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `countvar-${Date.now()}`
    const h = await seedHarness(marker)
    const { db, schema, stock, req, locA, bucket, assertInvariant, cleanup } = h
    const productId = `${marker}-prod`
    const productSku = `${marker}-SKU`
    const redId = `${marker}-red`
    const whiteId = `${marker}-white`
    const redSku = `${marker}-RED`
    const whiteSku = `${marker}-WHT`

    try {
      await db.insert(schema.products).values({ id: productId, name: `${marker} Counted`, sku: productSku, category: 'Tests', stock: 0 })
      for (const [title, id, sku, qty] of [['Red', redId, redSku, 4], ['White', whiteId, whiteSku, 3]] as const) {
        await db.insert(schema.productVariants).values({
          id, productId, title, optionValues: [title], sku, stock: 0, status: 'active',
        })
        await stock.applyStockMovement({ sku, qty, type: 'opening', locationId: locA })
      }

      // Scanning a VARIANT label resolves that variant (it used to 404) …
      const variantScan = await req('GET', `/products/scan?code=${encodeURIComponent(whiteSku)}`)
      assert.equal(variantScan.status, 200, JSON.stringify(variantScan.body))
      assert.equal((variantScan.body.data as Record<string, unknown>).variantId, whiteId)
      assert.equal((variantScan.body.data as Record<string, unknown>).variantTitle, 'White')
      // … while a PRODUCT label stays product-level (the caller expands it).
      const productScan = await req('GET', `/products/scan?code=${encodeURIComponent(productSku)}`)
      assert.equal(productScan.status, 200, JSON.stringify(productScan.body))
      assert.equal((productScan.body.data as Record<string, unknown>).variantId, null)

      // A counted VARIANT moves only that variant.
      const variantCount = await req('POST', '/inventory/stock-count', {
        counts: [{ id: productId, counted: 9, variantId: whiteId }],
        mode: 'set',
        locationId: locA,
      })
      assert.equal(variantCount.status, 200, JSON.stringify(variantCount.body))
      assert.equal(variantCount.body.applied, 1, JSON.stringify(variantCount.body))
      assert.equal(await bucket(productId, whiteId, locA), 9, 'the counted variant reads what was counted')
      assert.equal(await bucket(productId, redId, locA), 4, 'the other variant is untouched')
      assert.equal((await h.totals(productId)).ledger, 13, 'the product total follows')
      await assertInvariant(productId, 'variant count')

      // A product-level count still works and keeps every variant consistent.
      const productCount = await req('POST', '/inventory/stock-count', {
        counts: [{ id: productId, counted: 6 }],
        mode: 'set',
        locationId: locA,
      })
      assert.equal(productCount.status, 200, JSON.stringify(productCount.body))
      assert.equal((await h.totals(productId)).ledger, 6, 'the product total is what was counted')
      const [red, white] = await Promise.all([
        bucket(productId, redId, locA),
        bucket(productId, whiteId, locA),
      ])
      assert.ok(red >= 0 && white >= 0, 'the split never drives a variant negative')
      assert.equal(red + white, 6, 'and the parts still add up')
      await assertInvariant(productId, 'product-level count')
    } finally {
      await cleanup([productId])
    }
  },
)

// ─── 3 · history names its variant ──────────────────────────────────────────

test(
  'movement history names the variant and flags what cannot be named',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `history-${Date.now()}`
    const h = await seedHarness(marker)
    const { db, schema, stock, req, locA, cleanup } = h
    const productId = `${marker}-prod`
    const productSku = `${marker}-SKU`
    const redId = `${marker}-red`
    const redSku = `${marker}-RED`
    const ghostMovementId = `${marker}-legacy-movement`

    try {
      await db.insert(schema.products).values({ id: productId, name: `${marker} History`, sku: productSku, category: 'Tests', stock: 0 })
      for (const [title, id, sku] of [['Red', redId, redSku], ['White', `${marker}-white`, `${marker}-WHT`]] as const) {
        await db.insert(schema.productVariants).values({
          id, productId, title, optionValues: [title], sku, stock: 0, status: 'active',
        })
      }
      await stock.applyStockMovement({ sku: redSku, qty: 5, type: 'opening', locationId: locA })

      // A genuinely unattributed legacy row: written before variants existed.
      await db.insert(schema.stockMovements).values({
        id: ghostMovementId,
        productId,
        variantId: null,
        sku: productSku,
        locationId: locA,
        type: 'count_adjust',
        qty: 1,
        stockAfter: 6,
        note: 'legacy row',
        date: new Date().toISOString(),
      })

      const res = await req('GET', `/inventory/movements?sku=${encodeURIComponent(productSku)}`)
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const rows = res.body as unknown as Array<{
        id: string
        variantTitle: string | null
        variantSku: string | null
        unattributed: boolean
      }>
      const named = rows.find((r) => r.id !== ghostMovementId)
      assert.ok(named, 'the real movement is on the page')
      assert.equal(named?.variantTitle, 'Red', 'the variant is named')
      assert.equal(named?.variantSku, redSku, 'with its SKU')

      const legacy = rows.find((r) => r.id === ghostMovementId)
      assert.ok(legacy, 'the legacy row is still reported')
      assert.equal(legacy?.variantTitle, null, 'its variant is NOT guessed')
      assert.equal(legacy?.variantSku, null)
      assert.equal(legacy?.unattributed, true, 'it is clearly flagged as unattributed')
    } finally {
      await cleanup([productId])
    }
  },
)

// ─── 4 · unattributed / orphaned reconciliation ─────────────────────────────

test(
  'unattributed balances are reported and only attributed on confirmation; orphans are never touched',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `anomaly-${Date.now()}`
    const h = await seedHarness(marker)
    const { db, schema, req, locA, bucket, totals, assertInvariant, cleanup } = h
    const productId = `${marker}-prod`
    const productSku = `${marker}-SKU`
    const redId = `${marker}-red`
    const ghostId = `${marker}-ghost-product`
    const ghostMovementId = `${marker}-ghost-movement`
    const attributePath = '/inventory/stock-anomalies/attribute'

    try {
      await db.insert(schema.products).values({ id: productId, name: `${marker} Unattributed`, sku: productSku, category: 'Tests', stock: 7 })
      await db.insert(schema.productVariants).values([
        { id: redId, productId, title: 'Red', optionValues: ['Red'], sku: `${productSku}-RED`, stock: 0, status: 'active' },
        { id: `${marker}-white`, productId, title: 'White', optionValues: ['White'], sku: `${productSku}-WHT`, stock: 0, status: 'active' },
      ])
      // 7 pcs nobody has claimed a variant for (a legacy product-level row).
      await db.insert(schema.stockLevels).values({ productId, variantId: null, locationId: locA, qty: 7 })
      // An orphan: a balance whose product row is gone. Preserved as evidence.
      await db.insert(schema.stockLevels).values({ productId: ghostId, variantId: null, locationId: locA, qty: 8 })
      await db.insert(schema.stockMovements).values({
        id: ghostMovementId,
        productId: ghostId,
        sku: `${marker}-GHOST`,
        locationId: locA,
        type: 'count_adjust',
        qty: 8,
        stockAfter: 8,
        date: new Date().toISOString(),
      })

      const before = await req('GET', '/inventory/stock-anomalies')
      assert.equal(before.status, 200, JSON.stringify(before.body))
      const report = before.body as {
        unattributed: Array<{ productId: string; qty: number; variants: Array<{ id: string }> }>
        orphaned: Array<{ productId: string; qty: number; movements: number }>
        consistency: { mismatches: Array<{ productId: string; kind: string }> }
        totals: { unattributedUnits: number; orphanedUnits: number; ledgerUnits: number }
      }
      const mine = report.unattributed.find((r) => r.productId === productId)
      assert.ok(mine, 'the unattributed balance is reported separately from attributed ones')
      assert.equal(mine?.qty, 7)
      assert.equal(mine?.variants.length, 2, 'and it lists the variants that could claim it')
      const myOrphan = report.orphaned.find((r) => r.productId === ghostId)
      assert.ok(myOrphan, 'the orphaned balance is reported')
      assert.equal(myOrphan?.qty, 8)
      assert.equal(myOrphan?.movements, 1, 'with the history that still references it')
      assert.equal(
        report.consistency.mismatches.filter((m) => m.productId === productId).length,
        0,
        'the product itself is internally consistent (7 = 0 attributed + 7 unattributed)',
      )
      assert.equal((await totals(productId)).ledger, 7, 'nothing has moved yet')

      // Confirmation is required — an unconfirmed call changes nothing.
      const unconfirmed = await req('POST', attributePath, {
        productId, locationId: locA, variantId: redId,
      })
      assert.equal(unconfirmed.status, 400, JSON.stringify(unconfirmed.body))
      assert.match(String(unconfirmed.body.error), /confirm/i)
      assert.equal(await bucket(productId, null, locA), 7, 'still unattributed')

      // A variant of ANOTHER product is refused.
      const wrongVariant = await req('POST', attributePath, {
        productId, locationId: locA, variantId: `${marker}-not-a-variant`, confirm: true,
      })
      assert.equal(wrongVariant.status, 400, JSON.stringify(wrongVariant.body))

      // Confirmed: the whole balance becomes that variant's — nothing created,
      // nothing deleted, no quantity changed.
      const attributed = await req('POST', attributePath, {
        productId, locationId: locA, variantId: redId, confirm: true,
      })
      assert.equal(attributed.status, 200, JSON.stringify(attributed.body))
      assert.equal(attributed.body.qty, 7)
      assert.equal(await bucket(productId, redId, locA), 7, 'Red now holds it')
      assert.equal(await bucket(productId, null, locA), 0, 'and nothing is unattributed there any more')
      const t = await totals(productId)
      assert.equal(t.ledger, 7, 'the product still holds exactly 7 — attribution moves no quantity')
      assert.equal(t.rollup, 7, 'the rollup is untouched')
      await assertInvariant(productId, 'after attribution')

      const after = await req('GET', '/inventory/stock-anomalies')
      const afterReport = after.body as typeof report
      assert.equal(
        afterReport.unattributed.filter((r) => r.productId === productId).length,
        0,
        'the entry is gone from the report',
      )
      assert.ok(
        afterReport.orphaned.some((r) => r.productId === ghostId && r.qty === 8),
        'the orphan is still reported, exactly as it was',
      )

      // Repeated migration runs are safe around both: the orphan survives
      // untouched and the attributed balance does not move again.
      const pool = (await import('postgres')).default
      const sqlClient = pool(testUrl!, { max: 1 })
      try {
        const { attributeLegacyVariantStock } = await import('./db/variantStockBackfill')
        await attributeLegacyVariantStock(sqlClient)
        await attributeLegacyVariantStock(sqlClient)
      } finally {
        await sqlClient.end({ timeout: 5 }).catch(() => undefined)
      }
      const [ghostRow] = await db
        .select({ qty: schema.stockLevels.qty })
        .from(schema.stockLevels)
        .where(eq(schema.stockLevels.productId, ghostId))
      assert.equal(Number(ghostRow?.qty ?? 0), 8, 'the orphaned balance survives two migration runs untouched')
      assert.equal(await bucket(productId, redId, locA), 7, 'and the attributed balance did not move')
      assert.equal((await totals(productId)).ledger, 7, 'product total unchanged')

      const [ghostMovement] = await db
        .select({ id: schema.stockMovements.id })
        .from(schema.stockMovements)
        .where(eq(schema.stockMovements.id, ghostMovementId))
      assert.ok(ghostMovement, 'the orphan’s history is preserved too')
    } finally {
      await db.delete(schema.stockMovements).where(eq(schema.stockMovements.productId, ghostId)).catch(() => undefined)
      await db.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, ghostId)).catch(() => undefined)
      await cleanup([productId])
    }
  },
)

// ─── 5 · the consistency check itself ───────────────────────────────────────

test(
  'the consistency check finds drift and the ledger heals it',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `drift-${Date.now()}`
    const h = await seedHarness(marker)
    const { db, schema, stock, req, locA, totals, assertInvariant, cleanup } = h
    const productId = `${marker}-prod`
    const productSku = `${marker}-SKU`

    try {
      await db.insert(schema.products).values({ id: productId, name: `${marker} Drift`, sku: productSku, category: 'Tests', stock: 0 })
      await db.insert(schema.productVariants).values({
        id: `${productId}-v`, productId, title: 'Default Title', optionValues: ['Default Title'],
        sku: `${productSku}-V`, stock: 0, status: 'active',
      })
      await stock.applyStockMovement({ sku: productSku, qty: 5, type: 'opening', locationId: locA })
      await assertInvariant(productId, 'before drift')

      // Simulate a bypass that wrote the column directly (what the imports used
      // to do) — the report must catch it rather than trusting the rollup.
      await db.update(schema.products).set({ stock: 99 }).where(eq(schema.products.id, productId))
      const drifted = await req('GET', '/inventory/stock-anomalies')
      const driftReport = drifted.body as {
        consistency: { ok: boolean; mismatches: Array<{ productId: string; kind: string; productStock?: number; ledgerTotal: number }> }
      }
      const mine = driftReport.consistency.mismatches.find((m) => m.productId === productId)
      assert.ok(mine, 'the drift is reported')
      assert.equal(mine?.kind, 'rollup')
      assert.equal(mine?.productStock, 99)
      assert.equal(mine?.ledgerTotal, 5)

      // Healing goes through the ledger (the endpoint's total mode).
      const healed = await req('PATCH', `/products/${productId}/stock`, { stock: 5 })
      assert.equal(healed.status, 200, JSON.stringify(healed.body))
      assert.equal((await totals(productId)).rollup, 5, 'the rollup agrees with the ledger again')
      const clean = await req('GET', '/inventory/stock-anomalies')
      const cleanReport = clean.body as typeof driftReport
      assert.equal(
        cleanReport.consistency.mismatches.filter((m) => m.productId === productId).length,
        0,
        'and the report says so',
      )
      await assertInvariant(productId, 'after healing')
    } finally {
      await cleanup([productId])
    }
  },
)

// ─── 1 · backup scopes carry the ledger ─────────────────────────────────────

test('every backup scope that restores products also restores its stock ledger', () => {
  // Pure guard on the scope definitions: a restore that brings back
  // products.stock without stock_levels/stock_movements leaves balances only a
  // column can explain — and (worse) a restore into a database that still has
  // its ledger would silently disagree with it. Both directions are covered by
  // keeping the ledger in the same scope as the products.
  const ledgerTables = ['stock_levels', 'stock_movements']
  const scopesWithProducts = BACKUP_SCOPES.filter((s) => s.tables.includes('products'))
  assert.ok(scopesWithProducts.length >= 3, 'several scopes restore products')
  for (const scope of scopesWithProducts) {
    for (const table of ledgerTables) {
      assert.ok(
        scope.tables.includes(table),
        `scope "${scope.key}" restores products but not ${table} — a restored product would have stock no ledger explains`,
      )
    }
  }
  // The restore path also needs to know a table whose identity is NOT `id`
  // (stock_levels) so a restore replaces balances instead of stacking on them.
  assert.ok(BACKUP_SCOPES.some((s) => s.tables.includes('stock_levels')))
})
