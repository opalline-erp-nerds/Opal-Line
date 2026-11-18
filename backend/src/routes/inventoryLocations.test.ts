import test from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import http from 'node:http'

// Stock-location creation on an EXISTING database.
//
// Regression for the `Failed query: insert into inventory_locations (…)` error
// on the Stock Locations page. The Drizzle table lists six columns, and a
// Drizzle INSERT always names every one of them (values absent from the call
// are emitted as `default`), so a database that never received
// `shopify_location_id` fails EVERY location insert with
// `42703: column "shopify_location_id" … does not exist` — no matter what the
// request body carries.
//
// The column was declared only inside createSchema, which runs solely when
// `users` is missing, so every already-installed database took applyUpgrades
// and never gained it. This file pins the user-visible consequence:
//   1. a pre-feature database gains the column AND its partial unique index
//      from the upgrade path, and that index is genuinely unique-but-NULL-exempt;
//   2. creating a location through the real router returns 201 with a NULL
//      mapping, editing it afterwards works and keeps its stock, and opening
//      stock still lands in the existing ledger (`stock_movements` +
//      `stock_levels`) posted by the same transaction as the insert.
//
// Same scratch-DB contract as stockTransfers.test.ts: skipped without
// DASHBOARD_TEST_DATABASE_URL, and with DASHBOARD_TEST_CREATE=1 the file
// provisions the configured throwaway database itself. Only ever pointed at an
// explicitly configured scratch URL — never at shop data.
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
    const { bootstrapDatabase } = await import('../db/bootstrap')
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
  const { db, schema } = await import('../db/client')
  const { dbRouter } = await import('../routes/db')
  assert.ok(db, 'test database client did not initialize')

  const userId = `${marker}-admin`

  await db.insert(schema.users).values({
    id: userId,
    name: 'Location Create Admin',
    email: `${marker}@test.local`,
    role: 'Super Admin',
    status: 'active',
  })

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = userId
    next()
  })
  app.use(dbRouter)
  const server = app.listen(0)
  const port = Number((server.address() as { port: number }).port)

  // node:http with a one-shot agent instead of fetch: fetch's keep-alive
  // socket trips a libuv teardown assertion on Windows when the server closes.
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

  /** Raw result rows: drizzle's execute returns the driver's row list. */
  const rawRows = async (query: string): Promise<Record<string, unknown>[]> =>
    (await db.execute(sql.raw(query))) as unknown as Record<string, unknown>[]

  const cleanup = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await db.delete(schema.users).where(eq(schema.users.id, userId)).catch(() => undefined)
  }

  return { db, schema, userId, req, rawRows, cleanup }
}

test(
  'an existing database gains the mapping column and location inserts work',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `loccreate-${Date.now()}`
    const h = await seedHarness(marker)
    const { db, schema, req, rawRows, cleanup } = h
    const locationId = `${marker}-loc`
    const twinId = `${marker}-twin`
    let createdId = ''

    try {
      const { bootstrapDatabase, resetBootstrapForTests } = await import('../db/bootstrap')
      const columnPresent = async () =>
        (await rawRows(
          `select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'inventory_locations'
              and column_name = 'shopify_location_id'`,
        )).length === 1

      // Emulate an install created BEFORE the Shopify mapping existed: no
      // column and no index — exactly the state of a database whose last
      // bootstrap predates the feature.
      await rawRows('alter table inventory_locations drop column if exists shopify_location_id')
      assert.equal(await columnPresent(), false, 'precondition: the column is gone')

      // A second bootstrap of the same process is the existing-database path.
      resetBootstrapForTests()
      const boot = await bootstrapDatabase()
      assert.equal(boot.ran, true, 'the upgrade must run for an existing database')

      assert.equal(await columnPresent(), true, 'applyUpgrades must add shopify_location_id')

      const indexes = await rawRows(
        `select indexdef from pg_indexes
          where schemaname = 'public' and indexname = 'inventory_locations_shopify_location_id_idx'`,
      )
      assert.equal(indexes.length, 1, 'applyUpgrades must add the mapping index')
      assert.match(
        String(indexes[0]?.indexdef ?? ''),
        /WHERE \(?shopify_location_id IS NOT NULL\)?$/i,
        'the index must stay partial, so unmapped rows never collide',
      )

      // The partial unique index is real: one store location, one owner; two
      // unmapped (NULL) rows are exempt.
      await db.insert(schema.inventoryLocations).values([
        { id: locationId, name: `${marker} Branch A`, type: 'store', city: 'Salem' },
        { id: twinId, name: `${marker} Branch B`, type: 'store', city: 'Salem' },
      ])
      await db.update(schema.inventoryLocations)
        .set({ shopifyLocationId: '900001' })
        .where(eq(schema.inventoryLocations.id, locationId))
      let duplicate: unknown
      try {
        await db.update(schema.inventoryLocations)
          .set({ shopifyLocationId: '900001' })
          .where(eq(schema.inventoryLocations.id, twinId))
      } catch (err) {
        duplicate = err
      }
      // Drizzle wraps the driver error as "Failed query: …"; the SQLSTATE text
      // lives on the cause, so match across both rather than the wrapper.
      const duplicateText = [
        String((duplicate as Error | undefined)?.message ?? ''),
        String((duplicate as { cause?: Error } | undefined)?.cause?.message ?? ''),
      ].join(' ')
      assert.match(
        duplicateText,
        /duplicate key|unique constraint/i,
        'the partial unique index must reject a second owner of one store location',
      )
      await db.update(schema.inventoryLocations)
        .set({ shopifyLocationId: null })
        .where(eq(schema.inventoryLocations.id, locationId))

      // The reported failure, through the real router: no mapping sent at all.
      const created = await req('POST', '/inventory/locations', {
        name: `${marker} Salem branch`,
        type: 'store',
        city: 'Salem',
        manager: 'Priya',
      })
      assert.equal(created.status, 201, `create must succeed, got ${JSON.stringify(created.body)}`)
      assert.equal(created.body.shopifyLocationId, null, 'an unmapped location stores NULL, not an empty string')
      createdId = String(created.body.id)

      const [stored] = await db
        .select({ shopifyLocationId: schema.inventoryLocations.shopifyLocationId })
        .from(schema.inventoryLocations)
        .where(eq(schema.inventoryLocations.id, createdId))
      assert.equal(stored?.shopifyLocationId, null, 'NULL is what the column holds, not a blank string')

      // Editing goes through the generic PATCH and must not need the mapping
      // column in the request at all.
      const edited = await req('PATCH', `/inventory/locations/${encodeURIComponent(createdId)}`, {
        name: `${marker} Salem branch (renamed)`,
        type: 'warehouse',
        city: 'Salem South',
        manager: 'Priya',
      })
      assert.equal(edited.status, 200, `edit must succeed, got ${JSON.stringify(edited.body)}`)
      const [row] = await db.select().from(schema.inventoryLocations).where(eq(schema.inventoryLocations.id, createdId))
      assert.equal(row?.name, `${marker} Salem branch (renamed)`)
      assert.equal(row?.type, 'warehouse')
      assert.equal(row?.city, 'Salem South')
      assert.equal(row?.shopifyLocationId, null, 'an edit never disturbs an unmapped location')
    } finally {
      await db.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.id, locationId)).catch(() => undefined)
      await db.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.id, twinId)).catch(() => undefined)
      if (createdId) {
        await db.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.id, createdId)).catch(() => undefined)
      }
      await cleanup()
    }
  },
)

