import { useEffect, useState } from 'react'

/**
 * Shared palette for the Financial Analytics charts.
 *
 * The light values are the ones used elsewhere on the dashboard; the dark
 * values are tuned for the `.dark` class in index.css. `useChartTheme` re-renders
 * charts when the class flips so grid/axis colours never go stale.
 */

export const INCOME = '#008F78'
export const EXPENSE = '#5EEAD4'
export const PROFIT = '#008F78'
export const LOSS = '#E5484D'

/** Dashboard series order: teal, emerald, mint, deep cyan, forest, pale mint. */
export const SERIES_COLORS = ['#008F78', '#10B981', '#5EEAD4', '#0E7490', '#134E4A', '#A7F3D0', '#14B8A6']

/** Fixed order for slices/legends; repeats the series palette, then extras. */
export const SLICE_COLORS = [...SERIES_COLORS, '#E5484D', '#0F766E']

/** Payment Status colours shared by the donut and its legend. */
export const PAYMENT_STATUS_COLORS = {
  paid: '#008F78',
  pending: '#5EEAD4',
  failed: '#E5484D',
  overdue: '#F59E0B',
  refunded: '#CBD5E1',
} as const

/** Receivable aging ramp — current (healthy) through older (worst). */
export const AGING_COLORS = ['#008F78', '#14B8A6', '#5EEAD4', '#FBBF24', '#F59E0B', '#E5484D']

/** Neutral track behind donut rings, matching the light mint accent. */
export const DONUT_TRACK = '#E6F7F2'

export interface ChartTheme {
  grid: string
  axis: string
}

const LIGHT: ChartTheme = { grid: '#E8F3EF', axis: '#6B7F7A' }
const DARK: ChartTheme = { grid: '#30423D', axis: '#A6B8B0' }

/** Current chart theme; follows the `.dark` class on <html> live. */
export function useChartTheme(): ChartTheme {
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )
  useEffect(() => {
    const root = document.documentElement
    const sync = () => setDark(root.classList.contains('dark'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark ? DARK : LIGHT
}

/** Compact ₹ label for chart axes: `₹12k`, `₹3.4M` for very large values. */
export function rupeeTick(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `₹${Math.round(value / 1_000_000)}M`
  return `₹${Math.round(value / 1000)}k`
}

/** Exact Indian-grouping money string: `₹1,23,456.78`. */
export function inr(value: number): string {
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}
