import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPricedOrder } from './orderPricing'

// Regression suite for the order-pricing double count: the create handler
// used to store each line's FULL-quantity ex-GST total in `price`, while the
// edit dialog, the print doc and the update handler all multiply `price` by
// quantity exactly once — so re-editing a qty-3 order billed 3× an already-3×
// price. The stored price must be PER-UNIT (GST-inclusive, matching what the
// frontend sends and what the update handler's `Σ price × quantity` value
// expects), with `amount` keeping the ex-GST line total.
//
// Fixture: 10 g/unit at ₹60/g silver + ₹5/g making:
//   amount (qty 1) = 650, GST 3% → 669.50; qty 3 → 1950 → 2008.50.
const PRODUCTS = [{ sku: 'SKU-RING', netWeight: 10, makingCharge: 5 }]
const RATE = 60

test('quantity 1 vs quantity 3: totals scale once and the stored price stays per-unit', () => {
  const one = buildPricedOrder([{ title: 'Ring', sku: 'SKU-RING', quantity: 1, price: 669.5 }], PRODUCTS, RATE)
  const three = buildPricedOrder([{ title: 'Ring', sku: 'SKU-RING', quantity: 3, price: 2008.5 }], PRODUCTS, RATE)

  assert.equal(one.grandTotal, 669.5)
  assert.equal(three.grandTotal, 2008.5, 'order value is exactly 3× for quantity 3 — never 9×')
  assert.equal(three.itemCount, 3)

  assert.equal(one.lines[0].price, 669.5, 'per-unit GST-inclusive price')
  assert.equal(
    three.lines[0].price,
    669.5,
    'stored price is the PER-UNIT price (₹669.50), not the ₹2,008.50 line total',
  )
  assert.equal(three.lines[0].amount, 1950, 'amount keeps the ex-GST line total (taxable value)')
  assert.equal(three.subtotal, 1950)
  assert.equal(three.gstAmount, 58.5)

  // The update handler recomputes value as Σ price × quantity: with a
  // per-unit stored price that reproduces the create value instead of
  // multiplying the line total by the quantity again.
  const reEditValue = Math.round(three.lines.reduce((s, li) => s + li.price * li.quantity, 0) * 100) / 100
  assert.equal(reEditValue, three.grandTotal, 're-editing the order reproduces the same value')
})

test('per-unit split survives non-divisible rounding within a paisa', () => {
  // 12.37 g/unit @ ₹94.2/g + ₹12/g making, qty 3:
  //   amount = 3941.08, GST-inclusive line = 4059.31, per-unit = 1353.1033… → 1353.10
  //   re-edit value = 1353.10 × 3 = 4059.30 — within 2 paise of 4059.31.
  const three = buildPricedOrder(
    [{ title: 'Ring', sku: 'SKU-RING', quantity: 3, price: 4059.31 }],
    [{ sku: 'SKU-RING', netWeight: 12.37, makingCharge: 12 }],
    94.2,
  )
  assert.equal(three.lines[0].amount, 3941.08)
  assert.equal(three.lines[0].price, 1353.1, 'per-unit split rounds to the paisa')
  assert.equal(three.grandTotal, 4059.31)
  const reEditValue = Math.round(three.lines.reduce((s, li) => s + li.price * li.quantity, 0) * 100) / 100
  assert.ok(Math.abs(reEditValue - three.grandTotal) <= 0.02, `re-edit ${reEditValue} within 2 paise of ${three.grandTotal}`)
})

test('variant lines price through the parent productSku (both variants of one parent)', () => {
  // The frontend sends sku = variant SKU and productSku = parent SKU; weights
  // and making charge live on the parent, so both variant lines share them.
  const lines = buildPricedOrder(
    [
      { title: 'Ring — Small', sku: 'VAR-S', productSku: 'SKU-RING', quantity: 1, price: 669.5 },
      { title: 'Ring — Large', sku: 'VAR-L', productSku: 'SKU-RING', quantity: 2, price: 1339 },
    ],
    PRODUCTS,
    RATE,
  )
  assert.equal(lines.lines[0].price, 669.5)
  assert.equal(lines.lines[1].price, 669.5)
  assert.equal(lines.grandTotal, Math.round(669.5 * 3 * 100) / 100)
  assert.equal(lines.itemCount, 3)
})

test('lines the catalogue does not know price to zero instead of inventing a value', () => {
  const priced = buildPricedOrder([{ title: 'Mystery', sku: 'NOT-IN-CATALOGUE', quantity: 2, price: 100 }], PRODUCTS, RATE)
  assert.equal(priced.lines[0].amount, 0)
  assert.equal(priced.grandTotal, 0)
  assert.equal(priced.itemCount, 2, 'item count still reflects the requested units')
})
