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
  /** The exact variant the line sold, when the product has variants. */
  variantId?: string | null
  /** The variant's GST-inclusive "Add to price (₹)" delta. */
  priceAdjustment?: number | string | null
  /** Weight per piece (g) entered on the order form; only fills a product with no configured weight. */
  netWeight?: number | null
  /** Total line weight (g): qty × weight-per-piece, or a manual override from the form. */
  weight?: number | null
  /** Making charge per gram from the form; falls back to the catalogue when absent. */
  makingCharge?: number | null
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
  /** The GST-inclusive variant add-on carried by this line. */
  priceAdjustment: number
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

/** One catalogue row `buildPricedOrder` may price a line from. */
export interface OrderCatalogueRow {
  sku: string | null
  netWeight: number | string | null
  makingCharge: number | string | null
  /** Piece Rate Product — a fixed ₹/pc replaces the silver-weight maths. */
  pieceRateProduct?: boolean | null
  fixedPieceRate?: number | string | null
  /** Legacy carrier of the same number on rows saved before the column existed. */
  sellingPrice?: number | string | null
  /** Variant add-on answered for a variant-SKU row. */
  priceAdjustment?: number | string | null
}

/**
 * The fixed ₹/pc a Piece Rate row bills, or null when it prices by weight.
 *
 * Mirrors `lib/sellableItems.ts → sellableItemPrice` on the client so the
 * dialog's preview and the stored line can never disagree: `fixed_piece_rate`
 * wins, `sellingPrice` carries it on older rows, and a row that is not a Piece
 * Rate Product never has one — whatever its price columns say.
 */
export function fixedPieceRateFor(
  row: Pick<OrderCatalogueRow, 'pieceRateProduct' | 'fixedPieceRate' | 'sellingPrice'>,
): number | null {
  if (row.pieceRateProduct !== true) return null
  const fixed = Number(row.fixedPieceRate ?? 0)
  if (Number.isFinite(fixed) && fixed > 0) return fixed
  const selling = Number(row.sellingPrice ?? 0)
  return Number.isFinite(selling) && selling > 0 ? selling : null
}

