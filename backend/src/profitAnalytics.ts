/**
 * Pure money rules for Owner Insights.
 *
 * Gross profit is revenue minus the cost of the units that were actually sold.
 * The invoice header's `silver_value + making_charge` is a SALES-PRICE split
 * (and, on older rows, a stale weight × rate snapshot); it is not a cost and
 * must never be used as COGS. The authoritative cost is the weighted-average
 * `cost_price` maintained on purchase receipts: per UNIT on the product, or on
 * the exact variant when one was sold.
 *
 * These helpers are intentionally free of DB/Express imports so the accounting
 * rules can be unit-tested in isolation.
 */

export interface ProductCostRow {
  id: string
  sku: string | null
  costPrice: number | null
}

export interface VariantCostRow {
  id: string
  productId: string | null
  sku: string | null
  costPrice: number | null
  title?: string | null
}

export interface CostIndex {
  variantsById: Map<string, VariantCostRow>
  variantsBySku: Map<string, VariantCostRow>
  productsById: Map<string, ProductCostRow>
  productsBySku: Map<string, ProductCostRow>
}

export interface CostedLine {
  sku?: string | null
  variantId?: string | null
}

export interface ReturnLine {
  sku: string
  qty: number
  /** Credit-note line value (GST-inclusive, like the header `amount`). */
  amount?: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

const key = (value: unknown): string => String(value ?? '').trim().toLowerCase()

const positive = (value: unknown): number => {
  const n = Number(value ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Index the catalogue once per report, so every line resolves in O(1). */
export function buildCostIndex(
  products: ProductCostRow[],
  variants: VariantCostRow[],
): CostIndex {
  const index: CostIndex = {
    variantsById: new Map(),
    variantsBySku: new Map(),
    productsById: new Map(),
    productsBySku: new Map(),
  }
  for (const product of products) {
    index.productsById.set(product.id, product)
    const sku = key(product.sku)
    if (sku) index.productsBySku.set(sku, product)
  }
  for (const variant of variants) {
    index.variantsById.set(variant.id, variant)
    const sku = key(variant.sku)
    if (sku) index.variantsBySku.set(sku, variant)
  }
  return index
}

/**
 * Resolve one unit's cost, variant first.
 *
 * A variant with its own cost wins. A variant without one falls back to its
 * parent product's per-unit cost (piece-rate products store the fixed ₹/pc
 * there). Only historical lines with no resolvable variant fall back to the
 * product's own SKU. Never derives cost from weight or silver rate: that is a
 * pricing rule, not a purchase cost, and is exactly what produced -400% moves.
 */
export function resolveUnitCost(line: CostedLine, index: CostIndex): number {
  const variant = line.variantId ? index.variantsById.get(line.variantId) : undefined
  if (variant) {
    const own = positive(variant.costPrice)
    if (own) return own
    const parent = variant.productId ? index.productsById.get(variant.productId) : undefined
    const parentCost = positive(parent?.costPrice)
    if (parentCost) return parentCost
  }

  const sku = key(line.sku)
  if (sku) {
    const variantBySku = index.variantsBySku.get(sku)
    if (variantBySku) {
      const own = positive(variantBySku.costPrice)
      if (own) return own
      const parent = variantBySku.productId ? index.productsById.get(variantBySku.productId) : undefined
      const parentCost = positive(parent?.costPrice)
      if (parentCost) return parentCost
    }
    const product = index.productsBySku.get(sku)
    const productCost = positive(product?.costPrice)
    if (productCost) return productCost
  }
  return 0
}

/** COGS for a sold line: quantity × the per-UNIT cost above. */
export function lineCogs(qty: number, unitCost: number): number {
  const units = Number.isFinite(qty) && qty > 0 ? qty : 0
  return round2(units * positive(unitCost))
}

/** Parse the {sku, qty} rows a credit note carries into its return_items JSON. */
export function parseReturnItems(raw: unknown): ReturnLine[] {
  let rows: unknown = raw
  if (!Array.isArray(rows)) {
    const nested = (raw as Record<string, unknown> | null)?.items
    rows = Array.isArray(nested) ? nested : [raw]
  }
  const out: ReturnLine[] = []
  for (const row of rows as unknown[]) {
    if (!row || typeof row !== 'object') continue
    const sku = key((row as Record<string, unknown>).sku)
    const qty = Number((row as Record<string, unknown>).qty ?? 0)
    const amount = Number((row as Record<string, unknown>).amount ?? 0)
    if (sku && Number.isFinite(qty) && qty > 0) {
      const line: ReturnLine = { sku, qty }
      if (Number.isFinite(amount) && amount > 0) line.amount = amount
      out.push(line)
    }
  }
  return out
}

/** A return reverses the COGS of the units it put back, not the sale's price. */
export function returnCogs(raw: unknown, index: CostIndex): number {
  return round2(parseReturnItems(raw).reduce((sum, line) => {
    // Credit notes carry SKUs, not variant ids; variant SKU resolution still
    // wins over the parent so a returned variant restores its own bucket cost.
    return sum + lineCogs(line.qty, resolveUnitCost({ sku: line.sku }, index))
  }, 0))
}

/** Back a GST-inclusive money figure out to its taxable (ex-GST) value. */
export function exGstAmount(gross: number, gstRate: number | null | undefined): number {
  const amount = Number.isFinite(gross) ? gross : 0
  const rate = Number.isFinite(gstRate ?? 0) && (gstRate ?? 0) > -100 ? Number(gstRate) : 0
  return round2(amount / (1 + rate / 100))
}
