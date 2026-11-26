import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseQuotationQty,
  quotationLineAmount,
  quotationLineIssues,
  quotationLineWeight,
  quotationTotals,
} from './quotationPricing'

/**
 * Pins the quotation dialog to the BACKEND pricing rules it mirrors:
 *   amount = weight × (silverRate + makingChargePerGram), making charge per
 *   gram — the flat "weight × rate + making" math the old dialog used is the
 *   root cause of quotes pricing differently from what was stored.
 */

test('line amount = weight × (rate + making per gram), making charge per gram', () => {
  // 10.5g × (92.5 + 150) = 2546.25 — the exact figure the server stores.
  assert.equal(
    quotationLineAmount({ qty: 1, netWeight: 10.5, silverRatePerGram: 92.5, makingChargePerGram: 150, fixedPieceRate: 0 }),
    2546.25,
  )
})

test('qty multiplies the per-piece net weight before pricing', () => {
  // 2pcs × 3.2g = 6.4g total; 6.4 × (92.5 + 150) = 1552
  assert.equal(
    quotationLineAmount({ qty: 2, netWeight: 3.2, silverRatePerGram: 92.5, makingChargePerGram: 150, fixedPieceRate: 0 }),
    1552,
  )
  assert.equal(quotationLineWeight({ qty: 2, netWeight: 3.2 }), 6.4)
})

test('piece-rate lines bill the GST-inclusive fixed rate × qty backed out of tax', () => {
  // Applies applyPieceRateItems server-side: 450 × 3 ÷ 1.03 = 1310.68 — NOT weight math.
  assert.equal(
    quotationLineAmount({ qty: 3, netWeight: 12, silverRatePerGram: 92.5, makingChargePerGram: 200, fixedPieceRate: 450 }),
    1310.68,
  )
})

test('rounds to the paisa like round2 does (single rounding, at the end)', () => {
  // 1.005 × (1 + 0.004) = 1.00902 → 1.01 — matches the backend's single round.
  assert.equal(
    quotationLineAmount({ qty: 1, netWeight: 1.005, silverRatePerGram: 1, makingChargePerGram: 0.004, fixedPieceRate: 0 }),
    1.01,
  )
})

test('totals: GST on the subtotal, discount off the grand total, no double-application', () => {
  const lines = [
    { qty: 1, netWeight: 10, silverRatePerGram: 92.5, makingChargePerGram: 100, fixedPieceRate: 0 }, // 10 × (92.5 + 100) = 1925
    { qty: 2, netWeight: 5, silverRatePerGram: 92.5, makingChargePerGram: 50, fixedPieceRate: 0 }, // 10 × (92.5 + 50) = 1425
  ]
  const totals = quotationTotals(lines, 3, 50)
  // subtotal = 1925 + 1425 = 3350
  assert.equal(totals.subtotal, 3350)
  assert.equal(totals.gstAmount, 100.5)
  assert.equal(totals.grandTotal, 3350 + 100.5 - 50)
  // Invariants: GST is computed from the subtotal only, and the discount is
  // subtracted exactly once.
  assert.equal(totals.gstAmount, totals.subtotal * 0.03)
  assert.equal(
    totals.grandTotal,
    round2Of(totals.subtotal + totals.gstAmount) - 50,
  )
})

test('totals with piece-rate and silver-rate lines mixed', () => {
  const totals = quotationTotals(
    [
      { qty: 2, netWeight: 0, silverRatePerGram: 0, makingChargePerGram: 0, fixedPieceRate: 450 }, // 900 ÷ 1.03 = 873.79
      { qty: 1, netWeight: 10.5, silverRatePerGram: 92.5, makingChargePerGram: 150, fixedPieceRate: 0 }, // 2546.25
    ],
    3,
    0,
  )
  assert.equal(totals.subtotal, 3420.04)
  assert.equal(totals.grandTotal, 3522.64) // 3420.04 × 1.03 = 3522.6412 → .64
})

test('a variant add-on is GST-inclusive on a weight line', () => {
  const amount = quotationLineAmount({
    qty: 1, netWeight: 10.5, silverRatePerGram: 92.5,
    makingChargePerGram: 150, fixedPieceRate: 0, priceAdjustment: 200,
  })
  assert.equal(amount, 2740.42) // 2546.25 + 200 ÷ 1.03
  assert.equal(quotationTotals([{
    qty: 1, netWeight: 10.5, silverRatePerGram: 92.5,
    makingChargePerGram: 150, fixedPieceRate: 0, priceAdjustment: 200,
  }], 3, 0).grandTotal, 2822.63)
})

test('a piece-rate add-on folds into the fixed rate before backing out GST', () => {
  assert.equal(
    quotationLineAmount({
      qty: 3, netWeight: 12, silverRatePerGram: 92.5,
      makingChargePerGram: 200, fixedPieceRate: 450, priceAdjustment: 200,
    }),
    1893.20, // (450 + 200) × 3 ÷ 1.03
  )
})

test('an add-on alone still cannot price a weight line', () => {
  assert.deepEqual(
    quotationLineIssues({
      qty: 1, netWeight: 0, silverRatePerGram: 0,
      makingChargePerGram: 0, fixedPieceRate: 0, priceAdjustment: 200,
    }),
    ['weight per piece is required', 'silver rate or making charge is required to price the line'],
  )
})

test('parseQuotationQty accepts blank as 1 and rejects zero/negative/fraction junk', () => {
  assert.equal(parseQuotationQty(''), 1)
  assert.equal(parseQuotationQty('  3 '), 3)
  assert.equal(parseQuotationQty('0'), null)
  assert.equal(parseQuotationQty('-2'), null)
  assert.equal(parseQuotationQty('2.5'), null)
  assert.equal(parseQuotationQty('abc'), null)
})

test('quotationLineIssues — piece-rate lines need no rates; rate lines need weight and a price component', () => {
  assert.deepEqual(
    quotationLineIssues({ qty: 1, netWeight: 10, silverRatePerGram: 92.5, makingChargePerGram: 0, fixedPieceRate: 0 }),
    [],
  )
  assert.deepEqual(
    quotationLineIssues({ qty: 1, netWeight: 0, silverRatePerGram: 0, makingChargePerGram: 0, fixedPieceRate: 450 }),
    [],
  )
  assert.deepEqual(
    quotationLineIssues({ qty: 0, netWeight: 10, silverRatePerGram: 92.5, makingChargePerGram: 0, fixedPieceRate: 0 }),
    ['quantity must be at least 1'],
  )
  assert.deepEqual(
    quotationLineIssues({ qty: 1, netWeight: 0, silverRatePerGram: 92.5, makingChargePerGram: 0, fixedPieceRate: 0 }),
    ['weight per piece is required'],
  )
  assert.deepEqual(
    quotationLineIssues({ qty: 1, netWeight: 10, silverRatePerGram: 0, makingChargePerGram: 0, fixedPieceRate: 0 }),
    ['silver rate or making charge is required to price the line'],
  )
})

function round2Of(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
