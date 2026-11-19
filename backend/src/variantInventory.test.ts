import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import http from 'node:http'

// Variant-wise, location-wise inventory.
//
// The bug this pins down: stock lived in TWO independent counters —
// stock_levels/products.stock (per location, product-level) and
// product_variants.stock (per variant, global) — updated by different code
// paths with nothing tying a movement to a variant. Real data drifted exactly
// as reported: Red 4 + White 4 = 8 against a product/location total of 7.
//
// A balance is now (product, variant, location) and both counters are mirrors
// of it. Covered here:
//   1. Red and White with different quantities, and product total = Σ variants
//   2. transferring Red without touching White
//   3. a transfer between two locations (dispatch → receive)
//   4. insufficient source stock refused
//   5. a sale of one variant
//   6. a purchase receipt and a stock-count adjustment
//   7. cancellation restoring the same variant
//  10. legacy single-variant products (with and without a variant row)
//  11. the migration that attributes pre-variant balances without changing totals
//
// Duplicate-webhook and multi-location Shopify push live in
// shopifyLocationMapping.test.ts (it owns the Admin API mock) and run with
// this file's suite.
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

interface VariantFixture {
  productId: string
  productSku: string
  variants: Array<{ id: string; sku: string; title: string }>
  locA: string
  locB: string
  userId: string
}

async function seedHarness(marker: string, variantTitles: string[]) {
  process.env.DATABASE_URL = testUrl as string
  await ensureScratchReady()

  const express = (await import('express')).default
  const { db, schema } = await import('./db/client')
  const { dbRouter } = await import('./routes/db')
  const stock = await import('./stock')
  assert.ok(db, 'test database client did initialize')

  const userId = `${marker}-admin`
  const productId = `${marker}-product`
  const productSku = `${marker}-SKU`
  const locA = `${marker}-loc-a`
  const locB = `${marker}-loc-b`

  await db.insert(schema.users).values({
    id: userId,
    name: 'Variant Inventory Admin',
    email: `${marker}@test.local`,
    role: 'Super Admin',
    status: 'active',
  })
  await db.insert(schema.inventoryLocations).values([
    { id: locA, name: `${marker} Store`, type: 'store', city: 'Salem' },
    { id: locB, name: `${marker} Godown`, type: 'warehouse', city: 'Salem' },
  ])
  await db.insert(schema.products).values({
    id: productId,
    name: `${marker} Product`,
    sku: productSku,
    category: 'Tests',
    stock: 0,
  })
  const variants: Array<{ id: string; sku: string; title: string }> = []
  for (const title of variantTitles) {
    const variant = { id: `${marker}-v-${title.toLowerCase()}`, sku: `${marker}-${title.toUpperCase()}`, title }
    variants.push(variant)
    await db.insert(schema.productVariants).values({
      id: variant.id,
      productId,
      title,
      optionValues: [title],
      sku: variant.sku,
      stock: 0,
      status: 'active',
    })
  }

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = userId
    next()
  })
  app.use(dbRouter)
  const server = app.listen(0)
  const port = Number((server.address() as { port: number }).port)

  // node:http with a one-shot agent instead of fetch: fetch's keep-alive socket
  // trips a libuv teardown assertion on Windows when the server closes.
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

  /** Balance of ONE bucket: (product, variant|unattributed, location). */
  const levelOf = async (variantId: string | null, locationId: string): Promise<number> => {
    const where = and(
      eq(schema.stockLevels.productId, productId),
      eq(schema.stockLevels.locationId, locationId),
      variantId ? eq(schema.stockLevels.variantId, variantId) : isNull(schema.stockLevels.variantId),
    )
    const [row] = await db
      .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
      .from(schema.stockLevels)
      .where(where)
    return Number(row?.qty ?? 0)
  }

  const bucketTotal = async (variantId: string | null): Promise<number> => {
    const where = variantId
      ? eq(schema.stockLevels.variantId, variantId)
      : and(eq(schema.stockLevels.productId, productId), isNull(schema.stockLevels.variantId))
    const [row] = await db
      .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
      .from(schema.stockLevels)
      .where(where)
    return Number(row?.qty ?? 0)
  }

  const productBalance = async (): Promise<number> => {
    const [row] = await db
      .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productId, productId))
    return Number(row?.qty ?? 0)
  }

  /**
   * The invariant: products.stock is the rollup of its balances, each variant
   * counter mirrors its own balances, and everything balances to the same
   * total. Returns whatever could NOT be attributed to a variant (0 once the
   * migration has run).
   */
  const assertInvariant = async (): Promise<number> => {
    const total = await productBalance()
    const variantIds = variants.map((v) => v.id)
    const held = variantIds.length
      ? await db
          .select({ id: schema.productVariants.id, stock: schema.productVariants.stock })
          .from(schema.productVariants)
          .where(inArray(schema.productVariants.id, variantIds))
      : []
    const heldSum = held.reduce((sum, v) => sum + Number(v.stock ?? 0), 0)
    const ledgerVariantSum = (await Promise.all(variantIds.map((id) => bucketTotal(id)))).reduce((a, b) => a + b, 0)
    const [product] = await db
      .select({ stock: schema.products.stock })
      .from(schema.products)
      .where(eq(schema.products.id, productId))
      .limit(1)

    assert.equal(Number(product?.stock ?? 0), total, 'products.stock is the rollup of its balances')
    assert.equal(heldSum, ledgerVariantSum, 'product_variants.stock mirrors that variant’s balances')
    // Whatever the variants do not hold is unattributed stock (0 once the
    // migration has had its say) — reported so a caller can assert it away.
    return total - ledgerVariantSum
  }

  const unattributedTotal = async (): Promise<number> => {
    const [row] = await db
      .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
      .from(schema.stockLevels)
      .where(and(eq(schema.stockLevels.productId, productId), isNull(schema.stockLevels.variantId)))
    return Number(row?.qty ?? 0)
  }

  const cleanup = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const quashes = (p: Promise<unknown>) => p.catch(() => undefined)
    await quashes(
      db.delete(schema.stockMovements).where(inArray(schema.stockMovements.productId, [productId])),
    )
    await quashes(db.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, productId)))
    await quashes(db.delete(schema.stockTransfers).where(inArray(schema.stockTransfers.sku, [productSku, ...variants.map((v) => v.sku)])))
    await quashes(db.delete(schema.productVariants).where(eq(schema.productVariants.productId, productId)))
    await quashes(db.delete(schema.products).where(eq(schema.products.id, productId)))
    await quashes(db.delete(schema.inventoryLocations).where(inArray(schema.inventoryLocations.id, [locA, locB])))
    await quashes(db.delete(schema.users).where(eq(schema.users.id, userId)))
  }

  const fixture: VariantFixture = { productId, productSku, variants, locA, locB, userId }
  return { db, schema, stock, req, fixture, levelOf, bucketTotal, productBalance, unattributedTotal, assertInvariant, cleanup }
}

