import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'

// Regression suite for order stock deduction ignoring variant SKUs.
//
// The rule under test: a manual order line may carry a PRODUCT_VARIANTS sku
// that matches nothing in products.sku. The old handler looked the line up
// only in products and silently skipped the deduction — the sale saved with
// no stock movement at all, and on edit the old line was silently skipped on
// the restore side too. Order lines must now resolve through
// product_variants to the parent product, deduct BOTH the variant's own
// counter (product_variants.stock) and the parent ledger (stock_levels /
// stock_movements / products.stock rollup), reject unknown SKUs instead of
// skipping them, and restore symmetrically.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as stockAvailability.test.ts.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'order stock lines resolve variant SKUs: qty 1 vs 3, unknown rejected, restore symmetric',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const { db, schema } = await import('./db/client')
    const {
      applyStockMovement,
      deductOrderLineStock,
      restoreOrderLineStock,
      resolveStockSku,
      ensureDefaultLocation,
      levelAt,
      stockAt,
    } = await import('./stock')
    assert.ok(db, 'test database client did not initialize')

    const marker = `ordvar-${Date.now()}`
    const parentSku = `${marker}-P`
    const v1Sku = `${marker}-V1` // Small — 5 units
    const v2Sku = `${marker}-V2` // Large — 2 units
    const productId = `${marker}-prod`
    const v1Id = `${marker}-v1`
    const v2Id = `${marker}-v2`

    const variantStock = async (id: string) => {
      const [v] = await db!
        .select({ stock: schema.productVariants.stock })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.id, id))
        .limit(1)
      return v?.stock ?? -1
    }

    try {
      await db!.insert(schema.products).values({ id: productId, name: 'Variant Ring', sku: parentSku, category: 'Tests' })
      await db!.insert(schema.productVariants).values([
        { id: v1Id, productId, title: 'Small', optionValues: ['Small'], sku: v1Sku, stock: 5 },
        { id: v2Id, productId, title: 'Large', optionValues: ['Large'], sku: v2Sku, stock: 2 },
      ])
      // Parent ledger seeded to the variant sum (7) — the invariant sales must keep.
      await applyStockMovement({ sku: parentSku, qty: 7, type: 'opening' })
      const locationId = await ensureDefaultLocation()
      assert.equal(await stockAt(parentSku), 7, 'seeded parent balance is 7')

      // Resolution: a variant SKU resolves to the parent product/ledger SKU.
      const resolved = await resolveStockSku(db!, v1Sku)
      assert.deepEqual(resolved, { productId, ledgerSku: parentSku, variantId: v1Id })
      const resolvedParent = await resolveStockSku(db!, parentSku)
      assert.deepEqual(resolvedParent, { productId, ledgerSku: parentSku }, 'flat parent SKU still resolves')

      // Quantity 3: variant counter, location level and rollup all move by 3.
      await db!.transaction(async (tx) => {
        const r = await deductOrderLineStock({ tx, locationId, sku: v1Sku, qty: 3 })
        assert.equal(r?.productId, productId, 'returns the parent product for the Shopify inventory push')
      })
      assert.equal(await variantStock(v1Id), 2, 'variant counter deducted by 3')
      assert.equal(await levelAt(db!, productId, locationId), 4, 'location level deducted by 3')
      assert.equal(await stockAt(parentSku), 4, 'products.stock rollup deducted by 3')

      // Quantity 1 of the same variant deducts exactly one more.
      await db!.transaction(async (tx) => {
        await deductOrderLineStock({ tx, locationId, sku: v1Sku, qty: 1 })
      })
      assert.equal(await variantStock(v1Id), 1)
      assert.equal(await levelAt(db!, productId, locationId), 3)
      assert.equal(await stockAt(parentSku), 3)

      // The variant's own counter blocks a request the parent could cover:
      // parent holds 3, but Large only has 2.
      await assert.rejects(
        db!.transaction(async (tx) => {
          await deductOrderLineStock({ tx, locationId, sku: v2Sku, qty: 3 })
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /Insufficient stock for SKU .+-V2 at this location: available 2, requested 3/)
          return true
        },
      )
      assert.equal(await variantStock(v2Id), 2, 'rejected check moved nothing (rollback)')
      assert.equal(await stockAt(parentSku), 3)

      // Unknown SKU: rejected, never silently skipped.
      await assert.rejects(
        db!.transaction(async (tx) => {
          await deductOrderLineStock({ tx, locationId, sku: `${marker}-GHOST`, qty: 1 })
        }),
        /Unknown SKU/,
      )

      // Normal variant sale of Large, then the variant-empty case: the parent
      // still holds stock but Large itself is out.
      await db!.transaction(async (tx) => {
        await deductOrderLineStock({ tx, locationId, sku: v2Sku, qty: 2 })
      })
      assert.equal(await variantStock(v2Id), 0)
      assert.equal(await stockAt(parentSku), 1)
      await assert.rejects(
        db!.transaction(async (tx) => {
          await deductOrderLineStock({ tx, locationId, sku: v2Sku, qty: 1 })
        }),
        /Insufficient stock for SKU .+-V2 at this location: available 0, requested 1/,
      )
      assert.equal(await stockAt(parentSku), 1, 'variant-empty rejection rolled back')

      // Restore symmetry — an edit or cancellation gives the stock back.
      await db!.transaction(async (tx) => {
        await restoreOrderLineStock({ tx, locationId, sku: v1Sku, qty: 3 })
      })
      assert.equal(await variantStock(v1Id), 4)
      assert.equal(await levelAt(db!, productId, locationId), 4)
      assert.equal(await stockAt(parentSku), 4)

      // Unresolvable SKU restores nothing instead of trapping the edit.
      const ghost = await db!.transaction(async (tx) =>
        restoreOrderLineStock({ tx, locationId, sku: `${marker}-GHOST`, qty: 2 }),
      )
      assert.equal(ghost, null)

      // The edit flow (restore old + deduct new in ONE transaction) nets the
      // quantity change exactly once: Large 2 → 1.
      await db!.transaction(async (tx) => {
        await restoreOrderLineStock({ tx, locationId, sku: v2Sku, qty: 2 })
        await deductOrderLineStock({ tx, locationId, sku: v2Sku, qty: 1 })
      })
      assert.equal(await variantStock(v2Id), 1, 'edit restore+deduct nets the qty change once')
      assert.equal(await stockAt(parentSku), 5)

      // The ledger records every movement under the PARENT SKU — the same
      // convention product-save count corrections and Shopify pulls use.
      const movements = await db!.select().from(schema.stockMovements).where(eq(schema.stockMovements.sku, parentSku))
      const sales = movements.filter((m) => m.type === 'sale_out')
      assert.equal(sales.length, 4, 'rejected checks wrote no movement')
      assert.equal(
        sales.reduce((s, m) => s + m.qty, 0),
        -7,
        'sale_out total is −3 −1 −2 −1',
      )
      assert.ok(
        sales.every((m) => m.refType === 'sales_order'),
        'movements carry refType sales_order',
      )
      const returns = movements.filter((m) => m.type === 'sale_return_in')
      assert.equal(returns.reduce((s, m) => s + m.qty, 0), 5, 'returns total +3 (v1) +2 (v2 edit)')

      // Final invariant: the parent rollup equals the sum of its variants.
      const variants = await db!.select({ stock: schema.productVariants.stock }).from(schema.productVariants).where(eq(schema.productVariants.productId, productId))
      assert.equal(variants.reduce((s, v) => s + v.stock, 0), await stockAt(parentSku), 'Σ variant stock = products.stock')
    } finally {
      await db!.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, parentSku)).catch(() => undefined)
      await db!.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, productId)).catch(() => undefined)
      await db!.delete(schema.productVariants).where(eq(schema.productVariants.productId, productId)).catch(() => undefined)
      await db!.delete(schema.products).where(eq(schema.products.id, productId)).catch(() => undefined)
    }
  },
)
