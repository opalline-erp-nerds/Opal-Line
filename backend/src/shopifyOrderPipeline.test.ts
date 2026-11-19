import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOrderPatch,
  deriveStage,
  erpPaymentFor,
  importedErpStatus,
  normalizeFinancialStatus,
  normalizeFulfillmentStatus,
  snapshotFromRestOrder,
  type LocalOrder,
  type OrderSnapshot,
} from './shopifyOrderPipeline'
import { allocateFulfillmentLines } from './shopifyOrderActions'

/**
 * Regression suite for the Shopify ↔ ERP order pipeline.
 *
 * The contract under test:
 *   - Shopify's native payment/fulfilment state never collapses into a single
 *     "refunded"/"fulfilled" flag: a partial refund is still a paid, shippable
 *     order and an archived order is not a fulfilled one.
 *   - Applying the same Shopify snapshot twice is a no-op (webhooks retry).
 *   - The importer/mapper never invents stock or quantities; only what Shopify
 *     reports is written.
 *   - A fulfilment request can never exceed what Shopify says is remaining.
 */

function localOrder(overrides: Partial<Record<string, unknown>> = {}): LocalOrder {
  return {
    id: 'local-1',
    shopifyId: '#1027',
    shopifyGid: null,
    internalId: 'SO-1027',
    customer: 'Asha',
    value: 100,
    payment: 'paid',
    fulfillment: 'unfulfilled',
    invoice: null,
    status: 'processing',
    date: '2026-01-01T00:00:00.000Z',
    items: 1,
    currency: 'INR',
    lineItems: null,
    shopifyFinancialStatus: 'PAID',
    shopifyFulfillmentStatus: 'UNFULFILLED',
    trackingNumber: null,
    trackingCompany: null,
    trackingUrl: null,
    fulfillmentIds: [],
    cancelledAt: null,
    closedAt: null,
    shopifySyncedAt: null,
    locationId: null,
    ...overrides,
  } as unknown as LocalOrder
}

function snapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    name: '#1027',
    gid: 'gid://shopify/Order/1027',
    currency: 'INR',
    total: 100,
    financialStatus: 'PAID',
    fulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null,
    closedAt: null,
    tracking: { number: null, company: null, url: null },
    fulfillmentIds: [],
    lines: null,
    ...overrides,
  }
}

test('a partial refund stays shippable instead of becoming "refunded"', () => {
  assert.equal(normalizeFinancialStatus('partially_refunded'), 'PARTIALLY_REFUNDED')
  assert.equal(erpPaymentFor('PARTIALLY_REFUNDED'), 'paid')
  assert.equal(
    deriveStage({ status: 'processing', shopifyFinancialStatus: 'PARTIALLY_REFUNDED', shopifyFulfillmentStatus: 'UNFULFILLED' }),
    'in_progress',
  )
})

test('part-paid is partial and a voided authorisation is not a refund', () => {
  assert.equal(erpPaymentFor('PARTIALLY_PAID'), 'partial')
  assert.equal(erpPaymentFor('PAID'), 'paid')
  assert.equal(erpPaymentFor('PARTIALLY_REFUNDED'), 'paid')
  assert.equal(erpPaymentFor('VOIDED'), 'failed')
  assert.equal(erpPaymentFor('EXPIRED'), 'failed')
  assert.equal(erpPaymentFor('REFUNDED'), 'refunded')
})

test('archiving an order is not fulfilment', () => {
  const archived = { status: 'processing', shopifyFinancialStatus: 'PAID', shopifyFulfillmentStatus: 'UNFULFILLED', closedAt: '2026-01-02T00:00:00Z' }
  assert.equal(deriveStage(archived), 'archived')

  const { patch, changes } = buildOrderPatch(localOrder(), snapshot({ closedAt: '2026-01-02T00:00:00Z' }))
  assert.equal(patch.closedAt, '2026-01-02T00:00:00Z')
  assert.equal(patch.fulfillment, undefined, 'archive must not mark the order fulfilled')
  assert.equal(patch.status, undefined, 'archive must not move the ERP stage')
  assert.ok(changes.includes('archived'))
})

test('cancellation and partial fulfilment are distinct stages', () => {
  assert.equal(deriveStage({ status: 'imported', cancelledAt: '2026-01-02T00:00:00Z' }), 'cancelled')
  assert.equal(deriveStage({ status: 'processing', shopifyFulfillmentStatus: 'PARTIALLY_FULFILLED' }), 'partially_fulfilled')
  assert.equal(deriveStage({ status: 'processing', shopifyFulfillmentStatus: 'FULFILLED' }), 'fulfilled')
})

