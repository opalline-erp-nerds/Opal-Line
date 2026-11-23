import test from 'node:test'
import assert from 'node:assert/strict'
import { buildManualInvoiceLines, buildPricedOrder, fixedPieceRateFor } from './orderPricing'
import { invoiceTotals } from './invoiceTotals'

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

// ── Order → invoice lines: component rows unchanged, price-only rows fixed ──
// buildManualInvoiceLines feeds createInvoiceForOrderRow's manual branch —
// the path a booking convert takes. Component-shaped rows (order form) must
// bill exactly as before; a price-only row (everything a booking stores) used
// to fall through to a ₹0 line while its stock was still deducted.
const round2 = (n: number) => Math.round(n * 100) / 100

test('a price-only line (booking) bills from its price instead of ₹0', () => {
  // What POST /db/bookings stores: title/sku/quantity/price, nothing else.
  // `price` is PER-UNIT and GST-inclusive for every sales_orders consumer, so
  // the taxable value backs the GST out and adding GST returns the booked sum.
  const [line] = buildManualInvoiceLines([{ title: 'Gold chain', sku: 'GC-1', quantity: 2, price: 5000 }], 3)
  assert.equal(line.amount, 9708.74, '₹10,000 booked → taxable value at 3% GST')
  assert.equal(line.silverValue, line.amount, 'the whole taxable amount sits in silverValue (zero-weight convention)')
  assert.equal(line.makingValue, 0, 'a price-only line has no making component')
  assert.equal(line.tax, 291.26, 'line GST = 3% of the taxable value')
  assert.equal(line.qty, 2)
  assert.equal(line.weight, 0, 'no weight was recorded — never invented')

  // The invoice header maths (invoiceTotals) then reproduces the booking's
  // own value exactly, which is what the advance clamp and the convert
  // endpoint's `balance = value − advance` assume.
  const subtotal = round2(line.silverValue + line.makingValue)
  const { gstAmount, grandTotal } = invoiceTotals(subtotal, 3, 0)
  assert.equal(subtotal, 9708.74)
  assert.equal(gstAmount, 291.26)
  assert.equal(grandTotal, 10000, 'invoice grand total = the amount that was booked')
})

test('a booking discount lands on the invoice the same way it lands on the booking value', () => {
  const lines = buildManualInvoiceLines([{ title: 'Ring', sku: 'R-1', quantity: 1, price: 2060 }], 3)
  const subtotal = round2(lines.reduce((a, l) => a + l.silverValue + l.makingValue, 0))
  // Booking value = 2060 − 100 discount; invoice = subtotal + GST − discount.
  const { grandTotal } = invoiceTotals(subtotal, 3, 100)
  assert.equal(grandTotal, 1960, 'booked 2060 less a 100 discount → invoice total 1960')
})

test('component-shaped lines bill exactly from their components — unchanged', () => {
  // Order-form rows carry their components (buildPricedOrder output): the
  // stored values win outright, price is never consulted.
  const [stored] = buildManualInvoiceLines(
    [{ title: 'Ring', sku: 'SKU-RING', quantity: 2, price: 1339, weight: 20, silverRate: 60, makingCharge: 5, silverValue: 1200, makingValue: 100, amount: 1300 }],
    3,
  )
  assert.equal(stored.amount, 1300)
  assert.equal(stored.silverValue, 1200)
  assert.equal(stored.makingValue, 100)
  assert.equal(stored.tax, 39, 'line GST still runs off the taxable value')
  assert.equal(stored.weight, 20)

  // Components derived from weight when the stored silver/making are absent.
  const [derived] = buildManualInvoiceLines(
    [{ title: 'Ring', sku: 'SKU-RING', quantity: 2, price: 1339, weight: 20, silverRate: 60, makingCharge: 5 }],
    3,
  )
  assert.equal(derived.silverValue, 1200, '20 g × ₹60')
  assert.equal(derived.makingValue, 100, '20 g × ₹5')
  assert.equal(derived.amount, 1300)
})

test('explicit stored components win — an explicit zero is never re-priced from the price', () => {
  // An order-form row the catalogue could not weight stores zeros; its order
  // value was computed from those same zeros, so the invoice must agree with
  // the order rather than inventing an amount from `price`.
  const [line] = buildManualInvoiceLines(
    [{ title: 'Mystery', sku: 'NO-CAT', quantity: 2, price: 100, weight: 0, silverValue: 0, makingValue: 0, amount: 0 }],
    3,
  )
  assert.equal(line.amount, 0)
  assert.equal(line.silverValue, 0)
  assert.equal(line.makingValue, 0)
  assert.equal(line.tax, 0)
})