test(
  'opening stock posts to the existing ledger and edits keep the balance',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    const marker = `loccreate-${Date.now()}-open`
    const h = await seedHarness(marker)
    const { db, schema, req, cleanup } = h
    const productId = `${marker}-product`
    const sku = `${marker}-SKU`
    let locationId = ''

    try {
      await db.insert(schema.products).values({
        id: productId,
        name: 'Location Create Ring',
        sku,
        category: 'Tests',
        stock: 0,
      })

      const created = await req('POST', '/inventory/locations', {
        name: `${marker} Salem branch`,
        type: 'store',
        city: 'Salem',
        openingBalances: [{ sku, qty: 6 }],
      })
      assert.equal(created.status, 201, `create must succeed, got ${JSON.stringify(created.body)}`)
      assert.equal(created.body.openingLines, 1)
      locationId = String(created.body.id)

      // The same ledger as every other movement: one `opening` row keyed to
      // this location, and the per-location balance that ledger maintains.
      const movements = await db.select().from(schema.stockMovements)
        .where(eq(schema.stockMovements.locationId, locationId))
      assert.equal(movements.length, 1, 'exactly one opening movement is posted')
      assert.equal(movements[0]?.type, 'opening')
      assert.equal(movements[0]?.sku, sku)
      assert.equal(Number(movements[0]?.qty ?? 0), 6)
      assert.equal(movements[0]?.refType, 'inventory_location')
      assert.equal(movements[0]?.refId, locationId)

      const [level] = await db.select().from(schema.stockLevels)
        .where(eq(schema.stockLevels.locationId, locationId))
      assert.equal(Number(level?.qty ?? 0), 6, 'stock_levels holds the counted balance at the new location')
      const [product] = await db.select({ stock: schema.products.stock })
        .from(schema.products).where(eq(schema.products.id, productId))
      assert.equal(Number(product?.stock ?? 0), 6, 'the global rollup rose with the opening count')

      // Editing the location's details must not touch what it holds.
      const edited = await req('PATCH', `/inventory/locations/${encodeURIComponent(locationId)}`, {
        name: `${marker} Salem branch (edited)`,
        type: 'workshop',
        city: 'Salem',
        manager: 'Arun',
      })
      assert.equal(edited.status, 200, `edit must succeed, got ${JSON.stringify(edited.body)}`)
      const [after] = await db.select().from(schema.stockLevels)
        .where(eq(schema.stockLevels.locationId, locationId))
      assert.equal(Number(after?.qty ?? 0), 6, 'editing a location never changes its stock')
      const movementsAfter = await db.select().from(schema.stockMovements)
        .where(eq(schema.stockMovements.locationId, locationId))
      assert.equal(movementsAfter.length, 1, 'the ledger history is untouched by an edit')
    } finally {
      await db.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, sku)).catch(() => undefined)
      await db.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, productId)).catch(() => undefined)
      await db.delete(schema.products).where(eq(schema.products.id, productId)).catch(() => undefined)
      if (locationId) {
        await db.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.id, locationId)).catch(() => undefined)
      }
      await cleanup()
    }
  },
)
