import test from 'node:test'
import assert from 'node:assert/strict'
import type { LocationStockAvailability, Product } from '@/types'
import {
  findSellableBySku,
  flattenPurchasableItems,
  flattenSellableItems,
  parseSellableValue,
  purchasableItemOptions,
  resolveSellableByCode,
  searchSellableItems,
  sellableItemOptions,
  sellableItemPrice,
  sellableItemValue,
} from './sellableItems'

/**
 * The shared catalogue → line-item flattening every sales picker runs on.
 * These tests pin the two behaviours the screens drifted apart on: a variant
 * must be its OWN selectable row (code, label, price, stock), and the pricing
 * mode must decide the autofilled price — a Piece Rate product is never
 * re-priced by silver weight.
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

const pieceRateProduct = () =>
  product({
    pieceRateProduct: true,
    fixedPieceRate: 2000,
    sellingPrice: 2000,
    netWeight: 12,
    makingCharge: 0,
    variants: [{ id: 'v-red', productId: 'p-1', name: 'red', sku: 'OL-GIF-001-RED', sellingPrice: 0, stock: 4 }],
  })

test('a product with variants emits one row per variant, never the parent', () => {
  const items = flattenSellableItems([withVariants()])
  assert.equal(items.length, 2)
  assert.deepEqual(
    items.map((i) => [i.variantId, i.sku, i.label]),
    [
      ['v-red', 'OL-GIF-001-RED', 'silver toy - red (OL-GIF-001-RED)'],
      ['v-whi', 'OL-GIF-001-WHI', 'silver toy - white (OL-GIF-001-WHI)'],
    ],
  )
  // The variant keeps the parent relationship (stock, allocations and Shopify
  // sync all resolve through the product) and the parent's own pricing inputs.
  assert.equal(items[0]!.productId, 'p-1')
  assert.equal(items[0]!.netWeight, 10)
  assert.equal(items[0]!.makingCharge, 20)
  // Stock is the VARIANT's count, not the parent rollup (4 + 2 ≠ 8).
  assert.equal(items[0]!.stock, 4)
  assert.equal(items[1]!.stock, 2)
})

test('a product without variants stays a single row with a null variant', () => {
  const items = flattenSellableItems([product()])
  assert.equal(items.length, 1)
  const [item] = items
  assert.equal(item!.variantId, null)
  assert.equal(item!.sku, 'OL-GIF-001')
  assert.equal(item!.label, 'silver toy (OL-GIF-001)')
  assert.equal(item!.stock, 8)
  assert.equal(item!.pricingType, 'weight_based')
})

test('a Default Title mirror row collapses to the product itself', () => {
  // Every flat/legacy product carries one of these mirror rows; listing it
  // would double plain products in the picker and price them from the mirror's
  // stored value instead of the base.
  const mirrored = product({
    options: [{ name: 'Title', values: ['Default Title'] }],
    variants: [{ id: 'v-1', name: 'Default Title', sku: 'OL-GIF-001', sellingPrice: 2100, stock: 7 }],
  })
  const items = flattenSellableItems([mirrored])
  assert.equal(items.length, 1)
  assert.equal(items[0]!.variantId, null)
  assert.equal(items[0]!.label, 'silver toy (OL-GIF-001)')
  assert.equal(items[0]!.price, 1287.5, "the mirror's stored value is never added to the base")
  assert.equal(items[0]!.stock, 8)
})

test('variant price is base + add-on, so a 0 add-on never bills ₹0', () => {
  const [red, white] = flattenSellableItems([withVariants()])
  assert.equal(red!.price, 1287.5, 'a fresh variant row stores 0 — the base price must survive')
  assert.equal(white!.price, 1387.5, 'a configured add-on is added to the base')
})

test('the durable add-on travels with the sellable row, separate from the effective price', () => {
  const priced = product({
    variants: [
      {
        id: 'v-red',
        productId: 'p-1',
        name: 'red',
        sku: 'OL-GIF-001-RED',
        sellingPrice: 1487.5,
        priceAdjustment: 200,
        stock: 4,
      },
    ],
  })
  const [item] = flattenSellableItems([priced])
  assert.equal(item!.basePrice, 1287.5, 'the parent base is kept apart from the effective price')
  assert.equal(item!.priceAdjustment, 200)
  assert.equal(item!.price, 1487.5)
  // A live silver-rate change rebuilds the BASE and re-adds the same delta.
  assert.equal(sellableItemPrice(item!, { silverRate: 105 }), 1487.5)
  assert.equal(sellableItemPrice(item!, { silverRate: 115 }), 1590.5)
})

test('search matches variant SKU, variant name and parent name — case-insensitively', () => {
  const items = flattenSellableItems([withVariants(), product({ id: 'p-2', name: 'Silver Bangle', sku: 'OL-BNG-004' })])
  assert.deepEqual(searchSellableItems(items, 'ol-gif-001-red').map((i) => i.variantId), ['v-red'])
  assert.deepEqual(searchSellableItems(items, 'WHITE').map((i) => i.variantId), ['v-whi'])
  assert.deepEqual(searchSellableItems(items, 'silver bangle').map((i) => i.productId), ['p-2'])
  // The parent's name is a hit for EVERY one of its variant rows.
  assert.equal(searchSellableItems(items, 'Silver Toy').length, 2)
  assert.deepEqual(searchSellableItems(items, '   '), items, 'a blank query lists everything')
  assert.deepEqual(searchSellableItems(items, 'nope'), [])
})

test('value round-trips a product/variant pair for a saved line', () => {
  const [item] = flattenSellableItems([withVariants()])
  assert.equal(sellableItemValue(item!), 'p-1|v-red')
  assert.deepEqual(parseSellableValue('p-1|v-red'), { productId: 'p-1', variantId: 'v-red' })
  assert.deepEqual(parseSellableValue('p-1|'), { productId: 'p-1', variantId: null })
})

test('options carry the label, the parent-only subtitle and the search keywords', () => {
  const [red, white] = flattenSellableItems([withVariants()])
  const options = sellableItemOptions([red!, white!, ...flattenSellableItems([product()])])
  assert.equal(options[0]!.value, 'p-1|v-red')
  assert.equal(options[0]!.label, 'silver toy - red (OL-GIF-001-RED)')
  assert.equal(options[0]!.subtitle, undefined, "a variant's code is already in its label")
  assert.equal(options[2]!.subtitle, 'OL-GIF-001', 'the parent row keeps its SKU underneath')
  assert.ok(options[0]!.keywords.includes('OL-GIF-001-RED'))
  assert.ok(options[0]!.keywords.includes('silver toy'))
})

test('Piece Rate autofills the fixed price — never the silver-weight maths', () => {
  const [item] = flattenSellableItems([pieceRateProduct()])
  assert.equal(item!.pricingType, 'piece_rate')
  assert.equal(item!.fixedPieceRate, 2000)
  // 12 g × (₹105 + ₹0) + 3% would be ₹1289.80 — the fixed rate must win.
  assert.equal(sellableItemPrice(item!, { silverRate: 105 }), 2000)
})

test('Piece Rate adds the variant add-on once, on top of the fixed price', () => {
  const priced = pieceRateProduct()
  priced.variants = [
    { id: 'v-red', productId: 'p-1', name: 'red', sku: 'OL-GIF-001-RED', sellingPrice: 2200, priceAdjustment: 200, stock: 4 },
  ]
  const [item] = flattenSellableItems([priced])
  assert.equal(sellableItemPrice(item!, { silverRate: 105 }), 2200, 'base 2000 + add-on 200')
})

test('weight-based autofill uses the managed silver rate calculation', () => {
  const [item] = flattenSellableItems([withVariants()])
  assert.equal(item!.pricingType, 'weight_based')
  assert.equal(item!.fixedPieceRate, null)
  // (105 + 20) × 10 g = 1250 + 3% GST = 1287.50 per piece.
  assert.equal(sellableItemPrice(item!, { silverRate: 105 }), 1287.5)
  // No rate yet → the catalogue price, so the field is never left blank.
  assert.equal(sellableItemPrice(item!, { silverRate: 0 }), 1287.5)
})

test('per-store stock attaches to the matching product/variant pair only', () => {
  const availability: Record<string, LocationStockAvailability> = {
    'p-1|v-red': {
      locations: [
        { locationId: 'LOC-DEFAULT', name: 'Main Store', available: 3 },
        { locationId: 'LOC-2', name: 'Kiosk', available: 1 },
      ],
      combined: 4,
    },
  }
  const items = flattenSellableItems([withVariants()], availability)
  assert.deepEqual(items[0]!.stores, [
    { locationId: 'LOC-DEFAULT', name: 'Main Store', available: 3 },
    { locationId: 'LOC-2', name: 'Kiosk', available: 1 },
  ])
  assert.deepEqual(items[1]!.stores, [], 'the white variant asked for nothing — it gets nothing')
})

// ── Scan resolution ───────────────────────────────────────────────────────────
// The QR/SKU box must resolve the code a label carries — the variant SKU — and
// also the names a counter might type, case-insensitively.

test('resolveSellableByCode matches the variant SKU exactly, in any case', () => {
  const items = flattenSellableItems([withVariants(), product({ id: 'p-2', name: 'Silver Bangle', sku: 'OL-BNG-004' })])
  assert.equal(resolveSellableByCode(items, 'OL-GIF-001-RED')?.variantId, 'v-red')
  assert.equal(resolveSellableByCode(items, '  ol-gif-001-whi ')?.variantId, 'v-whi')
  assert.equal(resolveSellableByCode(items, 'OL-BNG-004')?.variantId, null)
})

test('resolveSellableByCode matches a variant name or a product name', () => {
  const items = flattenSellableItems([withVariants(), product({ id: 'p-2', name: 'Silver Bangle', sku: 'OL-BNG-004' })])
  assert.equal(resolveSellableByCode(items, 'red')?.variantId, 'v-red', 'the variant name on its own resolves')
  assert.equal(resolveSellableByCode(items, 'Silver Bangle')?.productId, 'p-2', 'a flat product resolves by name')
})

// ── Purchase-side flattening ──────────────────────────────────────────────────
// Purchase documents store the SKU on the line (never a product id) and every
// saved PO / Purchase Invoice / Purchase Return predates variants. So the
// purchase picker offers the parent AND its variants, and keys each option by
// the code the line actually carries.

test('the purchase flatten keeps the parent row alongside every variant', () => {
  const items = flattenPurchasableItems([withVariants()])
  assert.deepEqual(
    items.map((i) => [i.variantId, i.sku]),
    [
      [null, 'OL-GIF-001'],
      ['v-red', 'OL-GIF-001-RED'],
      ['v-whi', 'OL-GIF-001-WHI'],
    ],
  )
  // A parent-keyed credit is a real receiving target, so the parent row still
  // answers for its own code even when the product has variants.
  assert.equal(items[0]!.productId, 'p-1')
  assert.equal(items[0]!.pricingType, 'weight_based')
  assert.equal(items[1]!.stock, 4, "a variant row reports the variant's own count")
})

test('the purchase flatten collapses a Default Title mirror but keeps the parent', () => {
  const mirrored = product({
    options: [{ name: 'Title', values: ['Default Title'] }],
    variants: [{ id: 'v-1', name: 'Default Title', sku: 'OL-GIF-001', sellingPrice: 2100, stock: 7 }],
  })
  const items = flattenPurchasableItems([mirrored])
  assert.equal(items.length, 1, 'the mirror IS the product — not a second row')
  assert.equal(items[0]!.variantId, null)
  assert.equal(items[0]!.price, 1287.5)
})

test('a flat product is one purchase row with a null variant', () => {
  const items = flattenPurchasableItems([product()])
  assert.equal(items.length, 1)
  assert.equal(items[0]!.variantId, null)
  assert.equal(items[0]!.sku, 'OL-GIF-001')
})

test('purchase options use the line code as their value, not a product/variant pair', () => {
  const options = purchasableItemOptions(flattenPurchasableItems([withVariants()]))
  assert.deepEqual(
    options.map((o) => o.value),
    ['OL-GIF-001', 'OL-GIF-001-RED', 'OL-GIF-001-WHI'],
  )
  // The variant's code is already in its label, so there is no subtitle to
  // repeat it; the parent keeps its code underneath the name.
  assert.equal(options[0]!.subtitle, 'OL-GIF-001')
  assert.equal(options[1]!.subtitle, undefined)
  assert.ok(options[1]!.keywords.includes('silver toy'))
  assert.ok(options[1]!.keywords.includes('red'))
})

test('findSellableBySku resolves a parent or a variant code, in any case', () => {
  const items = flattenPurchasableItems([withVariants(), product({ id: 'p-2', name: 'bangle', sku: 'OL-BNG-004' })])
  assert.equal(findSellableBySku(items, 'ol-gif-001-red')?.variantId, 'v-red')
  assert.equal(findSellableBySku(items, '  OL-GIF-001  ')?.variantId, null)
  assert.equal(findSellableBySku(items, 'OL-BNG-004')?.productId, 'p-2')
  assert.equal(findSellableBySku(items, 'not-here'), null)
  assert.equal(findSellableBySku(items, ''), null)
})

test('an ambiguous product name resolves to nothing — the picker must choose', () => {
  const items = flattenSellableItems([withVariants()])
  // "silver toy" names BOTH of its variants; guessing would book the wrong stock.
  assert.equal(resolveSellableByCode(items, 'silver toy'), null)
  assert.equal(resolveSellableByCode(items, 'nope'), null)
  assert.equal(resolveSellableByCode(items, '   '), null)
})
