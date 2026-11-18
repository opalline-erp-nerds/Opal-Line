import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'

// Stock-transfer reliability.
//
// Exercises the real router against a scratch database to pin down the parts
// that used to break under multi-computer use:
//
//   - Transfer numbers are minted on the server inside the create transaction
//     (a client-side count of loaded rows goes stale under concurrency and
//     collides on the unique index), so a caller-supplied number is ignored.
//   - from/to store canonical `inventory_locations` IDs, not display names.
//   - Stock only moves with the status transition, and both happen in one
//     transaction: dispatch deducts the source exactly once even when two
//     requests race; a duplicate receive 400s instead of double-crediting; a
//     dispatch whose status update fails takes the ledger write back with it.
//   - Cancelling an in-transit transfer returns stock to the source; cancelling
//     a received one is refused.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as stockAvailability.test.ts. With
// DASHBOARD_TEST_CREATE=1 the file provisions that database itself: create it
// (server-side, from the same cluster's default database) and run
// bootstrapDatabase so the schema exists. Only ever pointed at an explicitly
// configured throwaway URL — never at either installed or development shop data.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()
const shouldProvision = Boolean(testUrl) && process.env.DASHBOARD_TEST_CREATE === '1'

/**
 * Make the configured scratch database real: create it if missing and apply
 * the current schema. Memoised because `npm test` runs the file's tests one
 * after another in one process.
 */
