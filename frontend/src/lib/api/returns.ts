// Returns (RMA) and refunds.
//
// Refunds here are backed by Shopify: `create` only reports success once Shopify
// returned a refund id, and `sync` pulls refunds that were issued in the Shopify
// admin into the ERP.
import { request } from './core'

export type ReturnStatus = 'requested' | 'approved' | 'in_transit' | 'received' | 'rejected' | 'completed'
export type RefundStatus = 'pending' | 'completed' | 'failed'

export interface ReturnListRow {
  id: string
  number: string
  order: string | null
  orderId: string | null
  orderValue: number
  /** ISO code of this return's amounts (the original order's currency). */
  currency: string
  customer: string
  customerEmail: string | null
  date: string | null
  requestedAt: string | null
  receivedAt: string | null
  completedAt: string | null
  itemsCount: number
  products: Array<{ sku: string; qty: number }>
  reason: string | null
  notes: string | null
  status: ReturnStatus | string
  source: string
  amount: number
  restocked: boolean
  refundStatus: string
  refundAmount: number
  refundCount: number
  receivedItems: Array<{ sku?: string; received?: number; accepted?: number; damaged?: number }> | null
}

export interface ReturnDetail extends ReturnListRow {
  items: Array<{
    sku: string
    product: string
    ordered: number
    previouslyReturned: number
    quantity: number
    remaining: number
    unitPrice: number
    amount: number
    received?: { sku?: string; received?: number; accepted?: number; damaged?: number }
  }>
  orderInfo?: {
    id: string
    number: string
    customer: string
    customerEmail: string | null
    value: number
    currency: string
    payment: string | null
    status: string | null
    date: string | null
  } | null
  refunds: Array<{
    id: string
    number: string
    shopifyRefundId: string | null
    status: RefundStatus
    source: string
    amount: number
    refundedAmount: number
    currency: string
    paymentMethod: string | null
    note: string | null
    createdAt: string | null
    processedAt: string | null
    syncError: string | null
  }>
}

export interface RefundRow {
  id: string
  number: string
  shopifyRefundId: string | null
  order: string | null
  orderId: string | null
  invoiceNumber: string | null
  returnId: string | null
  customer: string
  customerEmail: string | null
  date: string | null
  processedAt: string | null
  /** Total of the original order, so the UI can tell a partial refund from a full one. */
  orderValue: number
  /** Currency of `orderValue`; compares to `currency` only when they match. */
  orderCurrency: string | null
  amount: number
  requestedAmount: number
  refundedAmount: number
  currency: string
  paymentMethod: string | null
  /** Shopify payment gateway that processed the refund. */
  gateway: string | null
  /** Shopify order-transaction ids of the refund (comma separated). */
  transactionIds: string | null
  status: RefundStatus
  source: 'shopify' | 'erp' | string
  note: string | null
  syncError: string | null
  attempts: number
  items: Array<{ id: string; product: string; sku: string; quantity: number; amount: number }>
}

export interface RefundableLine {
  lineItemId: string
  name: string
  sku: string
  quantity: number
  refundableQuantity: number
  unitPrice: number
  currency: string
}

export interface RefundableOrder {
  orderGid: string
  orderName: string
  currency: string
  totalPrice: number
  totalRefunded: number
  financialStatus: string
  paymentMethod: string | null
  lines: RefundableLine[]
}

export interface RefundPreview {
  orderName: string
  currency: string
  itemsAmount: number
  shippingAmount: number
  totalAmount: number
  maximumRefundable: number
  suggested: Array<{ gateway: string; parentTransactionId: string | null; amount: number; kind?: string }>
  lines: Array<{ lineItemId: string; name: string; sku: string; quantity: number; amount: number }>
  warnings: string[]
}

export interface RefundCreationResult {
  ok: boolean
  refundId?: string | null
  refundNumber?: string | null
  amount?: number
  currency?: string
  status?: RefundStatus
  replayed?: boolean
  error?: string
  warnings?: string[]
}

export interface CurrencyTotal {
  currency: string
  count: number
  amount: number
  refunded: number
  pending: number
  failed: number
}

export interface ReturnsOverview {
  returns: { total: number; byStatus: Record<string, number>; amount: number; byCurrency?: CurrencyTotal[] }
  refunds: {
    count: number
    total: number
    refunded: number
    pending: number
    failed: number
    fromShopify: number
    /** Per-currency totals: amounts in different currencies are never added. */
    byCurrency?: CurrencyTotal[]
  }
  lastSyncedAt: string | null
  reasons: string[]
  statuses: ReturnStatus[]
}

export interface OrderSearchRow {
  id: string
  order: string
  shopifyOrder: string | null
  customer: string
  customerEmail: string | null
  value: number
  /** Currency of the order's value — what a refund of it will be paid in. */
  currency: string
  payment: string | null
  status: string | null
  date: string | null
  items: number
}

