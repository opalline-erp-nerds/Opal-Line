/**
 * Stock aging rules.
 *
 * Stock Overview answers "how much do we have"; this module answers the harder
 * question the shop actually asks: "how long have the units still on the shelf
 * been sitting there?" The product row only stores a balance, so the age has to
 * be rebuilt from the stock ledger.
 *
 * FIFO is the accounting assumption used everywhere else in the ERP: the units
 * sold first are the ones that entered first. So the remaining balance is the
 * newest `stock` units across all inflows, and the oldest unit still on hand is
 * the one whose inflow date we report. Doing this by lot keeps the answer honest
 * after a partial sale — a product restocked yesterday does not look fresh if
 * half its balance is still the lot from last year.
 *
 * Everything here is pure so the FIFO and bucket boundaries can be tested
 * without a database; the route only supplies the ledger rows.
 */

/** Age bands shown on the Stock Overview page. 180+ is the last, unbounded band. */
export type AgingBucketKey = 'd0_30' | 'd31_60' | 'd61_90' | 'd91_180' | 'd180_plus'

/** Badge tone for a band; ordered from healthy to write-off. */
export type AgingTone = 'success' | 'info' | 'warning' | 'danger' | 'muted'

export interface AgingBucketDefinition {
  key: AgingBucketKey
  label: string
  /** Inclusive lower bound, in days. */
  minDays: number
  /** Inclusive upper bound, in days. `null` means unbounded. */
  maxDays: number | null
  tone: AgingTone
}

export const AGING_BUCKETS: readonly AgingBucketDefinition[] = [
  { key: 'd0_30', label: '0-30 days', minDays: 0, maxDays: 30, tone: 'success' },
  { key: 'd31_60', label: '31-60 days', minDays: 31, maxDays: 60, tone: 'info' },
  { key: 'd61_90', label: '61-90 days', minDays: 61, maxDays: 90, tone: 'warning' },
  { key: 'd91_180', label: '91-180 days', minDays: 91, maxDays: 180, tone: 'danger' },
  { key: 'd180_plus', label: '180+ days', minDays: 181, maxDays: null, tone: 'muted' },
]

const MS_PER_DAY = 86_400_000

/**
 * Parses the date shapes that reach us here: JS Dates from the raw driver,
 * ISO strings from the API, and the naive `YYYY-MM-DD HH:MM:SS` strings that
 * `timestamp without time zone` columns produce.
 */
export function parseAgingDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (value == null) return null
  const text = String(value).trim()
  if (!text) return null
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Normalises a date for the API response, or null when it cannot be parsed. */
export function toAgingIso(value: unknown): string | null {
  const parsed = parseAgingDate(value)
  return parsed ? parsed.toISOString() : null
}

/** Whole days since `entryDate`, never negative (a future date reads as 0). */
export function ageInDays(entryDate: unknown, now: Date = new Date()): number | null {
  const entry = parseAgingDate(entryDate)
  if (!entry) return null
  const diff = now.getTime() - entry.getTime()
  if (!Number.isFinite(diff)) return null
  return Math.max(0, Math.floor(diff / MS_PER_DAY))
}

/** The band a day count falls into. Unknown/negative input is treated as fresh. */
export function agingBucketForDays(days: number | null | undefined): AgingBucketKey {
  const value = Number(days)
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0
  for (const bucket of AGING_BUCKETS) {
    if (safe >= bucket.minDays && (bucket.maxDays === null || safe <= bucket.maxDays)) return bucket.key
  }
  return AGING_BUCKETS[AGING_BUCKETS.length - 1].key
}

/** Definition lookup for callers that need the label/tone for a bucket. */
export function agingBucketDefinition(key: AgingBucketKey): AgingBucketDefinition {
  return AGING_BUCKETS.find((bucket) => bucket.key === key) ?? AGING_BUCKETS[0]
}

export interface InflowLot {
  date: unknown
  qty: unknown
}

export interface FifoAgeInput {
  /** Units still on hand (`products.stock`). */
  stock: number
  /** Every positive stock movement for the product, in any order. */
  inflows: Iterable<InflowLot>
}

/**
 * Entry date of the oldest unit still on hand, normalised to ISO.
 *
 * Computes the consumed quantity from the ledger rather than trusting a
 * separate outflow total: `consumed = total inflow - stock`. That keeps the
 * result consistent with the balance actually displayed even if an old manual
 * adjustment was recorded without a matching movement.
 *
 * Returns null when the ledger cannot explain the balance (no inflows, or less
 * stock-in than stock on hand). Callers fall back to the product's creation
 * date for those pre-ledger rows.
 */
export function fifoEntryDate({ stock, inflows }: FifoAgeInput): string | null {
  const target = Math.floor(Number(stock))
  if (!Number.isFinite(target) || target <= 0) return null

  const lots: Array<{ at: number; iso: string; qty: number }> = []
  for (const inflow of inflows) {
    const qty = Math.floor(Number(inflow.qty))
    if (!Number.isFinite(qty) || qty <= 0) continue
    const parsed = parseAgingDate(inflow.date)
    if (!parsed) continue
    lots.push({ at: parsed.getTime(), iso: parsed.toISOString(), qty })
  }
  if (lots.length === 0) return null

  // Oldest first. Ties keep the caller's ledger order (JS sort is stable).
  lots.sort((a, b) => a.at - b.at)

  const totalIn = lots.reduce((sum, lot) => sum + lot.qty, 0)
  if (totalIn < target) return null

  let consumed = totalIn - target
  for (const lot of lots) {
    if (consumed >= lot.qty) {
      consumed -= lot.qty
      continue
    }
    return lot.iso
  }
  return lots[lots.length - 1]?.iso ?? null
}
