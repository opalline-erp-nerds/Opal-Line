import test from 'node:test'
import assert from 'node:assert/strict'

// End-to-end return semantics against the real schema: partial returns, repeat
// partial returns, full returns, over-return rejection, idempotent duplicate
// submissions and the inventory rollup. Like the dashboard scratch tests, it
// only runs when INVOICE_RETURN_TEST_DATABASE_URL points at a scratch database
// with the schema applied — never the app database. Every row carries a unique
// marker and is deleted again in a finally block.
const testUrl = process.env.INVOICE_RETURN_TEST_DATABASE_URL?.trim()

test(
  'invoice returns: quantity-aware partial/multiple/full returns, inventory and statuses',
  { skip: testUrl ? false : 'INVOICE_RETURN_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const { db, schema } = await import('../db/client')
    const invoiceReturn = await import('../invoiceReturn')
    const { applyStockMovement } = await import('../stock')
    const { eq, inArray } = await import('drizzle-orm')
    assert.ok(db, 'test database client did not initialize')

    const marker = `ret-${Date.now()}`
    const skuA = `${marker}-A`
    const skuB = `${marker}-B`
    const invoiceId = `${marker}-inv`

    // ApplyInvoiceReturn exactly the way the route does: caller locks the
    // invoice row inside the same transaction first.
    const runReturn = async (
      items: Array<{ sku: string; qty: number }> | null,
      opts: { restock?: boolean; idempotencyKey?: string } = {},
    ) => {
      return db!.transaction(async (tx) => {
        await tx.select({ id: schema.salesInvoices.id }).from(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId)).limit(1).for('update')
        return invoiceReturn.applyInvoiceReturn(tx, invoiceId, { items, ...opts })
      })
    }
    const productStock = async (sku: string): Promise<number> => {
      const [p] = await db!.select({ stock: schema.products.stock }).from(schema.products).where(eq(schema.products.sku, sku))
      return Number(p?.stock ?? 0)
    }

    try {
      await db!.insert(schema.products).values([
        { id: `${marker}-pa`, name: 'Product A', sku: skuA, category: 'Test', stock: 0 },
        { id: `${marker}-pb`, name: 'Product B', sku: skuB, category: 'Test', stock: 0 },
      ])
      // The sale itself deducted stock for 5 pieces before the sale: A×3, B×2.
      await db!.insert(schema.salesInvoices).values({
        id: invoiceId, number: `${marker}-INV`, customer: 'Test Customer', paymentStatus: 'paid',
        status: 'paid', date: new Date().toISOString(), grandTotal: 500,
      })
      await db!.insert(schema.salesInvoiceItems).values([
        { id: `${marker}-ia`, invoiceId, product: 'Product A', sku: skuA, qty: 3, amount: 300 },
        { id: `${marker}-ib`, invoiceId, product: 'Product B', sku: skuB, qty: 2, amount: 200 },
      ])

      // 1. Partial return: one piece of Product A only. Inventory grows by
      //    exactly 1 for A, and the invoice becomes Partially Returned.
      const first = await runReturn([{ sku: skuA, qty: 1 }])
      assert.ok(first.ok, JSON.stringify(first.ok ? {} : (first as { error?: string }).error))
      const r1 = first.ok ? first.result : null
      assert.equal(r1!.amount, 100)
      assert.equal(r1!.status, 'partially_returned')
      assert.deepEqual(r1!.lines.map((l) => [l.sku, l.returned, l.remaining]), [
        [skuA, 1, 2], [skuB, 0, 2],
      ])
      assert.equal(await productStock(skuA), 1)
      assert.equal(await productStock(skuB), 0)

      // 2. Over-return is rejected while quantity remains — the response
      //    carries the remaining quantity, and nothing hits inventory again.
      const over = await runReturn([{ sku: skuA, qty: 3 }])
      assert.equal(over.ok, false)
      if (!over.ok) assert.match(over.error, /sold 3, 1 already returned, 2 remaining/)
      assert.equal(await productStock(skuA), 1)

      // 3. Duplicate submissions through separate partial returns are fine
      //    only while eligible quantity remains: another single piece of A.
      const second = await runReturn([{ sku: skuA, qty: 1 }])
      assert.ok(second.ok)
      if (second.ok) {
        assert.equal(second.result.status, 'partially_returned')
        assert.deepEqual(second.result.lines.map((l) => [l.sku, l.returned, l.remaining]), [
          [skuA, 2, 1], [skuB, 0, 2],
        ])
      }
      assert.equal(await productStock(skuA), 2)

      // 4. A truly duplicate submission (same intent sent twice — save,
      //    refresh, double click) replays its original credit note via the
      //    idempotency key and never adds inventory a second time.
      const key = `${marker}-b-return`
      const bFirst = await runReturn([{ sku: skuB, qty: 2 }], { idempotencyKey: key })
      assert.ok(bFirst.ok)
      assert.equal(bFirst.ok && bFirst.result.replayed, false)
      assert.equal(await productStock(skuB), 2)
      const bRepeat = await runReturn([{ sku: skuB, qty: 2 }], { idempotencyKey: key })
      assert.ok(bRepeat.ok)
      if (bRepeat.ok) {
        assert.equal(bRepeat.result.replayed, true)
        assert.equal(bRepeat.result.creditNoteNumber, bFirst.ok ? bFirst.result.creditNoteNumber : '')
      }
      assert.equal(await productStock(skuB), 2, 'replay must not restock twice')

      // 5. Now everything returnable is gone: one more piece of A finishes
      //    the invoice (Fully Returned), and further returns are rejected.
      const last = await runReturn([{ sku: skuA, qty: 1 }])
      assert.ok(last.ok)
      if (last.ok) {
        assert.equal(last.result.status, 'fully_returned')
        assert.deepEqual(last.result.lines.map((l) => [l.sku, l.returned, l.remaining]), [
          [skuA, 3, 0], [skuB, 2, 0],
        ])
      }
      const [invAfter] = await db!.select({ status: schema.salesInvoices.status }).from(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId))
      assert.equal(invAfter?.status, 'fully_returned')

      const exhausted = await runReturn([{ sku: skuA, qty: 1 }])
      assert.equal(exhausted.ok, false)
      if (!exhausted.ok) assert.match(exhausted.error, /already been returned/)
      assert.equal(await productStock(skuA), 3, 'no excess restock past the exhausted quantity')

      // 6. A later sale of Product A deducts inventory normally — it must
      //    never be conflated with the previous returns.
      await db!.transaction(async (tx) => {
        await applyStockMovement({ sku: skuA, qty: -1, type: 'sale_out', refType: 'test', tx })
      })
      assert.equal(await productStock(skuA), 2)
    } finally {
      await db!.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, invoiceId))
      await db!.delete(schema.salesReturns).where(eq(schema.salesReturns.invoiceId, invoiceId))
      await db!.delete(schema.payments).where(eq(schema.payments.ref, `${marker}-INV`))
      await db!.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, skuA))
      await db!.delete(schema.stockMovements).where(eq(schema.stockMovements.sku, skuB))
      await db!.delete(schema.stockLevels).where(inArray(schema.stockLevels.productId, [`${marker}-pa`, `${marker}-pb`]))
      await db!.delete(schema.products).where(inArray(schema.products.sku, [skuA, skuB]))
      await db!.delete(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId))
    }
  },
)