export interface OrderReturnStatus {
  orderId: string
  order: string
  customer: string
  customerEmail: string | null
  currency: string | null
  anyReturnable: boolean
  lines: Array<{ sku: string; product: string; ordered: number; returned: number; remaining: number; unitPrice: number }>
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

export const returnsApi = {
  overview: (params: { from?: string; to?: string } = {}) =>
    request<ReturnsOverview>(`/returns/summary${qs(params)}`),

  list: (params: {
    search?: string
    status?: string
    from?: string
    to?: string
    order?: string
    page?: number
    limit?: number
  } = {}) =>
    request<{ returns: ReturnListRow[]; pagination: { page: number; limit: number; total: number } }>(
      `/returns${qs(params)}`,
    ),

  /**
   * The detail endpoint returns the return, its order and its refunds as
   * separate blocks; the page wants one flat `ReturnDetail`.
   */
  detail: async (id: string): Promise<ReturnDetail> => {
    const res = await request<{
      return: Omit<ReturnDetail, 'items' | 'refunds' | 'orderInfo'>
      order: ReturnDetail['orderInfo']
      items: ReturnDetail['items']
      refunds: ReturnDetail['refunds']
    }>(`/returns/${encodeURIComponent(id)}`)
    return { ...res.return, orderInfo: res.order ?? null, items: res.items ?? [], refunds: res.refunds ?? [] }
  },

  searchOrders: (query: string, limit = 20) =>
    request<{ orders: OrderSearchRow[] }>(`/returns/orders${qs({ query, limit })}`),

  orderStatus: (orderId: string) => request<OrderReturnStatus>(`/returns/order/${encodeURIComponent(orderId)}`),

  create: (input: {
    orderId: string
    items: Array<{ sku: string; qty: number }>
    reason?: string
    notes?: string
    status?: ReturnStatus
    idempotencyKey?: string
  }) =>
    request<{ ok: true; id: string; number: string; amount: number; replayed: boolean }>('/returns', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  setStatus: (
    id: string,
    status: ReturnStatus,
    opts: { inspection?: Array<{ sku: string; received: number; accepted: number; damaged: number }>; notes?: string; locationId?: string } = {},
  ) =>
    request<{
      ok: true
      status: ReturnStatus
      restocked: number
      inspection: Array<{ sku: string; received: number; accepted: number; damaged: number }>
      /** Shopify stock mirror for a receipt; failures are reported, never fatal. */
      inventory?: { ok: boolean; updated: number; skipped: number; errors: string[]; message?: string }
    }>(`/returns/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...opts }),
    }),
}

export const refundsApi = {
  summary: (params: { from?: string; to?: string } = {}) =>
    request<{
      summary: {
        count: number
        completed: number
        pending: number
        failed: number
        refundedAmount: number
        pendingAmount: number
        failedAmount: number
        fromShopify: number
        fromErp: number
      }
      lastSyncedAt: string | null
    }>(`/refunds/summary${qs(params)}`),

  list: (params: {
    search?: string
    status?: string
    source?: string
    from?: string
    to?: string
    order?: string
    page?: number
    limit?: number
  } = {}) =>
    request<{ refunds: RefundRow[]; pagination: { page: number; limit: number; total: number } }>(`/refunds${qs(params)}`),

  detail: (id: string) =>
    request<{
      refund: RefundRow & Record<string, unknown>
      items: Array<{ id: string; product: string | null; sku: string | null; quantity: number | null; amount: number | null }>
      events: Array<{ id: string; action: string; status: string; message: string | null; createdAt: string | null }>
    }>(`/refunds/${encodeURIComponent(id)}`),

  /** Live refundable state from Shopify: quantities left, currency, payment method. */
  refundable: (orderName: string) => request<RefundableOrder>(`/refunds/refundable/${encodeURIComponent(orderName)}`),

  /** What Shopify would pay back for this selection (discounts and taxes included). */
  preview: (input: { orderName: string; items: Array<{ lineItemId?: string; sku?: string; quantity: number }>; shippingAmount?: number }) =>
    request<RefundPreview>('/refunds/preview', { method: 'POST', body: JSON.stringify(input) }),

  /** Create the refund in Shopify. Only resolves after Shopify returns a refund id. */
  create: (input: {
    orderName: string
    items: Array<{ lineItemId?: string; sku?: string; quantity: number }>
    shippingAmount?: number
    note?: string
    notify?: boolean
    returnId?: string
    idempotencyKey?: string
  }) =>
    request<RefundCreationResult>('/refunds', { method: 'POST', body: JSON.stringify(input) }),

  retry: (id: string) =>
    request<RefundCreationResult>(`/refunds/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({}) }),

  /** Pull every refund of an order from Shopify (recovers missed webhooks). */
  sync: (orderName: string) =>
    request<{ ok: true; orderName: string; imported: number; updated: number }>('/refunds/sync', {
      method: 'POST',
      body: JSON.stringify({ orderName }),
    }),
}
