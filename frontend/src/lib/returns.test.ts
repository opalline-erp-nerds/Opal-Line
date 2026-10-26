import test from 'node:test'
import assert from 'node:assert/strict'
import { loadReturns } from './returns'
import type { SalesReturn } from '@/types'

// The list used to swallow a failed fetch with an empty catch, so a broken API
// looked exactly like an empty database. The loader's contract is that it
// always resolves: the rows it got (or none) plus the message when the
// request failed.

const processedReturn: SalesReturn = {
  id: 'R1',
  number: 'CR202610-393819',
  order: '#1011',
  customer: 'rk',
  items: 1,
  amount: 6534,
  status: 'processed',
  date: '2026-10-26 05:13:22.341',
}

const pendingReturn: SalesReturn = {
  id: 'R2',
  number: 'SR-2026-00006',
  order: '#10220',
  customer: 'Priya Sharma',
  items: 1,
  amount: 620,
  status: 'pending',
  date: '2026-08-05T09:00:00',
}

test('a successful load reports the returns and their stats', async () => {
  const result = await loadReturns({
    getReturns: () => Promise.resolve([processedReturn, pendingReturn]),
    getInvoices: () => Promise.resolve([{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }]),
  })
  assert.equal(result.error, null, 'no error on the happy path')
  assert.equal(result.returns.length, 2)
  assert.equal(result.stats?.total, 2)
  assert.equal(result.stats?.pending, 1)
  assert.equal(result.stats?.pendingAmount, 620)
  assert.equal(result.stats?.refunded, 0, 'a processed credit note is not a pending or refunded return')
  assert.equal(result.stats?.rate, (2 / 3) * 100, 'return rate is returns against invoices')
})

test('an empty database loads as an empty list, not as an error', async () => {
  const result = await loadReturns({
    getReturns: () => Promise.resolve([]),
    getInvoices: () => Promise.resolve([]),
  })
  assert.equal(result.error, null)
  assert.deepEqual(result.returns, [])
  assert.deepEqual(result.stats, {
    total: 0,
    pending: 0,
    pendingAmount: 0,
    refunded: 0,
    refundedAmount: 0,
    rate: 0,
  })
})

test('a failed API call resolves with the message instead of throwing', async () => {
  const result = await loadReturns({
    getReturns: () => Promise.reject(new Error('API error 500')),
    getInvoices: () => Promise.resolve([{ id: 'i1' }]),
  })
  assert.equal(result.returns.length, 0, 'no rows on failure')
  assert.equal(result.stats, null, 'no stats can be computed')
  assert.equal(result.error, 'API error 500', 'the failure is reported, not swallowed')
})

test('a failure without an Error object still reports something', async () => {
  const result = await loadReturns({
    getReturns: () => Promise.reject('network down'),
    getInvoices: () => Promise.resolve([]),
  })
  assert.equal(result.error, 'Could not load sales returns')
})
