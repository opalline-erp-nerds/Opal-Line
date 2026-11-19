/**
 * Splitting one quantity across the variants of a product.
 *
 * Three places need exactly the same arithmetic and must not disagree:
 *
 *   1. the migration that attributes pre-existing product-level balances to
 *      the variants that already claim them (the "Red 4 + White 4 = 8 but the
 *      product shows 7" case);
 *   2. a movement that arrives keyed only to the PARENT product (a manual
 *      invoice, a purchase line or a stock count billing `products.sku` of a
 *      multi-variant product);
 *   3. the first movement of a pre-ledger product, which adopts the old
 *      `products.stock` balance.
 *
 * The rule everywhere: apportion by weight with the largest-remainder method,
 * so the parts ALWAYS sum back to the whole (no quantity is created or lost)
 * and — while the total fits in the weights, which every availability check
 * guarantees — no part can exceed its own weight, so nothing goes negative
 * from rounding alone.
 *
 * Pure on purpose: this is the part that silently corrupts stock if it is
 * wrong, so it is unit-tested without a database.
 */

export interface VariantWeightEntry {
  variantId: string
  /** Apportionment weight: the variant's current balance or recorded share. */
  weight: number
  /**
   * Stable tie-break (variant SKU, falling back to its id). Ties are broken
   * by this so the same inputs always produce the same split on every machine.
   */
  key: string
}

export interface VariantSplit {
  variantId: string
  qty: number
}

function floorNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Splits `qty` (any integer, positive or negative) across `entries`.
 *
 * Returns one part per entry, and the parts always sum to `qty`. With no
 * entries the split is empty — callers must treat that as "nothing to move"
 * rather than inventing a destination.
 */
export function splitQtyAcrossVariants(qty: number, entries: VariantWeightEntry[]): VariantSplit[] {
  if (entries.length === 0) return []
  const amount = Math.trunc(Number(qty) || 0)
  if (amount === 0 || entries.length === 1) {
    return entries.map((e) => ({ variantId: e.variantId, qty: amount }))
  }

  const weights = entries.map((e) => floorNonNegative(e.weight))
  const totalWeight = weights.reduce((sum, w) => sum + w, 0)

  // Nothing recorded anywhere (a brand-new multi-variant product receiving its
  // first parent-level stock): split evenly rather than dropping the movement.
  if (totalWeight === 0) {
    const ordered = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const head = Math.abs(amount)
    const base = Math.floor(head / ordered.length)
    let extra = head - base * ordered.length
    return ordered.map((e) => {
      const share = base + (extra > 0 ? 1 : 0)
      if (extra > 0) extra -= 1
      return { variantId: e.variantId, qty: Math.sign(amount) * share }
    })
  }

  // Largest-remainder apportionment on |qty|, then re-apply the sign, so the
  // parts sum to |qty| exactly and each part stays ≤ its weight whenever
  // |qty| ≤ totalWeight.
  const head = Math.abs(amount)
  const exact = weights.map((w) => (head * w) / totalWeight)
  const base = exact.map((v) => Math.floor(v))
  let leftover = head - base.reduce((sum, v) => sum + v, 0)

  const order = entries
    .map((e, i) => ({ i, frac: exact[i] - base[i], key: e.key }))
    .sort((a, b) => b.frac - a.frac || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const parts = [...base]
  for (const { i } of order) {
    if (leftover <= 0) break
    parts[i] += 1
    leftover -= 1
  }

  const sign = amount < 0 ? -1 : 1
  return entries.map((e, i) => ({ variantId: e.variantId, qty: sign * parts[i] }))
}
