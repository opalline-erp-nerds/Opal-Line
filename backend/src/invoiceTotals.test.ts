import test from 'node:test'
import assert from 'node:assert/strict'
import { invoiceTotals, roundMoney } from './invoiceTotals'

// Canonical money path for every sales invoice (order-raised, manual,
// duplicated and edited) and every quotation: GST on the subtotal, discount
// off the grand total. The invoice screen, the printable HTML and the PDF all
// render these STORED fields, so these pins are what keep them agreeing with
// each other.

test('GST is charged on the subtotal and the discount comes off the grand total', () => {
  const { gstAmount, grandTotal } = invoiceTotals(2000, 3, 100)
  assert.equal(gstAmount, 60)
  assert.equal(grandTotal, 1960)
})

test('decimal subtotals round to the paisa instead of leaking float noise', () => {
  // 333.33 × 3% = 9.9999 → 10.00; grand total keeps the arithmetic visible.
  const { gstAmount, grandTotal } = invoiceTotals(333.33, 3, 0)
  assert.equal(gstAmount, 10)
  assert.equal(grandTotal, 343.33)
})

test('per-line GST rounding lands on the same paisa the invoice stores', () => {
  // 105 × 3% = 3.15 exactly, 101 × 3% = 3.03 exactly, 101.01 × 3% = 3.0303.
  assert.equal(invoiceTotals(105, 3, 0).gstAmount, 3.15)
  assert.equal(invoiceTotals(101, 3, 0).gstAmount, 3.03)
  assert.equal(invoiceTotals(101.01, 3, 0).gstAmount, 3.03)
})

test('a 0% invoice keeps grand total equal to the subtotal', () => {
  const { gstAmount, grandTotal } = invoiceTotals(999.99, 0, 0)
  assert.equal(gstAmount, 0)
  assert.equal(grandTotal, 999.99)
})

test('grand total = subtotal + GST - discount for every combination', () => {
  for (const subtotal of [0, 1, 99.99, 1234.56, 2000]) {
    for (const gst of [0, 3, 5, 18]) {
      for (const discount of [0, 10, 123.45]) {
        const { gstAmount, grandTotal } = invoiceTotals(subtotal, gst, discount)
        assert.equal(roundMoney(subtotal + gstAmount - discount), grandTotal)
        assert.ok(gstAmount >= 0)
      }
    }
  }
})

test('a discount larger than the invoice is kept as recorded, not silently clamped', () => {
  const { grandTotal } = invoiceTotals(100, 3, 500)
  assert.equal(grandTotal, -397)
})