// ─── 1 · 5 · 6 · 10 · 11 ────────────────────────────────────────────────────

test(
  'Red and White keep their own balances; product total equals their sum',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `varinv-${Date.now()}`
    const h = await seedHarness(marker, ['Red', 'White'])
    const { db, schema, stock, fixture, levelOf, assertInvariant, cleanup } = h
    const [red, white] = fixture.variants
    try {
      // Opening stock, counted per variant (different quantities on purpose).
      await stock.applyStockMovement({ sku: red!.sku, qty: 4, type: 'opening', locationId: fixture.locA })
      await stock.applyStockMovement({ sku: white!.sku, qty: 7, type: 'opening', locationId: fixture.locA })

      assert.equal(await levelOf(red!.id, fixture.locA), 4, 'Red holds 4 at the source')
      assert.equal(await levelOf(white!.id, fixture.locA), 7, 'White holds 7 at the source')
      assert.equal(await stock.stockAt(red!.sku, fixture.locA), 4, 'stockAt answers per variant')
      assert.equal(await stock.stockAt(fixture.productSku, fixture.locA), 11, 'the product answers as the sum')
      assert.equal(await assertInvariant(), 0, 'no unattributed remainder — product = Red + White')

      // 5 · A sale of ONE variant: the line names White, only White moves.
      await db.transaction(async (tx) => {
        await stock.deductOrderLineStock({ tx, locationId: fixture.locA, sku: white!.sku, qty: 2 })
      })
      assert.equal(await levelOf(white!.id, fixture.locA), 5, 'the sold variant went down')
      assert.equal(await levelOf(red!.id, fixture.locA), 4, 'the other variant is untouched')
      assert.equal(await assertInvariant(), 0)

      // …and it refuses to oversell that same variant.
      await assert.rejects(
        () => db.transaction((tx) => stock.deductOrderLineStock({ tx, locationId: fixture.locA, sku: red!.sku, qty: 5 })),
        /Insufficient stock for SKU/,
        'availability is checked against the variant, not the product total',
      )
      // A cancellation/restock puts the same variant back.
      await db.transaction(async (tx) => {
        await stock.restoreOrderLineStock({ tx, locationId: fixture.locA, sku: white!.sku, qty: 1 })
      })
      assert.equal(await levelOf(white!.id, fixture.locA), 6)

      // 6 · A purchase receipt lands on the variant it was booked against.
      const purchased = await applyPurchaseStockSafe(red!.sku, 5, fixture.locA)
      assert.equal(purchased, true)
      assert.equal(await levelOf(red!.id, fixture.locA), 9, 'the purchased variant grew')
      assert.equal(await levelOf(white!.id, fixture.locA), 6, 'White is unaffected by Red’s receipt')
      assert.equal(await assertInvariant(), 0)

      // 6 · A stock-count adjustment against one variant.
      const count = await h.req('POST', '/inventory/stock-count', {
        counts: [{ id: fixture.productId, counted: 8, variantId: white!.id }],
        mode: 'set',
        locationId: fixture.locA,
      })
      assert.equal(count.status, 200, JSON.stringify(count.body))
      assert.equal(count.body.applied, 1, JSON.stringify(count.body))
      assert.equal(await levelOf(white!.id, fixture.locA), 8, 'the counted variant now reads what was counted')
      assert.equal(await assertInvariant(), 0)

      // The ledger names the variant on every movement it wrote.
      const movements = await db
        .select({ type: schema.stockMovements.type, variantId: schema.stockMovements.variantId, qty: schema.stockMovements.qty })
        .from(schema.stockMovements)
        .where(eq(schema.stockMovements.productId, fixture.productId))
      assert.ok(movements.length >= 5, 'every step left a ledger row')
      assert.ok(
        movements.every((m) => m.variantId === red!.id || m.variantId === white!.id),
        'no movement is left unattributed on a variant product',
      )
    } finally {
      await cleanup()
    }

    async function applyPurchaseStockSafe(sku: string, qty: number, locationId: string): Promise<boolean> {
      const { applyPurchaseStock } = await import('./purchases')
      return applyPurchaseStock(sku, qty, { locationId, unitValue: 100 })
    }
  },
)

