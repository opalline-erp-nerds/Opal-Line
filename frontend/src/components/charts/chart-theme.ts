import { useEffect, useState } from 'react'

/**
 * Shared palette for the Financial Analytics charts.
 *
 * The light values are the ones used elsewhere on the dashboard; the dark
 * values are tuned for the `.dark` class in index.css. `useChartTheme` re-renders
 * charts when the class flips so grid/axis colours never go stale.
 */

export const INCOME = '#7C5CE6'
export const EXPENSE = '#2FBF71'
export const PROFIT = '#2FBF71'
export const LOSS = '#E5484D'

/** Dashboard series order: purple, blue, green, orange, navy, yellow, teal. */
export const SERIES_COLORS = ['#7C5CE6', '#2F5BE0', '#2FBF71', '#F5821F', '#1E2A6B', '#F5C518', '#25B8C4']

/** Fixed order for slices/legends; repeats the series palette, then extras. */
export const SLICE_COLORS = [...SERIES_COLORS, '#E5484D', '#9D7BE0']

/** Receivable aging ramp — current (healthy) through older (worst). */
export const AGING_COLORS = ['#2FBF71', '#2F5BE0', '#F5821F', '#7C5CE6', '#E5484D', '#7F1D1D']

export interface ChartTheme {
  grid: string
  axis: string
}

const LIGHT: ChartTheme = { grid: '#E8E8F0', axis: '#8A8AA3' }
const DARK: ChartTheme = { grid: '#2A2A38', axis: '#7A7A93' }

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
