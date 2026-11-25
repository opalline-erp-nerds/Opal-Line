import test from 'node:test'
import assert from 'node:assert/strict'
import { fulfilledStoreIds, isSplitFulfilledInvoice } from './invoiceFulfilment'
import type { InvoiceItem } from '@/types'

// The split-invoice detection behind the invoice edit dialog's fulfilment
// note (Phase 4 hardening). A "split" invoice is one whose items name MORE
// THAN ONE store; single-store and historical (NULL-location) invoices must
// keep behaving exactly as before.

const item = (locationId?: string | null, qty = 1): InvoiceItem => ({
  product: 'Silver toy',
  sku: 'TOY-1',
  qty,
  weight: 0,
  silverRate: 0,
  makingCharge: 0,
  tax: 0,
  amount: 300,
  ...(locationId !== undefined ? { locationId } : {}),
})

test('a two-store fulfilment split is detected — and its stores listed in stable order', () => {
  const items = [item('LOC-DEFAULT', 5), item('L-2ND', 5)]
  assert.equal(isSplitFulfilledInvoice(items), true)
  assert.deepEqual(fulfilledStoreIds(items), ['L-2ND', 'LOC-DEFAULT'], 'sorted, so the note is deterministic')
})

test('single-store invoices are NOT split', () => {
  assert.equal(isSplitFulfilledInvoice([item('LOC-DEFAULT', 5), item('LOC-DEFAULT', 1)]), false)
  assert.deepEqual(fulfilledStoreIds([item('LOC-DEFAULT')]), ['LOC-DEFAULT'])
})

test('historical NULL-location invoices are NOT split — the legacy fallback stays available', () => {
  assert.equal(isSplitFulfilledInvoice([item(null), item(undefined)]), false)
  assert.deepEqual(fulfilledStoreIds([item(null)]), [])
  // A mix of legacy (NULL) rows and one store still reads as single-store:
  // only a SECOND named store makes the invoice split.
  assert.equal(isSplitFulfilledInvoice([item(null), item('LOC-DEFAULT')]), false)
})

test('empty or missing item lists are never split', () => {
  assert.equal(isSplitFulfilledInvoice([]), false)
  assert.equal(isSplitFulfilledInvoice(null), false)
  assert.equal(isSplitFulfilledInvoice(undefined), false)
  assert.deepEqual(fulfilledStoreIds(null), [])
})
