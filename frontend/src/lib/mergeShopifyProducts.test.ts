import test from 'node:test'
import assert from 'node:assert/strict'
import type { Product } from '@/types'
import type { SyncProduct } from '@/types/shopify'
import { mergeShopifyProducts, shopifyProductToProduct } from './mergeShopifyProducts'

/**
 * The QR Labels and Print Designer pages show a merged catalog of local
 * ERP products plus the connected Shopify store's products. These tests pin
 * the contract those pages rely on: Shopify rows appear, duplicates are not
 * added twice, and the fields both pages search on (name / SKU) are
 * populated. The Shopify barcode value is carried through as legacy data
 * only — no screen searches or displays it.
 */

const localProduct = (over: Partial<Product> = {}): Product => ({
  id: 'p-local-1',
  name: 'Silver Ring',
  sku: 'SL-RG-001',
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
  shopifyId: '111',
  status: 'active',
  createdAt: '2024-01-01',
  ...over,
})

const syncProduct = (over: Partial<SyncProduct> = {}): SyncProduct => ({
  id: 222,
  gid: 'gid://shopify/Product/222',
  title: 'Shopify Chain',
  handle: 'shopify-chain',
  vendor: 'Acme',
  productType: 'Chains',
  collection: 'Neck',
  chargeOnTax: true,
  status: 'active',
  sku: 'SH-CH-1',
  barcode: '8901234567890',
  price: '99.50',
  compareAtPrice: '149.00',
  image: 'https://cdn.shopify.com/x.png',
  inventoryQuantity: 7,
  inventoryItemId: 1,
  variantId: 2,
  createdAt: '2024-02-01',
  updatedAt: '2024-02-02',
  ...over,
})

test('appends Shopify-only products to the local catalog', () => {
  const merged = mergeShopifyProducts([localProduct()], [syncProduct()])
  assert.equal(merged.length, 2)
  assert.equal(merged[0].name, 'Silver Ring')
  assert.equal(merged[1].name, 'Shopify Chain')
})

test('mapped Shopify product carries its name, SKU and legacy barcode value', () => {
  const p = shopifyProductToProduct(syncProduct())
  assert.equal(p.name, 'Shopify Chain')
  assert.equal(p.sku, 'SH-CH-1')
  assert.equal(p.barcode, '8901234567890')
  assert.equal(p.sellingPrice, 99.5)
  assert.equal(p.stock, 7)
  assert.equal(p.shopifyStatus, 'synced')
  assert.equal(p.shopifyId, '222')
  assert.equal(p.id, 'shopify:222')
})

test('search by name / SKU finds the merged Shopify product', () => {
  const merged = mergeShopifyProducts([localProduct()], [syncProduct()])
  const matches = (q: string) => {
    const needle = q.toLowerCase()
    return merged.filter((p) => `${p.name} ${p.sku}`.toLowerCase().includes(needle))
  }
  assert.equal(matches('shopify chain').length, 1, 'by name')
  assert.equal(matches('sh-ch-1').length, 1, 'by SKU')
})

test('does not duplicate a product already present locally by SKU', () => {
  const local = localProduct({ sku: 'DUP-1' })
  const shopify = syncProduct({ id: 999, sku: 'dup-1', title: 'Duplicated' })
  const merged = mergeShopifyProducts([local], [shopify])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].name, 'Silver Ring')
})

test('does not duplicate a product already present locally by Shopify id', () => {
  const local = localProduct({ sku: 'LOCAL-SKU', shopifyId: '222' })
  const shopify = syncProduct({ id: 222, sku: 'OTHER-SKU' })
  const merged = mergeShopifyProducts([local], [shopify])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].sku, 'LOCAL-SKU')
})

test('does not add the same Shopify product twice', () => {
  const merged = mergeShopifyProducts([], [syncProduct(), syncProduct()])
  assert.equal(merged.length, 1)
})

test('empty local catalog still yields the Shopify products', () => {
  const merged = mergeShopifyProducts([], [syncProduct(), syncProduct({ id: 333, sku: 'SH-CH-2' })])
  assert.equal(merged.length, 2)
})

test('empty Shopify response yields the local catalog unchanged', () => {
  const local = [localProduct(), localProduct({ id: 'p-local-2', sku: 'SL-RG-002' })]
  const merged = mergeShopifyProducts(local, [])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged, local)
})

test('blank SKUs do not collide across products', () => {
  const merged = mergeShopifyProducts(
    [localProduct({ id: 'p-a', sku: '', barcode: '' })],
    [syncProduct({ id: 444, sku: '', title: 'No SKU Shopify' })],
  )
  assert.equal(merged.length, 2)
})
