/**
 * Shared "Add to price (₹)" tax math for every sales document.
 *
 * The add-on is a GST-INCLUSIVE amount on top of the GST-inclusive selling
 * price. It must therefore be backed out of the taxable value exactly once:
 *
 *   weight-rated line: taxable = weight × (silver + making) + addOn × qty ÷ 1.03
 *   piece-rate line:   taxable = (fixed + addOn) × qty ÷ 1.03
 *
 * Header totals then put GST back with `invoiceTotals` (3% on the subtotal,
 * discount off the grand total). Never add the add-on to a stored per-unit
 * `price` a second time: that price already contains it.
 */
import { roundMoney } from './invoiceTotals'

/** Standard GST rate for silver jewellery. */
export const SALES_GST_RATE = 3

function number(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** The add-on's share of a LINE's taxable (ex-GST) value. */
export function taxableAddOn(addOn: unknown, qty: unknown, gstRate: number = SALES_GST_RATE): number {
  const count = Math.max(0, Math.floor(number(qty)))
  if (count === 0) return 0
  return roundMoney((roundMoney(number(addOn)) * count) / (1 + gstRate / 100))
}

/** Taxable total for a weight-rated line, including its GST-inclusive add-on. */
export function weightTaxableAmount(
  weight: unknown,
  silverRatePerGram: unknown,
  makingChargePerGram: unknown,
  addOn: unknown,
  qty: unknown,
  gstRate: number = SALES_GST_RATE,
): number {
  const grams = Math.max(0, number(weight))
  return roundMoney(
    grams * number(silverRatePerGram) +
    grams * number(makingChargePerGram) +
    taxableAddOn(addOn, qty, gstRate),
  )
}

/** Taxable total for a Piece Rate line: fixed + add-on is GST-inclusive. */
export function pieceRateTaxableAmount(
  fixedRate: unknown,
  addOn: unknown,
  qty: unknown,
  gstRate: number = SALES_GST_RATE,
): number {
  const count = Math.max(0, Math.floor(number(qty)))
  return roundMoney(((number(fixedRate) + roundMoney(number(addOn))) * count) / (1 + gstRate / 100))
}

/**
 * Split already-computed line amounts into the invoice header's silver/making
 * components so `silverValue + makingCharge === subtotal` still holds once a
 * GST-inclusive add-on (or a fixed piece rate) is on the line.
 *
 * A weight line whose amount reconciles with `weight × (rate + making) + the
 * taxable add-on` keeps its natural split; everything else (piece-rate and
 * hand-typed fallback lines) is reported wholly as silver value, matching the
 * zero-weight convention in orderPricing.ts.
 */
export function invoiceComponentTotals(items: Array<Record<string, unknown>>, gstRate: number = SALES_GST_RATE) {
  let silverValue = 0
  let makingCharge = 0
  for (const item of items) {
    const qty = Math.max(1, Math.floor(number(item.qty ?? 1)))
    const weight = Math.max(0, number(item.weight))
    const rate = number(item.silverRate)
    const makingPerGram = number(item.makingCharge)
    const addOn = roundMoney(number(item.priceAdjustment))
    const amount = roundMoney(number(item.amount))
    const taxableAddOnValue = taxableAddOn(addOn, qty, gstRate)
    const naturalAmount = roundMoney(weight * rate + weight * makingPerGram + taxableAddOnValue)
    if (Math.abs(amount - naturalAmount) <= 0.02 && (weight > 0 || rate > 0 || makingPerGram > 0)) {
      silverValue = roundMoney(silverValue + weight * rate + taxableAddOnValue)
      makingCharge = roundMoney(makingCharge + weight * makingPerGram)
    } else {
      silverValue = roundMoney(silverValue + amount)
    }
  }
  return { silverValue: roundMoney(silverValue), makingCharge: roundMoney(makingCharge) }
}
