/**
 * Shopify order → sales invoice money mapping.
 *
 * A Shopify order is a transaction the customer has already been billed for, so
 * the order total is authoritative. The ERP catalogue only supplies the cost
 * component split (net weight × silver rate + making charge). The invoice
 * import used to rebuild the subtotal from those components alone, which wrote
 * a ₹0 invoice whenever a line's SKU was missing from the catalogue (or had no
 * weight) even though the Shopify order carried a real amount — e.g. order
 * #1025 worth ₹6,423.80 invoiced at ₹0.
 *
 * This module keeps one definition of the mapping:
 *   grandTotal  = Shopify order total           (authoritative)
 *   gstAmount   = Shopify's tax, else GST on the pre-tax value
 *   taxable     = grandTotal − gstAmount        (value after discount)
 *   discount    = Shopify's total_discounts     (identity below holds exactly)
 *   subtotal    = taxable + discount            (pre-discount taxable value)
 *   subtotal + gstAmount − discount = grandTotal
 * Line amounts and taxes are allocated across the Shopify line prices so the
 * invoice's own lines also add up to the grand total, and the metal/making
 * components are scaled to the taxable value (left null when the catalogue has
 * no weight, so the invoice is excluded from cost-based profit instead of
 * reporting a 100% margin).
 */
import { roundMoney } from './invoiceTotals'

const num = (value: unknown): number => {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

export interface ShopifyBilledLine {
  /** Shopify line price, per unit (pre-tax). */
  price: number
  quantity: number
  /** Total net weight for the line, in grams (0 when unknown). */
  weight?: number
  /** Per-gram silver rate used for the component split. */
  silverRate?: number
  /** Per-gram making charge used for the component split. */
  makingCharge?: number
}

export interface PricedInvoiceLine {
  /** Taxable value allocated to this line (after discount). */
  amount: number
  /** GST allocated to this line. */
  tax: number
  weight: number
  silverRate: number
  makingCharge: number
}

export interface ShopifyInvoiceAmounts {
  lines: PricedInvoiceLine[]
  /** Metal value for the invoice header; null when no catalogue weight exists. */
  silverValue: number | null
  /** Making charge for the invoice header; null when no catalogue weight exists. */
  makingCharge: number | null
  subtotal: number
  gstAmount: number
  discount: number
  grandTotal: number
}

export function computeShopifyInvoiceAmounts(input: {
  /** Shopify order total (total_price); line prices are the fallback. */
  total: unknown
  /** Shopify total_discounts. */
  discount?: unknown
  /** Shopify total_tax; when present it is the invoice's GST amount. */
  totalTax?: unknown
  /** ERP GST rate, used when Shopify reports no tax. */
  gstRate?: unknown
  lines: ShopifyBilledLine[]
}): ShopifyInvoiceAmounts {
  const gstRate = Math.max(0, num(input.gstRate))
  const priced = input.lines.map((line) => ({
    price: Math.max(0, num(line.price)),
    quantity: Math.max(0, num(line.quantity)),
    weight: Math.max(0, num(line.weight)),
    silverRate: Math.max(0, num(line.silverRate)),
    makingCharge: Math.max(0, num(line.makingCharge)),
  }))

  const billedGross = roundMoney(priced.reduce((sum, line) => sum + line.price * line.quantity, 0))
  const declaredTotal = roundMoney(num(input.total))
  // The Shopify order total wins; older rows imported without one fall back to
  // the sum of their line prices so a real sale is still never invoiced at ₹0.
  const grandTotal = declaredTotal > 0 ? declaredTotal : billedGross
  if (grandTotal <= 0) {
    return {
      lines: priced.map(() => ({ amount: 0, tax: 0, weight: 0, silverRate: 0, makingCharge: 0 })),
      silverValue: null,
      makingCharge: null,
      subtotal: 0,
      gstAmount: 0,
      discount: 0,
      grandTotal: 0,
    }
  }

  const declaredTax = roundMoney(num(input.totalTax))
  const gstAmount = declaredTax > 0 && declaredTax < grandTotal
    ? declaredTax
    : roundMoney(grandTotal - roundMoney(grandTotal / (1 + gstRate / 100)))
  const taxable = roundMoney(grandTotal - gstAmount)
  // The discount is shown separately on the tax invoice; subtotal is the value
  // before it, which keeps subtotal + gstAmount − discount === grandTotal.
  const discount = Math.min(Math.max(0, roundMoney(num(input.discount))), taxable)
  const subtotal = roundMoney(taxable + discount)

  // Allocate the taxable value and GST across the lines by billed amount. The
  // last line absorbs the rounding remainder so the lines sum exactly.
  const billedWeights = priced.map((line) => (line.price > 0 && line.quantity > 0 ? line.price * line.quantity : 0))
  const billedSum = billedWeights.reduce((sum, value) => sum + value, 0)
  const shareOf = (index: number) => (billedSum > 0 ? billedWeights[index] / billedSum : 1 / priced.length)

  let allocatedAmount = 0
  let allocatedTax = 0
  const amounts = priced.map((_, index) => {
    const last = index === priced.length - 1
    const amount = last ? roundMoney(taxable - allocatedAmount) : roundMoney(taxable * shareOf(index))
    const tax = last ? roundMoney(gstAmount - allocatedTax) : roundMoney(gstAmount * shareOf(index))
    allocatedAmount = roundMoney(allocatedAmount + amount)
    allocatedTax = roundMoney(allocatedTax + tax)
    return { amount, tax }
  })

  // Component split from the catalogue, scaled onto the actual taxable value so
  // the invoice's silver_value + making_charge never contradicts its subtotal.
  const rawSilver = priced.reduce((sum, line) => sum + line.weight * line.silverRate, 0)
  const rawMaking = priced.reduce((sum, line) => sum + line.weight * line.makingCharge, 0)
  const rawComponents = rawSilver + rawMaking
  let silverValue: number | null = null
  let makingCharge: number | null = null
  if (rawComponents > 0 && taxable > 0) {
    silverValue = roundMoney((rawSilver / rawComponents) * taxable)
    makingCharge = roundMoney(taxable - silverValue)
  }

  return {
    lines: priced.map((line, index) => ({
      amount: amounts[index]?.amount ?? 0,
      tax: amounts[index]?.tax ?? 0,
      weight: line.weight,
      silverRate: line.silverRate,
      makingCharge: line.makingCharge,
    })),
    silverValue,
    makingCharge,
    subtotal,
    gstAmount,
    discount,
    grandTotal,
  }
}
