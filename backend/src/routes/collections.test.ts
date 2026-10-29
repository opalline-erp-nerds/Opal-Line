import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

/**
 * Inventory → Collections & Categories, end to end through the product router:
 *
 *  1. The foundation seeds two collections: Silver Jewels (silver-rate, system)
 *     and Other Products (fixed-price, renameable), plus one category per
 *     established SKU prefix in Silver Jewels.
 *  2. Renaming a collection only changes its display name — the stable id, its
 *     pricing type and its categories are untouched, and re-seeding does not
 *     reset the new name.
 *  3. Categories can be created, edited and moved between collections; names
 *     and SKU prefixes are validated and globally unique.
 *  4. Renaming a category relabels the products that use it — their SKUs and
 *     prices are untouched — and a product in a Silver Jewels category is not
 *     affected by any of it.
 *  5. Inventory view-only users can read but never write.
 *
 * Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
 * the schema applied — the same contract as dashboardLowStock.test.ts.
 */
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const SILVER = 'COL-SILVER-JEWELS'
const OTHER = 'COL-OTHER-PRODUCTS'

test(
  'collections and categories keep stable identities and leave Silver Jewels pricing alone',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { eq, inArray, sql } = await import('drizzle-orm')
    const { db, schema, getRawClient } = await import('../db/client')
    const { dbRouter } = await import('./db')
    const { ensureCollectionFoundation } = await import('../db/collectionsSeed')
    assert.ok(db, 'test database client did not initialize')
    const raw = getRawClient()
    assert.ok(raw, 'raw client did not initialize')

    const marker = `colcategories${Date.now()}`
    const adminId = `${marker}-admin`
    const viewerId = `${marker}-viewer`
    const productIds: string[] = []
    const categoryIds: string[] = []
    let server: Server | null = null

    try {
      // Foundation first, then reset the display names so a run after a crashed
      // test still starts from the shipped labels (the ids never change).
      await ensureCollectionFoundation(raw!)
      await db!.update(schema.collections).set({ name: 'Silver Jewels' }).where(eq(schema.collections.id, SILVER))
      await db!.update(schema.collections).set({ name: 'Other Products' }).where(eq(schema.collections.id, OTHER))
      // Leftovers from an interrupted run of THIS test (never seeded rows).
      await db!.delete(schema.productCategories).where(sql`${schema.productCategories.name} like ${`%${marker}%`}`)
      await db!.delete(schema.products).where(sql`${schema.products.name} like ${`%${marker}%`}`)

      await db!.insert(schema.users).values([
        {
          id: adminId,
          name: 'Collections Admin',
          email: `${marker}-admin@test.local`,
          role: 'Super Admin',
          status: 'active',
        },
        {
          id: viewerId,
          name: 'Collections Viewer',
          email: `${marker}-viewer@test.local`,
          role: 'Staff',
          status: 'active',
          permissions: { inventory: { view: true, create: false, edit: false, delete: false } },
        },
      ])

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as { userId?: string }).userId = req.header('x-test-user') ?? undefined
        next()
      })
      app.use('/db', dbRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const call = async (
        who: string,
        method: 'GET' | 'POST' | 'PATCH',
        path: string,
        body?: unknown,
      ) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            ...(who ? { 'x-test-user': who } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return { status: res.status, body: (await res.json()) as any }
      }

      // ── 1. The foundation: two collections, existing categories seeded ───
      const collections = await call(adminId, 'GET', '/db/inventory/collections')
      assert.equal(collections.status, 200)
      const byId = new Map(collections.body.data.map((c: any) => [c.id, c]))
      assert.ok(byId.has(SILVER) && byId.has(OTHER), 'both foundation collections exist')

      const silver = byId.get(SILVER) as any
      assert.equal(silver.name, 'Silver Jewels')
      assert.equal(silver.pricingType, 'silver')
      assert.equal(silver.isSystem, true)

      const other = byId.get(OTHER) as any
      assert.equal(other.name, 'Other Products')
      assert.equal(other.pricingType, 'fixed')
      assert.equal(other.isSystem, false)

      const silverCats = await call(adminId, 'GET', `/db/inventory/categories?collectionId=${SILVER}`)
      assert.equal(silverCats.status, 200)
      const seeded = new Map(silverCats.body.data.map((c: any) => [c.prefix, c]))
      for (const prefix of ['SIL', 'RNG', 'CHN', 'BNG', 'CUF']) {
        assert.ok(seeded.has(prefix), `seeded category ${prefix} exists`)
      }
      assert.equal((seeded.get('RNG') as any).name, 'Rings')
      assert.equal((seeded.get('RNG') as any).collectionId, SILVER)

      // A Silver Jewels product used to prove nothing here rewrites it.
      const silverProductId = `${marker}-ring`
      await db!.insert(schema.products).values({
        id: silverProductId,
        name: `Silver rings ${marker}`,
        sku: `OL-RNG-${marker.slice(-6)}`,
        category: 'Rings',
        sellingPrice: 599,
        silverRate: 92.5,
        stock: 3,
        createdAt: new Date().toISOString(),
      })
      productIds.push(silverProductId)

      // ── 2. Rename preserves the stable identity ──────────────────────────
      const renamed = await call(adminId, 'PATCH', `/db/inventory/collections/${OTHER}`, {
        name: 'Preowned & Gifting',
      })
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body))
      assert.equal(renamed.body.id, OTHER, 'the id is unchanged')
      assert.equal(renamed.body.name, 'Preowned & Gifting')
      assert.equal(renamed.body.pricingType, 'fixed', 'renaming never changes pricing')

      const reloaded = await call(adminId, 'GET', '/db/inventory/collections')
      const otherNow = reloaded.body.data.find((c: any) => c.id === OTHER) as any
      assert.equal(otherNow.name, 'Preowned & Gifting')
      assert.equal(otherNow.pricingType, 'fixed')

      // Re-running the foundation (every boot) must not resurrect the old name
      // or duplicate the collection.
      await ensureCollectionFoundation(raw!)
      const reseeded = await call(adminId, 'GET', '/db/inventory/collections')
      assert.equal(reseeded.body.data.filter((c: any) => c.id === OTHER).length, 1)
      assert.equal((reseeded.body.data.find((c: any) => c.id === OTHER) as any).name, 'Preowned & Gifting')

      // ── 3. Silver Jewels and pricing type are immutable ──────────────────
      const locked = await call(adminId, 'PATCH', `/db/inventory/collections/${SILVER}`, { name: 'Everything' })
      assert.equal(locked.status, 400)
      assert.match(locked.body.error, /fixed/i)
      const stillSilver = await call(adminId, 'GET', '/db/inventory/collections')
      assert.equal((stillSilver.body.data.find((c: any) => c.id === SILVER) as any).name, 'Silver Jewels')

      const wrongPricing = await call(adminId, 'PATCH', `/db/inventory/collections/${OTHER}`, {
        pricingType: 'silver',
      })
      assert.equal(wrongPricing.status, 400)
      assert.match(wrongPricing.body.error, /pricing type/i)

      // ── 4. Category create / edit / move ────────────────────────────────
      const bags = await call(adminId, 'POST', '/db/inventory/categories', {
        collectionId: OTHER,
        name: 'Bags',
        prefix: 'BAG',
      })
      assert.equal(bags.status, 201, JSON.stringify(bags.body))
      categoryIds.push(bags.body.id)
      assert.equal(bags.body.collectionId, OTHER)
      assert.equal(bags.body.prefix, 'BAG')
      assert.equal(bags.body.productCount, 0)

      const otherCats = await call(adminId, 'GET', `/db/inventory/categories?collectionId=${OTHER}`)
      assert.ok(otherCats.body.data.some((c: any) => c.id === bags.body.id))

      const moved = await call(adminId, 'PATCH', `/db/inventory/categories/${bags.body.id}`, {
        name: 'Handbags',
        prefix: 'HBG',
        collectionId: SILVER,
      })
      assert.equal(moved.status, 200, JSON.stringify(moved.body))
      assert.equal(moved.body.name, 'Handbags')
      assert.equal(moved.body.prefix, 'HBG')
      assert.equal(moved.body.collectionId, SILVER)

      const otherAfterMove = await call(adminId, 'GET', `/db/inventory/categories?collectionId=${OTHER}`)
      assert.ok(!otherAfterMove.body.data.some((c: any) => c.id === bags.body.id))
      const silverAfterMove = await call(adminId, 'GET', `/db/inventory/categories?collectionId=${SILVER}`)
      assert.ok(silverAfterMove.body.data.some((c: any) => c.id === bags.body.id && c.name === 'Handbags'))

      // ── 5. Validation: duplicate prefix/name, bad prefix, unknown collection ─
      const dupPrefix = await call(adminId, 'POST', '/db/inventory/categories', {
        collectionId: OTHER,
        name: `Rings two ${marker}`,
        prefix: 'RNG',
      })
      assert.equal(dupPrefix.status, 400)
      assert.match(dupPrefix.body.error, /prefix/i)

      const dupName = await call(adminId, 'POST', '/db/inventory/categories', {
        collectionId: OTHER,
        name: 'rings',
        prefix: 'RGX',
      })
      assert.equal(dupName.status, 400)
      assert.match(dupName.body.error, /already exists/i)

      const badPrefix = await call(adminId, 'POST', '/db/inventory/categories', {
        collectionId: OTHER,
        name: `Bad prefix ${marker}`,
        prefix: 'B4G',
      })
      assert.equal(badPrefix.status, 400)
      assert.match(badPrefix.body.error, /letters/i)

      const unknownCollection = await call(adminId, 'POST', '/db/inventory/categories', {
        collectionId: 'COL-NOPE',
        name: `Nope ${marker}`,
        prefix: 'NPE',
      })
      assert.equal(unknownCollection.status, 400)
      assert.match(unknownCollection.body.error, /collection/i)

      // ── 6. Renaming a category relabels products, never their SKU/price ──
      const markerCat = await call(adminId, 'POST', '/db/inventory/categories', {
        collectionId: OTHER,
        name: `Gadgets ${marker}`,
        prefix: 'GDG',
      })
      assert.equal(markerCat.status, 201, JSON.stringify(markerCat.body))
      categoryIds.push(markerCat.body.id)

      const gadgetId = `${marker}-gadget`
      await db!.insert(schema.products).values({
        id: gadgetId,
        name: `Gadget ${marker}`,
        sku: `OL-GDG-${marker.slice(-6)}`,
        category: `Gadgets ${marker}`,
        sellingPrice: 1250,
        silverRate: 0,
        stock: 2,
        createdAt: new Date().toISOString(),
      })
      productIds.push(gadgetId)

      const relabelled = await call(adminId, 'PATCH', `/db/inventory/categories/${markerCat.body.id}`, {
        name: `Widgets ${marker}`,
      })
      assert.equal(relabelled.status, 200, JSON.stringify(relabelled.body))
      assert.equal(relabelled.body.productsUpdated, 1)

      const [gadget] = await db!
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, gadgetId))
        .limit(1)
      assert.equal(gadget.category, `Widgets ${marker}`, 'the product follows the category name')
      assert.equal(gadget.sku, `OL-GDG-${marker.slice(-6)}`, 'the SKU is untouched')
      assert.equal(Number(gadget.sellingPrice), 1250, 'the selling price is untouched')

      const [ring] = await db!
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, silverProductId))
        .limit(1)
      assert.equal(ring.category, 'Rings', 'Silver Jewels products keep their category')
      assert.equal(Number(ring.sellingPrice), 599)
      assert.equal(Number(ring.silverRate), 92.5)
      const seededNow = await call(adminId, 'GET', `/db/inventory/categories?collectionId=${SILVER}`)
      const ringsNow = seededNow.body.data.find((c: any) => c.prefix === 'RNG') as any
      assert.equal(ringsNow.name, 'Rings')
      assert.equal(ringsNow.collectionId, SILVER)

      // ── 7. Authorization: view-only users can read, never write ──────────
      const unauthenticated = await call('', 'GET', '/db/inventory/collections')
      assert.equal(unauthenticated.status, 401)

      const viewerList = await call(viewerId, 'GET', '/db/inventory/categories')
      assert.equal(viewerList.status, 200)
      const deniedCreate = await call(viewerId, 'POST', '/db/inventory/categories', {
        collectionId: OTHER,
        name: `Denied ${marker}`,
        prefix: 'DNY',
      })
      assert.equal(deniedCreate.status, 403)
      const deniedRename = await call(viewerId, 'PATCH', `/db/inventory/collections/${OTHER}`, { name: 'Nope' })
      assert.equal(deniedRename.status, 403)
      const deniedEdit = await call(viewerId, 'PATCH', `/db/inventory/categories/${bags.body.id}`, {
        name: 'Nope',
      })
      assert.equal(deniedEdit.status, 403)

      const finalName = await call(adminId, 'GET', '/db/inventory/collections')
      assert.equal((finalName.body.data.find((c: any) => c.id === OTHER) as any).name, 'Preowned & Gifting')
    } finally {
      if (categoryIds.length > 0) {
        await db!.delete(schema.productCategories).where(inArray(schema.productCategories.id, categoryIds))
      }
      await db!.delete(schema.productCategories).where(sql`${schema.productCategories.name} like ${`%${marker}%`}`)
      if (productIds.length > 0) {
        await db!.delete(schema.products).where(inArray(schema.products.id, productIds))
      }
      await db!.delete(schema.products).where(sql`${schema.products.name} like ${`%${marker}%`}`)
      await db!.delete(schema.users).where(inArray(schema.users.id, [adminId, viewerId]))
      await db!.update(schema.collections).set({ name: 'Other Products' }).where(eq(schema.collections.id, OTHER))
      server?.close()
      await raw?.end({ timeout: 5 })
    }
  },
)
