import type { StockAgingBucketKey, StockAgingRow } from '@/types'

export interface StockAgingFilters {
  query?: string
  category?: string
  bucket?: StockAgingBucketKey | ''
}

/** Search + filters for the Aging Unsold Stock table. Pure so it stays testable. */
export function filterAgingRows(rows: readonly StockAgingRow[], filters: StockAgingFilters): StockAgingRow[] {
  const query = (filters.query ?? '').trim().toLowerCase()
  return rows.filter((row) => {
    const matchesQuery = !query || row.name.toLowerCase().includes(query) || row.sku.toLowerCase().includes(query)
    const matchesCategory = !filters.category || row.category === filters.category
    const matchesBucket = !filters.bucket || row.agingBucket === filters.bucket
    return matchesQuery && matchesCategory && matchesBucket
  })
}

const AGING_BADGE_VARIANT: Record<StockAgingBucketKey, 'success' | 'info' | 'warning' | 'danger' | 'muted'> = {
  d0_30: 'success',
  d31_60: 'info',
  d61_90: 'warning',
  d91_180: 'danger',
  d180_plus: 'muted',
}

/** Badge tone for a bucket key, tolerant of API data that is newer than the UI. */
export function agingBadgeVariant(key: string): 'success' | 'info' | 'warning' | 'danger' | 'muted' {
  return AGING_BADGE_VARIANT[key as StockAgingBucketKey] ?? 'muted'
}

/** "1 day" / "42 days" — avoids the "1 days" copy bug in the table cell. */
export function formatDaysInStock(days: number): string {
  const value = Math.max(0, Math.floor(Number(days) || 0))
  return value === 1 ? '1 day' : `${value} days`
}
