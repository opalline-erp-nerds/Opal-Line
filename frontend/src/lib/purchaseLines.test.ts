import test from 'node:test'
import assert from 'node:assert/strict'
import type { Product } from '@/types'
import { flattenPurchasableItems } from './sellableItems'
import {
  isPieceRateShaped,
  lineTotalWeight,
  pickPurchaseLine,
  pieceRateAmount,
  pieceRateFromTotal,
  purchaseItemName,
  purchaseLinePricing,
  unitPrice,
} from './purchaseLines'

/**
 * The purchase-side line maths shared by Purchase Orders, Purchase Invoices
 * and Purchase Returns.
 *
 * Two conventions are pinned here, because getting either wrong silently books
 * the wrong money:
 *   - a Piece Rate line is `qty × ₹/pc` and must never be re-derived from
 *     grams of silver;
 *   - the catalogue only knows PER-PIECE grams, while a purchase invoice /
 *     return stores the line's TOTAL grams.
 */

const product = (over: Partial<Product> = {}): Product => ({
  id: 'p-1',
  name: 'silver toy',
  sku: 'OL-GIF-001',
  barcode: null,
  huid: null,
  category: 'Gifts',
  collection: 'Silver Jewels',
  collectionId: null,
  categoryId: null,
  purity: 0,
  grossWeight: 0,
  stoneWeight: 0,
  netWeight: 10,
  makingCharge: 20,
  gst: 3,
  hsn: '',
  supplier: '',
  silverRate: 0,
  sellingPrice: 1287.5,
  pieceRateProduct: null,
  fixedPieceRate: null,
  stock: 8,
  reorderLevel: 0,
  shopifyStatus: 'not-listed',
  status: 'active',
  createdAt: '2026-01-01',
  ...over,
})

const withVariants = () =>
  product({
    variants: [
      { id: 'v-red', productId: 'p-1', name: 'red', sku: 'OL-GIF-001-RED', sellingPrice: 0, stock: 4 },
      { id: 'v-whi', productId: 'p-1', name: 'white', sku: 'OL-GIF-001-WHI', sellingPrice: 100, stock: 2 },
    ],
  })

const pieceRate = () =>
  product({
    pieceRateProduct: true,
    fixedPieceRate: 2000,
    sellingPrice: 2000,
    netWeight: 12,
    variants: [{ id: 'v-red', productId: 'p-1', name: 'red', sku: 'OL-GIF-001-RED', sellingPrice: 0, stock: 4 }],
  })

test('picking a variant fills the variant identity, its code and its name', () => {
  const pick = pickPurchaseLine(flattenPurchasableItems([withVariants()]), 'OL-GIF-001-RED')
  assert.deepEqual(pick, {
    sku: 'OL-GIF-001-RED',
    // The Item column is the only place a variant is NAMED on paper; the SKU
    // column carries its own code alongside it.
    product: 'silver toy - red',
    productId: 'p-1',
    variantId: 'v-red',
    pricingType: 'weight_based',
    // Per-piece grams — the form decides whether to scale by qty.
    weight: '10',
  })
})

test('picking the parent row keeps a null variant so legacy lines still resolve', () => {
  const pick = pickPurchaseLine(flattenPurchasableItems([withVariants()]), 'OL-GIF-001')
  assert.equal(pick?.variantId, null)
  assert.equal(pick?.sku, 'OL-GIF-001')
  assert.equal(pick?.product, 'silver toy')
})

test('a piece-rate pick carries no weight at all', () => {
  const pick = pickPurchaseLine(flattenPurchasableItems([pieceRate()]), 'OL-GIF-001-RED')
  assert.equal(pick?.pricingType, 'piece_rate')
  // Filling per-piece grams here is exactly how a ₹2,000 item was priced as
  // silver: 12 g × rate would overwrite the fixed price.
  assert.equal(pick?.weight, '')
})

