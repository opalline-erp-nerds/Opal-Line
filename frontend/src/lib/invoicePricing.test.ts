import test from 'node:test'
import assert from 'node:assert/strict'
import {
  lineAmount,
  lineMakingValue,
  lineSilverValue,
  invoiceTotalsPreview,
} from './invoicePricing'

// These must match backend `normalizeInvoiceItems` (routes/db.ts) and
// `invoiceTotals` (invoiceTotals.ts) exactly — the dialog previews what the
// server will store. The historical bug was a FLAT making charge here
// (weight*rate + making) while the backend charged per gram
// (weight*(rate + making)), so the shown total never matched the invoice.

test('line amount treats making charge as PER GRAM (weight × (rate + making))', () => {
  // 10.5g at ₹92.5/g rate + ₹150/g making = 10.5 × 242.5 = 2546.25
  assert.equal(
    lineAmount({ weight: 10.5, silverRatePerGram: 92.5, makingChargePerGram: 150 }),
    2546.25,
  )
})

test('a flat making charge would have been wrong: 10g at 300 rate + 20/g making', () => {
  // Backend: 10 × (300 + 20) = 3200. The old flat maths gave 10×300 + 20 = 3020.
  const line = { weight: 10, silverRatePerGram: 300, makingChargePerGram: 20 }
  assert.equal(lineAmount(line), 3200)
  assert.notEqual(lineAmount(line), 3020)
})

test('zero weight yields zero regardless of rate/making', () => {
  assert.equal(lineAmount({ weight: 0, silverRatePerGram: 300, makingChargePerGram: 20 }), 0)
})

test('silver and making components round to the paisa', () => {
  const line = { weight: 2.345, silverRatePerGram: 92.5, makingChargePerGram: 18.25 }
  assert.equal(lineSilverValue(line), round2(2.345 * 92.5))
  assert.equal(lineMakingValue(line), round2(2.345 * 18.25))
  assert.equal(lineAmount(line), round2(lineSilverValue(line) + lineMakingValue(line)))
})

test('totals: GST on subtotal, discount off grand total', () => {
  const lines = [
    { weight: 10, silverRatePerGram: 300, makingChargePerGram: 20 }, // 3200
    { weight: 5, silverRatePerGram: 100, makingChargePerGram: 0 }, // 500
  ]
  const t = invoiceTotalsPreview(lines, 3, 100)
  assert.equal(t.subtotal, 3700)
  assert.equal(t.gstAmount, 111) // 3700 × 3%
  assert.equal(t.grandTotal, 3711) // 3700 + 111 - 100
})

test('totals round GST to two decimals', () => {
  const t = invoiceTotalsPreview([{ weight: 1, silverRatePerGram: 99.99, makingChargePerGram: 0 }], 3, 0)
  assert.equal(t.subtotal, 99.99)
  assert.equal(t.gstAmount, 3) // 2.9997 → 3
  assert.equal(t.grandTotal, 102.99)
})

// ── Piece Rate ────────────────────────────────────────────────────────────────
// A Piece Rate Product bills qty × its fixed ₹/pc; the silver-weight maths
// never applies to it. Mirrors `applyPieceRateItems` (routes/db.ts), which
// rewrites the line the same way on the way into the database.

test('a Piece Rate line bills qty × GST-inclusive fixed price backed out of tax', () => {
  assert.equal(lineAmount({ weight: 0, silverRatePerGram: 0, makingChargePerGram: 0, pieceRate: 2000, qty: 1 }), 1941.75)
  // Even with weight/rates present on the line, the fixed price wins — that is
  // the whole point of the flag.
  assert.equal(
    lineAmount({ weight: 200, silverRatePerGram: 105, makingChargePerGram: 20, pieceRate: 2000, qty: 1 }),
    1941.75,
  )
  // Quantity scales the FIXED price, not the weight.
  assert.equal(lineAmount({ weight: 0, silverRatePerGram: 0, makingChargePerGram: 0, pieceRate: 2000, qty: 3 }), 5825.24)
})

test('a Piece Rate line keeps its whole taxable amount in the silver component', () => {
  const line = { weight: 200, silverRatePerGram: 105, makingChargePerGram: 20, pieceRate: 2000, qty: 1 }
  assert.equal(lineSilverValue(line), lineAmount(line))
  assert.equal(lineMakingValue(line), 0)
})

test('totals put 3% GST back on a Piece Rate subtotal exactly once', () => {
  const t = invoiceTotalsPreview(
    [{ weight: 0, silverRatePerGram: 0, makingChargePerGram: 0, pieceRate: 2000, qty: 1 }],
    3,
    0,
  )
  assert.equal(t.subtotal, 1941.75)
  assert.equal(t.gstAmount, 58.25)
  assert.equal(t.grandTotal, 2000)
})

// ── Variant "Add to price (₹)" ────────────────────────────────────────────────
// The add-on is GST-INCLUSIVE. It reduces the taxable line amount by
// addOn × qty ÷ 1.03; the header's 3% GST puts exactly the add-on back.

test('a weight-based add-on is backed out of GST and returned by the total', () => {
  const t = invoiceTotalsPreview(
    [{ weight: 10, silverRatePerGram: 92.5, makingChargePerGram: 150, qty: 1, priceAdjustment: 200 }],
    3,
    0,
  )
  assert.equal(t.subtotal, 2619.17) // 2425 + 200 ÷ 1.03
  assert.equal(t.gstAmount, 78.58)
  assert.equal(t.grandTotal, 2697.75) // base + ₹200, once
})

test('a piece-rate add-on folds into the fixed price before backing out GST', () => {
  const t = invoiceTotalsPreview(
    [{ weight: 0, silverRatePerGram: 0, makingChargePerGram: 0, pieceRate: 2000, qty: 1, priceAdjustment: 200 }],
    3,
    0,
  )
  assert.equal(t.subtotal, 2135.92) // 2200 ÷ 1.03
  assert.equal(t.gstAmount, 64.08)
  assert.equal(t.grandTotal, 2200)
})

test('a zero add-on never zeroes a line', () => {
  const line = { weight: 10, silverRatePerGram: 300, makingChargePerGram: 20, priceAdjustment: 0 }
  assert.equal(lineAmount(line), 3200)
  assert.equal(lineSilverValue(line), 3000)
  assert.equal(lineMakingValue(line), 200)
})

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