export function buildPricedOrder<T extends OrderItemInput>(
  items: T[],
  productData: OrderCatalogueRow[],
  silverRate: number,
): PricedOrder<T> {
  const productMap = new Map(
    productData.map((p) => [
      String(p.sku ?? '').trim(),
      {
        netWeight: Number(p.netWeight ?? 0),
        makingCharge: Number(p.makingCharge ?? 0),
        pieceRate: fixedPieceRateFor(p),
        priceAdjustment: Number(p.priceAdjustment ?? 0) || 0,
      },
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
    const product = productMap.get(sku) ?? {
      netWeight: 0,
      makingCharge: 0,
      pieceRate: null as number | null,
      priceAdjustment: 0,
    }
    // The line's snapshot wins; a scan that omitted it still gets the add-on
    // from the variant row the catalogue looked up.
    const addOn = roundMoney(Number(li.priceAdjustment ?? product.priceAdjustment ?? 0) || 0)
    // A weight entered on the form wins (it must round-trip through
    // save/refresh); the catalogue fills in when the form sent none — which
    // covers every client that predates weight editing. Never invents a
    // weight: an unknown, unweighted line stays 0.
    const clientWeightPerPiece = Number(li.netWeight ?? 0)
    const netWeight = clientWeightPerPiece > 0 ? clientWeightPerPiece : product.netWeight
    const makingChargePerGram = li.makingCharge === undefined || li.makingCharge === null
      ? product.makingCharge
      : Number(li.makingCharge)
    const qty = Math.max(0, Math.floor(Number(li.quantity ?? 0)))
    // Total weight: the form's value (qty × weight-per-piece, or a manual
    // override) wins; otherwise derive it. Grams round to 3 dp — money below
    // keeps rounding to the paisa as before.
    const clientTotalWeight = Number(li.weight ?? 0)
    const weight = clientTotalWeight > 0
      ? Math.round(clientTotalWeight * 1000) / 1000
      : netWeight > 0
        ? Math.round(netWeight * qty * 1000) / 1000
        : 0

    // ── Piece Rate: the fixed ₹/pc IS the per-unit price. The silver-weight
    //    arithmetic below never runs for such a line — a ₹2,000/pc toy with a
    //    200 g net weight used to arrive as 200 × (rate + making). The stored
    //    `price` stays the catalogue's fixed figure (which is what the dialog
    //    shows and what Σ price × qty re-derives the order value from), and the
    //    taxable amount is that GST-inclusive price backed out — with the whole
    //    amount in silverValue and makingValue 0, the same shape
    //    `buildManualInvoiceLines` bills price-only lines from, so the header
    //    sums and the invoice raised from this order stay consistent.
    const pieceRate = product.pieceRate
    if (pieceRate != null) {
      // Fixed ₹/pc is GST-inclusive, so is the add-on: the whole unit price is
      // backed out to a taxable amount before the 3% is added back by totals.
      const unitPrice = roundMoney(pieceRate + addOn)
      const amount = qty > 0 ? roundMoney((unitPrice * qty) / (1 + ORDER_GST_RATE / 100)) : 0
      return {
        ...li,
        price: unitPrice,
        priceAdjustment: addOn,
        quantity: qty,
        netWeight,
        makingCharge: 0,
        weight,
        silverRate: 0,
        silverValue: amount,
        makingValue: 0,
        amount,
      }
    }

    const itemSilverRate = weight > 0 ? silverRate : 0
    const itemMakingCharge = weight > 0 ? makingChargePerGram : 0
    // The add-on is an amount ON TOP of a GST-inclusive selling price. Back it
    // out of the taxable value exactly like the base: addOn × qty ÷ 1.03. It
    // is carried in silverValue so subtotal = Σ silverValue + makingValue.
    const taxableAddOn = qty > 0 ? roundMoney((addOn * qty) / (1 + ORDER_GST_RATE / 100)) : 0
    const silverValue = roundMoney((weight > 0 ? weight * itemSilverRate : 0) + taxableAddOn)
    const makingValue = weight > 0 ? roundMoney(weight * itemMakingCharge) : 0
    const amount = roundMoney(silverValue + makingValue)
    // Same GST-inclusive line price the Shopify draft order receives, split
    // back to a per-unit price so re-editing the order multiplies once.
    const gstInclusiveLine = roundMoney(amount * (1 + ORDER_GST_RATE / 100))
    return {
      ...li,
      price: qty > 0 ? roundMoney(gstInclusiveLine / qty) : gstInclusiveLine,
      priceAdjustment: addOn,
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

/**
 * A stored `sales_orders.line_items` row — everything the order form and the
 * booking flow persist. Order-form lines are component-shaped (priced by
 * buildPricedOrder above); booking lines carry only title/sku/quantity/price.
 */
export interface StoredOrderLine {
  title?: string
  sku?: string
  quantity?: number
  price?: number
  weight?: number | null
  silverRate?: number | null
  makingCharge?: number | null
  silverValue?: number | null
  makingValue?: number | null
  amount?: number | null
  /** The exact variant the line sold — carried onto the invoice it becomes. */
  variantId?: string | null
  /** The variant add-on folded into `price`; persisted for the line breakdown. */
  priceAdjustment?: number | null
}

/** One `sales_invoice_items` row raised from a stored order line. */
export interface ManualInvoiceLine {
  product: string
  sku: string
  qty: number
  weight: number
  silverRate: number
  makingCharge: number
  /** Line GST at the invoice rate. */
  tax: number
  /** Taxable value (ex-GST). */
  amount: number
  silverValue: number
  makingValue: number
  /** NULL on flat lines — kept so the invoice keeps naming its variant. */
  variantId?: string | null
  /** The variant add-on folded into this line's price. */
  priceAdjustment?: number | null
}

/**
 * Invoice lines for a MANUAL order — the `createInvoiceForOrderRow` branch
 * that has no Shopify bill to mirror.
 *
 * Component-shaped lines (order-form rows) bill exactly as their stored
 * components say: silverValue + makingValue is the taxable amount, and a
 * stored `amount` wins — identical to the behaviour this replaces, so nothing
 * changes for orders already carrying their components.
 *
 * A line carrying only a `price` — which is everything a booking stores — used
 * to fall through to silverValue 0 / amount 0: a ₹0 invoice line, while its
 * stock was still deducted. Such a line is now billed from its price. The
 * table's own convention (module comment above) makes `price` PER-UNIT and
 * GST-inclusive, so the taxable value is price × qty ÷ (1 + gstRate); adding
 * GST back returns exactly the booked amount, which is what the booking's
 * `value`, its advance clamp and the convert endpoint's balance all assume.
 *
 * The whole taxable amount sits in silverValue (making 0) — the same
 * convention the zero-weight draft-order lines in index.ts already use — so an
 * invoice keeps its silverValue + makingCharge = subtotal shape and the weekly
 * margin sum (grandTotal − silverValue − makingCharge) cannot count the whole
 * sale as margin.
 */
export function buildManualInvoiceLines(lines: StoredOrderLine[], gstRate: number): ManualInvoiceLine[] {
  return lines.map((li) => {
    const qty = Number(li.quantity ?? 0)
    const price = Number(li.price ?? 0)
    const weight = Number(li.weight ?? 0)
    const itemSilverRate = Number(li.silverRate ?? 0)
    const itemMakingCharge = Number(li.makingCharge ?? 0)
    const componentSilver = li.silverValue != null
      ? Number(li.silverValue)
      : weight > 0 ? roundMoney(weight * itemSilverRate) : 0
    const componentMaking = li.makingValue != null
      ? Number(li.makingValue)
      : weight > 0 ? roundMoney(weight * itemMakingCharge) : 0
    const components = roundMoney(componentSilver + componentMaking)
    const fromPrice = qty > 0 && Number.isFinite(price)
      ? roundMoney((price * qty) / (1 + gstRate / 100))
      : 0
    const amount = li.amount != null ? Number(li.amount) : components > 0 ? components : fromPrice
    const silverValue = components > 0 ? componentSilver : amount
    const makingValue = componentMaking
    return {
      product: String(li.title ?? '').trim(),
      sku: String(li.sku ?? ''),
      qty,
      weight,
      silverRate: itemSilverRate,
      makingCharge: itemMakingCharge,
      tax: roundMoney((amount * gstRate) / 100),
      amount,
      silverValue,
      makingValue,
      // The variant travels with the line: the invoice must keep naming the
      // exact variant its stock was deducted from, not just its SKU string.
      ...(li.variantId ? { variantId: li.variantId } : {}),
      ...(li.priceAdjustment != null ? { priceAdjustment: li.priceAdjustment } : {}),
    }
  })
}
