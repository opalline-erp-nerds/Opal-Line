import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Selection-based label exports — the PDF endpoint with `ids`, and the raw ZPL
 * stream a Zebra printer/print server consumes — both read their rows through
 * fetchProductLabels(), which re-keys the result by `id` so the sheet keeps the
 * order the operator selected. If the SELECT leaves `id` out, every lookup
 * misses, the function silently returns [] and the route answers 404
 * "Products not found" for products that are in the catalogue.
 *
 * Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
 * the schema applied — the same contract as productSkuGeneration.test.ts.
 */
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'fetchProductLabels returns products whose ids exist (selection-based exports)',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    // db/client reads DATABASE_URL on first import, so it must point at the
    // scratch database before the dynamic imports below run.
    process.env.DATABASE_URL = testUrl as string

    const { eq } = await import('drizzle-orm')
    const { db, schema, getRawClient } = await import('./db/client')
    assert.ok(db, 'test database client did not initialize')
    assert.ok(getRawClient(), 'raw client did not initialize')

    const marker = `labelpick${Date.now()}`
    const id = `${marker}-id`
    const sku = `LBL-${marker.slice(-8)}`

    try {
      await db!.insert(schema.products).values({
        id,
        name: `Label picker ${marker}`,
        sku,
        category: 'Test',
        sellingPrice: 123.45,
        netWeight: 1.5,
      })

      const { fetchProductLabels, fetchAllProductLabels } = await import('./barcodeLabels')

      // The unfiltered path (the PDF button with nothing selected) still works.
      const all = await fetchAllProductLabels()
      assert.ok(all.length >= 1, 'the scratch catalogue must return rows')

      // The id path must return the row that exists — this is the regression:
      // without `id` in the SELECT this came back empty and every export 404'd.
      const picked = await fetchProductLabels([id])
      assert.equal(picked.length, 1, 'a product that exists must be returned by id')
      assert.equal(picked[0].sku, sku, 'the row must be the one the caller asked for')
      assert.equal(picked[0].price, 123.45, 'label fields must be carried through')

      // Ordering contract: the caller's order is preserved, unknown ids dropped.
      const mixed = await fetchProductLabels([id, `${id}-missing`])
      assert.equal(mixed.length, 1, 'an unknown id must not produce a row')
      assert.equal(mixed[0].sku, sku)

      const unknownOnly = await fetchProductLabels([`${id}-missing`])
      assert.equal(unknownOnly.length, 0, 'unknown ids alone must resolve to nothing')
    } finally {
      await db!.delete(schema.products).where(eq(schema.products.id, id))
    }
  },
)