test('an unknown or hand-typed code resolves to nothing', () => {
  const items = flattenPurchasableItems([withVariants()])
  assert.equal(pickPurchaseLine(items, 'NOT-IN-CATALOGUE'), null)
  assert.equal(pickPurchaseLine(items, ''), null)
  assert.equal(pickPurchaseLine(items, '   '), null)
})

test('a saved pricing mode always wins over the catalogue', () => {
  const items = flattenPurchasableItems([withVariants()])
  // The row was fixed when it was picked; a catalogue reload must not flip it.
  assert.equal(purchaseLinePricing({ sku: 'OL-GIF-001-RED', pricingType: 'piece_rate' }, items), 'piece_rate')
  assert.equal(purchaseLinePricing({ sku: 'OL-GIF-001', pricingType: 'weight_based' }, items), 'weight_based')
})

test('an unresolved mode falls back to the line code, then to weight-based', () => {
  const items = flattenPurchasableItems([pieceRate(), product({ id: 'p-2', sku: 'OL-BNG-004', name: 'bangle' })])
  assert.equal(purchaseLinePricing({ sku: 'OL-GIF-001-RED', pricingType: '' }, items), 'piece_rate')
  assert.equal(purchaseLinePricing({ sku: 'OL-BNG-004' }, items), 'weight_based')
  // A line saved before variants existed — or typed in by hand — keeps the
  // mode every purchase line had before Piece Rate existed.
  assert.equal(purchaseLinePricing({ sku: 'LEGACY-SKU' }, items), 'weight_based')
})

test('piece-rate money is qty × ₹/pc, rounded to paise', () => {
  assert.equal(pieceRateAmount(1, 500), 500)
  assert.equal(pieceRateAmount('3', '499.99'), 1499.97)
  assert.equal(pieceRateAmount('0', '250'), 250, 'qty floors at 1')
  assert.equal(pieceRateAmount('2', ''), 0)
})

test('a saved line reads as piece-rate only when it has money but no grams or ₹/g', () => {
  assert.equal(isPieceRateShaped(0, 0, 500), true)
  assert.equal(isPieceRateShaped(null, null, 500), true)
  // Weight-based: grams and a rate, so it is never mistaken for piece-rate.
  assert.equal(isPieceRateShaped(10, 55, 550), false)
  // Nothing on the line at all — there is no price to advertise.
  assert.equal(isPieceRateShaped(0, 0, 0), false)
})

test('unit price derives the ₹/pc from the stored line total', () => {
  assert.equal(unitPrice(1500, 3), 500)
  assert.equal(unitPrice(1000, 0), 1000, 'qty floors at 1')
  assert.equal(unitPrice(null, 2), 0)
})

test('a saved piece-rate line reopens at the money it already stored', () => {
  // Every purchase document stores the LINE total, so ₹1,500 over 3 pieces
  // opens at ₹500/pc — not repriced by the catalogue.
  assert.equal(pieceRateFromTotal(1500, 3), '500')
  assert.equal(pieceRateFromTotal(1499.97, 3), '499.99')
  assert.equal(pieceRateFromTotal(0, 3), '')
})

test('per-piece grams scale to the line total a purchase invoice stores', () => {
  assert.equal(lineTotalWeight('10', 3), '30')
  assert.equal(lineTotalWeight('10', '1'), '10')
  assert.equal(lineTotalWeight('0.335', 3), '1.005', 'sub-gram pieces do not lose precision')
  assert.equal(lineTotalWeight('', 3), '', 'a piece-rate line has no grams to scale')
  assert.equal(lineTotalWeight('10', 0), '10', 'qty floors at 1')
})

test('the Item column names a variant as "parent - variant"', () => {
  assert.equal(purchaseItemName({ productName: 'silver toy', variantName: 'red' }), 'silver toy - red')
  assert.equal(purchaseItemName({ productName: 'silver toy', variantName: null }), 'silver toy')
  assert.equal(purchaseItemName({ productName: 'silver toy' }), 'silver toy')
})
