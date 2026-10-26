/**
 * Order line pricing against the authoritative silver rate.
 *
 * Extracted from the order-create handler so the per-unit / line-total
 * convention can be pinned by unit tests without booting the app or a
 * database.
 *
 * Convention — every consumer of salesOrders.lineItems multiplies `price` by
 * the quantity exactly once (the order edit dialog's subtotal, the order
 * print document, the order→invoice conversion and the order-update value):
 *   price   = PER-UNIT line price, GST-inclusive
 *   amount  = line total ex-GST (the taxable value)
 *   value   = grandTotal = Σ amount + 3% GST
 * Storing a full-quantity line total in `price` made any later edit multiply
 * that total by the quantity again (the qty-3 → 9x double count).
 */
import { invoiceTotals, roundMoney } from './invoiceTotals'

/** Standard GST rate for silver jewellery. */
export const ORDER_GST_RATE = 3

export interface OrderItemInput {
  title?: string
  sku?: string
  productSku?: string
  quantity?: number
  price?: number
}

/**
 * The validated request shape: createOrderSchema guarantees title, quantity
 * and price, so handlers may assert it when handing lines on.
 */
export interface ValidatedOrderItem extends OrderItemInput {
  title: string
  quantity: number
  price: number
}

export interface PricedOrderItem {
  /** PER-UNIT, GST-inclusive — see the module comment. */
  price: number
  quantity: number
  netWeight: number
  makingCharge: number
  weight: number
  silverRate: number
  silverValue: number
  makingValue: number
  /** Line total ex-GST (taxable value). */
  amount: number
}

export interface PricedOrder<T extends OrderItemInput = OrderItemInput> {
  lines: Array<T & PricedOrderItem>
  /** Σ silverValue + Σ makingValue, ex-GST. */
  subtotal: number
  gstAmount: number
  grandTotal: number
  itemCount: number
}

export function buildPricedOrder<T extends OrderItemInput>(
  items: T[],
  productData: Array<{ sku: string | null; netWeight: number | string | null; makingCharge: number | string | null }>,
  silverRate: number,
): PricedOrder<T> {
  const productMap = new Map(
    productData.map((p) => [
      String(p.sku ?? '').trim(),
      { netWeight: Number(p.netWeight ?? 0), makingCharge: Number(p.makingCharge ?? 0) },
    ]),
  )

  // Canonical formula (same as invoices):
  //   weight      = netWeight × qty
  //   silverValue = weight × silverRate
  //   makingValue = weight × makingChargePerGram
  //   amount      = silverValue + makingValue (line total, ex-GST)
  //   grandTotal  = Σ amount + 3% GST
  const lines = items.map((li) => {
    const sku = String(li.productSku ?? li.sku ?? '').trim()
    const product = productMap.get(sku) ?? { netWeight: 0, makingCharge: 0 }
    const netWeight = product.netWeight
    const makingChargePerGram = product.makingCharge
    const qty = Math.max(0, Math.floor(Number(li.quantity ?? 0)))
    const weight = netWeight > 0 ? roundMoney(netWeight * qty) : 0
    const itemSilverRate = weight > 0 ? silverRate : 0
    const itemMakingCharge = weight > 0 ? makingChargePerGram : 0
    const silverValue = weight > 0 ? roundMoney(weight * itemSilverRate) : 0
    const makingValue = weight > 0 ? roundMoney(weight * itemMakingCharge) : 0
    const amount = roundMoney(silverValue + makingValue)
    // Same GST-inclusive line price the Shopify draft order receives, split
    // back to a per-unit price so re-editing the order multiplies once.
    const gstInclusiveLine = roundMoney(amount * (1 + ORDER_GST_RATE / 100))
    return {
      ...li,
      price: qty > 0 ? roundMoney(gstInclusiveLine / qty) : gstInclusiveLine,
      quantity: qty,
      netWeight,
      makingCharge: makingChargePerGram,
      weight,
      silverRate: itemSilverRate,
      silverValue,
      makingValue,
      amount,
    }
  })

  const totalSilverValue = roundMoney(lines.reduce((sum, li) => sum + (Number.isFinite(li.silverValue) ? li.silverValue : 0), 0))
  const totalMakingCharge = roundMoney(lines.reduce((sum, li) => sum + (Number.isFinite(li.makingValue) ? li.makingValue : 0), 0))
  const subtotal = roundMoney(totalSilverValue + totalMakingCharge)
  const { gstAmount, grandTotal } = invoiceTotals(subtotal, ORDER_GST_RATE, 0)
  const itemCount = lines.reduce((sum, li) => sum + li.quantity, 0)

  return { lines, subtotal, gstAmount, grandTotal, itemCount }
}
