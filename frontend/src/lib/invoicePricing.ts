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
 *   line amount = weight × (silverRatePerGram + makingChargePerGram)
 *   GST is charged on the subtotal (pre-discount); discount comes off the total.
 */

/** One editable line, with numeric fields already parsed. */
export interface InvoiceLineInput {
  /** Total billable weight in grams for the whole line (qty × per-piece net weight). */
  weight: number
  /** Managed silver rate per gram — authoritative, from Silver Rate Management. */
  silverRatePerGram: number
  /** Making charge PER GRAM (not a flat line fee). */
  makingChargePerGram: number
}

/** Line amount exactly as the backend computes it, rounded to the paisa. */
export function lineAmount(line: InvoiceLineInput): number {
  const weight = line.weight
  if (weight <= 0) return 0
  return round2(weight * (line.silverRatePerGram + line.makingChargePerGram))
}

/** Silver component of a line, for the breakdown row. */
export function lineSilverValue(line: InvoiceLineInput): number {
  return round2(line.weight * line.silverRatePerGram)
}

/** Making-charge component of a line, for the breakdown row. */
export function lineMakingValue(line: InvoiceLineInput): number {
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
