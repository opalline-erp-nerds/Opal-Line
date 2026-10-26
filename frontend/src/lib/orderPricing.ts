import { calculateJewelleryPrice } from './utils'

/**
 * The per-unit selling price for a Sales Order line at the applied silver rate.
 *
 * `li.price` on the order dialog is a PER-UNIT price: the subtotal multiplies
 * it by the line's quantity exactly once, and the backend stores it per unit
 * and multiplies once (`value = Σ price × quantity`). The pricing engine
 * scales linearly with quantity, so quantity is pinned to 1 here — callers may
 * pass whatever quantity the line currently holds and can never reintroduce
 * the old price-for-full-quantity × quantity double count.
 *
 * Returns undefined when there is no rate or no billable weight and no fallback
 * price, so callers can keep the line's existing price.
 */
export function perUnitLinePrice(params: {
  silverRate: number | null | undefined
  netWeight: number | null | undefined
  makingCharge: number | null | undefined
  fallback: number | null | undefined
}): number | undefined {
  const { silverRate, netWeight, makingCharge, fallback } = params
  if (silverRate && netWeight && netWeight > 0) {
    return calculateJewelleryPrice({
      silverRatePerGram: silverRate,
      netWeightPerUnit: netWeight,
      makingChargePerGram: makingCharge ?? 0,
      quantity: 1,
    }).finalPrice
  }
  return fallback == null ? undefined : Number(fallback) || 0
}

/** Order total: Σ per-unit price × quantity — the dialog's subtotal. */
export function orderLinesTotal(lines: Array<{ price: number; qty: number }>): number {
  return lines.reduce(
    (acc, li) => acc + (Number.isFinite(li.price) ? li.price : 0) * (Number.isFinite(li.qty) ? li.qty : 0),
    0,
  )
}
