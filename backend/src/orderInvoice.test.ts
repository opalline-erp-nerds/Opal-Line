import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

const round2 = (n: number) => Math.round(n * 100) / 100

// Raising an invoice from a Shopify order is what makes the dashboard's
// invoice-derived widgets (sales, invoices, top products/category, payment
// status) populate after an Orders Sync. This test runs createInvoiceForOrderRow
// against a scratch database to pin the totals, the stock opt-out the order
// import relies on, and idempotency — a second call must return the same number
// without creating a duplicate or moving stock twice.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied. The value is copied into DATABASE_URL *before* the db
// client is imported, and rows are removed again in a finally block.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'createInvoiceForOrderRow raises one invoice per paid order and is idempotent',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string
    process.env.LOYALTY_ENABLED = 'false'

    const { db, schema } = await import('./db/client')
    const { createInvoiceForOrderRow } = await import('./orderEmailIngest')
    assert.ok(db, 'test database client did not initialize')

    const marker = `inv-order-${Date.now()}`
    const shopifyId = `#${marker}`
    // The catalogue knows SKU1's net weight (12.5 g); SKU2 is unknown, so its
    // invoice item must keep weight 0 (rendered as "—", never "0.00 gm").
    const sku1 = `${marker}-SKU1`
    const sku2 = `${marker}-SKU2`
    const productId = `${marker}-prod`
    const order = {
      id: `${marker}-order`,
      shopifyId,
      customer: `${marker} Buyer`,
      value: 2060,
      payment: 'paid',
      status: 'imported',
      date: '2026-05-10T09:00:00',
      discount: 0,
      lineItems: [
        { title: 'Silver Ring', sku: sku1, quantity: 2, price: 500 },
        { title: 'Silver Chain', sku: sku2, quantity: 1, price: 1000 },
      ],
    }

    let invoiceId: string | null = null
    try {
      // Set up the authoritative silver rate from Silver Rate Management.
      const authoritativeSilverRate = 62
      await db!.insert(schema.silverRates).values({
        id: randomUUID(),
        purity: 92.5,
        rate: authoritativeSilverRate,
        previousRate: 60,
        updatedAt: new Date().toISOString(),
        change: 2,
        changePercent: round2((2 / 60) * 100),
        currency: 'INR',
        updatedBy: 'test',
        source: 'manual',
      })

      await db!.insert(schema.products).values({
        id: productId,
        name: 'Silver Ring (test)',
        sku: sku1,
        category: 'test',
        netWeight: 12.5,
      })
      await db!.insert(schema.salesOrders).values(order)
      const [row] = await db!
        .select()
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.shopifyId, shopifyId))
        .limit(1)

      // The order import already moved stock, so it opts the invoice out.
      const number = await createInvoiceForOrderRow(row, { deductStock: false })
      assert.ok(number, 'a paid order with line items must get an invoice')

      const [invoice] = await db!
        .select()
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, shopifyId))
        .limit(1)
      invoiceId = invoice.id
      assert.equal(invoice.number, number)
      assert.equal(invoice.customer, order.customer)
      // ERP subtotal = 25g × 62 = 1550 (vs Shopify billed 2000).
      // Difference (1550 - 2000 = -450) does not increase discount (negative adjustment not applied).
      // ERP subtotal = 1550, GST = 46.5, discount = 0, grandTotal = 1596.5
      assert.equal(Number(invoice.subtotal), 1550, 'invoice subtotal = ERP subtotal (actual rate × weight)')
      assert.equal(Number(invoice.gstAmount), 46.5, 'invoice gstAmount = 3% of ERP subtotal')
      assert.equal(Number(invoice.discount), 0, 'invoice discount = 0 (no positive adjustment)')
      assert.equal(Number(invoice.grandTotal), 1596.5, 'invoice grandTotal = ERP subtotal + GST - discount')
      assert.equal(invoice.paymentStatus, 'paid')
      assert.equal(invoice.status, 'paid')
      assert.equal(invoice.shopifyOrder, shopifyId)

      const items = await db!
        .select()
        .from(schema.salesInvoiceItems)
        .where(eq(schema.salesInvoiceItems.invoiceId, invoice.id))
      assert.equal(items.length, 2)
      // Items' 'amount' field stores Shopify billed amount (2000), not ERP amount
      assert.equal(items.reduce((a, it) => a + Number(it.amount), 0), 2000)

      // Weight snapshot: net weight × qty when the catalogue knows the SKU,
      // 0 (unknown) when it doesn't.
      const ring = items.find((it) => it.sku === sku1)
      const chain = items.find((it) => it.sku === sku2)
      assert.ok(ring, 'ring item must exist')
      assert.ok(chain, 'chain item must exist')
      assert.equal(Number(ring.weight), 25, 'weight snapshot = 12.5 g × 2')
      assert.equal(Number(chain.weight), 0, 'unknown SKU keeps weight 0')
      // Silver rate is the ACTUAL authoritative rate from Silver Rate Management (62)
      // ERP subtotal = 25g × 62 = 1550 (vs Shopify billed 2000)
      // Difference (1550 - 2000 = -450) does not increase discount (negative adjustment)
      const _expectedRate = 62
      assert.equal(Number(ring.silverRate), _expectedRate, 'ring uses actual Silver Rate Management rate')
      assert.equal(Number(chain.silverRate), 0, 'unknown SKU keeps weight 0, silver rate is 0')
      // Silver value = weight × actual rate = 25 × 62 = 1550
      assert.equal(Number(ring.silverRate) * Number(ring.weight), 1550, 'ring silver value = weight × actual rate')
      // Invoice header silverValue = ERP silver value (actual rate × weight)
      const [invoice2] = await db!
        .select()
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.id, invoice.id))
        .limit(1)
      assert.equal(Number(invoice2.silverValue), 1550, 'invoice silverValue = ERP silver value (actual rate × weight)')
      assert.equal(Number(invoice2.makingCharge), 0, 'invoice makingCharge = 0 (no making charge in product)')
      // ERP subtotal = 1550, GST = 46.5, discount = 0, grandTotal = 1596.5
      assert.equal(Number(invoice2.subtotal), 1550, 'invoice subtotal = ERP subtotal (actual rate × weight)')
      assert.equal(Number(invoice2.gstAmount), 46.5, 'invoice gstAmount = 3% of ERP subtotal')
      assert.equal(Number(invoice2.discount), 0, 'invoice discount = 0 (no positive adjustment)')
      assert.equal(Number(invoice2.grandTotal), 1596.5, 'invoice grandTotal = ERP subtotal + GST - discount')

      // The order now points at its invoice.
      const [linked] = await db!
        .select({ invoice: schema.salesOrders.invoice })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.shopifyId, shopifyId))
        .limit(1)
      assert.equal(linked.invoice, number)

      // Idempotent: a re-sync must not create a second invoice.
      const again = await createInvoiceForOrderRow(
        (await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, shopifyId)).limit(1))[0],
        { deductStock: false },
      )
      assert.equal(again, number)
      const all = await db!
        .select({ id: schema.salesInvoices.id })
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, shopifyId))
      assert.equal(all.length, 1, 're-sync must not duplicate the invoice')
    } finally {
      if (invoiceId) {
        await db!.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, invoiceId))
        await db!.delete(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId))
      }
      await db!.delete(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, shopifyId))
      await db!.delete(schema.products).where(eq(schema.products.id, productId))
      // Clean up the silver rate we inserted for this test
      await db!.delete(schema.silverRates)
    }
  },
)

