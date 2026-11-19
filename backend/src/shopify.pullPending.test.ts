// The inbound catalogue pull must never write Shopify's copy over an ERP row.
// The old contract had the pull overwrite name/description/vendor/stock unless
// a product happened to have an outbound job queued — so a plain "Sync Now"
// reverted the edit the next push was about to send, and the store and the ERP
// traded each other's stale values forever.
//
// ERP now owns the catalogue: the pull only refreshes the link to a product
// (and, while a push is queued, not even that). `pendingProductIds` is still
// consulted for the variant-link refresh, because a queued push may create the
// listing variants this pull has not seen yet.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyLiveCatalog, type CatalogPatch, type CatalogRow } from './shopify'
import type { SyncProduct } from './types'

const PRODUCT_ID = 'p-1'

function localRow(): CatalogRow {
  return {
    id: PRODUCT_ID,
    sku: 'PULL-001',
    name: 'ERP edited name',
    barcode: null,
    category: 'Rings',
    collection: null,
    netWeight: 4,
    makingCharge: 300,
    silverRate: 92.8,
    stock: 9,
    vendor: 'ERP vendor',
    productType: 'Rings',
    description: 'ERP edited copy',
    compareAtPrice: null,
    image: null,
    images: ['/uploads/erp.jpg'],
    chargeOnTax: true,
    shopifyId: '5000001',
    shopifyStatus: 'synced',
    status: 'active',
  }
}

function liveProduct(): SyncProduct {
  return {
    id: 5_000_001,
    gid: 'gid://shopify/Product/5000001',
    title: 'Shopify old name',
    handle: 'pull-001',
    vendor: 'Shopify vendor',
    productType: 'Shopify type',
    description: 'Shopify old copy',
    collection: 'Shopify collection',
    chargeOnTax: true,
    status: 'active',
    sku: 'PULL-001',
    barcode: null,
    price: '900.00',
    compareAtPrice: null,
    image: null,
    images: [],
    inventoryQuantity: 2,
    inventoryItemId: 7_000_001,
    variantId: 6_000_001,
    options: [{ name: 'Size', values: ['S'] }],
    variants: [
      {
        id: 6_000_001,
        title: 'S',
        option1: 'S',
        option2: null,
        option3: null,
        sku: 'PULL-001',
        barcode: null,
        price: '900.00',
        compareAtPrice: null,
        inventoryQuantity: 2,
        inventoryItemId: 7_000_001,
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function run(pendingProductIds?: ReadonlySet<string>) {
  const patches: CatalogPatch[] = []
  let variantSaves = 0
  let linkCalls = 0
  return {
    patches,
    variantSaves: () => variantSaves,
    linkCalls: () => linkCalls,
    promise: applyLiveCatalog(
      [liveProduct()],
      [localRow()],
      92.8,
      {
        insert: async () => undefined,
        update: async (_existing, patch) => {
          patches.push(patch)
        },
        saveVariants: async () => {
          variantSaves += 1
        },
        linkVariants: async () => {
          linkCalls += 1
        },
      },
      { pendingProductIds },
    ),
  }
}

test('a queued ERP edit is not reverted by the inbound pull', async () => {
  const { promise, patches, variantSaves, linkCalls } = run(new Set([PRODUCT_ID]))
  await promise
  assert.equal(patches.length, 1)
  const patch = patches[0]
  assert.equal(patch.name, 'ERP edited name', 'the queued title is not reverted')
  assert.equal(patch.description, 'ERP edited copy', 'the queued description is not reverted')
  // Stock is not in the patch at all any more: the pull writes no stock column
  // (stronger than "writes the ERP's value back" — nothing can overwrite a
  // balance, not even an echo of a value that has since moved).
  assert.equal(patch.stock, undefined, 'the queued stock count cannot be reverted by the pull')
  assert.equal(patch.vendor, 'ERP vendor')
  assert.equal(patch.productType, 'Rings')
  assert.deepEqual(patch.images, ['/uploads/erp.jpg'], 'queued local images survive the pull')
  assert.equal(patch.shopifyId, '5000001', 'the link itself is still refreshed')
  assert.equal(patch.shopifyStatus, 'synced')
  assert.equal(variantSaves(), 0, 'the listing variant set is left for the pending push')
  assert.equal(linkCalls(), 0, 'the variant link waits for the queued push')
})

test('with nothing queued the pull still keeps every ERP value', async () => {
  const { promise, patches, linkCalls } = run()
  await promise
  assert.equal(patches.length, 1)
  const patch = patches[0]
  assert.equal(patch.name, 'ERP edited name', 'the pull is never the source of the name')
  assert.equal(patch.description, 'ERP edited copy', 'nor of the description')
  assert.equal(patch.stock, undefined, 'nor of the stock — the patch carries no stock column at all')
  assert.equal(patch.vendor, 'ERP vendor')
  assert.equal(patch.compareAtPrice, null, 'nor of the price')
  assert.equal(patch.shopifyId, '5000001', 'only the link is refreshed')
  assert.equal(linkCalls(), 1, 'the variant link is refreshed when nothing is queued')
})

test('a different product being pending does not freeze this one', async () => {
  const { promise, patches, linkCalls } = run(new Set(['some-other-product']))
  await promise
  const patch = patches[0]
  assert.equal(patch.name, 'ERP edited name', 'ERP values win whatever the queue holds')
  assert.equal(patch.stock, undefined, 'ERP values win whatever the queue holds')
  assert.equal(linkCalls(), 1, 'this product is not held back by another product\'s queue')
})
