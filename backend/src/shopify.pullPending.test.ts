// The inbound catalog pull must not overwrite an ERP edit that is queued but
// not yet pushed. Without this guard the push/pull echo reverts the edit (the
// pull writes Shopify's older title/stock back, the queued push then sends the
// reverted value) — which is exactly how "changes made in ERP never reach
// Shopify" looked from the outside.
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
    options: [],
    variants: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function run(pendingProductIds?: ReadonlySet<string>) {
  const patches: CatalogPatch[] = []
  let variantSaves = 0
  return {
    patches,
    variantSaves: () => variantSaves,
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
      },
      { pendingProductIds },
    ),
  }
}

test('a queued ERP edit wins over the inbound pull', async () => {
  const { promise, patches, variantSaves } = run(new Set([PRODUCT_ID]))
  await promise
  assert.equal(patches.length, 1)
  const patch = patches[0]
  assert.equal(patch.name, 'ERP edited name', 'the queued title is not reverted')
  assert.equal(patch.description, 'ERP edited copy', 'the queued description is not reverted')
  assert.equal(patch.stock, 9, 'the queued stock count is not reverted')
  assert.equal(patch.vendor, 'ERP vendor')
  assert.equal(patch.productType, 'Rings')
  assert.deepEqual(patch.images, ['/uploads/erp.jpg'], 'queued local images survive the pull')
  assert.equal(patch.shopifyId, '5000001', 'the link itself is still refreshed')
  assert.equal(patch.shopifyStatus, 'synced')
  assert.equal(variantSaves(), 0, 'the listing variant set is left for the pending push')
})

test('without pending work the pull stays authoritative', async () => {
  const { promise, patches } = run()
  await promise
  const patch = patches[0]
  assert.equal(patch.name, 'Shopify old name', 'Shopify remains the source when nothing is queued')
  assert.equal(patch.description, 'Shopify old copy')
  assert.equal(patch.stock, 2)
  assert.equal(patch.vendor, 'Shopify vendor')
})

test('a different product being pending does not freeze this one', async () => {
  const { promise, patches } = run(new Set(['some-other-product']))
  await promise
  assert.equal(patches[0].name, 'Shopify old name')
  assert.equal(patches[0].stock, 2)
})
