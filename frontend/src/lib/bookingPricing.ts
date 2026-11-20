import { round2 } from '@/lib/utils'

/**
 * The booking money model — the FRONTEND half of one calculation path, kept
 * in sync with `computeBookingTotals` in backend/src/bookings.ts (pinned by
 * tests on both sides, same fixtures), which is itself identical to what
 * `createInvoiceForOrderRow` stores when the booking is converted.
 *
 *   line price = PER-UNIT, GST-inclusive (the sales_orders convention, see
 *                backend/src/orderPricing.ts)
 *   taxable_i  = round2(price_i × qty_i ÷ (1 + rate%))
 *   GST        = taxable × rate%
 *   grandTotal = taxable + GST − discount
 *
 * So the numbers this form shows are the numbers the invoice will hold —
 * to the paisa — and the advance/outstanding the customer agrees to.
 */

export interface BookingPricingLine {
  /** Per-unit, GST-inclusive. */
  price: number
  qty: number
}

export interface BookingPricingPreview {
  /** Σ price × qty — GST-inclusive, as entered on the lines. */
  linesTotal: number
  /** Taxable value: every line backed out of GST, rounded to the paisa. */
  taxable: number
  gstRate: number
  gstAmount: number
  discount: number
  /** taxable + GST − discount — exactly the invoice grand total at convert. */
  grandTotal: number
  advance: number
  /** max(0, grandTotal − advance). */
  outstanding: number
}

export function bookingPricing(
  lines: BookingPricingLine[],
  gstRate: number,
  discount: number,
  advance: number,
): BookingPricingPreview {
  const rate = Math.max(0, Number.isFinite(Number(gstRate)) ? Number(gstRate) : 0)
  const disc = Math.max(0, Number.isFinite(Number(discount)) ? Number(discount) : 0)
  const paid = Math.max(0, Number.isFinite(Number(advance)) ? Number(advance) : 0)

  const lineTotal = (l: BookingPricingLine) => (Number(l.price) || 0) * (Number(l.qty) || 0)
  const linesTotal = round2(lines.reduce((a, l) => a + lineTotal(l), 0))
  const taxable = round2(lines.reduce((a, l) => a + round2(lineTotal(l) / (1 + rate / 100)), 0))
  const gstAmount = round2((taxable * rate) / 100)
  const grandTotal = round2(taxable + gstAmount - disc)
  const outstanding = Math.max(0, round2(grandTotal - paid))

  return { linesTotal, taxable, gstRate: rate, gstAmount, discount: disc, grandTotal, advance: paid, outstanding }
}
