import type { SyncResource, SyncResult } from '@/types/shopify'

export interface SyncOutcome {
  ok: boolean
  message: string
}

/**
 * Turn the body of POST /api/v1/shopify/sync into what the UI should show.
 *
 * The backend answers in exactly two shapes (backend/src/index.ts, the
 * `res.json(results ? { ...result, db } : result)` line):
 *
 *   confirmed: { ok: true,  results: { orders: {...}, products: { ok, count },
 *                                     … }, db: { products, push, … } }
 *   refused:   { ok: false, message }   ← `results` is absent by design
 *               (e.g. "A sync is already in progress" while the scheduled
 *               auto-sync holds the shared lock)
 *
 * Reading `res.results.products` directly threw
 * "Cannot read properties of undefined (reading 'products')" whenever the
 * server refused the request — the queue had already pushed the change, so
 * the operation looked like it succeeded while the UI showed a TypeError.
 *
 * A confirmed body can still carry a per-resource failure (`ok: true` with
 * `results.products.ok === false`), which must surface as an error rather
 * than a success count.
 */
export function describeSyncResult(
  res: SyncResult | null | undefined,
  resource: SyncResource = 'products',
): SyncOutcome {
  if (!res || typeof res !== 'object') {
    return { ok: false, message: 'Shopify sync failed: no response from the server.' }
  }

  const entry = res.results?.[resource]
  if (res.ok !== true || !entry) {
    const message = typeof res.message === 'string' ? res.message.trim() : ''
    return { ok: false, message: message || 'Shopify sync failed' }
  }
  if (!entry.ok) {
    return { ok: false, message: entry.message?.trim() || `Shopify ${resource} sync failed` }
  }

  return { ok: true, message: successMessage(res, resource, entry.count) }
}

function successMessage(res: SyncResult, resource: SyncResource, count: number): string {
  const base =
    resource === 'products'
      ? `Shopify sync complete — ${count} products up to date.`
      : resource === 'customers'
        ? `Imported ${count} customers from Shopify`
        : `Shopify sync complete — ${count} ${resource} synced.`
  // The catalogue half of a sync finishes by pushing ERP values out through
  // the durable queue; report the backend's own tally when it sent one.
  const push = resource === 'products' ? res.db?.push : undefined
  return push ? `${base} Outbound push: ${push}.` : base
}
