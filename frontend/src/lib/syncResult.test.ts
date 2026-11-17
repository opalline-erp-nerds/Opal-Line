import test from 'node:test'
import assert from 'node:assert/strict'
import type { SyncResult } from '@/types/shopify'
import { describeSyncResult } from './syncResult'

/**
 * Regression tests for the response contract of POST /api/v1/shopify/sync
 * (backend/src/index.ts: `res.json(results ? { ...result, db } : result)`).
 *
 * The product page's Sync Shopify button used to read
 * `res.results.products?.count` unguarded. When the server refused the sync —
 * `runSync` returns `{ ok: false, message: 'A sync is already in progress' }`
 * while the scheduled auto-sync holds the shared lock, and the endpoint then
 * omits `results` entirely — that threw
 *   TypeError: Cannot read properties of undefined (reading 'products')
 * even though the outbound queue had already pushed the change to Shopify.
 * These tests pin both real shapes so the guard cannot be removed again.
 */

/** Body the backend returns when the sync ran: `results` plus the DB summary. */
const confirmedBody: SyncResult = {
  ok: true,
  results: {
    orders: { ok: true, count: 0 },
    products: { ok: true, count: 24 },
    customers: { ok: true, count: 0 },
    inventory: { ok: true, count: 0 },
    price: { ok: true, count: 0 },
  },
  db: {
    products: '24 (0 created, 0 updated)',
    push: '5 queued, 5 pushed',
    enrichment: 'orders: 0 enriched, customers: 0 enriched',
  },
}

/** Body the backend returns when the sync was refused: no `results` key. */
const refusedBody: SyncResult = { ok: false, message: 'A sync is already in progress' }

test('confirmed sync reports the product count and the backend push tally', () => {
  const outcome = describeSyncResult(confirmedBody, 'products')
  assert.equal(outcome.ok, true)
  assert.match(outcome.message, /24 products up to date/)
  assert.match(outcome.message, /5 queued, 5 pushed/)
})

test('refused sync (no results) is a meaningful error, not a TypeError', () => {
  // The old code did `res.results.products?.count` here and threw
  // "Cannot read properties of undefined (reading 'products')".
  assert.doesNotThrow(() => describeSyncResult(refusedBody, 'products'))
  const outcome = describeSyncResult(refusedBody, 'products')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.message, 'A sync is already in progress')
})

test('ok:false without a message still yields a readable error', () => {
  const outcome = describeSyncResult({ ok: false }, 'products')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.message, 'Shopify sync failed')
})

test('a confirmed body with a failed products entry surfaces the failure', () => {
  // runSync always answers ok:true once the lock was acquired; a per-resource
  // error rides in results.<resource>.ok === false and must not read as success.
  const body: SyncResult = {
    ok: true,
    results: {
      orders: { ok: true, count: 0 },
      products: { ok: false, count: 0, message: 'Shopify is not configured' },
      customers: { ok: true, count: 0 },
      inventory: { ok: true, count: 0 },
      price: { ok: true, count: 0 },
    },
  }
  const outcome = describeSyncResult(body, 'products')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.message, 'Shopify is not configured')
})

test('customers import message matches the confirmed customer count', () => {
  const body: SyncResult = {
    ok: true,
    results: {
      orders: { ok: true, count: 0 },
      products: { ok: true, count: 0 },
      customers: { ok: true, count: 12 },
      inventory: { ok: true, count: 0 },
      price: { ok: true, count: 0 },
    },
  }
  const outcome = describeSyncResult(body, 'customers')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.message, 'Imported 12 customers from Shopify')
})

test('missing or malformed responses degrade to an error', () => {
  for (const bad of [null, undefined, {} as unknown as SyncResult]) {
    const outcome = describeSyncResult(bad, 'products')
    assert.equal(outcome.ok, false)
    assert.ok(outcome.message.length > 0)
  }
})
