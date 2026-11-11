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

// ── Quantity → weight: catalogue weight first, form values only fill gaps ───
test('total weight scales with quantity from the product weight per piece', () => {
  // 10 g/pc: 1 → 10 g, 5 → 50 g, 2 → 20 g (silver jewellery, ₹60/g + ₹5/g making).
  const w = (qty: number) =>
    buildPricedOrder([{ title: 'Ring', sku: 'SKU-RING', quantity: qty, price: 669.5 }], PRODUCTS, RATE).lines[0].weight
  assert.equal(w(1), 10)
  assert.equal(w(5), 50)
  assert.equal(w(2), 20)
  // …and the money follows the weight: 50 g × (60 + 5) = ₹3,250 ex-GST.
  const five = buildPricedOrder([{ title: 'Ring', sku: 'SKU-RING', quantity: 5, price: 669.5 }], PRODUCTS, RATE)
  assert.equal(five.lines[0].amount, 3250)
  assert.equal(five.lines[0].netWeight, 10, 'weight per piece stays the product value')
})

test('a form-supplied weight is honoured; the catalogue fills in when the form sends none', () => {
  // Unknown-to-the-form product: no catalogue row, weight entered manually.
  const manual = buildPricedOrder(
    [{ title: 'Loose stone', sku: 'NO-CAT', quantity: 3, price: 0, netWeight: 2.5, makingCharge: 5 }],
    PRODUCTS,
    RATE,
  )
  assert.equal(manual.lines[0].netWeight, 2.5, 'manual weight-per-piece is honoured')
  assert.equal(manual.lines[0].weight, 7.5, 'total weight = quantity × weight per piece')
  assert.equal(manual.lines[0].amount, 487.5, 'priced from the manual weight (7.5 g × ₹65)')

  // The form's explicit weight wins over the catalogue: a manually edited
  // weight must round-trip through save/refresh instead of silently
  // reverting to the product value. When the form sends none (every client
  // that predates weight editing), the catalogue applies — below.
  const edited = buildPricedOrder(
    [{ title: 'Ring', sku: 'SKU-RING', quantity: 1, price: 669.5, netWeight: 99 }],
    PRODUCTS,
    RATE,
  )
  assert.equal(edited.lines[0].netWeight, 99, 'manual weight-per-piece survives the save')
  assert.equal(edited.lines[0].weight, 99)

  const fromCatalogue = buildPricedOrder(
    [{ title: 'Ring', sku: 'SKU-RING', quantity: 1, price: 669.5 }],
    PRODUCTS,
    RATE,
  )
  assert.equal(fromCatalogue.lines[0].netWeight, 10, 'no form weight → the product weight per piece')
  assert.equal(fromCatalogue.lines[0].weight, 10)
  assert.equal(fromCatalogue.lines[0].amount, 650)
})

test('a manually overridden total weight drives the line pricing', () => {
  // Form said 55 g total for qty 5 (manual edit): silver/making follow it
  // exactly as they follow the derived weight.
  const override = buildPricedOrder(
    [{ title: 'Ring', sku: 'SKU-RING', quantity: 5, price: 0, netWeight: 10, weight: 55 }],
    PRODUCTS,
    RATE,
  )
  assert.equal(override.lines[0].weight, 55)
  assert.equal(override.lines[0].silverValue, 3300, '55 g × ₹60')
  assert.equal(override.lines[0].makingValue, 275, '55 g × ₹5')
  assert.equal(override.lines[0].amount, 3575)

  // A form-supplied making charge is used as-is; without one the catalogue's applies.
  const freeMaking = buildPricedOrder(
    [{ title: 'Ring', sku: 'SKU-RING', quantity: 1, price: 0, weight: 10, makingCharge: 0 }],
    PRODUCTS,
    RATE,
  )
  assert.equal(freeMaking.lines[0].makingValue, 0, 'explicit zero making charge is honoured')
  assert.equal(freeMaking.lines[0].amount, 600, '10 g × ₹60 silver only')
})
