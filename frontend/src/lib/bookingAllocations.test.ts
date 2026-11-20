import test from 'node:test'
import assert from 'node:assert/strict'
import { allocationDraftIssues, allocationStatusFor, trackedQuantity, type AllocationDraft } from './bookingAllocations'
import type { BookingAllocationLine, InventoryLocation, LocationStockAvailability, SalesOrder } from '@/types'

// The booking ALLOCATION rules (Phase 3): pure planning maths, shared by the
// allocation dialog and its tests. The server enforces the same rules again on
// save — this pins the frontend half: status derivation, tracked quantities
// and the draft validation that gates the Save button.

test('allocation status: Unallocated / Partially Allocated / Fully Allocated', () => {
  assert.equal(allocationStatusFor(0, 10), 'unallocated')
  assert.equal(allocationStatusFor(4, 10), 'partial')
  assert.equal(allocationStatusFor(10, 10), 'fully')
  assert.equal(allocationStatusFor(12, 10), 'fully', 'over-allocation still reads as fully (the server refuses it first)')
  assert.equal(allocationStatusFor(0, 0), 'unallocated', 'nothing booked → nothing to allocate')
  assert.equal(allocationStatusFor(5, 0), 'unallocated')
})

test('trackedQuantity counts catalogue lines only — hand-typed lines never allocate', () => {
  const booking = {
    lineItems: [
      { productId: 'p1', quantity: 3, title: 'Ring', sku: 'R', price: 100 },
      { quantity: 2, title: 'Hand typed', sku: '', price: 50 }, // no productId
      { productId: 'p2', quantity: '4', title: 'Chain', sku: 'C', price: 30 }, // string qty tolerated
    ],
  } as unknown as SalesOrder
  assert.equal(trackedQuantity(booking), 7, '3 + 4 from tracked lines; the hand-typed 2 never counts')
  assert.equal(trackedQuantity({ lineItems: [] } as unknown as SalesOrder), 0)
})

const lines: BookingAllocationLine[] = [
  {
    lineIndex: 0,
    title: 'Silver toy — red',
    sku: 'RED-1',
    productId: 'p1',
    variantId: 'v1',
    tracked: true,
    required: 10,
    allocated: 4,
    remaining: 6,
    status: 'partial',
  },
  {
    lineIndex: 1,
    title: 'Hand typed extra',
    sku: '',
    productId: null,
    variantId: null,
    tracked: false,
    required: 3,
    allocated: 0,
    remaining: 3,
    status: 'unallocated',
  },
]

const locations: InventoryLocation[] = [
  { id: 'LOC-DEFAULT', name: 'Main Store', type: 'store', city: '', manager: '' },
  { id: 'L2', name: '2nd Store', type: 'store', city: '', manager: '' },
]

const availability: Record<string, LocationStockAvailability> = {
  'p1|v1': {
    locations: [
      { locationId: 'LOC-DEFAULT', name: 'Main Store', available: 6 },
      { locationId: 'L2', name: '2nd Store', available: 0 },
    ],
    combined: 6,
  },
}

const rowsOf = (rows: AllocationDraft[], avail: Record<string, LocationStockAvailability> = availability) =>
  allocationDraftIssues({ lines, rows, locations, availability: avail })

test('draft validation: a legal plan passes untouched', () => {
  const result = rowsOf([{ key: 'a', lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: '4' }])
  assert.equal(result.invalid, false)
  assert.deepEqual(result.perLine, {})
})

test('draft validation: never above the STORE balance (never the combined figure)', () => {
  // Main holds 6; the combined figure is 6 too — but the rule is per store.
  const over = rowsOf([{ key: 'a', lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: '7' }])
  assert.equal(over.invalid, true)
  assert.match(over.perLine[0], /Only 6 available at that store/)

  // A store with nothing: any quantity is refused there.
  const emptyStore = rowsOf([{ key: 'a', lineIndex: 0, locationId: 'L2', quantity: '1' }])
  assert.equal(emptyStore.invalid, true)
  assert.match(emptyStore.perLine[0], /Only 0 available at that store/)
})

test('draft validation: vanished stores and non-positive quantities', () => {
  const goneStore = rowsOf([{ key: 'a', lineIndex: 0, locationId: 'deleted-store', quantity: '1' }])
  assert.equal(goneStore.invalid, true)
  assert.match(goneStore.perLine[0], /no longer exists/)

  const zeroQty = rowsOf([{ key: 'a', lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: '0' }])
  assert.equal(zeroQty.invalid, true)
  assert.match(zeroQty.perLine[0], /at least 1/)
})

test('draft validation: never above the booked quantity — the draft REPLACES the saved plan', () => {
  // Both stores hold 6, so the store rule cannot fire: only the booking's own
  // quantity (10) can. The draft already CONTAINS the saved rows (the dialog
  // seeds from them), so it is compared against the booked total directly.
  const wide: Record<string, LocationStockAvailability> = {
    'p1|v1': {
      locations: [
        { locationId: 'LOC-DEFAULT', name: 'Main Store', available: 6 },
        { locationId: 'L2', name: '2nd Store', available: 6 },
      ],
      combined: 12,
    },
  }
  const over = rowsOf(
    [
      { key: 'a', lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: '6' },
      { key: 'b', lineIndex: 0, locationId: 'L2', quantity: '5' },
    ],
    wide,
  )
  assert.equal(over.invalid, true)
  assert.match(over.perLine[0], /Over-allocated by 1/, '11 planned against 10 booked')

  const exact = rowsOf(
    [
      { key: 'a', lineIndex: 0, locationId: 'LOC-DEFAULT', quantity: '6' },
      { key: 'b', lineIndex: 0, locationId: 'L2', quantity: '4' },
    ],
    wide,
  )
  assert.equal(exact.invalid, false, '6 + 4 = 10 = the booked quantity is a legal plan')
})
