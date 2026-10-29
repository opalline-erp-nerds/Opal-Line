import { dbApi } from '@/lib/api'
import type { SalesReturn } from '@/types'

/**
 * Data loading for the Sales Returns page.
 *
 * It lives here rather than in the page so the fast-refresh rule (a module may
 * export components *or* helpers, not both) holds, and so the load contract —
 * never rejects, reports the failure — can be unit-tested without a DOM.
 */

export interface ReturnsStats {
  total: number
  pending: number
  pendingAmount: number
  refunded: number
  refundedAmount: number
  rate: number
}

export interface ReturnsLoadResult {
  returns: SalesReturn[]
  stats: ReturnsStats | null
  error: string | null
}

function computeStats(list: SalesReturn[], totalInvoices: number): ReturnsStats {
  const pending = list.filter((r) => r.status === 'pending')
  const refunded = list.filter((r) => r.status === 'refunded')
  return {
    total: list.length,
    pending: pending.length,
    pendingAmount: pending.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    refunded: refunded.length,
    refundedAmount: refunded.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    rate: totalInvoices > 0 ? (list.length / totalInvoices) * 100 : 0,
  }
}

/**
 * Loads the returns list plus the headline stats.
 *
 * Never rejects: a failed request comes back as an empty list carrying the
 * message, so the page renders an error state instead of dying in the error
 * boundary (or worse, silently claiming there are no returns).
 */
export async function loadReturns(
  deps: {
    getReturns?: () => Promise<SalesReturn[]>
    getInvoices?: () => Promise<unknown[]>
  } = {},
): Promise<ReturnsLoadResult> {
  try {
    const getReturns = deps.getReturns ?? dbApi.getSalesReturns
    const getInvoices = deps.getInvoices ?? dbApi.getInvoices
    const [list, invoices] = await Promise.all([getReturns(), getInvoices()])
    return { returns: list, stats: computeStats(list, invoices.length), error: null }
  } catch (err) {
    return {
      returns: [],
      stats: null,
      error: err instanceof Error && err.message ? err.message : 'Could not load sales returns',
    }
  }
}
