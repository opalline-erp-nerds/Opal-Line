import test from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'

// Regression suite for purchase documents ignoring variant identity.
//
// The rule under test: a purchase line stores its SKU, so the only way to know
// WHICH variant a receipt credited (or a return deducted) is the
// product_id/variant_id saved beside it. Before those columns existed, a
// variant SKU was the only clue and `applyStockMovement` had to guess:
//   - a receipt of OL-GIF-001-RED credited whatever that SKU resolved to and
//     left the sibling variant, the parent rollup and `stock_movements` unable
//     to explain themselves;
//   - the PO → PI conversion dropped both ids, so the receipt reopened as an
//     anonymous SKU line;
//   - a Piece Rate line (no grams, no ₹/g) converted to a ₹0 invoice line
//     because the cost was re-derived from weight × rate.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as orderStockVariants.test.ts.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'purchase receipts and returns move the variant they name, and a PO → PI keeps it',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const { db, schema } = await import('./db/client')
    const { applyStockMovement, ensureDefaultLocation, levelAt, stockAt, variantStockTotal } = await import('./stock')
    const {
      ensurePurchaseInvoiceForOrder,
      normalizePurchaseItems,
      normalizeReturnLines,
      saveInvoiceItems,
      saveOrderLines,
      saveReturnLines,
    } = await import('./purchases')
    assert.ok(db, 'test database client did not initialize')

    const marker = `purvar-${Date.now()}`
    const productId = `${marker}-prod`
    const parentSku = `${marker}-P`
    const redSku = `${marker}-RED`
    const whiteSku = `${marker}-WHI`
    const redId = `${marker}-v-red`
    const whiteId = `${marker}-v-whi`
    const orderId = `${marker}-po`
    const invoiceId = `${marker}-pi`
    const returnId = `${marker}-pr`
    /** Id of the invoice `ensurePurchaseInvoiceForOrder` minted for the PO. */
    let autoInvoiceId = ''

    const variantStock = async (id: string) => {
      const [v] = await db!
        .select({ stock: schema.productVariants.stock })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.id, id))
        .limit(1)
      return Number(v?.stock ?? -1)
    }

    try {
      await db!.insert(schema.products).values({
        id: productId,
        name: 'Variant Toy',
        sku: parentSku,
        category: 'Tests',
        gst: 3,
      })
      await db!.insert(schema.productVariants).values([
        { id: redId, productId, title: 'red', optionValues: ['red'], sku: redSku, stock: 0 },
        { id: whiteId, productId, title: 'white', optionValues: ['white'], sku: whiteSku, stock: 0 },
      ])

      const locationId = await ensureDefaultLocation()
      // Seed each variant explicitly so the product owns no unattributed
      // balance — a parent-keyed movement would otherwise stay unattributed.
      await applyStockMovement({ sku: redSku, variantId: redId, qty: 4, type: 'opening' })
      await applyStockMovement({ sku: whiteSku, variantId: whiteId, qty: 2, type: 'opening' })
      assert.equal(await variantStock(redId), 4)
      assert.equal(await variantStock(whiteId), 2)
      assert.equal(await stockAt(parentSku), 6, 'parent rollup starts at 4 + 2')

      // ── 1. PO → PI: ids survive and the piece-rate money is not re-derived ──
      await db!.insert(schema.purchaseOrders).values({
        id: orderId,
        number: `${marker}-PO`,
        supplier: 'Variant Supplier',
        gst: 3,
        status: 'ordered',
        date: new Date().toISOString(),
      })
      await saveOrderLines(orderId, [
        {
          product: 'Variant Toy - red',
          sku: redSku,
          productId,
          variantId: redId,
          qty: 2,
          // Piece Rate: no grams, no ₹/g — 2 × ₹1,500 is the agreed price.
          weight: 0,
          rate: 0,
          amount: 3000,
        },
      ])

      const ensured = await ensurePurchaseInvoiceForOrder(orderId)
      assert.equal(ensured.ok, true, 'a PO with a supplier and lines must raise an invoice')
      assert.equal(ensured.ok && ensured.action, 'created')

      // The auto invoice mints its own id — find it by the order it is linked to.
      const [autoInvoice] = await db!
        .select()
        .from(schema.purchaseInvoices)
        .where(eq(schema.purchaseInvoices.orderId, orderId))
        .limit(1)
      assert.ok(autoInvoice, 'the invoice must link back to its order')
      autoInvoiceId = autoInvoice.id

      const [piLine] = await db!
        .select()
        .from(schema.purchaseInvoiceItems)
        .where(eq(schema.purchaseInvoiceItems.invoiceId, autoInvoiceId))
        .limit(1)
      assert.ok(piLine, 'the auto invoice must carry the PO line')
      assert.equal(piLine.productId, productId, 'product_id survives the conversion')
      assert.equal(piLine.variantId, redId, 'variant_id survives the conversion')
      assert.equal(Number(piLine.weight), 0, 'a piece-rate line gains no grams')
      assert.equal(Number(piLine.rate), 0, 'a piece-rate line gains no ₹/g rate')
      assert.equal(Number(piLine.cost), 3000, 'the agreed ₹3,000 must not collapse to ₹0')
      assert.equal(Number(piLine.tax), 90, '3% GST rides on the preserved cost')

      // Stock: red credited by 2, white untouched, parent rolled up.
      assert.equal(await variantStock(redId), 6, 'red: 4 + 2')
      assert.equal(await variantStock(whiteId), 2, 'the sibling variant is untouched')
      assert.equal(await stockAt(parentSku), 8, 'the parent total rolls up')
      const [poMovement] = await db!
        .select()
        .from(schema.stockMovements)
        .where(
          and(
            eq(schema.stockMovements.productId, productId),
            eq(schema.stockMovements.type, 'purchase_in'),
          ),
        )
        .limit(1)
      assert.equal(poMovement?.variantId, redId, 'stock_movements.variant_id records the bucket')

      // ── 2. A manual purchase invoice credits the variant it names ──────────
      await db!.insert(schema.purchaseInvoices).values({
        id: invoiceId,
        number: `${marker}-PI`,
        supplier: 'Variant Supplier',
        status: 'pending',
        date: new Date().toISOString(),
        locationId,
      })
      const saved = await saveInvoiceItems(
        db!,
        invoiceId,
        normalizePurchaseItems([
          {
            product: 'Variant Toy - white',
            sku: whiteSku,
            productId,
            variantId: whiteId,
            qty: 1,
            weight: 10,
            rate: 50,
          },
        ]),
        { addStock: true, locationId },
      )
      assert.equal(saved.stocked, 1, 'the weighted line must reach the stock layer')
      assert.equal(await variantStock(whiteId), 3, 'white: 2 + 1')
      assert.equal(await variantStock(redId), 6, 'red is untouched by a white receipt')
      assert.equal(await stockAt(parentSku), 9)

      // ── 3. A received purchase return deducts only that variant ────────────
      await db!.insert(schema.purchaseReturns).values({
        id: returnId,
        number: `${marker}-PR`,
        supplier: 'Variant Supplier',
        status: 'received',
        date: new Date().toISOString(),
      })
      const reversed = await db!.transaction(async (tx) =>
        saveReturnLines(
          tx as never,
          returnId,
          normalizeReturnLines([
            {
              product: 'Variant Toy - red',
              sku: redSku,
              productId,
              variantId: redId,
              qty: 1,
              weight: 0,
              rate: 0,
              amount: 1500,
            },
          ]),
          { reverseStock: true, locationId },
        ),
      )
      assert.equal(reversed.reversed, 1, 'the return must take stock back out')
      assert.equal(await variantStock(redId), 5, 'red: 6 − 1')
      assert.equal(await variantStock(whiteId), 3, 'the sibling variant is untouched')
      assert.equal(await stockAt(parentSku), 8)
      assert.equal(await variantStockTotal(db!, redId), 5, 'the variant holds 5 across locations')
      assert.equal(await levelAt(db!, productId, locationId, redId), 5, 'the red bucket, not the parent')

      const [returnMovement] = await db!
        .select()
        .from(schema.stockMovements)
        .where(
          and(
            eq(schema.stockMovements.productId, productId),
            eq(schema.stockMovements.type, 'purchase_return_out'),
          ),
        )
        .limit(1)
      assert.equal(returnMovement?.variantId, redId, 'the return movement names the variant')
      assert.equal(Number(returnMovement?.qty), -1, 'the return movement is a deduction')
    } finally {
      // Remove everything this test created, children first.
      await db!.delete(schema.stockMovements).where(eq(schema.stockMovements.productId, productId))
      await db!.delete(schema.stockLevels).where(eq(schema.stockLevels.productId, productId))
      if (autoInvoiceId) {
        await db!.delete(schema.purchaseInvoiceItems).where(eq(schema.purchaseInvoiceItems.invoiceId, autoInvoiceId))
        await db!.delete(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.id, autoInvoiceId))
      }
      await db!.delete(schema.purchaseInvoiceItems).where(eq(schema.purchaseInvoiceItems.invoiceId, invoiceId))
      await db!.delete(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.id, invoiceId))
      await db!.delete(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.orderId, orderId))
      await db!.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, orderId))
      await db!.delete(schema.purchaseReturnItems).where(eq(schema.purchaseReturnItems.returnId, returnId))
      await db!.delete(schema.purchaseReturns).where(eq(schema.purchaseReturns.id, returnId))
      await db!.delete(schema.productVariants).where(eq(schema.productVariants.productId, productId))
      await db!.delete(schema.products).where(eq(schema.products.id, productId))
    }
  },
)
