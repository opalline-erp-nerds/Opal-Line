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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
