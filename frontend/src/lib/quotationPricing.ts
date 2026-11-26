import { round2 } from '@/lib/utils'

/**
 * Canonical quotation money math — mirrors the backend one-for-one:
 *
 *   - `normalizeQuotationItems` (routes/quotations.ts):
 *       amount = weight × (rate + making) + addOn × qty ÷ 1.03
 *   - `applyPieceRateInvoiceItems`: piece-rate lines bill
 *       (fixed + addOn) × qty ÷ 1.03 and zero the rate components
 *   - `computeTotals`: GST on the subtotal; discount comes off the grand total
 *
 * The variant "Add to price (₹)" is GST-INCLUSIVE. It is backed out of the
 * taxable line amount here and put back exactly once by the header's 3% GST,
 * so the customer pays the base plus the add-on — never the add-on twice.
 */

/** Standard GST rate for silver jewellery. */
const GST_RATE_DIVISOR = 1.03

/** One editable quotation line, numeric fields already parsed. */
export interface QuotationLineInput {
  qty: number
  /** Net weight PER PIECE in grams (from the catalogue or typed). */
  netWeight: number
  /** Silver rate per gram (managed rate, editable on quotations). */
  silverRatePerGram: number
  /** Making charge PER GRAM (catalogue value, editable). */
  makingChargePerGram: number
  /** Fixed GST-inclusive price per piece for Piece Rate Products; 0 = weight line. */
  fixedPieceRate: number
  /** GST-inclusive variant "Add to price (₹)" snapshotted on the line. */
  priceAdjustment?: number
}

/** Total billable weight for a line = per-piece net weight × qty. */
export function quotationLineWeight(line: Pick<QuotationLineInput, 'qty' | 'netWeight'>): number {
  const net = Math.max(0, line.netWeight)
  const qty = Math.max(0, line.qty)
  return round2(net * qty)
}

/** Same piece-rate shape the backend stores (all rate components zeroed). */
export function isPieceRateLine(line: QuotationLineInput): boolean {
  return line.fixedPieceRate > 0
}

/** Line amount exactly as the backend computes it, rounded to the paisa. */
export function quotationLineAmount(line: QuotationLineInput): number {
  const qty = Math.max(0, line.qty)
  const addOn = round2(line.priceAdjustment ?? 0)
  if (isPieceRateLine(line)) {
    return round2(((line.fixedPieceRate + addOn) * qty) / GST_RATE_DIVISOR)
  }
  return round2(
    quotationLineWeight(line) * (line.silverRatePerGram + line.makingChargePerGram) +
    round2((addOn * qty) / GST_RATE_DIVISOR),
  )
}

export interface QuotationTotals {
  subtotal: number
  gstRate: number
  gstAmount: number
  discount: number
  grandTotal: number
}

/**
 * Totals mirroring the backend `computeTotals`: GST on the subtotal,
 * discount deducted from the grand total, each step rounded to the paisa.
 */
export function quotationTotals(
  lines: QuotationLineInput[],
  gstRate: number,
  discount: number,
): QuotationTotals {
  const subtotal = round2(lines.reduce((a, l) => a + quotationLineAmount(l), 0))
  const gstAmount = round2((subtotal * gstRate) / 100)
  const grandTotal = round2(subtotal + gstAmount - discount)
  return { subtotal, gstRate, gstAmount, discount, grandTotal }
}

/**
 * Per-quantity parse that never accepts zero/negative/fractional quantities.
 * Returns null where the string is not a usable quantity — callers show a
 * line-level error instead of silently clamping.
 */
export function parseQuotationQty(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return 1 // an empty qty defaults to 1 piece
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) return null
  return n
}

/**
 * What stops a line being priced/persisted. Returns [] for a valid line.
 * Rules (mirroring the server's expectations, no server round-trip needed):
 *   - piece-rate lines need no weight/rates — the fixed rate prices the line
 *   - every other line needs weight > 0 and a rate or making charge to price
 *   - NaN/blank numerics that should be numbers are reported, not coerced
 */
export function quotationLineIssues(line: QuotationLineInput): string[] {
  if (line.qty < 1) return ['quantity must be at least 1']
  if (isPieceRateLine(line)) return []
  const issues: string[] = []
  if (line.netWeight <= 0) issues.push('weight per piece is required')
  if (line.silverRatePerGram <= 0 && line.makingChargePerGram <= 0) {
    issues.push('silver rate or making charge is required to price the line')
  }
  return issues
}