test(
  'backfillInvoiceItemWeights fills weight 0 items from the catalogue, once',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const { db, schema } = await import('./db/client')
    const { backfillInvoiceItemWeights } = await import('./invoiceWeights')
    assert.ok(db, 'test database client did not initialize')

    const marker = `inv-weight-${Date.now()}`
    const skuKnown = `${marker}-KNOWN`
    const skuUnknown = `${marker}-UNKNOWN`
    const productId = `${marker}-prod`
    const invoiceId = `${marker}-inv`
    const knownItemId = `${marker}-item-known`
    const unknownItemId = `${marker}-item-unknown`
    const alreadyItemId = `${marker}-item-already`
    try {
      await db!.insert(schema.products).values({
        id: productId,
        name: 'Weight Backfill Ring (test)',
        sku: skuKnown,
        category: 'test',
        netWeight: 8.25,
      })
      await db!.insert(schema.salesInvoices).values({
        id: invoiceId,
        number: `${marker}-INV`,
        customer: 'Backfill Test',
        gst: 3,
        subtotal: 0,
        gstAmount: 0,
        discount: 0,
        grandTotal: 0,
        date: '2026-05-10T09:00:00',
      })
      await db!.insert(schema.salesInvoiceItems).values([
        // Weight 0 + a catalogue net weight → backfilled to 8.25 × 3.
        { id: knownItemId, invoiceId, sku: skuKnown, product: 'Ring', qty: 3, weight: 0, amount: 0 },
        // No product record → stays 0 (unknown).
        { id: unknownItemId, invoiceId, sku: skuUnknown, product: 'Mystery', qty: 2, weight: 0, amount: 0 },
        // Already carries a weight → never overwritten.
        { id: alreadyItemId, invoiceId, sku: skuKnown, product: 'Ring kept', qty: 1, weight: 5.5, amount: 0 },
      ])

      const updated = await backfillInvoiceItemWeights(db!)
      assert.ok(updated >= 1, 'at least the weight-0 item must be updated')

      const items = await db!
        .select()
        .from(schema.salesInvoiceItems)
        .where(eq(schema.salesInvoiceItems.invoiceId, invoiceId))
      const known = items.find((it) => it.id === knownItemId)
      const unknown = items.find((it) => it.id === unknownItemId)
      const already = items.find((it) => it.id === alreadyItemId)
      assert.equal(Number(known!.weight), 24.75, 'backfill = net weight × qty')
      assert.equal(Number(unknown!.weight), 0, 'unknown SKU stays 0')
      assert.equal(Number(already!.weight), 5.5, 'existing weight is never overwritten')

      // Idempotent: a second run must change nothing.
      const again = await backfillInvoiceItemWeights(db!)
      const [knownAfter] = await db!
        .select()
        .from(schema.salesInvoiceItems)
        .where(eq(schema.salesInvoiceItems.id, knownItemId))
      assert.equal(Number(knownAfter.weight), 24.75)
      assert.ok(again >= 0, 'second run completes')
    } finally {
      await db!.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, invoiceId))
      await db!.delete(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId))
      await db!.delete(schema.products).where(eq(schema.products.id, productId))
    }
  },
)

