import test from 'node:test'
import assert from 'node:assert/strict'
import { bookingBalance, bookingStats } from './bookingStats'
import type { SalesOrder } from '@/types'

// Bookings-page headline numbers (Phase 5.1). The invariant pinned here:
// a CANCELLED booking never counts towards the ACTIVE advance — its money
// was reversed in the payment ledger with an Advance Refund entry, so
// including it would report cash the business no longer holds.

const booking = (over: Partial<SalesOrder>): SalesOrder =>
  ({ status: 'confirmed', value: 0, advancePaid: 0, ...over }) as SalesOrder

test('cancelled bookings leave the active advance, pending and outstanding stats', () => {
  const bookings = [
    booking({ id: 'open', value: 1000, advancePaid: 100 }), // active, un-invoiced
    booking({ id: 'cancelled', status: 'cancelled', value: 5000, advancePaid: 500 }), // refunded
    booking({ id: 'converted', invoice: 'INV-1', value: 2000, advancePaid: 200 }), // active, invoiced
  ]
  const stats = bookingStats(bookings)

  // The active advance counts open + converted, NEVER the cancelled one.
  assert.equal(stats.totalAdvance, 300, 'the cancelled booking’s ₹500 is excluded')

  assert.equal(stats.pending, 1, 'only the open un-invoiced booking awaits conversion')
  assert.equal(
    stats.outstanding,
    900 + 1800,
    'open balance + converted balance — the cancelled booking’s balance never counts',
  )
  // Total booked value stays all-inclusive (what was ever booked).
  assert.equal(stats.totalValue, 1000 + 5000 + 2000, 'value still measures everything booked')
})

test('a booking with no advance contributes nothing to the advance total', () => {
  const stats = bookingStats([booking({ id: 'a', value: 700, advancePaid: 0 })])
  assert.equal(stats.totalAdvance, 0)
  assert.equal(stats.outstanding, 700, 'the full value is still outstanding')
  assert.equal(stats.pending, 1)
})

test('bookingBalance is value − advance, floored at zero', () => {
  assert.equal(bookingBalance(booking({ value: 1000, advancePaid: 400 })), 600)
  assert.equal(bookingBalance(booking({ value: 1000, advancePaid: 1000 })), 0, 'fully advanced → nothing due')
  // An over-advanced row (advance clamped above value by a bad edit) can
  // never produce a NEGATIVE outstanding.
  assert.equal(bookingBalance(booking({ value: 500, advancePaid: 800 })), 0)
  assert.equal(bookingBalance(booking({})), 0)
})

test('the advance stat is ACTUAL cash (advanceCollected), falling back to the field for legacy rows', () => {
  // A decrease-without-refund leaves terms below recorded cash: the stat
  // reports the cash the ledger holds, never double-counting either.
  const cashOverTerms = bookingStats([
    booking({ id: 'a', value: 1000, advancePaid: 150, advanceCollected: 350 }),
  ])
  assert.equal(cashOverTerms.totalAdvance, 350, 'ledger cash wins over the 150 terms')

  // Bookings that predate the ledger have no advanceCollected — the field is
  // the only record of that collection, so it is the fallback.
  const legacy = bookingStats([booking({ id: 'b', value: 1000, advancePaid: 500 })])
  assert.equal(legacy.totalAdvance, 500, 'legacy bookings keep their advance in the stat')

  // And a fully-refunded cancelled booking is excluded entirely (both by
  // cancellation and by its zero cash).
  const refunded = bookingStats([
    booking({ id: 'c', status: 'cancelled', value: 1000, advancePaid: 500, advanceCollected: 0 }),
  ])
  assert.equal(refunded.totalAdvance, 0, 'a cancelled, fully-refunded booking holds no active advance')
})
