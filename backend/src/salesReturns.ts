/**
 * Sales return planning: which invoice lines a credit note covers, and the
 * guard rails that stop a return from paying out more than was invoiced.
 *
 * The rules live here rather than in the route so they can be unit-tested
 * without a database. The route wraps the resulting plan (restock, credit
 * note, refund record) in a single transaction.
 */

export interface InvoiceItemRow {
  product: string | null
  sku: string | null
  qty: number | null
  amount: number | null
}

export interface ReturnRequestLine {
  sku?: string | null
  qty: number
}

export interface PriorReturnRow {
  returnItems: unknown
}

export interface PlannedReturnLine {
  product: string | null
  sku: string
  qty: number
  amount: number
}

export type PlannedReturn =
  | { ok: true; items: PlannedReturnLine[]; amount: number }
  | { ok: false; error: string }

const round2 = (n: number) => Math.round(n * 100) / 100

function skuOf(value: unknown): string {
  return value == null ? '' : String(value).trim()
}

/**
 * Decide what a return against an invoice actually covers.
 *
 * Two rules matter for the books:
 *
 *   1. A SKU can never be returned more often than it was invoiced. The
 *      shortfall is measured against previous credit notes on the same
 *      invoice, so re-submitting a return is rejected instead of restocking
 *      and refunding the same goods twice.
 *   2. Amounts stay pro-rated against the line they came from — an SKU split
 *      over several invoice lines credits each line for exactly its share.
 *
 * An empty request means "return the whole invoice"; if part of it is already
 * returned, that is an overrun and the caller is told what is left.
 */
export function planSalesReturn(args: {
  invoiceItems: InvoiceItemRow[]
  requested: ReturnRequestLine[]
  priorReturns: PriorReturnRow[]
}): PlannedReturn {
  const { invoiceItems, requested, priorReturns } = args

  // What the invoice sold, per SKU (an SKU can span several lines).
  const invoiced = new Map<string, number>()
  for (const it of invoiceItems) {
    const sku = skuOf(it.sku)
    if (!sku) continue
    invoiced.set(sku, (invoiced.get(sku) ?? 0) + Number(it.qty ?? 1))
  }

  // What earlier credit notes against this invoice already took back.
  const alreadyReturned = new Map<string, number>()
  for (const ret of priorReturns) {
    const lines = Array.isArray(ret.returnItems) ? (ret.returnItems as Array<Record<string, unknown>>) : []
    for (const line of lines) {
      const sku = skuOf(line?.sku)
      const qty = Number(line?.qty ?? 0)
      if (!sku || !Number.isFinite(qty) || qty <= 0) continue
      alreadyReturned.set(sku, (alreadyReturned.get(sku) ?? 0) + qty)
    }
  }

  const qtyBySku = new Map<string, number>()
  if (requested.length > 0) {
    for (const r of requested) {
      const sku = skuOf(r?.sku)
      const qty = Number(r?.qty ?? 0)
      if (!sku || !Number.isFinite(qty) || qty <= 0) continue
      qtyBySku.set(sku, (qtyBySku.get(sku) ?? 0) + qty)
    }
  } else {
    for (const [sku, qty] of invoiced) qtyBySku.set(sku, qty)
  }

  // Never return more than was invoiced, less what is already returned.
  const overruns: string[] = []
  for (const [sku, qty] of qtyBySku) {
    const sold = invoiced.get(sku) ?? 0
    const returned = alreadyReturned.get(sku) ?? 0
    if (qty <= sold - returned) continue
    overruns.push(
      sold === 0
        ? `${sku} is not on this invoice`
        : `${sku}: ${qty} requested, ${returned} of ${sold} already returned`,
    )
  }
  if (overruns.length > 0) {
    return { ok: false, error: `Return quantity exceeds what is left to return — ${overruns.join('; ')}` }
  }

  // Walk the invoice lines in order, handing each one the quantity it still
  // owes from the request: a repeated SKU splits across its own lines and each
  // amount stays pro-rated against the line it came from.
  const remaining = new Map(qtyBySku)
  const items: PlannedReturnLine[] = []
  for (const it of invoiceItems) {
    const sku = skuOf(it.sku)
    if (!sku) continue
    const want = remaining.get(sku) ?? 0
    if (want <= 0) continue
    const take = Math.min(want, Number(it.qty ?? 1))
    if (take <= 0) continue
    remaining.set(sku, want - take)
    items.push({
      product: it.product ?? null,
      sku,
      qty: take,
      amount: round2(((it.amount ?? 0) * take) / (it.qty || 1)),
    })
  }

  if (items.length === 0) {
    return { ok: false, error: 'No matching items to return (SKU + qty required)' }
  }

  return { ok: true, items, amount: round2(items.reduce((a, it) => a + it.amount, 0)) }
}
