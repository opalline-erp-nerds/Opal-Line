import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  agingBucketFor,
  balanceOf,
  bumpPurchaseInvoiceNumber,
  computeTcs,
  normalizeOrderLines,
  normalizePurchaseItems,
  normalizeReturnLines,
  orderLineTotals,
  purchaseTotals,
  returnLineTotals,
  splitInputGst,
  stateFromGstin,
} from './purchases'

describe('normalizePurchaseItems', () => {
  it('derives cost from weight × rate and taxes on top', () => {
    // weight is the line's total weight, so cost is not multiplied by qty again
    const [line] = normalizePurchaseItems([
      { product: 'Silver bar', sku: 'AG-1', qty: 2, weight: 100, rate: 50, tax: 10 },
    ])
    assert.equal(line.cost, 5000)
    assert.equal(line.tax, 10)
    assert.equal(line.amount, 5010)
    assert.equal(line.qty, 2)
  })

  it('keeps a supplied cost when there is no weight/rate pair', () => {
    const [line] = normalizePurchaseItems([{ product: 'Hallmarking', sku: 'FEE-1', qty: 1, cost: 250 }])
    assert.equal(line.cost, 250)
  })

  it('drops blank lines and floors quantity at 1', () => {
    const lines = normalizePurchaseItems([{ sku: '', product: '  ' }, { sku: 'AG-2', qty: 0 }])
    assert.equal(lines.length, 1)
    assert.equal(lines[0].qty, 1)
  })

  it('ignores a non-array payload', () => {
    assert.deepEqual(normalizePurchaseItems(null), [])
    assert.deepEqual(normalizePurchaseItems('nope'), [])
  })
})

describe('purchaseTotals', () => {
  it('sums weight, qty, cost and tax and derives the effective rate', () => {
    const totals = purchaseTotals(
      normalizePurchaseItems([
        { sku: 'AG-1', weight: 100, rate: 50, tax: 100, qty: 1 },
        { sku: 'AG-2', weight: 100, rate: 60, tax: 120, qty: 2 },
      ]),
    )
    assert.equal(totals.weight, 200)
    assert.equal(totals.qty, 3)
    assert.equal(totals.cost, 11000)
    assert.equal(totals.tax, 220)
    assert.equal(totals.total, 11220)
    assert.equal(totals.rate, 55)
  })
})

describe('stateFromGstin', () => {
  it('maps the GSTIN state code', () => {
    assert.equal(stateFromGstin('27AAAAA0000A1Z5'), 'Maharashtra')
    assert.equal(stateFromGstin('07AAAAA0000A1Z5'), 'Delhi')
    assert.equal(stateFromGstin(''), '')
    assert.equal(stateFromGstin('99XXXXX0000A1Z5'), '')
  })
})

describe('splitInputGst', () => {
  it('splits CGST + SGST when the supplier is in the same state', () => {
    const split = splitInputGst(180, '27AAAAA0000A1Z5', 'Maharashtra')
    assert.equal(split.supplierState, 'Maharashtra')
    assert.equal(split.cgst, 90)
    assert.equal(split.sgst, 90)
    assert.equal(split.igst, 0)
  })

  it('charges IGST in full when the supplier is in another state', () => {
    const split = splitInputGst(180, '29AAAAA0000A1Z5', 'Maharashtra')
    assert.equal(split.supplierState, 'Karnataka')
    assert.equal(split.cgst, 0)
    assert.equal(split.sgst, 0)
    assert.equal(split.igst, 180)
  })

  it('treats a missing supplier GSTIN as intra-state', () => {
    const split = splitInputGst(100, null, 'Maharashtra')
    assert.equal(split.cgst, 50)
    assert.equal(split.sgst, 50)
    assert.equal(split.igst, 0)
  })

  it('is case-insensitive about the state name', () => {
    const split = splitInputGst(100, '27AAAAA0000A1Z5', 'maharashtra')
    assert.equal(split.cgst, 50)
  })
})

