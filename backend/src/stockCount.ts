/**
 * Pure helpers for the scan stock-count flow (POST /db/inventory/stock-count).
 * Kept side-effect free so validation rules are unit-testable without a DB.
 */

export interface StockCountRow {
  id: string
  counted: number
  /**
   * Counts ONE variant of that product instead of the product as a whole.
   * Optional: the shipped stock-count screen counts products, and a
   * product-level count is split across its variants by what each holds (the
   * location's total is exact either way). A caller that knows which variant
   * it physically counted passes this and the balance moves on that variant
   * alone.
   */
  variantId?: string | null
}

export interface StockCountParseResult {
  rows: StockCountRow[]
  errors: string[]
}

export const STOCK_COUNT_MAX_ITEMS = 500

/**
 * Validate and normalise a raw counts payload:
 *  - `id` must be a non-empty string, `counted` a finite number >= 0
 *  - values are floored to whole units
 *  - at most STOCK_COUNT_MAX_ITEMS rows are accepted, extras are reported as errors
 */
export function buildStockCountRows(raw: unknown): StockCountParseResult {
  const rows: StockCountRow[] = []
  const errors: string[] = []
  const list = Array.isArray(raw) ? raw : []
  for (const c of list.slice(0, STOCK_COUNT_MAX_ITEMS)) {
    const id = String((c as { id?: unknown })?.id ?? '').trim()
    const counted = Number((c as { counted?: unknown })?.counted)
    const variantId = String((c as { variantId?: unknown })?.variantId ?? '').trim()
    if (!id || !Number.isFinite(counted) || counted < 0) {
      errors.push(`${id || 'unknown'}: invalid counted value`)
      continue
    }
    // The key only appears when the caller actually counted a variant, so the
    // product-level shape the shipped screen sends stays exactly as it was.
    rows.push(variantId ? { id, counted: Math.floor(counted), variantId } : { id, counted: Math.floor(counted) })
  }
  for (let i = STOCK_COUNT_MAX_ITEMS; i < list.length; i++) {
    errors.push(`item ${i + 1}: over the ${STOCK_COUNT_MAX_ITEMS}-item limit`)
  }
  return { rows, errors }
}

/** Coerces a stored per-location balance (which may be null or a string) to a whole number. */
export function stockAtLocation(stored: unknown): number {
  const n = Number(stored ?? 0)
  return Math.floor(Number.isFinite(n) ? n : 0)
}

/**
 * The signed movement a count should post for one product.
 *
 * `current` MUST be the balance at the location being counted, not the
 * cross-location total: passing products.stock here makes counting one shop
 * silently correct another whenever more than one location holds stock.
 *
 * `set` treats `counted` as the physical truth at that location. `adjust`
 * treats it as a delta to apply on top of what the ledger already says.
 */
export function stockCountDelta(current: number, counted: number, mode: 'set' | 'adjust'): number {
  const currentQty = stockAtLocation(current)
  const countedQty = stockAtLocation(counted)
  if (mode === 'adjust') return countedQty
  return countedQty - currentQty
}