test('REST snapshot keeps partial quantities, newest tracking, and cancelled fulfilments out', () => {
  const snap = snapshotFromRestOrder({
    id: 1027,
    name: '#1027',
    admin_graphql_api_id: 'gid://shopify/Order/1027',
    financial_status: 'partially_refunded',
    fulfillment_status: 'partial',
    total_price: '149.50',
    line_items: [
      { id: 11, admin_graphql_api_id: 'gid://shopify/LineItem/11', sku: 'RING-1', quantity: 3, fulfillable_quantity: 1, price: '49.83' },
    ],
    fulfillments: [
      { id: 5, status: 'cancelled', tracking_number: 'OLD-1', tracking_company: 'OldCarrier' },
      { id: 6, status: 'success', tracking_number: 'NEW-9', tracking_company: 'BlueDart', tracking_url: 'https://track/9' },
    ],
  })

  assert.equal(snap.financialStatus, 'PARTIALLY_REFUNDED')
  assert.equal(snap.fulfillmentStatus, 'PARTIALLY_FULFILLED')
  assert.equal(snap.total, 149.5)
  assert.equal(snap.cancelledAt, null)
  assert.deepEqual(snap.tracking, { number: 'NEW-9', company: 'BlueDart', url: 'https://track/9' })
  assert.equal(snap.lines?.[0].fulfilledQuantity, 2, '3 ordered − 1 fulfillable = 2 fulfilled')
  assert.equal(snap.lines?.[0].shopifyLineItemId, 'gid://shopify/LineItem/11')
  assert.deepEqual(snap.fulfillmentIds, ['gid://shopify/Fulfillment/5', 'gid://shopify/Fulfillment/6'])
})

test('applying the same snapshot twice writes nothing the second time', () => {
  const snap = snapshot({
    fulfillmentStatus: 'PARTIALLY_FULFILLED',
    lines: [{ shopifyLineItemId: 'gid://shopify/LineItem/11', sku: 'RING-1', title: 'Silver Ring', quantity: 3, price: 50, fulfilledQuantity: 1 }],
    tracking: { number: 'AWB-1', company: 'BlueDart', url: null },
  })
  const first = buildOrderPatch(localOrder(), snap, '2026-01-03T00:00:00.000Z')
  assert.ok(first.changes.length > 0)
  assert.equal(first.patch.shopifySyncedAt, '2026-01-03T00:00:00.000Z')
  assert.equal(first.patch.status, undefined, 'partial fulfilment keeps the operator stage')
  assert.equal(first.patch.fulfillment, 'partial')
  assert.ok(first.changes.includes('partial'))

  const applied = localOrder({ ...first.patch, lineItems: first.patch.lineItems })
  const second = buildOrderPatch(applied, snap, '2026-01-04T00:00:00.000Z')
  assert.deepEqual(second.changes, [], 'a retried webhook must not create duplicate timeline work')
  assert.equal(second.patch.shopifySyncedAt, undefined)
})

test('fulfilment side effects only run on a real transition', () => {
  // First sync of a legacy row: the native state was unknown, so the order is
  // recorded as fulfilled but nobody is emailed / invoiced for an old shipment.
  const legacy = buildOrderPatch(localOrder({ shopifyFulfillmentStatus: null, fulfillment: null }), snapshot({ fulfillmentStatus: 'FULFILLED' }))
  assert.ok(legacy.changes.includes('fulfilled'))
  assert.ok(!legacy.changes.includes('became-fulfilled'))

  const transition = buildOrderPatch(localOrder(), snapshot({ fulfillmentStatus: 'FULFILLED' }))
  assert.ok(transition.changes.includes('became-fulfilled'))

  // A redelivered webhook against the row the transition produced is silent.
  const stored = localOrder({ shopifyGid: 'gid://shopify/Order/1027', ...transition.patch })
  assert.deepEqual(buildOrderPatch(stored, snapshot({ fulfillmentStatus: 'FULFILLED' })).changes, [])
})

test('a payload without tracking never blanks a known shipment', () => {
  const local = localOrder({ trackingNumber: 'AWB-1', trackingCompany: 'BlueDart', trackingUrl: 'https://track/1' })
  const { patch } = buildOrderPatch(local, snapshot({ fulfillmentStatus: 'PARTIALLY_FULFILLED' }))
  assert.equal(patch.trackingNumber, undefined)
  assert.equal(patch.trackingCompany, undefined)
})

test('fulfilment allocation enforces Shopify remaining quantities', () => {
  const available = [
    { fulfillmentOrderId: 'fo-1', fulfillmentOrderLineItemId: 'l-1', sku: 'RING-1', remaining: 2 },
    { fulfillmentOrderId: 'fo-2', fulfillmentOrderLineItemId: 'l-2', sku: 'RING-1', remaining: 1 },
  ]

  const split = allocateFulfillmentLines(available, [{ sku: 'RING-1', quantity: 3 }])
  assert.equal(split.ok, true)
  if (split.ok) {
    assert.deepEqual(split.groups, [
      { fulfillmentOrderId: 'fo-1', lines: [{ id: 'l-1', quantity: 2 }] },
      { fulfillmentOrderId: 'fo-2', lines: [{ id: 'l-2', quantity: 1 }] },
    ])
  }

  const over = allocateFulfillmentLines(available, [{ sku: 'RING-1', quantity: 4 }])
  assert.equal(over.ok, false)
  if (!over.ok) assert.match(over.error, /only 3 of 4/)

  const unknown = allocateFulfillmentLines(available, [{ sku: 'GHOST', quantity: 1 }])
  assert.equal(unknown.ok, false)

  const zero = allocateFulfillmentLines(available, [{ sku: 'RING-1', quantity: 0 }])
  assert.equal(zero.ok, false)
})