describe('computeTcs', () => {
  it('charges TCS on the pre-tax value', () => {
    assert.deepEqual(computeTcs(100000, 1), { tcsRate: 1, tcsAmount: 1000 })
  })

  it('is off when the rate is zero or missing', () => {
    assert.deepEqual(computeTcs(100000, 0), { tcsRate: 0, tcsAmount: 0 })
    assert.deepEqual(computeTcs(100000, undefined), { tcsRate: 0, tcsAmount: 0 })
  })

  it('is off when there is nothing to tax', () => {
    assert.deepEqual(computeTcs(0, 1), { tcsRate: 0, tcsAmount: 0 })
  })
})

describe('balanceOf', () => {
  it('is total minus paid and never goes negative', () => {
    assert.equal(balanceOf({ total: 1000, paidAmount: 400 }), 600)
    assert.equal(balanceOf({ total: 1000, paidAmount: 1000 }), 0)
    assert.equal(balanceOf({ total: 1000, paidAmount: 1200 }), 0)
  })

  it('falls back to the full total for legacy rows with no paid amount', () => {
    assert.equal(balanceOf({ total: 750 }), 750)
    assert.equal(balanceOf({}), 0)
  })
})

describe('agingBucketFor', () => {
  it('treats an invoice due today as current', () => {
    assert.equal(agingBucketFor(0), 'current')
  })

  it('buckets 1–30 days as d1_30', () => {
    assert.equal(agingBucketFor(1), 'd1_30')
    assert.equal(agingBucketFor(30), 'd1_30')
  })

  it('buckets 31–60 days as d31_60', () => {
    assert.equal(agingBucketFor(31), 'd31_60')
    assert.equal(agingBucketFor(60), 'd31_60')
  })

  it('buckets anything past 60 days as d60plus', () => {
    assert.equal(agingBucketFor(61), 'd60plus')
    assert.equal(agingBucketFor(400), 'd60plus')
  })

  it('does not let a bad age leak into a real bucket', () => {
    assert.equal(agingBucketFor(-5), 'current')
    assert.equal(agingBucketFor(NaN), 'current')
  })
})

describe('normalizeOrderLines / orderLineTotals', () => {
  it('totals what was ordered as qty × weight × rate (per-piece weight)', () => {
    const lines = normalizeOrderLines([
      { sku: 'AG-1', qty: 2, weight: 100, rate: 50 },
      { sku: 'AG-2', qty: 1, weight: 50, rate: 60 },
    ])
    // line amounts: 2×100×50 = 10 000 and 1×50×60 = 3 000; header weight is
    // the total grams: 2×100 + 1×50 = 250.
    assert.deepEqual(orderLineTotals(lines), { items: 2, qty: 3, weight: 250, value: 13000 })
  })

  it('ignores blank lines', () => {
    assert.equal(normalizeOrderLines([{ sku: '', product: '' }]).length, 0)
  })
})

describe('normalizeReturnLines / returnLineTotals', () => {
  it('totals what is going back', () => {
    const lines = normalizeReturnLines([
      { sku: 'AG-1', qty: 1, weight: 50, rate: 60 },
      { sku: 'AG-2', qty: 2, weight: 20, rate: 55 },
    ])
    assert.deepEqual(returnLineTotals(lines), { items: 2, weight: 70, amount: 4100 })
  })

  it('floors quantity at 1 and drops blank lines', () => {
    const lines = normalizeReturnLines([{ sku: 'AG-1', qty: 0 }, { sku: '', product: '' }])
    assert.equal(lines.length, 1)
    assert.equal(lines[0].qty, 1)
  })

  it('ignores a non-array payload', () => {
    assert.deepEqual(normalizeReturnLines(null), [])
  })
})

// ── Catalogue identity on purchase lines ─────────────────────────────────────
// A purchase line stores its SKU (never a product id), so the variant a line
// received or returned can only be recovered from the ids saved beside it. A
// blank or absent id is normalised to null — never to the string "undefined" —
// because the stock layer reads null as "the product itself".

