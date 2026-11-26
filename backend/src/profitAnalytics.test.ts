import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCostIndex,
  exGstAmount,
  lineCogs,
  parseReturnItems,
  resolveUnitCost,
  returnCogs,
  type ProductCostRow,
  type VariantCostRow,
} from './profitAnalytics'

const products: ProductCostRow[] = [
  { id: 'p-weight', sku: 'SLV-RING', costPrice: 120.5 },
  { id: 'p-piece', sku: 'GIFT-001', costPrice: 45 },
  { id: 'p-no-cost', sku: 'NEW-001', costPrice: null },
  { id: 'p-bad', sku: '0007', costPrice: 81993.67 },
]

const variants: VariantCostRow[] = [
  { id: 'v-red', productId: 'p-weight', sku: 'SLV-RING-RED', costPrice: 150, title: 'Red' },
  { id: 'v-blue', productId: 'p-weight', sku: 'SLV-RING-BLUE', costPrice: null, title: 'Blue' },
  { id: 'v-piece', productId: 'p-piece', sku: 'GIFT-001-RED', costPrice: null, title: 'Red' },
]

const index = buildCostIndex(products, variants)

test('weight-based product: COGS is quantity × per-unit cost, never weight × silver rate', () => {
  const unit = resolveUnitCost({ sku: 'SLV-RING' }, index)
  assert.equal(unit, 120.5)
  assert.equal(lineCogs(3, unit), 361.5)
  // A 9.2 g line billed at a ₹200/g rate is a PRICE, not a cost. If the old
  // weight × rate rule were still in play this would be ₹1,840.
  assert.notEqual(lineCogs(1, unit), 9.2 * 200)
})

test('variant-first resolution uses the exact variant cost, then its parent', () => {
  assert.equal(resolveUnitCost({ sku: 'SLV-RING-RED', variantId: 'v-red' }, index), 150)
  assert.equal(resolveUnitCost({ sku: 'SLV-RING-BLUE', variantId: 'v-blue' }, index), 120.5)
  assert.equal(resolveUnitCost({ sku: 'SLV-RING-RED' }, index), 150)
  assert.equal(lineCogs(2, resolveUnitCost({ sku: 'SLV-RING-RED', variantId: 'v-red' }, index)), 300)
})

test('piece-rate products resolve their ₹/piece cost through variant SKUs', () => {
  assert.equal(resolveUnitCost({ sku: 'GIFT-001' }, index), 45)
  assert.equal(resolveUnitCost({ sku: 'GIFT-001-RED', variantId: 'v-piece' }, index), 45)
  assert.equal(lineCogs(7, resolveUnitCost({ sku: 'GIFT-001-RED', variantId: 'v-piece' }, index)), 315)
})

test('unknown and zero costs never invent a COGS (a missing cost is surfaced, not guessed)', () => {
  assert.equal(resolveUnitCost({ sku: 'NEW-001' }, index), 0)
  assert.equal(resolveUnitCost({ sku: 'NO-SUCH-SKU' }, index), 0)
  assert.equal(lineCogs(5, 0), 0)
  assert.equal(lineCogs(-2, 120.5), 0)
})

test('bad cost prices are reported by the caller, not silently rewritten here', () => {
  assert.equal(resolveUnitCost({ sku: '0007' }, index), 81993.67)
})

test('returns reverse the COGS of the exact SKUs and quantities put back', () => {
  const items = [
    { sku: 'SLV-RING-RED', qty: 1, amount: 4326 },
    { sku: 'GIFT-001', qty: 2, amount: 90 },
  ]
  const soldCogs = items.reduce((sum, it) => sum + lineCogs(it.qty, resolveUnitCost(it, index)), 0)
  assert.equal(soldCogs, 240)
  const reversed = returnCogs(items, index)
  assert.equal(reversed, 240)
  assert.equal(round(soldCogs - reversed), 0)
})

test('return_items jsonb, legacy wrappers and junk rows are parsed safely', () => {
  assert.deepEqual(parseReturnItems([{ sku: 'SLV-RING', qty: 2 }, { sku: '', qty: 3 }, null]), [
    { sku: 'slv-ring', qty: 2 },
  ])
  assert.deepEqual(parseReturnItems({ items: [{ sku: 'GIFT-001', qty: '4' }] }), [{ sku: 'gift-001', qty: 4 }])
  assert.deepEqual(parseReturnItems([{ sku: 'SLV-RING', qty: 1, amount: 3090 }]), [
    { sku: 'slv-ring', qty: 1, amount: 3090 },
  ])
  assert.equal(returnCogs([{ sku: 'NO-SUCH-SKU', qty: 5 }], index), 0)
})

test('ex-GST backs GST-inclusive revenue and discounts out consistently', () => {
  assert.equal(exGstAmount(10300, 3), 10000)
  assert.equal(exGstAmount(3090, 3), 3000)
  assert.equal(exGstAmount(1000, 0), 1000)
  assert.equal(exGstAmount(1000, null), 1000)
  assert.equal(exGstAmount(1000, -101), 1000)
})

const round = (n: number) => Math.round(n * 100) / 100
