import type { BookingAllocationLine, InventoryLocation, LocationStockAvailability, SalesOrder } from '@/types'

/**
 * Booking allocation PLANNING helpers — the frontend half of
 * backend/src/bookings.ts (`allocationStatusFor` / `buildAllocationSummary`
 * / `putBookingAllocations`); the pure rules live here so both the dialog and
 * its tests can use them without touching the page component.
 *
 * Allocations are planning records: they never reserve or move stock.
 */

/** Unallocated / Partially Allocated / Fully Allocated — one line or a booking. */
export type AllocationStatus = 'unallocated' | 'partial' | 'fully'

/** Mirror of the backend rule — keep in sync with backend/src/bookings.ts. */
export function allocationStatusFor(allocated: number, required: number): AllocationStatus {
  if (!(required > 0) || !(allocated > 0)) return 'unallocated'
  if (allocated >= required) return 'fully'
  return 'partial'
}

/** One editable allocation row in the allocation dialog. */
export interface AllocationDraft {
  key: string
  lineIndex: number
  locationId: string
  /** Quantity as typed (string, like every other numeric form field). */
  quantity: string
}

/** Σ booked quantity across CATALOGUE lines only — hand-typed lines never allocate. */
export function trackedQuantity(b: SalesOrder): number {
  return (b.lineItems ?? []).reduce<number>((sum, li) => {
    if (!(li as { productId?: string }).productId) return sum
    return sum + Math.max(0, Math.floor(Number(li.quantity ?? 0)))
  }, 0)
}

/**
 * Client-side validation of a draft allocation set — the SAME rules the
 * server enforces, so Save can be gated and errors shown inline. The server
 * stays authoritative on save; combined/cross-store stock is never consulted.
 */
export function allocationDraftIssues(args: {
  lines: BookingAllocationLine[]
  rows: AllocationDraft[]
  locations: InventoryLocation[]
  availability: Record<string, LocationStockAvailability | null | { error: string } | undefined>
}): { invalid: boolean; perLine: Record<number, string> } {
  const { lines, rows, locations, availability } = args
  const perLine: Record<number, string> = {}

  for (const row of rows) {
    const line = lines.find((l) => l.lineIndex === row.lineIndex)
    if (!line) continue
    const qty = Math.floor(Number(row.quantity) || 0)
    if (!locations.some((l) => l.id === row.locationId)) {
      perLine[row.lineIndex] = 'Selected store no longer exists — pick another store.'
      continue
    }
    if (qty < 1) {
      perLine[row.lineIndex] = 'Allocation quantities must be at least 1.'
      continue
    }
    const avail = availability[`${line.productId ?? ''}|${line.variantId ?? ''}`]
    if (avail && !('error' in avail)) {
      const storeAvailable = avail.locations.find((l) => l.locationId === row.locationId)?.available ?? 0
      if (qty > storeAvailable) {
        perLine[row.lineIndex] = `Only ${storeAvailable} available at that store — reduce the quantity or pick another store.`
        continue
      }
    }
  }

  // Over-allocation against the booked quantity (draft totals).
  for (const line of lines) {
    if (!line.tracked || line.required <= 0) continue
    const draft = rows
      .filter((r) => r.lineIndex === line.lineIndex)
      .reduce((sum, r) => sum + Math.max(0, Math.floor(Number(r.quantity) || 0)), 0)
    if (draft > line.required && !perLine[line.lineIndex]) {
      perLine[line.lineIndex] = `Over-allocated by ${draft - line.required} — this booking only books ${line.required}.`
    }
  }

  return { invalid: Object.keys(perLine).length > 0, perLine }
}