test('booking lines round to the paisa across a multi-line order', () => {
  const lines = buildManualInvoiceLines(
    [
      { title: 'Chain', sku: 'A', quantity: 3, price: 333.33 },
      { title: 'Payal', sku: 'B', quantity: 1, price: 1999.5 },
    ],
    3,
  )
  const subtotal = round2(lines.reduce((a, l) => a + l.silverValue + l.makingValue, 0))
  const { grandTotal } = invoiceTotals(subtotal, 3, 0)
  const booked = round2(3 * 333.33 + 1999.5)
  assert.ok(Math.abs(grandTotal - booked) <= 0.02, `invoice ${grandTotal} within 2 paise of booked ${booked}`)
})

// ── Piece Rate: the fixed ₹/pc is the price, never weight × (rate + making) ──
// A ₹2,000/pc toy with a 200 g net weight used to arrive as 200 × (rate + making)
// on the manual-order screen. The stored unit price stays the catalogue's fixed
// figure (so Σ price × qty still reproduces the order value on edit) and the
// taxable amount is that GST-inclusive price backed out.

const PIECE_RATE_PRODUCT = [
  {
    sku: 'SKU-TOY',
    netWeight: 200,
    makingCharge: 20,
    pieceRateProduct: true,
    fixedPieceRate: 2000,
    sellingPrice: 2000,
  },
]

test('a Piece Rate line prices from its fixed ₹/pc, never from weight', () => {
  const one = buildPricedOrder(
    [{ title: 'silver toy', sku: 'SKU-TOY', quantity: 1, price: 2000 }],
    PIECE_RATE_PRODUCT,
    RATE,
  )
  assert.equal(one.lines[0].price, 2000, 'unit price is the fixed rate')
  assert.equal(one.lines[0].amount, 1941.75, 'taxable value = the GST-inclusive fixed price backed out')
  assert.equal(one.lines[0].silverRate, 0, 'no silver rate on a fixed-price line')
  assert.equal(one.lines[0].makingCharge, 0, 'no making charge either')
  assert.equal(one.lines[0].silverValue, one.lines[0].amount, 'the whole taxable amount sits in silverValue')
  assert.equal(one.lines[0].makingValue, 0)
  assert.equal(one.grandTotal, 2000, 'the customer pays qty × fixed')
  // The weight maths it replaces would have been 200 g × (60 + 5) = 13,000.
  assert.notEqual(one.lines[0].amount, 13000)
  assert.equal(one.lines[0].weight, 200, 'the physical weight is still recorded on the line')
})

test('quantity scales the fixed price: 3 × ₹2,000 = ₹6,000', () => {
  const three = buildPricedOrder(
    [{ title: 'silver toy', sku: 'SKU-TOY', quantity: 3, price: 6000 }],
    PIECE_RATE_PRODUCT,
    RATE,
  )
  assert.equal(three.lines[0].price, 2000, 'the per-unit price never scales with quantity')
  assert.equal(three.grandTotal, 6000)
  const reEdit = Math.round(three.lines.reduce((s, li) => s + li.price * li.quantity, 0) * 100) / 100
  assert.equal(reEdit, three.grandTotal, 're-editing the order reproduces the same value')
})

test('a variant line takes the parent piece rate through its productSku', () => {
  // loadOrderProductData answers BOTH codes with the parent's pricing inputs,
  // which is what makes a variant of a Piece Rate product bill at the rate.
  const rows = [
    ...PIECE_RATE_PRODUCT,
    { ...PIECE_RATE_PRODUCT[0], sku: 'SKU-TOY-RED' },
  ]
  const [line] = buildPricedOrder(
    [{ title: 'silver toy — red', sku: 'SKU-TOY-RED', productSku: 'SKU-TOY', quantity: 1, price: 2000 }],
    rows,
    RATE,
  ).lines
  assert.equal(line.price, 2000)
  assert.equal(line.amount, 1941.75)
})

test('fixedPieceRateFor reads the flag first, falls back to sellingPrice, and never fires for weight-based rows', () => {
  assert.equal(fixedPieceRateFor({ pieceRateProduct: true, fixedPieceRate: 2000, sellingPrice: 2000 }), 2000)
  // Rows saved before the fixed_piece_rate column existed carry the same
  // number in sellingPrice (setPieceRate writes both).
  assert.equal(fixedPieceRateFor({ pieceRateProduct: true, fixedPieceRate: null, sellingPrice: 1500 }), 1500)
  assert.equal(fixedPieceRateFor({ pieceRateProduct: false, fixedPieceRate: 2000, sellingPrice: 2000 }), null)
  assert.equal(fixedPieceRateFor({ pieceRateProduct: true, fixedPieceRate: 0, sellingPrice: 0 }), null)
  assert.equal(fixedPieceRateFor({}), null)
})