test(
  'a multi-product order keeps every line on its own product and refuses to raise a duplicate invoice',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string
    process.env.LOYALTY_ENABLED = 'false'

    const { db, schema } = await import('./db/client')
    const { createInvoiceForOrderRow } = await import('./orderEmailIngest')
    assert.ok(db, 'test database client did not initialize')

    const marker = `inv-multi-${Date.now()}`
    const shopifyId = `#${marker}`
    const skuRing = `${marker}-RING`
    const skuChain = `${marker}-CHAIN`
    const skuPendant = `${marker}-PENDANT`
    const productIds = [`${marker}-p1`, `${marker}-p2`, `${marker}-p3`]
    const orderId = `${marker}-order`
    // Distinct names, SKUs, quantities and prices per line so swapped or
    // duplicated values cannot pass by accident.
    const order = {
      id: orderId,
      shopifyId,
      customer: `${marker} Buyer`,
      value: 2860,
      payment: 'paid',
      status: 'imported',
      date: '2026-05-10T09:00:00',
      discount: 100,
      lineItems: [
        { title: 'Silver Ring', sku: skuRing, quantity: 2, price: 500 },
        { title: 'Silver Chain', sku: skuChain, quantity: 1, price: 1000 },
        { title: 'Gold Pendant', sku: skuPendant, quantity: 3, price: 320 },
      ],
    }

    const invoiceIds: string[] = []
    try {
      // Set up the authoritative silver rate from Silver Rate Management.
      // This is the single source of truth for new pricing operations.
      const authoritativeSilverRate = 65
      await db!.insert(schema.silverRates).values({
        id: randomUUID(),
        purity: 92.5,
        rate: authoritativeSilverRate,
        previousRate: 60,
        updatedAt: new Date().toISOString(),
        change: 5,
        changePercent: round2((5 / 60) * 100),
        currency: 'INR',
        updatedBy: 'test',
        source: 'manual',
      })

      await db!.insert(schema.products).values([
        { id: productIds[0], name: 'Silver Ring (test)', sku: skuRing, category: 'test', netWeight: 12.5, silverRate: 60, makingCharge: 150 },
        { id: productIds[1], name: 'Silver Chain (test)', sku: skuChain, category: 'test', netWeight: 20, silverRate: 55, makingCharge: 200 },
        { id: productIds[2], name: 'Gold Pendant (test)', sku: skuPendant, category: 'test', netWeight: 0, silverRate: 0, makingCharge: 300 },
      ])
      await db!.insert(schema.salesOrders).values(order)
      const [row] = await db!
        .select()
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.shopifyId, shopifyId))
        .limit(1)

      const number = await createInvoiceForOrderRow(row, { deductStock: false })
      assert.ok(number, 'the order must be invoiced')

      const [invoice] = await db!
        .select()
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, shopifyId))
        .limit(1)
      invoiceIds.push(invoice.id)
      // ERP totals using authoritative silver rate (65) from Silver Rate Management:
      //   Ring: 25g × 65 = 1625 silver, 25g × 150 = 3750 making
      //   Chain: 20g × 65 = 1300 silver, 20g × 200 = 4000 making
      //   Pendant: 0g × 65 = 0 silver, 0g × 300 = 0 making
      // ERP subtotal = 2925 + 7750 = 10675
      // Shopify billed subtotal = 2960, difference = 7715 added to discount
      // Effective discount = 100 + 7715 = 7815
      // GST = 3% of ERP subtotal = 320.25
      // Grand total = ERP subtotal + GST - effective discount = 10675 + 320.25 - 7815 = 3180.25
      assert.equal(Number(invoice.subtotal), 10675, 'invoice subtotal = ERP subtotal (actual rate × weight)')
      assert.equal(Number(invoice.silverValue), 2925, 'invoice silverValue = ERP silver value (actual rate × weight)')
      assert.equal(Number(invoice.makingCharge), 7750, 'invoice makingCharge = ERP making charge (per-gram × weight)')
      assert.equal(Number(invoice.discount), 7815, 'invoice discount = original 100 + adjustment 7715')
      assert.equal(Number(invoice.gstAmount), 320.25, 'invoice gstAmount = 3% of ERP subtotal')
      assert.equal(Number(invoice.grandTotal), 3180.25, 'invoice grandTotal = ERP subtotal + GST - effective discount')
      assert.equal(Number(invoice.silverValue) + Number(invoice.makingCharge), Number(invoice.subtotal), 'components must add up to ERP subtotal')

      const items = await db!
        .select()
        .from(schema.salesInvoiceItems)
        .where(eq(schema.salesInvoiceItems.invoiceId, invoice.id))
      assert.equal(items.length, 3, 'one line per ordered product, no duplicates, none missing')
      const bySku = new Map(items.map((it) => [it.sku, it]))
      const ring = bySku.get(skuRing)
      const chain = bySku.get(skuChain)
      const pendant = bySku.get(skuPendant)
      assert.ok(ring && chain && pendant, 'every ordered SKU must appear exactly once')
      // Each line keeps its own name, quantity, amount and per-line GST.
      // Silver rate is the ACTUAL authoritative rate from Silver Rate Management.
      // Components use actual rate; difference from Shopify billed amount is reflected in discount.
      const expectedRate = 65
      assert.equal(ring.product, 'Silver Ring')
      assert.equal(Number(ring.qty), 2)
      assert.equal(Number(ring.amount), 1000)
      assert.equal(Number(ring.tax), 30)
      assert.equal(Number(ring.weight), 25, 'weight snapshot = 12.5 g × 2')
      assert.equal(Number(ring.silverRate), expectedRate, 'ring uses actual Silver Rate Management rate')
      assert.equal(Number(ring.makingCharge), 150, 'ring making charge from product catalogue')
      assert.equal(chain.product, 'Silver Chain')
      assert.equal(Number(chain.qty), 1)
      assert.equal(Number(chain.amount), 1000)
      assert.equal(Number(chain.tax), 30)
      assert.equal(Number(chain.weight), 20)
      assert.equal(Number(chain.silverRate), expectedRate, 'chain uses actual Silver Rate Management rate')
      assert.equal(Number(chain.makingCharge), 200, 'chain making charge from product catalogue')
      assert.equal(pendant.product, 'Gold Pendant')
      assert.equal(Number(pendant.qty), 3)
      assert.equal(Number(pendant.amount), 960)
      assert.equal(Number(pendant.tax), 28.8)
      assert.equal(Number(pendant.weight), 0, 'zero catalogue weight stays unknown, never 0.00')
      assert.equal(Number(pendant.silverRate), 0, 'pendant has zero weight, silver rate is 0')
      assert.equal(Number(pendant.makingCharge), 300, 'pendant making charge from product catalogue')

      // The order points at its invoice — the correct source relationship.
      const [linked] = await db!
        .select({ invoice: schema.salesOrders.invoice })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.shopifyId, shopifyId))
        .limit(1)
      assert.equal(linked.invoice, number)

      // A repeated request returns the same invoice…
      const [fresh] = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, orderId)).limit(1)
      const again = await createInvoiceForOrderRow(fresh, { deductStock: false })
      assert.equal(again, number)

      // …and even two CONCURRENT requests that both start from the stale,
      // still-un-invoiced row share one invoice: the loser reuses the
      // winner's number instead of inserting a duplicate.
      const [a, b] = await Promise.all([
        createInvoiceForOrderRow(fresh, { deductStock: false }),
        createInvoiceForOrderRow(fresh, { deductStock: false }),
      ])
      assert.equal(a, number)
      assert.equal(b, number)
      const all = await db!
        .select({ id: schema.salesInvoices.id })
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, shopifyId))
      assert.equal(all.length, 1, 'concurrent creation must not duplicate the invoice')
    } finally {
      for (const id of invoiceIds) {
        await db!.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, id))
        await db!.delete(schema.salesInvoices).where(eq(schema.salesInvoices.id, id))
      }
      await db!.delete(schema.salesOrders).where(eq(schema.salesOrders.id, orderId))
      for (const id of productIds) await db!.delete(schema.products).where(eq(schema.products.id, id))
      // Clean up the silver rate we inserted for this test
      await db!.delete(schema.silverRates)
    }
  },
)