let provisioning: Promise<void> | null = null
function ensureScratchReady(): Promise<void> {
  provisioning ??= (async () => {
    if (!shouldProvision) return
    const pool = (await import('postgres')).default
    const admin = pool(testUrl!.replace(/\/[^/?]+(\?|$)/, '/postgres$1'), { max: 1 })
    try {
      // The LAST path segment is the database name (never the userinfo/host).
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

interface PostResult {
  status: number
  body: Record<string, unknown>
}

async function seedHarness(marker: string) {
  process.env.DATABASE_URL = testUrl as string
  await ensureScratchReady()

  const express = (await import('express')).default
  const { db, schema } = await import('./db/client')
  const { dbRouter } = await import('./routes/db')
  const { stockAt } = await import('./stock')
  assert.ok(db, 'test database client did not initialize')

  const userId = `${marker}-admin`
  const productId = `${marker}-product`
  const sku = `${marker}-SKU`
  const fromId = `${marker}-from`
  const toId = `${marker}-to`

  await db!.insert(schema.users).values({
    id: userId,
    name: 'Transfer Test Admin',
    email: `${marker}@test.local`,
    role: 'Super Admin',
    status: 'active',
  })
  await db!.insert(schema.inventoryLocations).values([
    { id: fromId, name: `${marker} Source`, type: 'store' },
    { id: toId, name: `${marker} Destination`, type: 'store' },
  ])
  await db!.insert(schema.products).values({ id: productId, name: 'Transfer Test Ring', sku, category: 'Tests' })

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = userId
    next()
  })
  app.use(dbRouter)
  const server = app.listen(0)
  const port = Number((server.address() as { port: number }).port)

  const post = async (path: string, body?: unknown): Promise<PostResult> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const get = async (path: string): Promise<PostResult> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`)
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const balance = async (locationId: string): Promise<number> => {
    const [row] = await db!.select({ qty: schema.stockLevels.qty })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.locationId, locationId))
      .limit(1)
    return Number(row?.qty ?? 0)
  }
  const transfersForSku = async () =>
    (await db!.select().from(schema.stockTransfers).where(eq(schema.stockTransfers.sku, sku)))
  const movementsForRef = async (refId: string) =>
    (await db!.select().from(schema.stockMovements).where(eq(schema.stockMovements.refId, refId)))
    .map((m) => ({ type: m.type ?? '', qty: Number(m.qty) }))

  const cleanup = async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    const quashes = (p: Promise<unknown>) => p.catch(() => undefined)
    await db!.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, sku)).catch(() => undefined)
    await db!.delete(schema.stockTransfers).where(eq(schema.stockTransfers.sku, sku)).catch(() => undefined)
    await db!.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, productId)).catch(() => undefined)
    await db!.delete(schema.products).where(eq(schema.products.id, productId)).catch(() => undefined)
    await quashes(db!.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.id, fromId)))
    await quashes(db!.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.id, toId)))
    await db!.delete(schema.users).where(eq(schema.users.id, userId)).catch(() => undefined)
  }

  return { db, schema, sku, productId, fromId, toId, userId, post, get, balance, stockAt, transfersForSku, movementsForRef, cleanup }
}

test(
  'create mints server-side transfer numbers and stores canonical location IDs',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const marker = `stockxfer-${Date.now()}-create`
    const h = await seedHarness(marker)
    try {
      // Seeded through the ledger so balances are authoritative.
      const { applyStockMovement } = await import('./stock')
      await applyStockMovement({ sku: h.sku, qty: 5, type: 'opening', locationId: h.fromId })

      // A client-supplied number is ignored: numbering is server-owned because
      // list counts from another computer go stale and collide on the unique index.
      const created = await h.post('/inventory/transfers', {
        sku: h.sku, qty: 2, from: h.fromId, to: h.toId, number: 'ST-2026-0001',
      })
      assert.equal(created.status, 201)
      assert.match(String(created.body.number), /^ST-\d{4}-[A-F0-9]{8}$/)
      assert.notEqual(created.body.number, 'ST-2026-0001')
      assert.equal(created.body.from, h.fromId, 'transfer stores canonical source location ID')
      assert.equal(created.body.to, h.toId, 'transfer stores canonical destination location ID')
      assert.equal(created.body.status, 'pending')
      assert.equal(await h.balance(h.fromId), 5, 'creating a pending transfer does not move stock')
      assert.equal(await h.balance(h.toId), 0)
      assert.deepEqual(await h.movementsForRef(String(created.body.id)), [], 'no ledger write on creation')

      // Fractional quantities are refused rather than silently floored.
      const fractional = await h.post('/inventory/transfers', { sku: h.sku, qty: 2.5, from: h.fromId, to: h.toId })
      assert.equal(fractional.status, 400)
      assert.match(String(fractional.body.error), /whole-number/)

      // A second create gets a different number.
      const second = await h.post('/inventory/transfers', { sku: h.sku, qty: 1, from: h.fromId, to: h.toId })
      assert.equal(second.status, 201)
      const numbers = await (await h.transfersForSku()).map((t) => t.number)
      assert.equal(new Set(numbers).size, numbers.length, 'transfer numbers are unique')
    } finally {
      await h.cleanup()
    }
  },
)

test(
  'concurrent dispatch and duplicate receive move stock exactly once',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const marker = `stockxfer-${Date.now()}-dispatch`
    const h = await seedHarness(marker)
    try {
      const { applyStockMovement } = await import('./stock')
      await applyStockMovement({ sku: h.sku, qty: 5, type: 'opening', locationId: h.fromId })

      const created = await h.post('/inventory/transfers', { sku: h.sku, qty: 2, from: h.fromId, to: h.toId })
      assert.equal(created.status, 201)
      const transferId = String(created.body.id)

      // Race two dispatch requests: the transfer row lock must allow exactly
      // one state transition and exactly one source deduction.
      const dispatches = await Promise.all([
        h.post(`/inventory/transfers/${transferId}/dispatch`),
        h.post(`/inventory/transfers/${transferId}/dispatch`),
      ])
      assert.equal(dispatches.filter((r) => r.status === 200).length, 1)
      assert.equal(dispatches.filter((r) => r.status === 400).length, 1)
      assert.equal(await h.balance(h.fromId), 3, 'dispatch deducts exactly once')
      assert.equal(await h.balance(h.toId), 0, 'in-transit stock is not at either location')
      assert.equal((await h.movementsForRef(transferId)).filter((m) => m.type === 'transfer_out').length, 1, 'exactly one ledger deduction')

      const received = await h.post(`/inventory/transfers/${transferId}/receive`, { receivedQty: 2 })
      assert.equal(received.status, 200)
      assert.equal(await h.balance(h.fromId), 3)
      assert.equal(await h.balance(h.toId), 2)
      assert.equal(await h.stockAt(h.sku), 5, 'total stock is conserved at full receipt')

      const duplicateReceive = await h.post(`/inventory/transfers/${transferId}/receive`, { receivedQty: 2 })
      assert.equal(duplicateReceive.status, 400)
      assert.equal(await h.balance(h.toId), 2, 'duplicate receive cannot add stock twice')
      assert.equal((await h.movementsForRef(transferId)).filter((m) => m.type === 'transfer_in').length, 1, 'exactly one ledger credit')
    } finally {
      await h.cleanup()
    }
  },
)

test(
  'cancel restores in-transit stock and a failed dispatch rolls the ledger back',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const marker = `stockxfer-${Date.now()}-cancel`
    const h = await seedHarness(marker)
    try {
      const { applyStockMovement } = await import('./stock')
      const { sql } = await import('drizzle-orm')
      await applyStockMovement({ sku: h.sku, qty: 5, type: 'opening', locationId: h.fromId })

      // Cancel while in transit: the stock went out on dispatch, so it has to
      // come back, postings and status flip committing together.
      const provisional = await h.post('/inventory/transfers', { sku: h.sku, qty: 1, from: h.fromId, to: h.toId })
      assert.equal(provisional.status, 201)
      assert.equal((await h.post(`/inventory/transfers/${provisional.body.id}/dispatch`)).status, 200)
      assert.equal(await h.balance(h.fromId), 4)
      const cancelledInTransit = await h.post(`/inventory/transfers/${provisional.body.id}/cancel`)
      assert.equal(cancelledInTransit.status, 200)
      assert.equal(cancelledInTransit.body.status, 'cancelled')
      assert.equal(await h.balance(h.fromId), 5, 'cancelling an in-transit transfer restores the source')
      assert.equal(await h.balance(h.toId), 0, 'cancel does not alter destination stock')
      // Repeating the cancel is refused — one cancel per transfer.
      assert.equal((await h.post(`/inventory/transfers/${provisional.body.id}/cancel`)).status, 400)

      // Cancelling a received transfer is refused: stock already landed.
      const completed = await h.post('/inventory/transfers', { sku: h.sku, qty: 1, from: h.fromId, to: h.toId })
      assert.equal((await h.post(`/inventory/transfers/${completed.body.id}/dispatch`)).status, 200)
      assert.equal((await h.post(`/inventory/transfers/${completed.body.id}/receive`, { receivedQty: 1 })).status, 200)
      assert.equal((await h.post(`/inventory/transfers/${completed.body.id}/cancel`)).status, 400)
      assert.equal(await h.balance(h.toId), 1, 'a refused cancel leaves the receipt in place')

      // Forced failure mid-transaction: the status update is made to fail AFTER
      // the stock movement ran. The transaction must roll the deduction back
      // with the status change — no orphaned ledger write.
      const victim = await h.post('/inventory/transfers', { sku: h.sku, qty: 1, from: h.fromId, to: h.toId })
      const victimId = String(victim.body.id)
      await h.db.execute(sql`create or replace function stockxfer_force_fail() returns trigger as $$
        begin raise exception 'forced rollback for transfer test'; end;
        $$ language plpgsql`)
      await h.db.execute(sql`create trigger stockxfer_force_fail
        before update on stock_transfers
        for each row execute function stockxfer_force_fail()`)
      try {
        const failed = await h.post(`/inventory/transfers/${victimId}/dispatch`)
        assert.equal(failed.status, 500, 'the sabotage surfaces as a server error')
        assert.equal(await h.balance(h.fromId), 4, 'no stock left the source: the movement rolled back')
        assert.equal(await (await h.transfersForSku()).find((t) => t.id === victimId)?.status, 'pending', 'status unchanged after rollback')
        assert.deepEqual(await h.movementsForRef(victimId), [], 'no ledger write survives a failed dispatch')
      } finally {
        await h.db.execute(sql`drop trigger if exists stockxfer_force_fail on stock_transfers`)
        await h.db.execute(sql`drop function if exists stockxfer_force_fail()`)
      }

      // The same transfer dispatches cleanly once the failure is gone.
      assert.equal((await h.post(`/inventory/transfers/${victimId}/dispatch`)).status, 200)
      assert.equal(await h.balance(h.fromId), 3)
      // 3 at the source + 1 received at the destination + 1 riding in transit
      // (in neither location's balance): the seeded 5 minus nothing.
      assert.equal(await h.stockAt(h.sku), 4)
    } finally {
      await h.cleanup()
    }
  },
)

test(
  'detail and list resolve readable names, ledger history and removed locations',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const marker = `stockxfer-${Date.now()}-detail`
    const h = await seedHarness(marker)
    try {
      const { applyStockMovement } = await import('./stock')
      // Store → warehouse: two different kinds of place, the flat location
      // model's "different stores" case.
      await h.db.update(h.schema.inventoryLocations)
        .set({ type: 'warehouse' })
        .where(eq(h.schema.inventoryLocations.id, h.toId))
      await applyStockMovement({ sku: h.sku, qty: 5, type: 'opening', locationId: h.fromId })

      const created = await h.post('/inventory/transfers', { sku: h.sku, qty: 3, from: h.fromId, to: h.toId, weight: 12.6 })
      assert.equal(created.status, 201)
      const id = String(created.body.id)
      assert.equal((await h.post(`/inventory/transfers/${id}/dispatch`)).status, 200)
      assert.equal(await h.balance(h.fromId), 2, 'dispatch leaves 2 at the source')
      assert.equal(await h.balance(h.toId), 0, 'in-transit stock sits at neither location')
      const received = await h.post(`/inventory/transfers/${id}/receive`, { receivedQty: 2 })
      assert.equal(received.status, 200)
      assert.equal(await h.balance(h.toId), 2, 'the counted quantity lands at the DESTINATION')

      // List: resolved endpoints and a readable creator — never ids.
      const list = await h.get('/inventory/transfers')
      assert.equal(list.status, 200)
      const rows = list.body.data as Array<Record<string, unknown>>
      const row = rows.find((r) => r.id === id)
      assert.ok(row, 'the transfer appears on the list')
      assert.equal((row!.fromLocation as { name?: string } | null)?.name, `${marker} Source`)
      assert.equal((row!.toLocation as { name?: string; type?: string } | null)?.name, `${marker} Destination`)
      assert.equal((row!.toLocation as { type?: string } | null)?.type, 'warehouse')
      assert.equal(row!.initiatedByName, 'Transfer Test Admin', 'the By column shows a name, not a user id')

      // Detail: endpoints, actors, ledger history, current owner, variance.
      const detail = await h.get(`/inventory/transfers/${id}`)
      assert.equal(detail.status, 200)
      assert.equal(detail.body.status, 'received')
      assert.equal((detail.body.fromLocation as { name?: string } | null)?.name, `${marker} Source`)
      assert.equal((detail.body.toLocation as { name?: string } | null)?.name, `${marker} Destination`)
      assert.equal(detail.body.productName, 'Transfer Test Ring')
      assert.equal(detail.body.initiatedByName, 'Transfer Test Admin')
      const dispatch = detail.body.dispatch as { at?: string; byName?: string } | null
      assert.equal(dispatch?.byName, 'Transfer Test Admin', 'dispatched-by resolves to a name')
      assert.ok(dispatch?.at, 'the dispatch date comes from the ledger')
      const receive = detail.body.receive as { byName?: string; qty?: number } | null
      assert.equal(receive?.byName, 'Transfer Test Admin')
      assert.equal(receive?.qty, 2)
      assert.equal(detail.body.variance, -1, 'one of the three dispatched never arrived')
      const owner = detail.body.owner as { name?: string | null; inTransit?: boolean } | null
      assert.equal(owner?.inTransit, false)
      assert.equal(owner?.name, `${marker} Destination`, 'received stock belongs to the destination')
      const history = detail.body.history as Array<{ type: string; locationName?: string | null; byName?: string | null }>
      assert.equal(history.length, 2, 'dispatch + receive are the complete history')
      assert.deepEqual(history.map((m) => m.type).sort(), ['transfer_in', 'transfer_out'])
      const out = history.find((m) => m.type === 'transfer_out')!
      const inn = history.find((m) => m.type === 'transfer_in')!
      assert.equal(out.locationName, `${marker} Source`)
      assert.equal(inn.locationName, `${marker} Destination`)
      assert.ok(history.every((m) => m.byName === 'Transfer Test Admin'))

      // A deleted destination must not break the view: detail still answers,
      // the raw reference survives, the resolved side becomes null (the UI
      // shows "Removed location" instead of a UUID).
      await h.db.delete(h.schema.inventoryLocations).where(eq(h.schema.inventoryLocations.id, h.toId))
      const afterDelete = await h.get(`/inventory/transfers/${id}`)
      assert.equal(afterDelete.status, 200, 'a missing location must not break the detail view')
      assert.equal(afterDelete.body.toLocation, null)
      assert.equal(afterDelete.body.to, h.toId, 'the raw reference is kept for clients')
      const listAfter = await h.get('/inventory/transfers')
      const rowAfter = (listAfter.body.data as Array<Record<string, unknown>>).find((r) => r.id === id)
      assert.equal(rowAfter!.toLocation, null)

      // Rows written before the id backfill store display names — historical
      // transfers must resolve by name too.
      const oldDepotId = `${marker}-old-depot`
      await h.db.insert(h.schema.inventoryLocations).values({ id: oldDepotId, name: `${marker} Old Depot`, type: 'store' })
      const legacyId = `${marker}-legacy`
      await h.db.insert(h.schema.stockTransfers).values({
        id: legacyId,
        number: `ST-LEGACY-${Date.now().toString(36).toUpperCase()}`,
        from: `${marker} Source`,
        to: `${marker} Old Depot`,
        product: 'Transfer Test Ring',
        sku: h.sku,
        qty: 1,
        initiatedBy: h.userId,
        status: 'received',
        date: new Date().toISOString(),
      })
      const legacy = await h.get(`/inventory/transfers/${legacyId}`)
      assert.equal(legacy.status, 200)
      assert.equal((legacy.body.fromLocation as { name?: string } | null)?.name, `${marker} Source`, 'name-valued legacy source resolves')
      assert.equal((legacy.body.toLocation as { name?: string } | null)?.name, `${marker} Old Depot`, 'name-valued legacy destination resolves')
      assert.equal((legacy.body.owner as { name?: string | null }).name, `${marker} Old Depot`, 'legacy owner reads as a name')
      await h.db.delete(h.schema.inventoryLocations).where(eq(h.schema.inventoryLocations.id, oldDepotId))
    } finally {
      await h.cleanup()
    }
  },
)

test(
  'a user without the inventory module cannot list, read or act on transfers',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const marker = `stockxfer-${Date.now()}-perm`
    const h = await seedHarness(marker)
    const express = (await import('express')).default
    const { dbRouter } = await import('./routes/db')
    const outsiderId = `${marker}-outsider`
    let server: { close: (cb: () => void) => unknown; address: () => unknown } | null = null
    try {
      // A role with no stored row falls back to defaultRolePermissions, which
      // grants no modules to anything except Super Admin — the same path a
      // real counter-staff user takes through Users & Roles.
      await h.db.insert(h.schema.users).values({
        id: outsiderId,
        name: 'Counter Staff',
        email: `${marker}-outsider@test.local`,
        role: 'Counter Staff',
        status: 'active',
      })

      // One server, the user chosen per request: mirrors how the real stack
      // resolves req.userId before RBAC runs (production additionally mounts
      // enforceRbac in front of this router — two layers, same decision).
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as { userId?: string }).userId = String(req.headers['x-test-user'] ?? '') || undefined
        next()
      })
      app.use(dbRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const getAs = async (path: string, user: string): Promise<number> => {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-test-user': user } })
        return r.status
      }

      const { applyStockMovement } = await import('./stock')
      await applyStockMovement({ sku: h.sku, qty: 3, type: 'opening', locationId: h.fromId })
      const created = await h.post('/inventory/transfers', { sku: h.sku, qty: 1, from: h.fromId, to: h.toId })
      assert.equal(created.status, 201)
      const id = String(created.body.id)

      // The outsider can neither list nor open transfers…
      assert.equal(await getAs('/inventory/transfers', outsiderId), 403, 'listing is denied without inventory view')
      assert.equal(await getAs(`/inventory/transfers/${id}`, outsiderId), 403, 'the detail view is denied too')
      // …nor act on them.
      const dispatch = await fetch(`http://127.0.0.1:${port}/inventory/transfers/${id}/dispatch`, {
        method: 'POST',
        headers: { 'x-test-user': outsiderId },
      })
      assert.equal(dispatch.status, 403, 'dispatching is denied without inventory edit')
      // Anonymous is refused outright.
      assert.equal(await getAs('/inventory/transfers', ''), 401, 'no user, no data')
      // The Super Admin's authorized visibility is unchanged.
      assert.equal(await getAs('/inventory/transfers', h.userId), 200, 'Super Admin still lists transfers')
      assert.equal(await getAs(`/inventory/transfers/${id}`, h.userId), 200, 'Super Admin still reads the detail')
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
      await h.db.delete(h.schema.users).where(eq(h.schema.users.id, outsiderId)).catch(() => undefined)
      await h.cleanup()
    }
  },
)
