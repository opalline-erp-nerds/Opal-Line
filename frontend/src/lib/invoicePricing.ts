import { round2 } from '@/lib/utils'

/**
 * Canonical invoice money math for the billing screens — the FRONTEND half of
 * a single calculation path shared with the backend.
 *
 * The backend (`normalizeInvoiceItems` in routes/db.ts and `invoiceTotals` in
 * invoiceTotals.ts) is the source of truth: it recomputes every line and total
 * on write, so the numbers the server stores always win. This module exists so
 * the New Sales Invoice dialog can PREVIEW exactly what the server will store,
 * instead of drifting the way the old flat-making-charge maths did.
 *
 * Keep the two in sync:
 *   line amount = (fixed + addOn) × qty ÷ 1.03             (Piece Rate lines)
 *              = weight × (rate + making) + addOn × qty ÷ 1.03  (weight-based)
 *   GST is charged on the subtotal (3%); discount comes off the grand total.
 *
 * Variant "Add to price (₹)" is GST-INCLUSIVE: it is backed out of the taxable
 * value here and put back exactly once by the totals. The per-unit price in a
 * picker already contains it, so this helper must never be fed that effective
 * price as if it were the base.
 */

/** Standard GST rate for silver jewellery. */
const GST_RATE_DIVISOR = 1.03

/** One editable line, with numeric fields already parsed. */
export interface InvoiceLineInput {
  /** Total billable weight in grams for the whole line (qty × per-piece net weight). */
  weight: number
  /** Managed silver rate per gram — authoritative, from Silver Rate Management. */
  silverRatePerGram: number
  /** Making charge PER GRAM (not a flat line fee). */
  makingChargePerGram: number
  /**
   * Fixed GST-inclusive ₹/pc for a Piece Rate line; 0/absent = weight-based.
   * When set the line bills `(fixed + addOn) × qty ÷ 1.03` and the
   * weight/rate/making inputs are ignored — the same rule
   * `applyPieceRateItems` applies server-side, so a ₹2,000/pc toy is never
   * re-priced by silver weight here.
   */
  pieceRate?: number
  /** Whole pieces; only read when `pieceRate` applies, and by the add-on. */
  qty?: number
  /** GST-inclusive variant "Add to price (₹)" snapshotted on the line. */
  priceAdjustment?: number
}

/** The add-on's share of the LINE's taxable (ex-GST) value. */
export function lineAddOnValue(line: InvoiceLineInput): number {
  const addOn = round2(line.priceAdjustment ?? 0)
  const qty = Math.max(1, Math.floor(line.qty ?? 1))
  return round2((addOn * qty) / GST_RATE_DIVISOR)
}

/** Line amount exactly as the backend computes it, rounded to the paisa. */
export function lineAmount(line: InvoiceLineInput): number {
  const qty = Math.max(1, Math.floor(line.qty ?? 1))
  if (line.pieceRate != null && line.pieceRate > 0) {
    return round2(((line.pieceRate + round2(line.priceAdjustment ?? 0)) * qty) / GST_RATE_DIVISOR)
  }
  const weight = line.weight
  if (weight <= 0) return 0
  return round2(weight * (line.silverRatePerGram + line.makingChargePerGram) + lineAddOnValue(line))
}

/** Silver component of a line, for the breakdown row. */
export function lineSilverValue(line: InvoiceLineInput): number {
  if (line.pieceRate != null && line.pieceRate > 0) return lineAmount(line)
  return round2(line.weight * line.silverRatePerGram + lineAddOnValue(line))
}

/** Making-charge component of a line, for the breakdown row. */
export function lineMakingValue(line: InvoiceLineInput): number {
  if (line.pieceRate != null && line.pieceRate > 0) return 0
  return round2(line.weight * line.makingChargePerGram)
}

export interface InvoiceTotalsPreview {
  subtotal: number
  gstRate: number
  gstAmount: number
  discount: number
  grandTotal: number
}

/**
 * Invoice totals mirroring the backend `invoiceTotals`: GST on the subtotal,
 * discount deducted from the grand total, each step rounded to the paisa.
 */
export function invoiceTotalsPreview(
  lines: InvoiceLineInput[],
  gstRate: number,
  discount: number,
): InvoiceTotalsPreview {
  const subtotal = round2(lines.reduce((a, l) => a + lineAmount(l), 0))
  const gstAmount = round2((subtotal * gstRate) / 100)
  const grandTotal = round2(subtotal + gstAmount - discount)
  return { subtotal, gstRate, gstAmount, discount, grandTotal }
}
