import test from 'node:test'
import assert from 'node:assert/strict'
import type { Product } from '@/types'
import {
  findVariantById,
  findVariantBySku,
  matchProductByCode,
  normalizeVariant,
  productHasVariants,
  productVariants,
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
