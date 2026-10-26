import test from 'node:test'
import assert from 'node:assert/strict'
import { perUnitLinePrice, orderLinesTotal } from './orderPricing'

// Regression suite for the Sales Order dialog double-count: the pricing
// engine was once called with the line's full quantity and the returned
// (full-quantity) price was then multiplied by quantity again in the
// subtotal, so qty 3 billed 3× the already-3× price. The dialog's
// `li.price` is a PER-UNIT price; every flow — variant selection, quantity
// edits, QR rescans — must produce the same unit price and let the
// subtotal multiply once.
//
// Fixture: 10 g/unit at ₹60/g silver + ₹5/g making = ₹650 + 3% GST = ₹669.50.
const SILVER_RATE = 60
const NET_WEIGHT = 10
const MAKING_CHARGE = 5
const UNIT_PRICE = 669.5

test('quantity 1 and quantity 3 share one per-unit price; the total scales once', () => {
  const unit = perUnitLinePrice({
    silverRate: SILVER_RATE,
    netWeight: NET_WEIGHT,
    makingCharge: MAKING_CHARGE,
    fallback: 999,
  })
  assert.equal(unit, UNIT_PRICE, 'per-unit price ignores quantity entirely')
  assert.equal(orderLinesTotal([{ price: unit, qty: 1 }]), 669.5)
  assert.equal(
    orderLinesTotal([{ price: unit, qty: 3 }]),
    3 * UNIT_PRICE,
    'qty 3 total is exactly 3 × the unit price — never 3 × (price for 3 units)',
  )
})

test('changing the variant reprices per unit from the new line details', () => {
  const small = perUnitLinePrice({
    silverRate: SILVER_RATE,
    netWeight: NET_WEIGHT,
    makingCharge: MAKING_CHARGE,
    fallback: 0,
  })
  // A heavier variant (14 g/unit) at the same rate and making charge.
  const heavy = perUnitLinePrice({
    silverRate: SILVER_RATE,
    netWeight: 14,
    makingCharge: MAKING_CHARGE,
    fallback: 0,
  })
  assert.equal(small, UNIT_PRICE)
  assert.equal(heavy, 937.3, 'heavy variant priced per unit: (840+70)×1.03')
  // The line keeps its quantity through a variant swap (selectVariant only
  // swaps sku/price); the new total is new unit × old qty — once.
  assert.equal(orderLinesTotal([{ price: heavy, qty: 3 }]), 3 * 937.3)
})

test('re-scanning an item bumps qty without inflating the per-unit price', () => {
  // Fresh scan → unit price; each re-scan recomputes with quantity pinned to
  // 1 (the helper never sees the quantity), so the price is stable across
  // rescans and only the qty scales the total.
  const scan = () =>
    perUnitLinePrice({
      silverRate: SILVER_RATE,
      netWeight: NET_WEIGHT,
      makingCharge: MAKING_CHARGE,
      fallback: null,
    })
  assert.equal(scan(), UNIT_PRICE)
  assert.equal(scan(), UNIT_PRICE, 'second scan of the same variant yields the same unit price')
  assert.equal(
    orderLinesTotal([{ price: scan() ?? UNIT_PRICE, qty: 3 }]),
    3 * UNIT_PRICE,
    'three scans of the same QR code total 3 × unit price',
  )
})

test('quantity edits on a line keep the unit price (updateLineItem path)', () => {
  // updateLineItem recomputes per-unit when qty changes and keeps the line's
  // price when nothing can recompute (loaded lines carry no weight).
  const recomputed = perUnitLinePrice({
    silverRate: SILVER_RATE,
    netWeight: NET_WEIGHT,
    makingCharge: MAKING_CHARGE,
    fallback: null,
  })
  assert.equal(recomputed, UNIT_PRICE, 'recompute on qty change refreshes the unit price, not the line total')

  const kept = perUnitLinePrice({ silverRate: SILVER_RATE, netWeight: null, makingCharge: null, fallback: null })
  assert.equal(kept, undefined, 'no weight and no fallback → caller keeps the existing price')
})

test('falls back to the catalog selling price without a rate or billable weight', () => {
  assert.equal(
    perUnitLinePrice({ silverRate: null, netWeight: NET_WEIGHT, makingCharge: MAKING_CHARGE, fallback: 1200 }),
    1200,
    'no silver rate → variant/product selling price as-is',
  )
  assert.equal(
    perUnitLinePrice({ silverRate: SILVER_RATE, netWeight: 0, makingCharge: MAKING_CHARGE, fallback: 800 }),
    800,
    'zero net weight → selling price, no rate maths',
  )
  assert.equal(
    perUnitLinePrice({ silverRate: SILVER_RATE, netWeight: NET_WEIGHT, makingCharge: MAKING_CHARGE, fallback: null }),
    UNIT_PRICE,
    'rate and weight win over a missing fallback',
  )
})

test('orderLinesTotal guards non-finite inputs the way the dialog subtotal did', () => {
  assert.equal(orderLinesTotal([{ price: Number.NaN, qty: 3 }, { price: UNIT_PRICE, qty: 2 }]), 2 * UNIT_PRICE)
})
