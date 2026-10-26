import test from 'node:test'
import assert from 'node:assert/strict'
import { agingBadgeVariant, filterAgingRows, formatDaysInStock } from './stockAging'
import type { StockAgingRow } from '@/types'

const row = (over: Partial<StockAgingRow> = {}): StockAgingRow => ({
  id: 'p-1',
  name: 'Silver Ring',
  sku: 'RING-42',
  category: 'Rings',
  quantity: 3,
  stock: 3,
  stockEntryDate: '2026-01-01T00:00:00.000Z',
  lastSoldDate: null,
  daysInStock: 42,
  agingBucket: 'd31_60',
  agingStatus: '31-60 days',
  stockValue: 300,
  ...over,
})

const rows = [
  row(),
  row({ id: 'p-2', name: 'Gold Chain', sku: 'CHAIN-7', category: 'Chains', agingBucket: 'd91_180', daysInStock: 120 }),
  row({ id: 'p-3', name: 'Old Bangle', sku: 'BANGLE-1', category: 'Bangles', agingBucket: 'd180_plus', daysInStock: 240 }),
]

test('filterAgingRows: empty filters return every row in server order', () => {
  assert.deepEqual(filterAgingRows(rows, {}).map((r) => r.id), ['p-1', 'p-2', 'p-3'])
})

test('filterAgingRows: search matches name and SKU case-insensitively', () => {
  assert.deepEqual(filterAgingRows(rows, { query: 'gold' }).map((r) => r.id), ['p-2'])
  assert.deepEqual(filterAgingRows(rows, { query: 'chain-7' }).map((r) => r.id), ['p-2'])
  assert.deepEqual(filterAgingRows(rows, { query: '  ' }).length, 3, 'whitespace is not a search')
})

test('filterAgingRows: category and bucket combine with search', () => {
  assert.deepEqual(filterAgingRows(rows, { category: 'Chains' }).map((r) => r.id), ['p-2'])
  assert.deepEqual(filterAgingRows(rows, { bucket: 'd180_plus' }).map((r) => r.id), ['p-3'])
  assert.deepEqual(filterAgingRows(rows, { category: 'Chains', bucket: 'd180_plus' }), [])
  assert.deepEqual(filterAgingRows(rows, { query: 'a', category: 'Chains', bucket: 'd91_180' }).map((r) => r.id), ['p-2'])
})

test('agingBadgeVariant maps severity and tolerates unknown keys', () => {
  assert.equal(agingBadgeVariant('d0_30'), 'success')
  assert.equal(agingBadgeVariant('d61_90'), 'warning')
  assert.equal(agingBadgeVariant('d91_180'), 'danger')
  assert.equal(agingBadgeVariant('d180_plus'), 'muted')
  assert.equal(agingBadgeVariant('d999'), 'muted')
})

test('formatDaysInStock handles zero and singular days', () => {
  assert.equal(formatDaysInStock(0), '0 days')
  assert.equal(formatDaysInStock(1), '1 day')
  assert.equal(formatDaysInStock(42.9), '42 days')
  assert.equal(formatDaysInStock(Number.NaN), '0 days')
})
