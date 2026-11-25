import test from 'node:test'
import assert from 'node:assert/strict'
import { bookingPricing } from './bookingPricing'

// The booking form preview must equal what the backend stores: these are the
// SAME fixtures as backend/src/bookings.test.ts ("booking totals use the
// invoice formula"), so a drift between the two halves shows up as a failure
// on one side or the other.

test('a booked total round-trips: taxable + GST returns exactly what was entered', () => {
  const t = bookingPricing([{ price: 1500, qty: 3 }], 7, 0, 0)
  assert.equal(t.linesTotal, 4500, 'lines total = Σ price × qty, GST-inclusive')
  assert.equal(t.taxable, 4205.61, 'the line backed out of 7% GST')
  assert.equal(t.gstAmount, 294.39)
  assert.equal(t.grandTotal, 4500)
})

test('discount and advance drive the grand total and the outstanding balance', () => {
  const t = bookingPricing([{ price: 2000, qty: 2 }], 5, 250, 500)
  assert.equal(t.taxable, 3809.52)
  assert.equal(t.gstAmount, 190.48)
  assert.equal(t.discount, 250)
  assert.equal(t.grandTotal, 3750, 'taxable + GST − discount')
  assert.equal(t.advance, 500)
  assert.equal(t.outstanding, 3250, 'what the customer still owes')

  // An over-advanced booking never shows a negative balance.
  const over = bookingPricing([{ price: 1000, qty: 1 }], 3, 0, 5000)
  assert.equal(over.outstanding, 0)
})

test('zero GST keeps the entered figure exact', () => {
  const t = bookingPricing([{ price: 100, qty: 2 }], 0, 10, 0)
  assert.deepEqual(t, {
    linesTotal: 200,
    taxable: 200,
    gstRate: 0,
    gstAmount: 0,
    discount: 10,
    grandTotal: 190,
    advance: 0,
    outstanding: 190,
  })
})

test('multi-line rounding matches the invoice, within two paise of the entered figure', () => {
  const t = bookingPricing([{ price: 333.33, qty: 3 }, { price: 1999.5, qty: 1 }], 3, 0, 0)
  const entered = Math.round((3 * 333.33 + 1999.5) * 100) / 100
  assert.ok(Math.abs(t.grandTotal - entered) <= 0.02, `grand ${t.grandTotal} within 2 paise of entered ${entered}`)
})

test('junk inputs can never invert the money', () => {
  const t = bookingPricing([{ price: 100, qty: 1 }], -5, -20, -1)
  assert.equal(t.gstRate, 0, 'a negative rate clamps to 0')
  assert.equal(t.discount, 0)
  assert.equal(t.advance, 0)
  assert.equal(t.grandTotal, 100)
  const empty = bookingPricing([], 3, 0, 0)
  assert.equal(empty.grandTotal, 0, 'no lines means no total, never NaN')
  assert.equal(empty.outstanding, 0)
})