test(
  'legacy single-variant products keep working, with and without a variant row',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `varlegacy-${Date.now()}`
    const h = await seedHarness(marker, ['Single'])
    const { db, schema, stock, fixture, assertInvariant, unattributedTotal, cleanup } = h
    const [only] = fixture.variants
    try {
      // A product SKU on a single-variant product resolves to its one variant
      // — the "select the default variant automatically" rule, applied by the
      // ledger rather than by every caller.
      await stock.applyStockMovement({ sku: fixture.productSku, qty: 6, type: 'opening', locationId: fixture.locA })
      assert.equal(await h.levelOf(only!.id, fixture.locA), 6, 'the product SKU wrote to its only variant')
      assert.equal(await h.bucketTotal(null), 0, 'nothing fell back to an unattributed bucket')
      assert.equal(await assertInvariant(), 0)

      await db.transaction(async (tx) => {
        await stock.deductOrderLineStock({ tx, locationId: fixture.locA, sku: fixture.productSku, qty: 2 })
      })
      assert.equal(await h.levelOf(only!.id, fixture.locA), 4, 'a product-SKU sale moves that variant')

      // A product with NO variant rows at all (an install mid-upgrade): its
      // stock is a product-level balance and must still move, count and total
      // exactly as before.
      const bareId = `${marker}-bare`
      const bareSku = `${marker}-BARE`
      await db.insert(schema.products).values({
        id: bareId,
        name: `${marker} Bare`,
        sku: bareSku,
        category: 'Tests',
        stock: 0,
      })
      try {
        await stock.applyStockMovement({ sku: bareSku, qty: 5, type: 'opening', locationId: fixture.locA })
        const [row] = await db
          .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
          .from(schema.stockLevels)
          .where(eq(schema.stockLevels.productId, bareId))
        assert.equal(Number(row?.qty ?? 0), 5, 'a variant-less product still holds its balance')
        const [bare] = await db
          .select({ stock: schema.products.stock })
          .from(schema.products)
          .where(eq(schema.products.id, bareId))
        assert.equal(Number(bare?.stock ?? 0), 5, 'and its rollup still tracks it')
        const bareVariants = await db
          .select({ id: schema.productVariants.id })
          .from(schema.productVariants)
          .where(eq(schema.productVariants.productId, bareId))
        assert.equal(bareVariants.length, 0, 'nothing invented a variant behind the scenes')
      } finally {
        await db.delete(schema.stockMovements).where(eq(schema.stockMovements.productId, bareId)).catch(() => undefined)
        await db.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, bareId)).catch(() => undefined)
        await db.delete(schema.products).where(eq(schema.products.id, bareId)).catch(() => undefined)
      }

      assert.equal(await unattributedTotal(), 0)
      await assertInvariant()
    } finally {
      await cleanup()
    }
  },
)

