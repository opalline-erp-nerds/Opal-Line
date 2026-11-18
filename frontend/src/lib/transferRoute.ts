import type { InventoryLocation, StockTransfer, TransferStatus } from '@/types'
import {
  LOCATION_UNAVAILABLE,
  formatLocationLabel,
  locationTypeLabel,
  resolveLocation,
  type ResolvedLocation,
} from './locations'

/**
 * Human-readable transfer routes.
 *
 * Transfers store canonical `inventory_locations` ids in `from`/`to` (legacy
 * rows store the display name), and a row can outlive the location it points
 * at. Everything a screen shows about a route goes through here — which now
 * delegates the actual formatting/resolving to the shared location helpers in
 * `./locations.ts` so the transfer screens and the rest of the inventory
 * module label locations identically. A raw id or UUID can never reach the UI.
 *
 * Pure functions only — the page owns the data fetching, these own the labels.
 */

/** Display-ready view of one end of a transfer route. */
export type RouteEndpoint = ResolvedLocation

export { locationTypeLabel, LOCATION_UNAVAILABLE }

/**
 * Resolve one end of a transfer route for display.
 *
 * Order: enriched reference from the API → the loaded locations list (by id,
 * then by the legacy name-valued rows) → `Location unavailable`, never a UUID.
 */
export function resolveRouteEndpoint(
  enriched: { name: string; type?: string | null; city?: string | null } | null | undefined,
  raw: string | null | undefined,
  known: InventoryLocation[],
): RouteEndpoint {
  return resolveLocation(enriched, raw, known)
}

/** Dropdown label for one location — `Main Store · Store · Mumbai`, never an id. */
export function routeOptionLabel(loc: { name: string; type?: string | null; city?: string | null }): string {
  return formatLocationLabel(loc)
}

/**
 * Where the transferred stock sits right now — the answer the list and detail
 * views must always give: pending/cancelled stock is still at the source,
 * in-transit stock belongs to neither location, received stock is the
 * destination's.
 */
export function transferOwnerLabel(
  transfer: Pick<StockTransfer, 'status' | 'from' | 'to' | 'fromLocation' | 'toLocation'>,
  known: InventoryLocation[],
): string {
  const source = resolveLocation(transfer.fromLocation, transfer.from, known)
  const dest = resolveLocation(transfer.toLocation, transfer.to, known)
  switch (transfer.status as TransferStatus) {
    case 'pending':
      return source.missing ? 'Stock still at the source location' : `Stock still at ${source.title}`
    case 'in-transit':
      return 'In transit — held at neither location'
    case 'received':
      return dest.missing ? 'Stock arrived at the destination' : `Stock now at ${dest.title}`
    case 'cancelled':
      return source.missing ? 'Stock stays at the source location' : `Stock stays at ${source.title}`
    default:
      return ''
  }
}
