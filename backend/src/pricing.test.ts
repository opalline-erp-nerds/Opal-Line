import 'dotenv/config'
import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CONSTANTS } from './constants'

// dotenv has already populated process.env — clear the database URL before the
// route modules load so db/client.ts never opens a real connection in tests.
delete process.env.DATABASE_URL

let dbRoutes: typeof import('./routes/db')
let quotations: typeof import('./routes/quotations')
let shopify: typeof import('./shopify')

before(async () => {
  dbRoutes = await import('./routes/db')
  quotations = await import('./routes/quotations')
  shopify = await import('./shopify')
})

describe('round2 / num helpers', () => {
  test('round2 rounds to two decimals', () => {
    assert.equal(dbRoutes.round2(1234.567), 1234.57)
    assert.equal(dbRoutes.round2(99.999), 100)
    assert.equal(dbRoutes.round2(10.1), 10.1)
    assert.equal(dbRoutes.round2(0), 0)
    assert.equal(dbRoutes.round2(-2.6749), -2.67)
  })

  test('num coerces numeric strings and falls back on garbage', () => {
    assert.equal(dbRoutes.num('42.5', 0), 42.5)
    assert.equal(dbRoutes.num('abc', 7), 7)
    assert.equal(dbRoutes.num(Number.POSITIVE_INFINITY, 3), 3)
    assert.equal(dbRoutes.num(undefined, 5), 5)
    assert.equal(dbRoutes.num(null, 5), 0) // Number(null) === 0
  })
})

describe('normalizeInvoiceItems (invoice line pricing)', () => {
  test('recomputes amount from weight x (rate + makingChargePerGram)', () => {
    // Correct formula: amount = weight × (silverRate + makingChargePerGram)
    // weight=10.5g, silverRate=92.5/g, makingCharge=150/g
    // amount = 10.5 × (92.5 + 150) = 10.5 × 242.5 = 2546.25
    const rows = dbRoutes.normalizeInvoiceItems([
      { product: ' Silver Chain ', sku: ' C1 ', qty: 1, weight: 10.5, silverRate: 92.5, makingCharge: 150 },
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].product, 'Silver Chain')
    assert.equal(rows[0].sku, 'C1')
    assert.equal(rows[0].amount, 2546.25)
    // Verify component values
    assert.equal(rows[0].silverRate, 92.5)
    assert.equal(rows[0].makingCharge, 150)
    assert.equal(rows[0].weight, 10.5)
  })

  test('keeps the provided amount when weight or rate is missing', () => {
    const rows = dbRoutes.normalizeInvoiceItems([
      { product: 'Setting', sku: 'S1', weight: 0, amount: 450 },
      { product: 'Polish', sku: 'P1', weight: 5, silverRate: 0, amount: 100 },
    ])
    assert.equal(rows[0].amount, 450)
    assert.equal(rows[1].amount, 100)
  })

  test('clamps qty to at least 1 and floors fractions', () => {
    const rows = dbRoutes.normalizeInvoiceItems([
      { product: 'A', sku: 'A1', qty: 0, amount: 10 },
      { product: 'B', sku: 'B1', qty: 2.7, amount: 10 },
      { product: 'C', sku: 'C1', amount: 10 },
    ])
    assert.equal(rows[0].qty, 1)
    assert.equal(rows[1].qty, 2)
    assert.equal(rows[2].qty, 1)
  })

  test('drops rows with no sku and no product; coerces numeric strings', () => {
    const rows = dbRoutes.normalizeInvoiceItems([
      { sku: '', product: '', amount: 99 },
      'not-an-object',
      null,
      { product: 'Ring', sku: 'R1', weight: '2.5', silverRate: '40', makingCharge: 0 },
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].amount, 100) // 2.5 x 40
  })

  test('the managed silver rate overrides any client-supplied rate', () => {
    // The whole point of Silver Rate Management: a stale/tampered payload
    // carrying rate=290 must be repriced at the managed rate (300).
    const rows = dbRoutes.normalizeInvoiceItems(
      [{ product: 'Chain', sku: 'C9', weight: 2, silverRate: 290, makingCharge: 0 }],
      300,
    )
    assert.equal(rows[0].silverRate, 300)
    assert.equal(rows[0].amount, 600) // 2g x (300 + 0)
  })

  test('falls back to the provided rate only when no managed rate exists', () => {
    const rows = dbRoutes.normalizeInvoiceItems([
      { product: 'Ring', sku: 'R2', weight: 1, silverRate: 92.5, makingCharge: 0 },
    ])
    assert.equal(rows[0].silverRate, 92.5)
    // A managed rate of 0 (unset) must not zero out pricing.
    const zeroManaged = dbRoutes.normalizeInvoiceItems(
      [{ product: 'Ring', sku: 'R3', weight: 1, silverRate: 92.5, makingCharge: 0 }],
      0,
    )
    assert.equal(zeroManaged[0].silverRate, 92.5)
  })
})