// ─── 2 · 3 · 4 · 7 ──────────────────────────────────────────────────────────

test(
  'a transfer moves exactly one variant, refuses over-requests, and cancels back',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `varxfer-${Date.now()}`
    const h = await seedHarness(marker, ['Red', 'White'])
    const { req, fixture, levelOf, assertInvariant, cleanup } = h
    const [red, white] = fixture.variants
    await h.stock.applyStockMovement({ sku: red!.sku, qty: 4, type: 'opening', locationId: fixture.locA })
    await h.stock.applyStockMovement({ sku: white!.sku, qty: 7, type: 'opening', locationId: fixture.locA })

    try {
      // 4 · More than the source holds for THAT variant is refused up front.
      const tooMany = await req('POST', '/inventory/transfers', {
        sku: fixture.productSku,
        variantId: red!.id,
        qty: 99,
        from: fixture.locA,
        to: fixture.locB,
      })
      assert.equal(tooMany.status, 400, JSON.stringify(tooMany.body))
      assert.match(String(tooMany.body.error), /Only 4/, 'the refusal names the variant’s own availability')

      // A multi-variant product cannot be transferred by parent SKU alone.
      const noVariant = await req('POST', '/inventory/transfers', {
        sku: fixture.productSku,
        qty: 1,
        from: fixture.locA,
        to: fixture.locB,
      })
      assert.equal(noVariant.status, 400, JSON.stringify(noVariant.body))
      assert.match(String(noVariant.body.error), /variant/i, 'the variant is mandatory for a multi-variant product')

      // 3 · Create → dispatch → receive, Red only.
      const created = await req('POST', '/inventory/transfers', {
        sku: fixture.productSku,
        variantId: red!.id,
        qty: 3,
        from: fixture.locA,
        to: fixture.locB,
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const transferId = String(created.body.id)
      assert.equal(created.body.variantId, red!.id, 'the record remembers which variant moves')
      assert.equal(created.body.sku, red!.sku, 'and stores the variant’s SKU, not the parent’s')
      assert.equal(await levelOf(red!.id, fixture.locA), 4, 'creating moves nothing')
      assert.equal(await levelOf(white!.id, fixture.locA), 7, 'White is untouched')

      const dispatched = await req('POST', `/inventory/transfers/${transferId}/dispatch`)
      assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body))
      assert.equal(await levelOf(red!.id, fixture.locA), 1, 'the dispatched variant left the source')
      assert.equal(await levelOf(red!.id, fixture.locB), 0, 'and has not arrived yet')
      assert.equal(await levelOf(white!.id, fixture.locA), 7, 'White never moved')
      assert.equal(await assertInvariant(), 0, 'the product total did not change — stock is in transit')

      const received = await req('POST', `/inventory/transfers/${transferId}/receive`, { receivedQty: 2 })
      assert.equal(received.status, 200, JSON.stringify(received.body))
      assert.equal(await levelOf(red!.id, fixture.locB), 2, 'the counted quantity arrived at the destination')
      assert.equal(await levelOf(red!.id, fixture.locA), 1)
      assert.equal(await levelOf(white!.id, fixture.locA), 7, 'White still untouched')
      assert.equal(await assertInvariant(), 0)

      // 7 · A second transfer, cancelled mid-flight, returns THE SAME variant.
      const second = await req('POST', '/inventory/transfers', {
        sku: red!.sku,
        qty: 1,
        from: fixture.locA,
        to: fixture.locB,
      })
      assert.equal(second.status, 201, JSON.stringify(second.body))
      const secondId = String(second.body.id)
      assert.equal(second.body.variantId, red!.id, 'a variant SKU resolves to that variant')
      await req('POST', `/inventory/transfers/${secondId}/dispatch`)
      assert.equal(await levelOf(red!.id, fixture.locA), 0, 'the source is empty of Red now')
      const cancelled = await req('POST', `/inventory/transfers/${secondId}/cancel`)
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
      assert.equal(await levelOf(red!.id, fixture.locA), 1, 'cancel put Red back where it came from')
      assert.equal(await levelOf(white!.id, fixture.locA), 7, 'White was never involved')
      assert.equal(await assertInvariant(), 0)

      // Every ledger row of this transfer names the variant.
      const detail = await req('GET', `/inventory/transfers/${transferId}`)
      assert.equal(detail.status, 200, JSON.stringify(detail.body))
      assert.equal(detail.body.variantTitle, 'Red', 'the detail view shows the variant that moved')
      assert.equal(detail.body.variantSku, red!.sku)
      const history = (detail.body.history ?? []) as Array<{ variantId: string | null }>
      assert.ok(history.length >= 2, 'dispatch and receive are both on the trail')
      assert.ok(history.every((row) => row.variantId === red!.id), 'history is variant-attributed')
    } finally {
      await cleanup()
    }
  },
)

