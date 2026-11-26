import test from 'node:test'
import assert from 'node:assert/strict'
import type { Product } from '@/types'
import {
  findVariantById,
  findVariantBySku,
  hasRealOptions,
  isDefaultVariantName,
  matchProductByCode,
  normalizeVariant,
  productHasVariants,
  productVariants,
  variantAddOn,
  variantEffectivePrice,
  variantFinalPrice,
  variantIsDefaultRow,
  variantLabel,
  variantOptions,
} from './productVariants'

/**
 * Invoice and order flows must not break when the product-variant feature
 * starts populating Product.variants. These tests pin the adapter contract:
 * variants in any reasonable shape are normalized, and products without
 * variants behave exactly as the flat single-SKU catalog always has.
 */

const flatProduct = (over: Partial<Product> = {}): Product => ({
  id: 'p-1',
  name: 'Silver Ring',
  sku: 'RING-42',
  barcode: '8900000000017',
  category: 'Rings',
  collection: '',
  purity: 0,
  grossWeight: 0,
  stoneWeight: 0,
  netWeight: 3.1,
  makingCharge: 0,
  gst: 0,
  hsn: '',
  supplier: '',
  silverRate: 0,
  sellingPrice: 1200,
  stock: 5,
  reorderLevel: 0,
  shopifyStatus: 'synced',
  status: 'active',
  createdAt: '2024-01-01',
  ...over,
})

const variantProduct = () =>
  flatProduct({
    variants: [
      { id: 'v-1', name: '16in', sku: 'RING-42-16', sellingPrice: 1200, stock: 3, barcode: '8900000000100', shopifyVariantId: 111 },
      { id: 'v-2', name: '18in', sku: 'RING-42-18', sellingPrice: 1300, stock: 7, barcode: '8900000000117', shopifyVariantId: 222 },
    ],
  })

test('flat products have no variants', () => {
  const p = flatProduct()
  assert.equal(productHasVariants(p), false)
  assert.deepEqual(productVariants(p), [])
  assert.deepEqual(variantOptions(p), [])
})

test('missing/null variants arrays are treated as flat', () => {
  assert.equal(productHasVariants(flatProduct({ variants: null })), false)
  assert.equal(productHasVariants(flatProduct({ variants: [] })), false)
})

test('variants are exposed with their sku, price, stock and Shopify id', () => {
  const vs = productVariants(variantProduct())
  assert.equal(vs.length, 2)
  assert.deepEqual(vs[0], {
    id: 'v-1',
    name: '16in',
    sku: 'RING-42-16',
    sellingPrice: 1200,
    priceAdjustment: null,
    stock: 3,
    barcode: '8900000000100',
    shopifyVariantId: 111,
  })
})

test('normalizeVariant tolerates Shopify-style field names', () => {
  const v = normalizeVariant({ id: 333, sku: 'CH-9', price: '99.50', inventoryQuantity: 4, option1: 'Gold', option2: null })
  assert.ok(v)
  assert.equal(v.id, '333')
  assert.equal(v.sku, 'CH-9')
  assert.equal(v.sellingPrice, 99.5)
  assert.equal(v.stock, 4)
  assert.equal(v.name, 'Gold')
  assert.equal(v.shopifyVariantId, 333)
})

test('normalizeVariant drops unusable entries', () => {
  assert.equal(normalizeVariant(null), null)
  assert.equal(normalizeVariant({ name: 'Ghost' }), null)
})

test('variant labels fall back to the SKU', () => {
  const [v] = productVariants(flatProduct({ variants: [{ id: 'v-9', sku: 'X-9' }] }))
  assert.ok(v)
  assert.equal(variantLabel(v), 'X-9')
})

test('findVariantById / BySku are exact and case-insensitive', () => {
  const p = variantProduct()
  assert.equal(findVariantById(p, 'v-2')?.sku, 'RING-42-18')
  assert.equal(findVariantById(p, 'nope'), null)
  assert.equal(findVariantBySku(p, 'ring-42-16')?.id, 'v-1')
  assert.equal(findVariantBySku(p, ''), null)
})

test('variant options feed the modal dropdown', () => {
  assert.deepEqual(variantOptions(variantProduct()), [
    { value: 'v-1', label: '16in', subtitle: 'RING-42-16' },
    { value: 'v-2', label: '18in', subtitle: 'RING-42-18' },
  ])
})

test('scan resolution matches product SKU then variant SKU — never a barcode', () => {
  const plain = flatProduct({ id: 'p-2', sku: 'BANGLE-1' })
  const withVars = variantProduct()

  const byProductSku = matchProductByCode([withVars, plain], 'ring-42')
  assert.equal(byProductSku?.product.id, 'p-1')
  assert.equal(byProductSku?.variant, null)

  const byVariantSku = matchProductByCode([plain, withVars], 'RING-42-16')
  assert.equal(byVariantSku?.product.id, 'p-1')
  assert.equal(byVariantSku?.variant?.id, 'v-1')

  // Labels carry a QR encoding ONLY the SKU: legacy barcode values (on the
  // product or its variants) must never resolve to a product.
  assert.equal(matchProductByCode([plain, withVars], '8900000000017'), null)
  assert.equal(matchProductByCode([plain, withVars], '8900000000117'), null)
  assert.equal(matchProductByCode([plain], 'nope'), null)
  assert.equal(matchProductByCode([plain], ''), null)
})