describe('quotation normalization and totals', () => {
  test('computes line amount as round2(weight x (rate + makingChargePerGram))', () => {
    // Correct formula: amount = weight × (silverRate + makingChargePerGram)
    // weight=10.5g, silverRate=92.5/g, makingCharge=150/g
    // amount = 10.5 × (92.5 + 150) = 10.5 × 242.5 = 2546.25
    const rows = quotations.normalizeQuotationItems([
      { product: 'Chain', sku: 'C1', qty: 1, weight: 10.5, silverRate: 92.5, makingCharge: 150 },
    ])
    assert.equal(rows[0].amount, 2546.25)
    assert.equal(rows[0].makingCharge, 150)
  })

  test('rounds once at the end for both paths with the new formula', () => {
    // Both paths now use the same formula: weight × (silverRate + makingChargePerGram)
    // weight=1.005, silverRate=1, makingCharge=0.004
    // amount = 1.005 × (1 + 0.004) = 1.00902 -> rounded to 1.01
    const [quoteRow] = quotations.normalizeQuotationItems([
      { product: 'X', sku: 'X1', weight: 1.005, silverRate: 1, makingCharge: 0.004 },
    ])
    const [invoiceRow] = dbRoutes.normalizeInvoiceItems([
      { product: 'X', sku: 'X1', weight: 1.005, silverRate: 1, makingCharge: 0.004 },
    ])
    assert.equal(quoteRow.amount, 1.01)
    assert.equal(invoiceRow.amount, 1.01)
  })

  test('computeTotals applies GST then discount', () => {
    const items = [{ amount: 1000 }, { amount: 500 }]
    assert.deepEqual(quotations.computeTotals(items, 3, 50), {
      subtotal: 1500,
      gstAmount: 45,
      grandTotal: 1495,
    })
  })

  test('computeTotals rounds GST to two decimals', () => {
    const t = quotations.computeTotals([{ amount: 99.99 }], 3, 0)
    assert.equal(t.subtotal, 99.99)
    assert.equal(t.gstAmount, 3) // 2.9997 -> 3
    assert.equal(t.grandTotal, 102.99)
  })

  test('computeTotals does not clamp a discount above the total', () => {
    const t = quotations.computeTotals([{ amount: 100 }], 3, 500)
    assert.equal(t.grandTotal, -397)
  })

  test('computeTotals with no items and no discount is all zeroes', () => {
    assert.deepEqual(quotations.computeTotals([], 3, 0), { subtotal: 0, gstAmount: 0, grandTotal: 0 })
  })
})

describe('backComputePricing / computeSellingPrice', () => {
  test('rejects non-positive inputs', () => {
    assert.equal(shopify.backComputePricing(0, 92.5), null)
    assert.equal(shopify.backComputePricing(-5, 92.5), null)
    assert.equal(shopify.backComputePricing(100, 0), null)
    assert.equal(shopify.backComputePricing(100, -1), null)
  })

  test('back-computes net weight with the default making charge', () => {
    const r = shopify.backComputePricing(1150, 90)
    assert.ok(r)
    assert.equal(r.makingCharge, CONSTANTS.DEFAULT_MAKING_CHARGE)
    const expected = 1150 / ((90 + CONSTANTS.DEFAULT_MAKING_CHARGE) * 1.03)
    assert.ok(Math.abs(r.netWeight - expected) < 1e-9)
  })

  test('round-trips back to the original selling price', () => {
    for (const price of [500, 1150, 25000.5, 999999.99]) {
      const r = shopify.backComputePricing(price, 92.5)
      assert.ok(r, `price ${price} should back-compute`)
      const reprice = shopify.computeSellingPrice(92.5, r.netWeight, r.makingCharge)
      assert.ok(Math.abs(reprice - price) <= 0.01, `reprice ${reprice} vs original ${price}`)
    }
  })

  test('selling price formula: (rate + making) x netWeight + 3% GST', () => {
    assert.equal(shopify.computeSellingPrice(92.5, 10, 20), 1158.75)
    assert.equal(shopify.computeSellingPrice(0, 10, 0), 0)
  })
})
