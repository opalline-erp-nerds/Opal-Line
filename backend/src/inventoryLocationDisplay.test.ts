import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import http from 'node:http'

// Location display contract for the inventory endpoints.
//
// /inventory/movements and /inventory/levels keep `locationId` on every row
// (API callers and joins still need it) but now resolve `locationName`,
// `locationType` and `locationCity` alongside it so the UI can render
// `Main Store · Store · Chennai` instead of a UUID. A row whose location was
// deleted — or a legacy row storing the display NAME instead of the id — must
// still resolve gracefully: null metadata for the client to show
// `Location unavailable`, never the raw id.
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
    const { bootstrapDatabase } = await import('./db/bootstrap')
    await bootstrapDatabase()
  })()
  return provisioning
}

interface GetResult {
  status: number
  body: unknown
}

test(
  'movements and levels resolve location name/type/city and degrade safely',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string
    await ensureScratchReady()

    const express = (await import('express')).default
    const { db, schema } = await import('./db/client')
    const { dbRouter } = await import('./routes/db')
    const { applyStockMovement } = await import('./stock')
    assert.ok(db, 'test database client did not initialize')

    const marker = `locdisplay-${Date.now()}`
    const locationId = `${marker}-loc`
    const ghostId = `${marker}-deleted-uuid-0000`
    const userId = `${marker}-admin`
    const productId = `${marker}-product`
    const sku = `${marker}-SKU`

    await db.insert(schema.users).values({
      id: userId,
      name: 'Location Display Admin',
      email: `${marker}@test.local`,
      role: 'Super Admin',
      status: 'active',
    })
    await db.insert(schema.inventoryLocations).values([
      { id: locationId, name: `${marker} Main`, type: 'warehouse', city: 'Chennai' },
    ])
    await db.insert(schema.products).values({ id: productId, name: 'Location Display Ring', sku, category: 'Tests' })

    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = userId
      next()
    })
    app.use(dbRouter)
    const server = app.listen(0)
    const port = Number((server.address() as { port: number }).port)
    // Plain one-shot http.get instead of fetch: undici's keep-alive agent
    // parks an open socket to this server, and closing it concurrently with
    // the server trips a libuv "handle already closing" assertion on Windows
    // during process exit (the file passes its assertions but exits non-zero).
    const get = (path: string): Promise<GetResult> =>
      new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}${path}`, { agent: false }, (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as unknown })
            } catch (err) {
              reject(err)
            }
          })
        })
        req.on('error', reject)
      })

    try {
      // One movement at the real location, one at a location that does not
      // exist (simulating a deleted location row), one legacy row keyed by
      // the display NAME the way pre-backfill records were written.
      await applyStockMovement({ sku, qty: 7, type: 'opening', locationId })
      await applyStockMovement({ sku, qty: 3, type: 'opening', locationId: ghostId })
      await db.insert(schema.stockMovements).values({
        id: `${marker}-legacy-mvt`,
        productId,
        sku,
        locationId: `${marker} Main`,
        type: 'count_adjust',
        qty: 1,
        stockAfter: 11,
        note: 'legacy name-valued row',
        date: new Date().toISOString(),
      })

      // ── /inventory/movements ────────────────────────────────────────────
      const movements = await get(`/inventory/movements?sku=${encodeURIComponent(sku)}`)
      assert.equal(movements.status, 200)
      const rows = movements.body as Array<{
        locationId: string
        locationName: string | null
        locationType: string | null
        locationCity: string | null
        qty: number
      }>
      assert.equal(rows.length, 3)
      const real = rows.find((r) => r.locationId === locationId)!
      assert.equal(real.locationName, `${marker} Main`, 'the id resolves to a readable name')
      assert.equal(real.locationType, 'warehouse')
      assert.equal(real.locationCity, 'Chennai')
      const ghost = rows.find((r) => r.locationId === ghostId)!
      assert.equal(ghost.locationName, null, 'a deleted location carries null metadata, never a name')
      assert.equal(ghost.locationId, ghostId, 'the id itself stays on the row for API use')
      const legacy = rows.find((r) => r.locationId === `${marker} Main`)!
      assert.equal(legacy.locationName, `${marker} Main`, 'legacy name-valued rows resolve to themselves')
      assert.equal(legacy.locationType, 'warehouse')

      // ── /inventory/levels ───────────────────────────────────────────────
      const levels = await get(`/inventory/levels?sku=${encodeURIComponent(sku)}`)
      assert.equal(levels.status, 200)
      const levelRows = levels.body as Array<{
        locationId: string
        qty: number
        locationName: string | null
        locationType: string | null
        locationCity: string | null
      }>
      const levelReal = levelRows.find((r) => r.locationId === locationId)!
      assert.equal(levelReal.locationName, `${marker} Main`)
      assert.equal(levelReal.locationType, 'warehouse')
      assert.equal(levelReal.locationCity, 'Chennai')
      const levelGhost = levelRows.find((r) => r.locationId === ghostId)!
      assert.equal(levelGhost.locationName, null)

      // ── calculations unchanged (regression 7) ───────────────────────────
      // Enrichment is presentation only: the balances are exactly what the
      // ledger posted (7 + 3 at their locations).
      assert.equal(Number(levelReal.qty), 7, 'the real location still holds 7')
      assert.equal(Number(levelGhost.qty), 3, 'the ghost level is untouched by display code')
      const total = levelRows.reduce((sum, r) => sum + Number(r.qty), 0)
      assert.equal(total, 10, 'total stock across locations is unchanged')
    } finally {
      // Drop keep-alive sockets (undici's fetch agent holds one open) before
      // closing: closing the server and the socket at the same instant trips a
      // libuv "handle already closing" assertion on Windows during exit.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const quashes = (p: Promise<unknown>) => p.catch(() => undefined)
      await quashes(db.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, sku)))
      await quashes(db.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, productId)))
      await quashes(db.delete(schema.products).where(eq(schema.products.id, productId)))
      await quashes(db.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.id, locationId)))
      await quashes(db.delete(schema.users).where(eq(schema.users.id, userId)))
    }
  },
)