describe('catalogue identity on purchase lines', () => {
  it('keeps productId/variantId on a purchase invoice line', () => {
    const [line] = normalizePurchaseItems([
      {
        product: 'silver toy - red',
        sku: 'OL-GIF-001-RED',
        productId: 'prod-1',
        variantId: 'var-red',
        qty: 2,
        weight: 20,
        rate: 50,
      },
    ])
    assert.equal(line.productId, 'prod-1')
    assert.equal(line.variantId, 'var-red')
    // variant SKU is preserved verbatim — it is what the stock layer resolves on
    assert.equal(line.sku, 'OL-GIF-001-RED')
  })

  it('accepts snake_case ids and nulls a blank or missing one', () => {
    const [snake, blank, absent] = normalizePurchaseItems([
      { sku: 'A', product_id: 'p1', variant_id: 'v1' },
      { sku: 'B', productId: '  ', variantId: '' },
      { sku: 'C' },
    ])
    assert.equal(snake.productId, 'p1')
    assert.equal(snake.variantId, 'v1')
    assert.equal(blank.productId, null)
    assert.equal(blank.variantId, null)
    assert.equal(absent.productId, null)
    assert.equal(absent.variantId, null)
  })

  it('keeps the ids on a purchase order line', () => {
    const [line] = normalizeOrderLines([
      { product: 'silver toy - red', sku: 'OL-GIF-001-RED', productId: 'prod-1', variantId: 'var-red', qty: 3, weight: 4, rate: 60 },
    ])
    assert.equal(line.productId, 'prod-1')
    assert.equal(line.variantId, 'var-red')
  })

  it('keeps the ids on a purchase return line', () => {
    const [line] = normalizeReturnLines([
      { product: 'silver toy - red', sku: 'OL-GIF-001-RED', productId: 'prod-1', variantId: 'var-red', qty: 1, weight: 10, rate: 50 },
    ])
    assert.equal(line.productId, 'prod-1')
    assert.equal(line.variantId, 'var-red')
  })

  it('a Piece Rate line keeps the money it was given instead of re-deriving it', () => {
    // weight/rate are deliberately absent: the fixed ₹/pc IS the price, and
    // deriving from 0 grams is what turned a ₹1,500 line into a ₹0 cost.
    const [invoice] = normalizePurchaseItems([{ sku: 'PR-1', variantId: 'v1', qty: 3, cost: 1500 }])
    assert.equal(invoice.weight, 0)
    assert.equal(invoice.rate, 0)
    assert.equal(invoice.cost, 1500)
    assert.equal(invoice.amount, 1500)

    const [order] = normalizeOrderLines([{ sku: 'PR-1', variantId: 'v1', qty: 3, weight: 0, rate: 0, amount: 1500 }])
    assert.equal(order.amount, 1500, 'qty × weight × rate would have been 0')
  })
})

describe('bumpPurchaseInvoiceNumber', () => {
  it('bumps the last digit run, preserving width and padding', () => {
    assert.equal(bumpPurchaseInvoiceNumber('INV-005'), 'INV-006')
    assert.equal(bumpPurchaseInvoiceNumber('PI-2026-0041'), 'PI-2026-0042')
    assert.equal(bumpPurchaseInvoiceNumber('PI-2026-0009'), 'PI-2026-0010')
    // The whole trailing run must advance as one number — bumping only its
    // last digit would turn these into PI-2026-00110 / PI-2026-00910.
    assert.equal(bumpPurchaseInvoiceNumber('PI-2026-0019'), 'PI-2026-0020')
    assert.equal(bumpPurchaseInvoiceNumber('PI-2026-0099'), 'PI-2026-0100')
  })

  it('only bumps the final run in a multi-run number', () => {
    // The year must stay put — only the sequence part advances.
    assert.equal(bumpPurchaseInvoiceNumber('PI-2026-1999'), 'PI-2026-2000')
    assert.equal(bumpPurchaseInvoiceNumber('PI-2025-9999'), 'PI-2025-10000')
  })

  it('bumps by more than one when retrying past a clash', () => {
    assert.equal(bumpPurchaseInvoiceNumber('PI-2026-0041', 3), 'PI-2026-0044')
  })

  it('keeps a non-numeric suffix in place', () => {
    assert.equal(bumpPurchaseInvoiceNumber('INV-005-A'), 'INV-006-A')  })

  it('falls back to a dated suffix when the number has no digits', () => {
    const bumped = bumpPurchaseInvoiceNumber('PROFORMA')
    assert.match(bumped, /^PROFORMA-\d{8}$/)
    // A retried bump on a digit-less number gets its own disambiguator.
    assert.match(bumpPurchaseInvoiceNumber('PROFORMA', 2), /^PROFORMA-\d{8}-2$/)
  })
})