// ── Variant pricing: base + additional amount ────────────────────────────────
// Mirrors backend/src/shopify.ts → variantPushPrice, which is what actually
// reaches Shopify: the ERP selling price is the base, a real option row adds
// its configured amount (618 + 200 → 818), and a "Default Title" mirror row
// (every flat/legacy product) prices from the base alone.

test('real option rows price as base + additional amount', () => {
  assert.equal(variantFinalPrice(618, 200, 'S'), 818, 'base 618 + add-on 200 → 818')
  assert.equal(variantFinalPrice(618, 400, 'M'), 1018, 'base 618 + add-on 400 → 1018')
  assert.equal(variantFinalPrice(618, 0, 'S'), 618, 'no add-on → the base alone')
  assert.equal(variantFinalPrice(618, null, 'S'), 618, 'unpriced row → the base alone')
  assert.equal(variantFinalPrice(618.455, 200, 'S'), 818.46, 'the sum rounds to cents')
})

test('Default Title mirror rows price from the base — never base + stored value', () => {
  // The live bug this pins: a legacy mirror row stored the ABSOLUTE 4800 on a
  // base-4738 product; adding it pushed 9538 to the store.
  assert.equal(variantFinalPrice(4738, 4800, 'Default Title'), 4738)
  assert.equal(variantFinalPrice(500, 500, 'Default Title'), 500, 'base + mirror would wrongly be 1000')
  assert.equal(variantFinalPrice(500, null, 'Default Title'), 500)
  assert.equal(variantFinalPrice(500, 500, ''), 500, 'an unnamed row is a mirror too')
})

test('variantFinalPrice is stable across repeated reads (no double-adding)', () => {
  const base = 618
  const add = 200
  const first = variantFinalPrice(base, add, 'S')
  assert.equal(variantFinalPrice(base, add, 'S'), first, 'the same inputs always re-derive the same price')
  assert.equal(base, 618, 'the stored base is never mutated')
  assert.equal(add, 200, 'the stored add-on is never mutated')
})

test('isDefaultVariantName recognises only the Shopify placeholder', () => {
  assert.equal(isDefaultVariantName('Default Title'), true)
  assert.equal(isDefaultVariantName(' default title '), true)
  assert.equal(isDefaultVariantName(''), true)
  assert.equal(isDefaultVariantName(null), true)
  assert.equal(isDefaultVariantName('S'), false)
  assert.equal(isDefaultVariantName('18in'), false)
})

test('hasRealOptions ignores the single-variant placeholder', () => {
  const placeholder = [{ name: 'Title', values: ['Default Title'] }]
  assert.equal(hasRealOptions(placeholder), false, 'every flat legacy product carries this')
  assert.equal(hasRealOptions([]), false)
  assert.equal(hasRealOptions(null), false)
  assert.equal(hasRealOptions(undefined), false)
  assert.equal(hasRealOptions([{ name: 'Size', values: ['S', 'M'] }]), true)
  assert.equal(hasRealOptions([...placeholder, { name: 'Size', values: ['S'] }]), true)
})

// ── Durable priceAdjustment (the "Add to price (₹)" column) ───────────────────
// selling_price is now the EFFECTIVE price. The add-on lives in its own column;
// legacy rows without it still store the add-on in selling_price.

test('normalizeVariant carries the explicit add-on through the wire shape', () => {
  const v = normalizeVariant({
    id: 'v-1',
    sku: 'OL-SIL-001-RED-LAR',
    title: 'Red / Large',
    sellingPrice: 4526,
    priceAdjustment: 200,
  })
  assert.ok(v)
  assert.equal(v.sellingPrice, 4526, 'effective price survives normalization')
  assert.equal(v.priceAdjustment, 200, 'the durable delta survives normalization')
})

test('variantAddOn reads priceAdjustment and falls back to legacy selling_price', () => {
  assert.equal(variantAddOn({ title: 'Red', priceAdjustment: 200, sellingPrice: 4526 }), 200)
  assert.equal(variantAddOn({ title: 'Red', sellingPrice: 200 }), 200, 'pre-column row')
  assert.equal(variantAddOn({ name: 'Red', priceAdjustment: 0, sellingPrice: 4526 }), 0)
  assert.equal(variantAddOn({ title: 'Red', priceAdjustment: null, sellingPrice: null }), 0)
})

test('variantIsDefaultRow works on the raw catalogue title shape', () => {
  // The catalogue endpoints return `title`, not `name`; reading only `name`
  // made every real row look like a Default-Title mirror.
  assert.equal(variantIsDefaultRow({ title: 'Red', optionValues: ['Red'] }), false)
  assert.equal(variantIsDefaultRow({ name: 'Red', optionValues: ['Red'] }), false)
  assert.equal(variantIsDefaultRow({ title: 'Default Title', optionValues: ['Default Title'] }), true)
  assert.equal(variantAddOn({ title: 'Default Title', sellingPrice: 4800 }), 0)
})

test('variantEffectivePrice re-derives base + add-on without compounding', () => {
  const row = { title: 'Red', priceAdjustment: 200, sellingPrice: 4526 }
  assert.equal(variantEffectivePrice(4326, row), 4526)
  assert.equal(variantEffectivePrice(4326, row), 4526, 'a second read does not add 200 twice')
  assert.equal(variantEffectivePrice(5000, row), 5200, 'a silver-rate reprice keeps +200 above the new base')
  assert.equal(variantEffectivePrice(5000, { title: 'Red', sellingPrice: 200 }), 5200, 'legacy row')
  assert.equal(variantEffectivePrice(4326, { title: 'Default Title', sellingPrice: 4326 }), 4326)
})
