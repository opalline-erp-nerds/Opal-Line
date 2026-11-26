import { formatCurrency } from './format'

export interface TrendPoint {
  revenue: number
  grossProfit: number
  netProfit: number
}

/** One consistent money shape for every Owner Insights figure (paise included). */
export function ownerMoney(value: number | null | undefined): string {
  return formatCurrency(value, { decimals: true })
}

/** Month keys arrive as YYYY-MM from the API; render them in en-IN short form. */
export function ownerMonthLabel(key: string): string {
  const [year, month] = String(key ?? '').split('-').map(Number)
  if (!year || !month) return String(key ?? '')
  return new Date(year, month - 1, 1).toLocaleString('en-IN', { month: 'short', year: '2-digit' })
}

/** Shared scale across all three series, including negative excursions. */
export function ownerChartMax(points: TrendPoint[]): number {
  return Math.max(
    1,
    ...points.flatMap((p) => [
      Math.abs(Number(p.revenue) || 0),
      Math.abs(Number(p.grossProfit) || 0),
      Math.abs(Number(p.netProfit) || 0),
    ]),
  )
}

/**
 * Percentage width of a bar. Zero (and non-finite) values are EXACTLY zero —
 * no 2px stub pill — and the bar never escapes its track.
 */
export function ownerBarWidth(value: number, maxAbs: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0 || !Number.isFinite(maxAbs) || maxAbs <= 0) return 0
  return Math.min(100, (Math.abs(n) / maxAbs) * 100)
}

/** Profit is green at/above zero and red below it, on cards and in the chart. */
export function ownerProfitTone(value: number): string {
  return Number(value) < 0 ? 'text-destructive' : 'text-success'
}

/** Bar colour follows the sign, so negative profit never reads as a gain. */
export function ownerBarTone(value: number, positive: string): string {
  return Number(value) < 0 ? 'bg-destructive' : positive
}

/** Signed margin text kept beside the money, always in the same shape. */
export function ownerMarginLabel(margin: number): string {
  const n = Number.isFinite(margin) ? margin : 0
  return `${n.toFixed(2)}%`
}
