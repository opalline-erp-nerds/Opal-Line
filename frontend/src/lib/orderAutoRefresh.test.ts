import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ORDER_REFRESH_INTERVAL_MS,
  isOrderRefreshDue,
  newOrdersMessage,
  newShopifyOrders,
  shouldOrderRefreshRun,
} from './orderAutoRefresh'
import type { SalesOrder } from '@/types'

const order = (id: string, shopifyId: string | null = null): SalesOrder => ({ id, shopifyId }) as SalesOrder

test('a refresh is due on the first tick', () => {
  assert.equal(isOrderRefreshDue(0, 1_000), true)
  assert.equal(isOrderRefreshDue(Number.NaN, 1_000), true)
})

test('a refresh is due only after the interval has elapsed', () => {
  const last = 10_000
  assert.equal(isOrderRefreshDue(last, last + ORDER_REFRESH_INTERVAL_MS - 1), false)
  assert.equal(isOrderRefreshDue(last, last + ORDER_REFRESH_INTERVAL_MS), true)
})

test('a non-positive interval never polls', () => {
  assert.equal(isOrderRefreshDue(1, 1_000_000, 0), false)
})

test('hidden tabs and open dialogs suspend the refresh', () => {
  assert.equal(shouldOrderRefreshRun('visible', false), true)
  assert.equal(shouldOrderRefreshRun('hidden', false), false)
  assert.equal(shouldOrderRefreshRun('prerender', false), false)
  assert.equal(shouldOrderRefreshRun('visible', true), false)
  assert.equal(shouldOrderRefreshRun('visible', false, false), false)
})

test('only genuinely new Shopify orders are announced', () => {
  const before = [order('so-1', '#1001'), order('so-2', '#1002')]
  const after = [order('so-1', '#1001'), order('so-2', '#1002'), order('so-3', '#1003')]
  assert.deepEqual(newShopifyOrders(before, after).map((o) => o.id), ['so-3'])
})

test('manual ERP orders never count as new Shopify arrivals', () => {
  const before = [order('so-1', '#1001')]
  const after = [...before, order('mo-1')]
  assert.deepEqual(newShopifyOrders(before, after), [])
})

test('an order that keeps the same id is not re-announced', () => {
  const rows = [order('so-1', '#1001')]
  assert.deepEqual(newShopifyOrders(rows, [...rows]), [])
})

test('a local order that gains a Shopify id is not announced as a new arrival', () => {
  const before = [order('mo-1', null)]
  const after = [order('mo-1', '#2001')]
  assert.deepEqual(newShopifyOrders(before, after), [])
})

test('the toast copy reads naturally', () => {
  assert.equal(newOrdersMessage(0), '')
  assert.equal(newOrdersMessage(1), '1 new Shopify order received')
  assert.equal(newOrdersMessage(3), '3 new Shopify orders received')
})
