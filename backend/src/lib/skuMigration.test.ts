import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  GENERIC_SEGMENT,
  hasLiveReferences,
  isGenericSku,
  migrationWarnings,
  planSkuMigration,
} from './skuMigration'

const product = (id: string, sku: string, category: string, name = `Product ${id}`) => ({
  id,
  name,
  sku,
  category,
})

test('only legacy generic (GEN segment) codes are migration candidates', () => {
  assert.equal(GENERIC_SEGMENT, 'GEN')
  assert.equal(isGenericSku('SLV-GEN-001'), true)
  assert.equal(isGenericSku('OL-GEN-00099'), true)
  assert.equal(isGenericSku('slv-gen-7'), true)
  // Category codes, variant tails and junk are never candidates — existing
  // SKUs are preserved exactly as they are.
  assert.equal(isGenericSku('SLV-RNG-00021'), false)
  assert.equal(isGenericSku('OL-CHN-001'), false)
  assert.equal(isGenericSku('OL-RNG-001-SMA-RED'), false)
  assert.equal(isGenericSku('OL-SIL-001'), false)
  assert.equal(isGenericSku(''), false)
  assert.equal(isGenericSku(null), false)
})

test('planning regenerates generic codes as category-based OL-{CODE}-{SEQ}', () => {
  const plan = planSkuMigration(
    [
      product('a', 'SLV-GEN-001', 'Rings'),
      product('b', 'SLV-GEN-002', 'Chains'),
      product('c', 'SLV-GEN-003', 'Earrings'),
    ],
    ['SLV-GEN-001', 'SLV-GEN-002', 'SLV-GEN-003'],
  )
  const byId = new Map(plan.map((c) => [c.id, c]))
  assert.equal(plan.length, 3)
  assert.equal(byId.get('a')?.oldSku, 'SLV-GEN-001')
  assert.equal(byId.get('a')?.newSku, 'OL-RNG-001')
  assert.equal(byId.get('b')?.newSku, 'OL-CHN-001')
  assert.equal(byId.get('c')?.newSku, 'OL-EAR-001')
  assert.equal(byId.get('a')?.name, 'Product a')
})

test('sequences continue per category instead of restarting', () => {
  const plan = planSkuMigration(
    [product('a', 'SLV-GEN-010', 'Rings'), product('b', 'SLV-GEN-011', 'Rings')],
    ['SLV-GEN-010', 'SLV-GEN-011', 'SLV-RNG-00021'],
  )
  const news = plan.map((c) => c.newSku).sort()
  // SLV-RNG-00021 keeps the Rings sequence alive: regenerated codes continue
  // at 022+ rather than colliding with or restarting below the existing one.
  assert.deepEqual(news, ['OL-RNG-022', 'OL-RNG-023'])
})

test('existing non-generic SKUs are never planned or rewritten', () => {
  const rows = [
    product('keep1', 'SLV-RNG-00021', 'Rings'),
    product('keep2', 'OL-CHN-042', 'Chains'),
    product('keep3', 'OL-SIL-001', 'Silver jewels'),
  ]
  const plan = planSkuMigration(rows, rows.map((r) => r.sku))
  assert.deepEqual(plan, [])
})

test('planned codes never collide with any product or variant SKU', () => {
  const all = ['OL-RNG-001', 'OL-RNG-002', 'OL-RNG-001-SMA-RED', 'junk']
  const plan = planSkuMigration([product('g', 'SLV-GEN-050', 'Rings')], all)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].newSku, 'OL-RNG-003')
  assert.ok(!all.includes(plan[0].newSku), 'the candidate must be free everywhere')
})

test('dry-run planning is deterministic regardless of input order', () => {
  const rows = [product('z', 'SLV-GEN-002', 'Chains'), product('a', 'SLV-GEN-001', 'Rings')]
  const all = rows.map((r) => r.sku)
  const one = planSkuMigration(rows, all)
  const two = planSkuMigration([...rows].reverse(), all)
  assert.deepEqual(one, two)
})

test('a product with no usable category plans the generic code (nothing better exists)', () => {
  const plan = planSkuMigration([product('x', 'OLD-GEN-9', '')], ['OLD-GEN-9'])
  assert.equal(plan.length, 1)
  // The legacy generic sequence keeps running instead of restarting: the
  // existing OLD-GEN-9 count advances the generic line to the next free code.
  assert.equal(plan[0].newSku, 'OL-GEN-010')
})

test('warnings report document snapshots and Shopify links before any rewrite', () => {
  const refs = {
    invoiceItems: 0,
    orderItems: 0,
    stockMovements: 0,
    stockTransfers: 0,
    variants: 0,
    shopifyLinked: false,
  }
  assert.deepEqual(migrationWarnings(refs), [])
  const docWarn = migrationWarnings({ ...refs, invoiceItems: 2 })
  assert.equal(docWarn.length, 1)
  assert.match(docWarn[0], /2 invoice line\(s\) keep the old SKU/)
  const shopWarn = migrationWarnings({ ...refs, orderItems: 3, shopifyLinked: true })
  assert.equal(shopWarn.length, 2)
  assert.match(shopWarn[0], /3 order line\(s\)/)
  assert.match(shopWarn[1], /Shopify/)
})

test('stock ledger, transfers and variants are live references that get rewritten', () => {
  const base = {
    invoiceItems: 0,
    orderItems: 0,
    stockMovements: 0,
    stockTransfers: 0,
    variants: 0,
    shopifyLinked: false,
  }
  // Documents are historical snapshots — not "live".
  assert.equal(hasLiveReferences({ ...base, invoiceItems: 99, orderItems: 99 }), false)
  assert.equal(hasLiveReferences({ ...base, stockMovements: 1 }), true)
  assert.equal(hasLiveReferences({ ...base, stockTransfers: 1 }), true)
  assert.equal(hasLiveReferences({ ...base, variants: 2 }), true)
})
