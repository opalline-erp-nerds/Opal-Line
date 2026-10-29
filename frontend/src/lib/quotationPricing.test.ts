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

test('piece-rate lines bill fixed rate × qty with the rate components zeroed', () => {
  // Applies applyPieceRateItems server-side: 450 × 3 = 1350 — NOT weight math.
  assert.equal(
    quotationLineAmount({ qty: 3, netWeight: 12, silverRatePerGram: 92.5, makingChargePerGram: 200, fixedPieceRate: 450 }),
    1350,
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
      { qty: 2, netWeight: 0, silverRatePerGram: 0, makingChargePerGram: 0, fixedPieceRate: 450 }, // 900
      { qty: 1, netWeight: 10.5, silverRatePerGram: 92.5, makingChargePerGram: 150, fixedPieceRate: 0 }, // 2546.25
    ],
    3,
    0,
  )
  assert.equal(totals.subtotal, 3446.25)
  assert.equal(totals.grandTotal, 3549.64) // 3446.25 × 1.03 = 3549.6375 → .64
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
