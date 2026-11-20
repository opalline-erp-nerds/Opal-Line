import type { InvoiceItem } from '@/types'

/**
 * Fulfilment-shape helpers for an invoice's line items (Phase 4 hardening).
 *
 * A multi-store fulfilment split stores the SAME invoice as one item per
 * store (`location_id` on each row; NULL on historical invoices). The invoice
 * edit dialog uses these to explain — before anything is attempted — that
 * fulfilment lines and their stores are not editable there, instead of leaving
 * a caller to discover the backend's refusal after the fact.
 *
 * Pure: no network, no state — unit tested directly.
 */

/** Distinct fulfilment stores across an invoice's items, in stable order. */
export function fulfilledStoreIds(items: readonly InvoiceItem[] | null | undefined): string[] {
  const ids = new Set<string>()
  for (const item of items ?? []) {
    const locationId = item?.locationId
    if (typeof locationId === 'string' && locationId.trim() !== '') ids.add(locationId.trim())
  }
  return [...ids].sort()
}

/**
 * True when ONE invoice's lines were fulfilled from MORE THAN ONE store —
 * a "split" invoice. Single-store and historical (all-NULL) invoices are
 * not split: their replacement lines keep working without a store on them.
 */
export function isSplitFulfilledInvoice(items: readonly InvoiceItem[] | null | undefined): boolean {
  return fulfilledStoreIds(items).length > 1
}