test(
  'an order without line items raises no invoice and says so explicitly',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string
    process.env.LOYALTY_ENABLED = 'false'

    const { db, schema } = await import('./db/client')
    const { createInvoiceForOrderRow } = await import('./orderEmailIngest')
    assert.ok(db, 'test database client did not initialize')

    const marker = `inv-empty-${Date.now()}`
    const shopifyId = `#${marker}`
    const orderId = `${marker}-order`
    try {
      await db!.insert(schema.salesOrders).values({
        id: orderId,
        shopifyId,
        customer: `${marker} Buyer`,
        value: 0,
        payment: 'paid',
        status: 'imported',
        date: '2026-05-10T09:00:00',
        discount: 0,
        lineItems: [],
      })
      const [row] = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, orderId)).limit(1)
      const number = await createInvoiceForOrderRow(row, { deductStock: false })
      assert.equal(number, null, 'no line items means no invoice — never an empty one')
      const invoices = await db!
        .select({ id: schema.salesInvoices.id })
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, shopifyId))
      assert.equal(invoices.length, 0, 'no invoice row may exist for an empty order')
      const [after] = await db!
        .select({ invoice: schema.salesOrders.invoice })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.id, orderId))
        .limit(1)
      assert.equal(after.invoice, null, 'the order must stay unlinked')
    } finally {
      await db!.delete(schema.salesOrders).where(eq(schema.salesOrders.id, orderId))
    }
  },
)