// ─── migration ──────────────────────────────────────────────────────────────

test(
  'the upgrade attributes pre-variant balances without changing any total',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `varmigrate-${Date.now()}`
    const h = await seedHarness(marker, ['Red', 'White'])
    const { db, schema, fixture, cleanup } = h
    const [red, white] = fixture.variants
    const bareId = `${marker}-bare-product`
    const bareSku = `${marker}-BARE-SKU`
    let sqlClient: import('postgres').Sql | null = null

    try {
      // Exactly the reported shape: a product-level balance of 7 that the two
      // variants claim 4 and 4 of, plus a product with stock and no variants
      // at all (a pre-upgrade install).
      await db
        .insert(schema.stockLevels)
        .values({ productId: fixture.productId, variantId: null, locationId: fixture.locA, qty: 7 })
      await db
        .update(schema.productVariants)
        .set({ stock: 4 })
        .where(inArray(schema.productVariants.id, [red!.id, white!.id]))
      await db.update(schema.products).set({ stock: 7 }).where(eq(schema.products.id, fixture.productId))
      await db.insert(schema.products).values({
        id: bareId,
        name: `${marker} Bare`,
        sku: bareSku,
        category: 'Tests',
        stock: 5,
      })
      await db
        .insert(schema.stockLevels)
        .values({ productId: bareId, variantId: null, locationId: fixture.locA, qty: 5 })
      await db.insert(schema.stockMovements).values({
        id: `${marker}-mv`,
        productId: fixture.productId,
        variantId: null,
        sku: fixture.productSku,
        locationId: fixture.locA,
        type: 'count_adjust',
        qty: 7,
        stockAfter: 7,
        date: new Date().toISOString(),
      })

      const pool = (await import('postgres')).default
      sqlClient = pool(testUrl!, { max: 1 })
      const { attributeLegacyVariantStock } = await import('./db/variantStockBackfill')
      const result = await attributeLegacyVariantStock(sqlClient)

      // Totals first: nothing may be created, dropped or moved between stores.
      const [productTotal] = await db
        .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
        .from(schema.stockLevels)
        .where(eq(schema.stockLevels.productId, fixture.productId))
      assert.equal(Number(productTotal?.qty ?? 0), 7, 'the store still holds exactly 7')
      const [bareTotal] = await db
        .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
        .from(schema.stockLevels)
        .where(eq(schema.stockLevels.productId, bareId))
      assert.equal(Number(bareTotal?.qty ?? 0), 5, 'the variant-less product still holds exactly 5')

      // The 7 is now split across Red and White (4/3 by their recorded 4/4)…
      const [redHeld, whiteHeld] = await Promise.all([
        db
          .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
          .from(schema.stockLevels)
          .where(eq(schema.stockLevels.variantId, red!.id))
          .then((r) => Number(r[0]?.qty ?? 0)),
        db
          .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
          .from(schema.stockLevels)
          .where(eq(schema.stockLevels.variantId, white!.id))
          .then((r) => Number(r[0]?.qty ?? 0)),
      ])
      assert.deepEqual([redHeld, whiteHeld].sort((a, b) => a - b), [3, 4], 'attributed by their recorded shares')
      assert.ok(result.levelsAttributed >= 2, 'the balance rows were attributed')

      // …and the mirrors follow the ledger, not the other way round.
      const held = await db
        .select({ id: schema.productVariants.id, stock: schema.productVariants.stock })
        .from(schema.productVariants)
        .where(inArray(schema.productVariants.id, [red!.id, white!.id]))
      assert.deepEqual(
        held.map((v) => v.stock).sort((a, b) => Number(a) - Number(b)),
        [3, 4],
        'variant counters are recomputed from the balances',
      )
      const [product] = await db
        .select({ stock: schema.products.stock })
        .from(schema.products)
        .where(eq(schema.products.id, fixture.productId))
      assert.equal(Number(product?.stock ?? 0), 7, 'products.stock is untouched by attribution')

      // A product with no variant rows gains its default variant, so its
      // balance can name one from now on.
      const bareVariants = await db
        .select()
        .from(schema.productVariants)
        .where(eq(schema.productVariants.productId, bareId))
      assert.equal(bareVariants.length, 1, 'the default variant was created')
      assert.equal(bareVariants[0]?.title, 'Default Title')
      const [bareLevel] = await db
        .select({ variantId: schema.stockLevels.variantId })
        .from(schema.stockLevels)
        .where(eq(schema.stockLevels.productId, bareId))
      assert.equal(bareLevel?.variantId, bareVariants[0]?.id, 'its balance now names that variant')

      // History is annotated only where it is unambiguous: this product has
      // exactly one variant… no — it has two, so the movement stays NULL rather
      // than being rewritten to fit a model it predates.
      const [movement] = await db
        .select({ variantId: schema.stockMovements.variantId })
        .from(schema.stockMovements)
        .where(eq(schema.stockMovements.id, `${marker}-mv`))
      assert.equal(movement?.variantId, null, 'ambiguous history is left alone')

      // Running it again changes nothing for these products: the migration is
      // idempotent. (The counters are scoped rather than global — another test
      // file's rows are not this assertion's business.)
      await attributeLegacyVariantStock(sqlClient!)
      const rowsAfter = await db
        .select({ variantId: schema.stockLevels.variantId, qty: schema.stockLevels.qty })
        .from(schema.stockLevels)
        .where(inArray(schema.stockLevels.productId, [fixture.productId, bareId]))
      assert.equal(rowsAfter.length, 3, 'the same three balance rows exist — no duplicates were added')
      assert.equal(
        rowsAfter.reduce((sum, r) => sum + Number(r.qty ?? 0), 0),
        12,
        'and still exactly 7 + 5 units after a second run',
      )
      const [totalAgain] = await db
        .select({ qty: sql<number>`coalesce(sum(${schema.stockLevels.qty}), 0)` })
        .from(schema.stockLevels)
        .where(eq(schema.stockLevels.productId, fixture.productId))
      assert.equal(Number(totalAgain?.qty ?? 0), 7, 'and still exactly 7 units')
    } finally {
      await db.delete(schema.stockMovements).where(eq(schema.stockMovements.productId, fixture.productId)).catch(() => undefined)
      await db.delete(schema.stockMovements).where(eq(schema.stockMovements.productId, bareId)).catch(() => undefined)
      await db.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, fixture.productId)).catch(() => undefined)
      await db.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, bareId)).catch(() => undefined)
      await db.delete(schema.productVariants).where(eq(schema.productVariants.productId, bareId)).catch(() => undefined)
      await db.delete(schema.products).where(eq(schema.products.id, bareId)).catch(() => undefined)
      if (sqlClient) await sqlClient.end({ timeout: 5 }).catch(() => undefined)
      await cleanup()
    }
  },
)
