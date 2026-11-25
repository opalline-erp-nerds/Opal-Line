import { useEffect, useRef } from 'react'
import type { SalesOrder } from '@/types'
import {
  ORDER_REFRESH_INTERVAL_MS,
  isOrderRefreshDue,
  newShopifyOrders,
  shouldOrderRefreshRun,
} from '@/lib/orderAutoRefresh'

export interface UseOrderAutoRefreshOptions {
  /** Turn the whole thing off (e.g. the user lacks permission to read orders). */
  enabled?: boolean
  /**
   * Suspend refreshes without tearing down the timer — used while a dialog is
   * open so an in-progress order form or detail panel is never reset.
   */
  paused?: boolean
  intervalMs?: number
  fetchOrders: () => Promise<SalesOrder[]>
  /** Replaces the list in place; filters, search, sort and pagination are untouched. */
  onOrders: (orders: SalesOrder[]) => void
  /** Called only when orders that were not there before appear. */
  onNewShopifyOrders?: (orders: SalesOrder[]) => void
}

/**
 * Refreshes the orders list in the background: every interval while the tab is
 * visible, plus on window focus. Failures keep the last good list on screen.
 */
export function useOrderAutoRefresh({
  enabled = true,
  paused = false,
  intervalMs = ORDER_REFRESH_INTERVAL_MS,
  fetchOrders,
  onOrders,
  onNewShopifyOrders,
}: UseOrderAutoRefreshOptions): void {
  const latest = useRef({ paused, fetchOrders, onOrders, onNewShopifyOrders })
  const previous = useRef<SalesOrder[] | null>(null)
  const busy = useRef(false)
  const lastRunAt = useRef(0)

  // Keep the callbacks current without re-arming the timer on every render.
  useEffect(() => {
    latest.current = { paused, fetchOrders, onOrders, onNewShopifyOrders }
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    const refresh = async (force = false) => {
      const now = Date.now()
      if (!force && !isOrderRefreshDue(lastRunAt.current, now, intervalMs)) return
      if (!shouldOrderRefreshRun(document.visibilityState, latest.current.paused, true)) return
      if (busy.current) return
      busy.current = true
      lastRunAt.current = now
      try {
        const rows = await latest.current.fetchOrders()
        if (cancelled) return
        const fresh = previous.current ? newShopifyOrders(previous.current, rows) : []
        previous.current = rows
        latest.current.onOrders(rows)
        if (fresh.length > 0) latest.current.onNewShopifyOrders?.(fresh)
      } catch {
        // A transient API/network failure must not blank the table; the next
        // tick retries on its own.
      } finally {
        busy.current = false
      }
    }

    const timer = window.setInterval(() => void refresh(), intervalMs)
    const onFocus = () => void refresh(true)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh(true)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, intervalMs])
}
