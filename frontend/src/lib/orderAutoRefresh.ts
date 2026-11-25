import type { SalesOrder } from '@/types'

/**
 * Background refresh of the orders feed.
 *
 * Shopify orders now also arrive through the server's order poll (the desktop
 * app cannot receive webhooks), so the open page has to notice them without a
 * manual "Sync Orders" click — and without disturbing what the user is doing.
 * The helpers here are pure so the refresh policy is testable on its own.
 */

/** Poll interval. 30s is fresh enough for a counter, cheap enough for Render. */
export const ORDER_REFRESH_INTERVAL_MS = 30_000

/** A tick is due when the interval has elapsed (or no tick has run yet). */
export function isOrderRefreshDue(lastRunAt: number, now: number, intervalMs = ORDER_REFRESH_INTERVAL_MS): boolean {
  if (!Number.isFinite(lastRunAt) || lastRunAt <= 0) return true
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false
  return now - lastRunAt >= intervalMs
}

/**
 * Whether a background refresh may touch the list right now.
 * Hidden tabs and open dialogs are left completely alone.
 */
export function shouldOrderRefreshRun(
  visibilityState: string,
  paused: boolean,
  enabled = true,
): boolean {
  if (!enabled || paused) return false
  return visibilityState === 'visible'
}

/**
 * Orders present now that were not in the previous snapshot.
 * Only Shopify-sourced rows count: a manual ERP order typed by the user must
 * never be announced as a "new Shopify order".
 *
 * Match on BOTH identifiers. A local order can gain a `shopifyId` when an ERP
 * sale is linked to Shopify; its Shopify key is new but the row is not, so a
 * toast would be a false "new order" announcement.
 */
export function newShopifyOrders(previous: readonly SalesOrder[], next: readonly SalesOrder[]): SalesOrder[] {
  const knownShopifyIds = new Set(
    previous.map((order) => order.shopifyId).filter((id): id is string => Boolean(id)),
  )
  const knownLocalIds = new Set(previous.map((order) => order.id))
  return next.filter((order) =>
    Boolean(order.shopifyId) &&
    !knownShopifyIds.has(order.shopifyId!) &&
    !knownLocalIds.has(order.id),
  )
}

/** Toast copy for a batch of auto-arrived orders. */
export function newOrdersMessage(count: number): string {
  if (count <= 0) return ''
  return `${count} new Shopify order${count === 1 ? '' : 's'} received`
}
