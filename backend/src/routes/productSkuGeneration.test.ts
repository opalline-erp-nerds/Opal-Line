import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

/**
 * Automatic SKU generation, end to end through the product routes:
 *
 *  1. GET /db/products/next-sku derives the proposal from live rows under the
 *     create path's advisory lock, and follows the category mapping
 *     (Rings → RNG, Chains → CHN) — no generic OL-GEN codes.
 *  2. POST /db/products mints the code server-side when none is supplied, so
 *     the dialog's proposal is not the only source of truth, and continuing
 *     proposals advance from the persisted row.
 *  3. A category-less create is rejected instead of minting OL-GEN.
 *  4. A taken code is rejected (409), and concurrent creates in one category
 *     mint distinct, consecutive codes.
 *  5. PATCH /db/products/:id never rewrites a saved product's SKU.
 *
 * Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
 * the schema applied — the same contract as dashboardLowStock.test.ts.
 */
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

/** OL-CHN-0007 → OL-CHN-0008 (same digit width). */
function nextInSequence(sku: string): string {
  return sku.replace(/(\d+)$/, (digits) => String(Number(digits) + 1).padStart(digits.length, '0'))
}

test(
  'SKU generation follows the selected category and is never rewritten on edit',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { eq, inArray } = await import('drizzle-orm')
    const { db, schema, getRawClient } = await import('../db/client')
    const { dbRouter } = await import('./db')
    assert.ok(db, 'test database client did not initialize')

    const marker = `skugen${Date.now()}`
    const userId = `${marker}-admin`
    // Marker category → its own sequence (first three letters: SKU), so the
    // exact numbers cannot be inflated by rows left in the scratch database.
    const category = `Skutest ${marker}`
    let server: Server | null = null
    const createdIds: string[] = []
    let settingsBefore: Record<string, unknown> | null = null

    try {
      await db!.insert(schema.users).values({
        id: userId,
        name: 'SKU Tester',
        email: `${marker}@test.local`,
        role: 'Super Admin',
        status: 'active',
      })
      // The shipped OL defaults, so the assertions do not depend on whatever
      // Product codes settings the scratch database happens to hold.
      const [existingSettings] = await db!.select().from(schema.settings).limit(1)
      if (existingSettings) {
        settingsBefore = existingSettings as unknown as Record<string, unknown>
        await db!
          .update(schema.settings)
          .set({ skuPrefix: 'OL', skuSuffix: '', skuFormat: null, skuSeqLength: 3 })
      }

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as { userId?: string }).userId = req.header('x-test-user') ?? undefined
        next()
      })
      app.use('/db', dbRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const call = async (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            'x-test-user': userId,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return { status: res.status, body: (await res.json()) as any }
      }

      // ── A category is required to mint a code ────────────────────────────
      const missing = await call('GET', '/db/products/next-sku')
      assert.equal(missing.status, 400)
      assert.match(missing.body.error, /category/i)

      // ── The proposal follows the established category prefix ─────────────
      const rings = await call('GET', '/db/products/next-sku?category=Rings')
      assert.equal(rings.status, 200)
      assert.match(rings.body.sku, /^OL-RNG-\d{3,}$/)

      // ── An absent SKU is minted server-side, from the category ───────────
      const first = await call('POST', '/db/products', { name: `${marker} ring`, category: 'Rings' })
      assert.equal(first.status, 201, JSON.stringify(first.body))
      createdIds.push(first.body.id)
      assert.equal(first.body.sku, rings.body.sku, 'server minting matches the proposal for an idle category')
      assert.match(first.body.sku, /^OL-RNG-\d{3,}$/)

      // The next proposal continues from the row that was just persisted.
      const ringsNext = await call('GET', '/db/products/next-sku?category=Rings')
      assert.equal(ringsNext.body.sku, nextInSequence(first.body.sku))

      // ── Switching the category before saving changes the prefix ──────────
      const chains = await call('GET', '/db/products/next-sku?category=Chains')
      assert.equal(chains.status, 200)
      assert.match(chains.body.sku, /^OL-CHN-\d{3,}$/)
      const chain = await call('POST', '/db/products', { name: `${marker} chain`, category: 'Chains' })
      assert.equal(chain.status, 201)
      createdIds.push(chain.body.id)
      assert.equal(chain.body.sku, chains.body.sku)

      // ── No category is rejected, never minted as OL-GEN ─────────────────
      const noCategory = await call('POST', '/db/products', { name: `${marker} generic` })
      assert.equal(noCategory.status, 400)
      assert.match(noCategory.body.error, /category/i)

      // ── A code that is already taken is rejected ────────────────────────
      const duplicate = await call('POST', '/db/products', {
        name: `${marker} dup`,
        category: 'Rings',
        sku: first.body.sku,
      })
      assert.equal(duplicate.status, 409)
      assert.match(duplicate.body.error, /already exists/i)

      // ── Concurrent creates mint distinct, consecutive codes ────────────
      const racers = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          call('POST', '/db/products', { name: `${marker} racer ${i}`, category }),
        ),
      )
      const racerSkus = racers.map((r) => {
        assert.equal(r.status, 201, JSON.stringify(r.body))
        createdIds.push(r.body.id)
        return r.body.sku as string
      })
      assert.equal(new Set(racerSkus).size, 4, `duplicate SKUs minted: ${racerSkus.join(', ')}`)
      for (const sku of racerSkus) assert.match(sku, /^OL-SKU-\d{3,}$/)
      assert.deepEqual(
        [...racerSkus].sort(),
        ['001', '002', '003', '004'].map((n) => `OL-SKU-${n}`),
        'four racers in one category produce the first four sequences, once each',
      )

      // ── Editing never rewrites an existing SKU ──────────────────────────
      const edited = await call('PATCH', `/db/products/${first.body.id}`, {
        sku: 'OL-RNG-999',
        category: 'Chains',
        name: `${marker} renamed`,
      })
      assert.equal(edited.status, 200)
      assert.equal(edited.body.sku, first.body.sku, 'a saved SKU is immutable through a general edit')
      assert.equal(edited.body.category, 'Chains')
      assert.equal(edited.body.name, `${marker} renamed`)
    } finally {
      if (createdIds.length > 0) {
        await db!.delete(schema.products).where(inArray(schema.products.id, createdIds))
      }
      await db!.delete(schema.users).where(eq(schema.users.id, userId))
      if (settingsBefore) {
        await db!.update(schema.settings).set({
          skuPrefix: settingsBefore.skuPrefix as string | null,
          skuSuffix: settingsBefore.skuSuffix as string | null,
          skuFormat: settingsBefore.skuFormat as string | null,
          skuSeqLength: settingsBefore.skuSeqLength as number | null,
        })
      }
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
