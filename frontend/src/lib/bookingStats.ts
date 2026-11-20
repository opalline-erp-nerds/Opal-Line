import type { SalesOrder } from '@/types'

/**
 * Headline numbers for the Bookings page (Phase 5.1).
 *
 * A CANCELLED booking is closed business: it leaves the pending and
 * outstanding pipelines AND the ACTIVE advance total — cancellation is a
 * status, not a refund, so the cash it still holds is reported separately as
 * `advanceRefundable` (an explicit operator action), never as active advance.
 *
 * The advance figure is ACTUAL CASH: `advanceCollected` from the server
 * (payment-ledger collections minus real refunds, falling back to the field
 * for bookings that predate the ledger) — each cash event is one immutable
 * ledger row, so additional collections add up without ever double-counting
 * and a decrease-without-refund never shrinks recorded history.
 *
 * Pure — no network, no state — unit tested directly.
 */

/** What the customer still owes on a booking: value − advance, floored at 0. */
export function bookingBalance(b: SalesOrder): number {
  return Math.max(0, Math.round((Number(b.value ?? 0) - Number(b.advancePaid ?? 0)) * 100) / 100)
}

export interface BookingStats {
  /** Everything ever booked on this page (cancelled included). */
  totalValue: number
  /** Actual advance cash held on ACTIVE bookings — cancelled ones are excluded. */
  totalAdvance: number
  /** Open bookings awaiting conversion (never invoiced, never cancelled). */
  pending: number
  /** Outstanding balance across active bookings (cancelled excluded). */
  outstanding: number
}

export function bookingStats(bookings: SalesOrder[]): BookingStats {
  const active = bookings.filter((b) => b.status !== 'cancelled')
  return {
    totalValue: bookings.reduce((a, o) => a + Number(o.value ?? 0), 0),
    totalAdvance: active.reduce(
      (a, o) => a + Number(o.advanceCollected ?? o.advancePaid ?? 0),
      0,
    ),
    pending: bookings.filter((o) => !o.invoice && o.status !== 'cancelled').length,
    outstanding: active.reduce((a, o) => a + bookingBalance(o), 0),
  }
}
