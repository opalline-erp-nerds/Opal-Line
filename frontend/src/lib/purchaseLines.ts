import { findSellableBySku, type SellableItem } from '@/lib/sellableItems'

/**
 * How a purchase line's money is derived.
 *
 * `''` means "not resolved yet" — the line came off a saved PO / Purchase
 * Invoice / Purchase Return (or the catalogue has not arrived), so the mode is
 * looked up from the flattened catalogue on demand. It never silently flips a
 * line that was already decided when its row was picked.
 */
export type PurchaseLinePricing = '' | 'piece_rate' | 'weight_based'

/** The fields a catalogue row fills in when it is picked onto a purchase line. */
export interface PurchaseLinePick {
  sku: string
  /**
   * What the Item column of every purchase table, detail modal and printout
   * renders. A variant row writes `parent - variant`, because that column is
   * free text and is the ONLY place a variant is named on the paper — the
   * SKU column carries the variant's own code alongside it.
   */
  product: string
  productId: string | null
  variantId: string | null
  pricingType: Exclude<PurchaseLinePricing, ''>
  /**
   * Per-piece grams for a weight-based row, blank for a piece-rate one. A
   * piece-rate item has no weight, and filling one in is exactly how a ₹500
   * line ended up priced as `netWeight × silver rate`.
   */
  weight: string
}

/**
 * Resolve a purchase line's own code against the flattened catalogue.
 *
 * Returns null for an unknown / hand-typed code — the caller keeps whatever
 * the line already held, which is what lets a legacy parent-SKU line (saved
 * before variants existed) and a typed-in "Other" line both survive an edit.
 */
export function pickPurchaseLine(items: SellableItem[], sku: string): PurchaseLinePick | null {
  const item = findSellableBySku(items, sku)
  if (!item) return null
  return {
    sku: item.sku,
    product: purchaseItemName(item),
    productId: item.productId,
    variantId: item.variantId,
    pricingType: item.pricingType,
    weight:
      item.pricingType === 'piece_rate'
        ? ''
        : item.netWeight != null
          ? String(item.netWeight)
          : '',
  }
}

/**
 * The pricing mode a line actually runs on.
 *
 * A stored value always wins — it was fixed when the row was picked and must
 * not change because the catalogue reloaded underneath the dialog. Otherwise
 * the line's own code resolves it, and anything unresolvable stays
 * weight-based: the mode every purchase line had before Piece Rate existed.
 */
export function purchaseLinePricing(
  line: { sku?: string; pricingType?: PurchaseLinePricing },
  items: SellableItem[],
): 'piece_rate' | 'weight_based' {
  if (line.pricingType === 'piece_rate' || line.pricingType === 'weight_based') return line.pricingType
  return findSellableBySku(items, line.sku ?? '')?.pricingType ?? 'weight_based'
}

/**
 * Per-piece grams → the line's TOTAL grams.
 *
 * A purchase ORDER stores the per-piece weight (its amount is qty × weight ×
 * rate), but a purchase INVOICE / RETURN stores the line total (amount is
 * weight × rate). The catalogue only knows the per-piece figure, so a document
 * that stores totals must scale it by the quantity — otherwise a qty-3 line of
 * 5 g pieces is booked as 5 g of silver instead of 15 g.
 */
export function lineTotalWeight(perPiece: string, qty: string | number): string {
  const grams = Number(perPiece) || 0
  if (grams <= 0) return ''
  const pieces = Math.max(1, Math.floor(Number(qty) || 1))
  return String(Math.round(grams * pieces * 1000) / 1000)
}

/** ₹ for a Piece Rate line: qty × the ₹/pc the operator entered. */
export function pieceRateAmount(qty: string | number, price: string | number): number {
  const pieces = Math.max(1, Math.floor(Number(qty) || 1))
  return Math.round(pieces * (Number(price) || 0) * 100) / 100
}

/**
 * Does a SAVED line have the piece-rate shape — no grams, no ₹/g rate, but a
 * real money total?
 *
 * Saved purchase rows carry no pricing-mode flag (the columns were added
 * without one, and backfilling a guess would risk rewriting documents), so
 * this is how a detail modal and a printout tell a ₹500-per-piece line apart
 * from a weight-based one. A line with nothing on it at all answers false —
 * there is no price to advertise.
 */
export function isPieceRateShaped(
  weight: number | null | undefined,
  rate: number | null | undefined,
  base: number | null | undefined,
): boolean {
  return !(Number(weight) > 0) && !(Number(rate) > 0) && (Number(base) || 0) > 0
}

/** ₹ per piece for a saved line, derived from its stored LINE total. */
export function unitPrice(total: number | null | undefined, qty: number | null | undefined): number {
  const pieces = Math.max(1, Math.floor(Number(qty) || 1))
  return Math.round(((Number(total) || 0) / pieces) * 100) / 100
}

/**
 * The Item column text for a catalogue row: `parent - variant` when there is
 * one, so a variant is named on every table, detail modal and printout that
 * only ever renders this free-text column.
 */
export function purchaseItemName(item: { productName: string; variantName?: string | null }): string {
  return item.variantName ? `${item.productName} - ${item.variantName}` : item.productName
}

/**
 * The ₹/pc a saved piece-rate line opens at.
 *
 * Every purchase document stores the LINE total, so per piece is `total ÷ qty`
 * — which reproduces the stored money exactly. A line saved before Piece Rate
 * existed therefore round-trips at the value it already had rather than being
 * quietly repriced by the catalogue.
 */
export function pieceRateFromTotal(base: string | number, qty: string | number): string {
  const pieces = Math.max(1, Math.floor(Number(qty) || 1))
  const total = Number(base) || 0
  if (total <= 0) return ''
  return String(Math.round((total / pieces) * 100) / 100)
}