test('normalizes REST and GraphQL fulfilment spellings', () => {
  assert.equal(normalizeFulfillmentStatus('partial'), 'PARTIALLY_FULFILLED')
  assert.equal(normalizeFulfillmentStatus('partially_fulfilled'), 'PARTIALLY_FULFILLED')
  assert.equal(normalizeFinancialStatus('partially-refunded'), 'PARTIALLY_REFUNDED')
})

test('a new Shopify order is never imported as cancelled', () => {
  // A voided/refunded payment is a payment state, not an order cancellation.
  // Brand-new orders with no cancellation timestamp land in the New pipeline.
  for (const financial of ['voided', 'pending', 'paid', 'authorized', 'refunded']) {
    const snap = snapshotFromRestOrder({ name: '#1', cancelled_at: null, financial_status: financial, fulfillment_status: null })
    assert.equal(snap.cancelledAt, null)
    assert.equal(importedErpStatus(snap), 'imported', `financial_status=${financial} must not cancel the order`)
  }
  // Only a parseable date is a cancellation. Literal sentinels from dev stores,
  // proxies or partial payloads must never reach the status mapper.
  for (const sentinel of ['null', 'undefined', '', false, 0, 'not-a-date']) {
    const snap = snapshotFromRestOrder({ name: '#1', cancelled_at: sentinel, fulfillment_status: null })
    assert.equal(snap.cancelledAt, null, `cancelled_at=${String(sentinel)} is not a cancellation`)
    assert.equal(importedErpStatus(snap), 'imported')
  }
  // A genuine Shopify cancellation still cancels.
  const cancelled = snapshotFromRestOrder({ name: '#1', cancelled_at: '2026-11-19T10:00:00Z', fulfillment_status: null })
  assert.equal(importedErpStatus(cancelled), 'cancelled')
  // Fulfilment still drives the stage it always did.
  assert.equal(importedErpStatus({ cancelledAt: null, fulfillmentStatus: 'FULFILLED' }), 'fulfilled')
  assert.equal(importedErpStatus({ cancelledAt: null, fulfillmentStatus: 'PARTIALLY_FULFILLED' }), 'processing')
})

test('a live Shopify order clears a stale cancellation but a verified one stays', () => {
  // The incident shape: a row marked cancelled with no cancellation timestamp
  // (old voided mapping / old UI cancel). Shopify says it is live, so the row
  // must return to the New stage instead of staying cancelled forever.
  const stale = localOrder({ status: 'cancelled', cancelledAt: null })
  const reopened = buildOrderPatch(stale, snapshot({ financialStatus: 'PAID', cancelledAt: null }))
  assert.equal(reopened.patch.status, 'imported')
  assert.equal(reopened.patch.cancelledAt, undefined, 'there was no timestamp to clear')
  assert.ok(reopened.changes.includes('status-reopened'))

  // A cancellation backed by a real timestamp is intentional and survives.
  const verified = localOrder({ status: 'cancelled', cancelledAt: '2026-11-18T10:00:00.000Z' })
  const kept = buildOrderPatch(verified, snapshot({ cancelledAt: null }))
  assert.equal(kept.patch.status, undefined)
  assert.notEqual(kept.patch.cancelledAt, null, 'a verified cancellation is not cleared by a live payload')

  // A manual ERP order cancelled locally (before Shopify caught up) also stays.
  const manual = localOrder({ status: 'cancelled', cancelledAt: null, internalId: 'MO-1027', tags: 'manual-order' })
  assert.equal(buildOrderPatch(manual, snapshot({ cancelledAt: null })).patch.status, undefined)

  // And a genuine Shopify cancellation always wins, even over an open row.
  const genuine = buildOrderPatch(localOrder({ status: 'imported' }), snapshot({ cancelledAt: '2026-11-19T10:00:00.000Z' }))
  assert.equal(genuine.patch.status, 'cancelled')
  assert.equal(genuine.patch.cancelledAt, '2026-11-19T10:00:00.000Z')
})

test('the same cancelled instant in Postgres and ISO format is not rewritten', () => {
  const local = localOrder({ shopifyGid: 'gid://shopify/Order/1027', status: 'cancelled', cancelledAt: '2026-11-19 10:00:00' })
  const again = buildOrderPatch(local, snapshot({ cancelledAt: '2026-11-19T10:00:00.000Z' }))
  assert.deepEqual(again.changes, [], 'a retried webhook must not rewrite the same instant')
})
