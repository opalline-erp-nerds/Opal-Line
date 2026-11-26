import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import postgres from 'postgres'

// Booking → invoice conversion against the REAL schema in a THROWAWAY scratch
// database (the same pattern as bookings.test.ts / orderStockVariants.test.ts),
// skipped when DATABASE_URL is unset.
//
// What this pins — the variant half of the conversion contract:
//   • the invoice line keeps the EXACT variant the booking sold (variant_id +
//     the variant's own SKU), not just a product-level SKU string;
//   • stock is validated against THAT variant's balance, so a parent product
//     with enough combined stock can still refuse a line its variant cannot
//     cover — the oversell variant stock exists to prevent;
//   • the deduction moves that variant's bucket, leaves its sibling untouched,
//     and the parent rollup is re-derived as the sum of its variants;
//   • stock history records the movement under the parent ledger SKU WITH the
//     variant_id that moved.
//
// The product here is a Piece Rate product (₹2,000/pc) on purpose: its booked
// price must reach the invoice as booked, never re-derived from silver weight.

process.env.OPAL_DISABLE_SHOPIFY_PUSH = '1'
process.env.LOYALTY_ENABLED = 'false'

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_booking_variants_test'

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

test(
  'booking conversion keeps the variant: invoice line, variant-scoped guard, variant deduction, movement history',
  { skip: baseDbUrl ? false : 'DATABASE_URL is not set — needs a local PostgreSQL to create the scratch database' },
  async () => {
    const admin = postgres(baseDbUrl, { max: 1 })
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`)
    } finally {
      await admin.end({ timeout: 5 })
    }

    const previousDbUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = scratchUrl(baseDbUrl)

    try {
      const { bootstrapDatabase } = await import('./db/bootstrap')
      const boot = await bootstrapDatabase()
      assert.equal(boot.tablesCreated, true, 'fresh scratch schema must be created')

      const { db, schema } = await import('./db/client')
      const { convertBookingToInvoice } = await import('./bookings')
      const { applyStockMovement } = await import('./stock')
      const { eq } = await import('drizzle-orm')
      assert.ok(db, 'test database client did not initialize')

      const marker = `bkv-${Date.now()}`
      const parentSku = `${marker}-TOY`
      const redSku = `${parentSku}-RED`
      const whiteSku = `${marker}-TOY-WHI`
      const productId = `${marker}-prod`
      const redId = `${marker}-red`
      const whiteId = `${marker}-white`

      // Invoice creation refuses to run without the authoritative silver rate.
      await db!.insert(schema.silverRates).values({
        id: `${marker}-rate`,
        purity: 92.5,
        rate: 62,
        previousRate: 60,
        updatedAt: new Date().toISOString(),
        change: 2,
        changePercent: 3.33,
        currency: 'INR',
        updatedBy: 'test',
        source: 'manual',
      })

      // A Piece Rate product with two variants: fixed ₹2,000/pc, 200 g of
      // net weight that must NEVER price this line.
      await db!.insert(schema.products).values({
        id: productId,
        name: 'silver toy (test)',
        sku: parentSku,
        category: 'test',
        netWeight: 200,
        makingCharge: 20,
        sellingPrice: 2000,
        pieceRateProduct: true,
        fixedPieceRate: 2000,
        stock: 0,
      })
      await db!.insert(schema.productVariants).values([
        { id: redId, productId, title: 'red', optionValues: ['red'], sku: redSku, sellingPrice: 2200, priceAdjustment: 200, stock: 0 },
        { id: whiteId, productId, title: 'white', optionValues: ['white'], sku: whiteSku, sellingPrice: 2000, priceAdjustment: 0, stock: 0 },
      ])
      // Seed each variant's own balance through the ledger (a variant SKU
      // resolves to that variant alone), so the parent rollup is 5 + 3.
      await applyStockMovement({ sku: redSku, qty: 5, type: 'opening' })
      await applyStockMovement({ sku: whiteSku, qty: 3, type: 'opening' })

      const variantStock = async (id: string) => {
        const [v] = await db!
          .select({ stock: schema.productVariants.stock })
          .from(schema.productVariants)
          .where(eq(schema.productVariants.id, id))
          .limit(1)
        return Number(v?.stock ?? -1)
      }
      const productStock = async () => {
        const [p] = await db!
          .select({ stock: schema.products.stock })
          .from(schema.products)
          .where(eq(schema.products.id, productId))
          .limit(1)
        return Number(p?.stock ?? -1)
      }

      assert.equal(await variantStock(redId), 5, 'red starts with 5')
      assert.equal(await variantStock(whiteId), 3, 'white starts with 3')
      assert.equal(await productStock(), 8, 'the parent is the sum of its variants')

      const booking = (id: string, quantity: number) => ({
        id,
        internalId: `BK${marker}-${id}`,
        customer: `${marker} Buyer`,
        value: 2200 * quantity,
        payment: 'pending',
        fulfillment: 'pending',
        status: 'confirmed',
        date: new Date().toISOString(),
        items: 1,
        tags: 'booking',
        currency: 'INR',
        discount: 0,
        lineItems: [
          {
            title: 'silver toy — red',
            sku: redSku,
            quantity,
            price: 2200,
            priceAdjustment: 200,
            productId,
            variantId: redId,
          },
        ],
        isBooking: true,
        advancePaid: 0,
      })

      const overBooked = booking('over', 7)
      const soldOne = booking('sold', 1)
      await db!.insert(schema.salesOrders).values([overBooked, soldOne])

      // ── The parent has 8, red has 5: a 7-unit red line must be refused.
      //    This is the exact oversell variant stock exists to prevent — a
      //    product-level check would have happily waved it through.
      const refused = await convertBookingToInvoice(overBooked.id)
      assert.equal(refused.ok, false, 'the variant balance refuses what the parent total could cover')
      if (refused.ok === false) {
        assert.equal(refused.status, 409, 'a shortfall answers with the structured stock refusal')
        assert.equal(refused.stock?.products?.[0]?.variantId, redId, 'the refusal names the variant that is short')
      }
      assert.equal(await variantStock(redId), 5, 'a refused conversion moved nothing')
      assert.equal(await productStock(), 8)

      // ── A 1-unit red line converts: the invoice keeps the variant, and
      //    only the red bucket moves.
      const res = await convertBookingToInvoice(soldOne.id, { actor: 'tester' })
      assert.ok(res.ok, JSON.stringify(res))

      const [invoice] = await db!
        .select()
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.number, res.invoiceNumber))
        .limit(1)
      const items = await db!
        .select()
        .from(schema.salesInvoiceItems)
        .where(eq(schema.salesInvoiceItems.invoiceId, invoice!.id))
      assert.equal(items.length, 1, 'one invoice line per booked line')
      assert.equal(items[0]!.variantId, redId, 'the invoice line names the EXACT variant it billed')
      assert.equal(items[0]!.sku, redSku, 'and carries the variant SKU, not the parent one')
      // Booked ₹2,200/pc (fixed ₹2,000 + ₹200 add-on): taxable = 2200 ÷ 1.03
      // = 2135.92 — never 200 g × (rate + making), and never a second add-on.
      assert.equal(Number(items[0]!.priceAdjustment), 200, 'the durable add-on reaches the invoice line')
      assert.equal(Number(items[0]!.amount), 2135.92, 'the inclusive booked price is backed out once')

      assert.equal(await variantStock(redId), 4, 'red alone was deducted')
      assert.equal(await variantStock(whiteId), 3, 'the sibling variant is untouched')
      assert.equal(await productStock(), 7, 'the parent rollup is re-derived as Σ variant stock')

      // ── Stock history: parent ledger SKU (the convention every writer
      //    resolves against) WITH the variant that actually moved.
      const movements = await db!
        .select()
        .from(schema.stockMovements)
        .where(eq(schema.stockMovements.sku, parentSku))
      const sales = movements.filter((m) => m.type === 'sale_out')
      assert.equal(sales.length, 1, 'exactly one sale movement — the refused check wrote none')
      assert.equal(sales[0]!.variantId, redId, 'the movement records the variant_id that moved')
      assert.equal(Number(sales[0]!.qty), -1)
      assert.equal(sales[0]!.refType, 'email_order')

      // The parent invariant holds after the sale: Σ variant stock = rollup.
      const variants = await db!
        .select({ stock: schema.productVariants.stock })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.productId, productId))
      const sum = variants.reduce((a, v) => a + Number(v.stock), 0)
      assert.equal(sum, await productStock(), 'Σ variant stock = products.stock')
    } finally {
      // The whole scratch database goes with it — invoices, movements and the
      // booking rows above are all inside it.
      if (previousDbUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDbUrl
      const cleanup = postgres(baseDbUrl, { max: 1 })
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      } finally {
        await cleanup.end({ timeout: 5 })
      }
    }
  },
)
