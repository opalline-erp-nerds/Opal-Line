import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

/**
 * ERP order lifecycle: a manual sales order is saved, its invoice is raised by
 * the same pipeline Shopify uses, and neither step changes the operator's
 * chosen stage or double-moves stock.
 *
 * Skipped unless DASHBOARD_TEST_DATABASE_URL points at a test database with the
 * schema applied. Rows are removed again in a finally block.
 */
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'an ERP manual order auto-invoices exactly once with its own totals',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string
    process.env.LOYALTY_ENABLED = 'false'

    const { db, schema } = await import('./db/client')
    const { createInvoiceForOrderRow } = await import('./orderEmailIngest')
    assert.ok(db, 'test database client did not initialize')

    const marker = `erp-life-${Date.now()}`
    const rateId = randomUUID()
    const orderId = `${marker}-order`
    const shopifyRef = `MO-${marker}`
    const sku = `${marker}-SKU`
    const customer = `${marker} Buyer`

    try {
      // The invoice pipeline prices against Silver Rate Management, not the
      // per-product legacy rate.
      await db.insert(schema.silverRates).values({
        id: rateId,
        purity: 92.5,
        rate: 65,
        previousRate: 60,
        updatedAt: new Date().toISOString(),
        change: 5,
        changePercent: 8.33,
        currency: 'INR',
        updatedBy: 'test',
        source: 'manual',
      })

      // Exactly the shape the ERP create route stores: `manual-order` tag, an
      // MO- reference, stock already deducted at creation (which is why the
      // invoice is raised with deductStock: false).
      await db.insert(schema.salesOrders).values({
        id: orderId,
        shopifyId: shopifyRef,
        internalId: shopifyRef,
        customer,
        customerEmail: `${marker}@example.com`,
        value: 1699.5,
        payment: 'pending',
        fulfillment: 'unfulfilled',
        invoice: null,
        status: 'confirmed',
        date: new Date().toISOString(),
        items: 2,
        tags: 'manual-order',
        currency: 'INR',
        discount: 0,
        lineItems: [{
          title: 'Lifecycle Ring',
          sku,
          quantity: 2,
          price: 849.75,
          netWeight: 5,
          weight: 10,
          makingCharge: 100,
          silverRate: 65,
          silverValue: 650,
          makingValue: 1000,
          amount: 1650,
        }],
      } as any)

      const [row] = await db
        .select()
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.id, orderId))
        .limit(1)
      assert.ok(row, 'the ERP order must exist before invoicing')

      const number = await createInvoiceForOrderRow(row, { deductStock: false })
      assert.ok(number, 'a valid ERP order must raise an invoice')

      const [invoice] = await db
        .select()
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.number, number as string))
        .limit(1)
      assert.ok(invoice, 'the generated invoice must be stored')
      assert.equal(invoice.customer, customer, 'customer snapshot comes from the order')
      assert.equal(invoice.customerEmail, `${marker}@example.com`)
      assert.equal(invoice.shopifyOrder, shopifyRef, 'the invoice keeps the ERP order reference')
      assert.equal(Number(invoice.subtotal), 1650, 'subtotal = taxable silver + making value')
      assert.equal(Number(invoice.silverValue), 650)
      assert.equal(Number(invoice.makingCharge), 1000)
      assert.equal(Number(invoice.gstAmount), 49.5, 'GST = 3% of the taxable value')
      assert.equal(Number(invoice.discount), 0)
      assert.equal(Number(invoice.grandTotal), 1699.5, 'invoice total = the order value')
      assert.equal(Number(invoice.grandTotal), Number(row.value), 'never a different total from the order')
      assert.equal(invoice.paymentStatus, 'pending')
      assert.equal(invoice.status, 'issued')

      const items = await db
        .select()
        .from(schema.salesInvoiceItems)
        .where(eq(schema.salesInvoiceItems.invoiceId, invoice.id))
      assert.equal(items.length, 1, 'one invoice line per ordered product')
      assert.equal(items[0].product, 'Lifecycle Ring')
      assert.equal(items[0].sku, sku)
      assert.equal(Number(items[0].qty), 2)
      assert.equal(Number(items[0].amount), 1650)
      assert.equal(Number(items[0].tax), 49.5)

      const [linked] = await db
        .select({ invoice: schema.salesOrders.invoice, status: schema.salesOrders.status })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.id, orderId))
        .limit(1)
      assert.equal(linked.invoice, number, 'the order is linked to its invoice')
      assert.equal(linked.status, 'confirmed', 'invoicing must not move or cancel the order stage')

      // A retry (webhook, manual button, second request) must reuse the same
      // invoice number instead of raising a duplicate.
      const again = await createInvoiceForOrderRow({ ...row, invoice: number }, { deductStock: false })
      assert.equal(again, number, 'invoicing is idempotent')
      const invoices = await db
        .select({ id: schema.salesInvoices.id })
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, shopifyRef))
      assert.equal(invoices.length, 1, 'exactly one invoice exists for the order')
    } finally {
      const invoices = await db
        .select({ id: schema.salesInvoices.id })
        .from(schema.salesInvoices)
        .where(eq(schema.salesInvoices.shopifyOrder, shopifyRef))
      for (const inv of invoices) {
        await db.delete(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, inv.id))
        await db.delete(schema.salesInvoices).where(eq(schema.salesInvoices.id, inv.id))
      }
      await db.delete(schema.salesOrders).where(eq(schema.salesOrders.id, orderId))
      await db.delete(schema.silverRates).where(eq(schema.silverRates.id, rateId))
    }
  },
)
