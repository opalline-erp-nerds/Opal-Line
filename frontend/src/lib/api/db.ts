import type {
  Activity,
  ActivityLogEntry,
  AgingBucket,
  AgingInvoice,
  AnalyticsStat,
  SilverRateAutoStatus,
  PendingRateChange,
  SilverRateRequestRow,
  SilverRateRequestsResponse,
  SilverRateRow,
  SilverRateSubmitResponse,
  Quotation,
  SalesFollowUpsResponse,
  EInvoiceStatus,
  AppSettings,
  AuditLogEntry,
  NotificationSettings,
  BankAccount,
  Customer,
  Expense,
  FinancialSummary,
  GstReportResult,
  Invoice,
  InventoryLocation,
  LocationStockSummary,
  InvoiceItem,
  KpiCardData,
  LedgerEntry,
  LowStockItem,
  ReceivablesAging,
  Payment,
  PaymentStatusSegment,
  Product,
  PurchaseInvoice,
  PurchaseInvoiceDetail,
  PurchaseInvoiceInput,
  PurchaseOrder,
  PurchaseOrderReceipt,
  PurchaseReturn,
  SupplierDuesDetail,
  SupplierDuesResponse,
  SalesOrder,
  SalesOverviewPoint,
  SalesReturn,
  SilverRate,
  SilverHistoryDays,
  SilverRatePoint,
  ProfitAnalytics,
  StockCategory,
  StockTransfer,
  Supplier,
  SyncLog,
  TopCategory,
  TopProduct,
  User,
  ConnectionSettings,
  DbStatus,
  Customer360,
  OrderFullDetail,
  ReorderSuggestion,
  StockAgingResponse,
  Shipment,
  NotificationLogEntry,
} from '@/types'
import { request, list, maybe, withItems, PAGED } from './core'
import type { SearchResults, SalesInvoiceRow } from './core'

/** A dashboard date range as the endpoints accept it. */
type DashboardRangeInput = { period: string; start?: string; end?: string }

/** Build the `period`/`start`/`end` query for a dashboard range. */
function rangePath(path: string, range?: DashboardRangeInput | string): string {
  if (!range) return path
  const q =
    typeof range === 'string'
      ? new URLSearchParams({ period: range })
      : (() => {
          const params = new URLSearchParams({ period: range.period })
          if (range.period === 'custom') {
            if (range.start) params.set('start', range.start)
            if (range.end) params.set('end', range.end)
          }
          return params
        })()
  return `${path}?${q.toString()}`
}

export const dbApi = {
  getSilverRate: async (): Promise<SilverRate> => {
    const res = await request<{ rate: number; purity: number; previousRate: number; updatedAt: string | null; currency: string }>('/silver/rate')
    const change = Math.round((res.rate - res.previousRate) * 100) / 100
    return {
      purity: res.purity,
      rate: res.rate,
      previousRate: res.previousRate,
      updatedAt: res.updatedAt ?? '',
      change,
      changePercent: res.previousRate > 0 ? Math.round((change / res.previousRate) * 10000) / 100 : 0,
      currency: res.currency,
    }
  },
  /**
   * Legacy endpoint — kept for older clients. It now runs through the same
   * approval gate: staff get a queued request, approvers apply directly.
   */
  updateSilverRate: async (rate: number, syncFirst = false) =>
    request<{ ok: boolean; rate: number; previousRate: number; affected: number; matched: number; updated: number; skipped: number; errors: string[]; message?: string; steps?: Array<{ key: string; label: string; status: 'done' | 'failed' | 'skipped'; detail?: string }> }>(
      '/silver/update',
      { method: 'POST', body: JSON.stringify({ rate, syncFirst }) },
    ),
  /** Submit a rate change: applies directly for admins / when approval is
   * disabled, otherwise queues a request for admin approval. */
  submitSilverRateRequest: (rate: number, syncFirst = false): Promise<SilverRateSubmitResponse> =>
    request('/silver/requests', { method: 'POST', body: JSON.stringify({ rate, syncFirst }) }),
  getSilverRateRequests: (status?: 'pending' | 'approved' | 'rejected' | 'all'): Promise<SilverRateRequestsResponse> =>
    request(`/silver/requests${status ? `?status=${status}` : ''}`),
  approveSilverRateRequest: (id: string, note?: string): Promise<{ ok: boolean; request: SilverRateRequestRow }> =>
    request(`/silver/requests/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({ note }) }),
  rejectSilverRateRequest: (id: string, note?: string): Promise<{ ok: boolean; request: SilverRateRequestRow }> =>
    request(`/silver/requests/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
  getSilverRateRows: (): Promise<{ data: SilverRateRow[] }> => request('/db/silver-rates?limit=100'),
  getSilverRateAutoStatus: (): Promise<SilverRateAutoStatus> => request('/silver/auto-rate/status'),
  fetchSilverRateNow: (): Promise<{ ok: boolean; rate: number | null; repriced?: number; pushed?: number; error?: string | null }> =>
    request('/silver/auto-rate/fetch-now', { method: 'POST' }),
  toggleSilverRateAuto: (enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> =>
    request('/silver/auto-rate/toggle', { method: 'POST', body: JSON.stringify({ enabled }) }),
  setSilverRateSchedule: (payload: { days: number[]; time: string }): Promise<{ ok: boolean; schedule: { days: number[]; time: string } }> =>
    request('/silver/auto-rate/schedule', { method: 'PUT', body: JSON.stringify(payload) }),
  getScheduledRateChanges: (): Promise<{ changes: PendingRateChange[] }> =>
    request('/silver/scheduled-changes'),
  scheduleSilverRateChange: (payload: { rate: number; applyAt: string; note?: string }): Promise<{ ok: boolean; change: PendingRateChange; changes: PendingRateChange[] }> =>
    request('/silver/scheduled-changes', { method: 'POST', body: JSON.stringify(payload) }),
  updateScheduledRateChange: (id: string, payload: { rate: number; applyAt: string; note?: string }): Promise<{ ok: boolean; change: PendingRateChange; changes: PendingRateChange[] }> =>
    request(`/silver/scheduled-changes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  cancelScheduledRateChange: (id: string): Promise<{ ok: boolean; changes: PendingRateChange[] }> =>
    request(`/silver/scheduled-changes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getDashboardKpis: async (range?: DashboardRangeInput): Promise<KpiCardData[]> => {
    const rows = await request<
      Array<{ key: string; label: string; value: string; delta: string | null; deltaLabel: string | null; rangeLabel: string | null; icon: string; trend: 'up' | 'down' | 'flat'; accent: string }>
    >(rangePath('/db/dashboard/kpis', range))
    return rows.map((r) => ({
      key: r.key,
      label: r.label,
      value: r.value,
      trend: r.trend,
      delta: r.delta ?? undefined,
      deltaLabel: r.deltaLabel ?? undefined,
      rangeLabel: r.rangeLabel ?? undefined,
      icon: r.icon,
      accent: (r.accent as KpiCardData['accent']) ?? 'slate',
    }))
  },
  getDashboardSummary: (range?: DashboardRangeInput) =>
    request<{
      totalProducts: number
      activeProducts: number
      totalCustomers: number
      activeCustomers: number
      totalSuppliers: number
      activeSuppliers: number
      totalStockQty: number
      totalStockWeight: number
      todayExpenses: number
      rangeExpenses: number
      pendingPayments: number
      totalOrders: number
      totalInvoices: number
    }>(rangePath('/db/dashboard/summary', range)),
  getSalesOverview: (range: DashboardRangeInput | string = 'week'): Promise<SalesOverviewPoint[]> => request(rangePath('/db/dashboard/sales-overview', range)),
  getTopProducts: (range?: DashboardRangeInput): Promise<TopProduct[]> => request(rangePath('/db/dashboard/top-products', range)),
  getTopCategory: (range?: DashboardRangeInput): Promise<TopCategory[]> => request(rangePath('/db/dashboard/top-category', range)),
  getProductMargins: (months = 12): Promise<{ months: number; rows: Array<{ sku: string; name: string; qty: number; revenue: number; cost: number; profit: number; marginPct: number }>; totals: { revenue: number; cost: number; profit: number; marginPct: number } }> =>
    request(`/db/reports/product-margins?months=${months}`),
  getProfitAnalytics: (months = 12): Promise<ProfitAnalytics> =>
    request(`/db/dashboard/profit?months=${months}`),
  getPaymentStatus: (range?: DashboardRangeInput): Promise<{ segments: PaymentStatusSegment[]; total: number }> =>
    request(rangePath('/db/dashboard/payment-status', range)),
  getReceivablesAging: (): Promise<ReceivablesAging> => request('/db/dashboard/aging'),
  // The Financial Analytics section owns its range (defaults to Last 12
  // Months server-side when no period is passed) and is independent of the
  // page-wide filter.
  getDashboardFinancial: (range?: DashboardRangeInput | string): Promise<FinancialSummary> =>
    request(rangePath('/db/dashboard/financial', range)),
  getAgingInvoices: (bucket: AgingBucket['key']): Promise<{ bucket: string; invoices: AgingInvoice[] }> =>
    request(`/db/dashboard/aging/invoices?bucket=${encodeURIComponent(bucket)}`),
  // One point per IST calendar day, backfilled server-side, for the given
  // window (the chart owns this range — the page-wide filter does not drive it).
  getSilverRateHistory: (days: SilverHistoryDays = 7): Promise<SilverRatePoint[]> =>
    request<{ days: number; points: SilverRatePoint[] }>(`/db/dashboard/silver-history?days=${days}`).then(
      (res) => res.points,
    ),
  getLowStock: (): Promise<LowStockItem[]> => request('/db/dashboard/low-stock'),
  getRecentActivities: (range?: DashboardRangeInput): Promise<Activity[]> => request(rangePath('/db/dashboard/activities', range)),
  getDashboardSecurity: (range?: DashboardRangeInput): Promise<{ failedLogins: number; lockedAccounts: number; recent: Array<{ entity: string | null; details: string | null; timestamp: string | null }> }> =>
    request(rangePath('/db/dashboard/security', range)),
  getNotificationFeed: () =>
    request<{ items: Array<{ type: string; title: string; detail: string | null; at: string | null; href: string }>; counts: { total: number; lowStock: number; alerts: number } }>('/db/notifications/feed'),
  getAnalyticsStats: (range?: DashboardRangeInput): Promise<AnalyticsStat[]> => request(rangePath('/db/dashboard/analytics', range)),
  getInventoryOverview: () =>
    request<{
      totalProducts: number
      totalQuantity: number
      totalWeight: number
      inventoryValue: number
      lowStock: number
      outOfStock: number
    }>('/db/dashboard/inventory-overview'),
  getGstReport: (params?: { month?: number; year?: number }) => {
    const q = new URLSearchParams()
    if (params?.month) q.set('month', String(params.month))
    if (params?.year) q.set('year', String(params.year))
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<GstReportResult>(`/db/reports/gst${suffix}`)
  },
  getSettings: (): Promise<AppSettings | null> => request('/db/settings'),
  updateSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/db/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  getConnectionSettings: (): Promise<ConnectionSettings> => request('/db/settings/connections'),
  updateConnectionSettings: (patch: Partial<ConnectionSettings>) =>
    request<{ ok: boolean; reconnectError?: string; shopify?: { ok: boolean; error?: string; shop?: string } }>('/db/settings/connections', { method: 'PUT', body: JSON.stringify(patch) }),
  getDbStatus: (): Promise<DbStatus> => request('/db/settings/db-status'),
  getNotificationSettings: (): Promise<NotificationSettings> => request('/db/settings/notifications'),
  updateNotificationSettings: (patch: Partial<NotificationSettings>) =>
    request<NotificationSettings>('/db/settings/notifications', { method: 'PUT', body: JSON.stringify(patch) }),
  /**
   * Superadmin recovery password state (owner roles only). The value itself is
   * stored as an argon2id hash and is never returned — only its source.
   */
  getRecoveryPasswordState: (): Promise<{ source: 'default' | 'custom' }> =>
    request('/db/settings/recovery-password'),
  setRecoveryPassword: (password: string): Promise<{ ok: boolean; source: 'default' | 'custom' }> =>
    request('/db/settings/recovery-password', { method: 'PUT', body: JSON.stringify({ password }) }),
  resetRecoveryPassword: (): Promise<{ ok: boolean; source: 'default' | 'custom' }> =>
    request('/db/settings/recovery-password', { method: 'PUT', body: JSON.stringify({ reset: true }) }),
  /** Outstanding supplier dues with an aging split (cancelled invoices excluded). */
  getSupplierDues: (): Promise<SupplierDuesResponse> => request('/db/supplier-dues'),
  /** Open invoices + payment ledger for one supplier. */
  getSupplierDuesDetail: (supplier: string): Promise<SupplierDuesDetail> =>
    request(`/db/supplier-dues/${encodeURIComponent(supplier)}`),
  /** Record a payment; `allocate` restricts it to the given invoice ids. */
  recordSupplierPayment: (payload: {
    supplier: string
    amount: number
    method: string
    note?: string
    allocate?: string[]
  }) =>
    request<{ ok: boolean; ref: string; paymentId: string; outstanding: number; settled: string[]; allocations: Array<{ invoiceId: string; invoiceNumber: string; amount: number; settled: boolean }> }>(
      '/db/supplier-dues/pay',
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  /** Email the owner a summary of what is owed to suppliers. */
  sendSupplierDuesSummary: (to?: string): Promise<{ ok: boolean; sent: number; to?: string; message?: string; error?: string }> =>
    request('/db/supplier-dues/remind', { method: 'POST', body: JSON.stringify({ to }) }),
  createPaymentLink: (customer: string, amount: number) =>
    request<{ url: string; id: string; configured: boolean }>('/db/dues/payment-link', {
      method: 'POST',
      body: JSON.stringify({ customer, amount }),
    }),
  sendWhatsApp: (phone: string, message: string) =>
    request<{ ok: boolean; messageId: string; configured: boolean }>('/db/send-whatsapp', {
      method: 'POST',
      body: JSON.stringify({ phone, message }),
    }),
  sendInvoiceWhatsApp: (invoiceId: string) =>
    request<{ ok: boolean; to?: string; messageId?: string; error?: string }>(`/whatsapp/invoice/${invoiceId}`, { method: 'POST' }),
  emailInvoice: (invoiceId: string, to?: string) =>
    request<{ ok: boolean; message?: string; to?: string; error?: string }>(`/db/invoices/${encodeURIComponent(invoiceId)}/email`, {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),
  importProductsCsv: (csv: string) =>
    request<{ ok: boolean; imported: number; created: number; updated: number; errors: string[] }>('/db/products/import-csv', {
      method: 'POST',
      body: JSON.stringify({ csv }),
    }),
  loyaltyBalance: (customer: string) =>
    request<{ found: boolean; customer?: { id: string; name: string; phone: string | null }; balance?: number; pointValue?: number; enabled?: boolean }>(`/loyalty/balance?customer=${encodeURIComponent(customer)}`),
  loyaltyHistory: (customer: string) =>
    request<{ found: boolean; entries: Array<{ id: string; type: string; points: string; balanceAfter: string | null; note: string | null; invoiceNumber: string | null; date: string }> }>(`/loyalty/history?customer=${encodeURIComponent(customer)}`),
  loyaltyRedeem: (customer: string, points: number, opts?: { invoiceId?: string; invoiceNumber?: string }) =>
    request<{ ok: boolean; balanceAfter?: number; error?: string }>('/loyalty/redeem', {
      method: 'POST',
      body: JSON.stringify({ customer, points, ...opts }),
    }),
  loyaltyAdjust: (customer: string, points: number, note: string) =>
    request<{ ok: boolean; points: number; balanceAfter: number }>('/loyalty/adjust', {
      method: 'POST',
      body: JSON.stringify({ customer, points, note }),
    }),

  getProducts: () => list<Product>('/db/products', PAGED),
  getProductById: (id: string) => maybe<Product>(`/db/products/${id}`),
  bulkImportProducts: (rows: Array<Record<string, string>>) =>
    request<{ created: number; updated: number; errors: string[] }>('/db/products/bulk-import', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    }),
  bulkUploadProductImages: (images: Array<{ filename: string; dataUrl: string }>) =>
    request<{ matched: number; unmatched: string[]; errors: string[] }>('/db/products/bulk-images', {
      method: 'POST',
      body: JSON.stringify({ images }),
    }),
  updateOrderStatus: (orderId: string, status: string) =>
    request<SalesOrder & { autoInvoice?: string | null }>(`/db/sales-orders/${orderId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  createReturn: (invoiceId: string, payload: { items?: Array<{ sku: string; qty: number }>; restock?: boolean }) =>
    request<{ creditNoteNumber: string; amount: number; restocked: boolean }>(`/db/invoices/${invoiceId}/return`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  createBooking: (payload: { customer: string; items: Array<{ product: string; sku?: string; qty: number; price: number }>; advanceAmount?: number; discount?: number }) =>
    request<SalesOrder>('/db/bookings', { method: 'POST', body: JSON.stringify(payload) }),
  updateBooking: (orderId: string, payload: { customer?: string; items?: Array<{ product: string; sku?: string; qty: number; price: number }>; advanceAmount?: number; discount?: number }) =>
    request<SalesOrder>(`/db/bookings/${orderId}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  convertBooking: (orderId: string) =>
    request<{ invoiceNumber: string; advanceApplied: number; balance: number }>(`/db/bookings/${orderId}/convert`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  bookingPaymentLink: (bookingId: string) =>
    request<{ url: string; id: string; amount: number; configured: boolean }>(`/db/bookings/${bookingId}/payment-link`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getOrderEvents: (orderId: string) =>
    request<{ data: Array<{ id: string; orderId: string; event: string; details: string | null; actor: string | null; createdAt: string }> }>(`/db/orders/${orderId}/events`),
  getOrderFull: (orderId: string) =>
    request<OrderFullDetail>(`/db/orders/${orderId}/full`),
  repairOrderPii: (orderIds?: string[]) =>
    request<{ ok: boolean; matched: number; repaired: Array<{ shopifyId: string; from: string; to: string }>; unmatched: string[] }>(
      '/db/orders/repair-pii',
      {
        method: 'POST',
        body: JSON.stringify(orderIds ? { orderIds } : {}),
      },
    ),
  customer360: (name: string) =>
    request<Customer360>(`/db/customers/${encodeURIComponent(name)}/summary`),
  bulkOrderStatus: (ids: string[], status: string) =>
    request<{ updated: number; status: string; invoicesCreated?: number; newInvoices?: string[] }>('/db/sales-orders/bulk-status', {
      method: 'POST',
      body: JSON.stringify({ ids, status }),
    }),
  bulkOrderInvoice: (ids: string[]) =>
    request<{ created: number; alreadyInvoiced: number; failed: number; errors: string[] }>('/db/sales-orders/bulk-invoice', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  reorderSuggestions: () =>
    request<{ data: ReorderSuggestion[]; generatedAt: string }>('/db/inventory/reorder-suggestions'),
  /** Stock on hand with FIFO age, last-sold date and 30/60/90/180+ bands. */
  getStockAging: () => request<StockAgingResponse>('/db/inventory/aging'),
  getCustomers: () => list<Customer>('/db/customers', PAGED),
  getSuppliers: () => list<Supplier>('/db/suppliers', PAGED),
  getInvoices: async (): Promise<Invoice[]> => {
    const invoices = await list<SalesInvoiceRow>('/db/invoices', PAGED)
    return invoices.map((inv) => ({ ...inv, items: [] }))
  },
  getInvoicesWithItems: async (): Promise<Invoice[]> => {
    const res = await request<{ data: Array<SalesInvoiceRow & { items: InvoiceItem[] }> }>('/db/invoices/with-items?limit=200')
    return res.data
  },
  getInvoiceById: async (id: string): Promise<Invoice | undefined> => {
    const inv = await maybe<SalesInvoiceRow>(`/db/invoices/${id}`)
    if (!inv) return undefined
    return withItems(inv)
  },
  getSalesOrders: () => list<SalesOrder>('/db/sales-orders', PAGED),
  getShipments: () => request<{ data: Shipment[] }>('/db/shipments'),
  dispatchShipment: (orderId: string, opts?: { courier?: string; trackingNumber?: string; expectedDelivery?: string; notes?: string }) =>
    request<{ ok: boolean }>('/db/shipments/dispatch', { method: 'POST', body: JSON.stringify({ orderId, ...opts }) }),
  confirmDelivery: (shipmentId: string) =>
    request<{ ok: boolean }>(`/db/shipments/${encodeURIComponent(shipmentId)}/delivered`, { method: 'POST' }),
  getNotificationLog: () => request<{ data: NotificationLogEntry[] }>('/db/notifications/log'),
  resendNotification: (id: string) =>
    request<{ ok: boolean }>('/db/notifications/resend', { method: 'POST', body: JSON.stringify({ id }) }),
  getProductDuplicates: () => request<{ data: Array<{ sku: string; cnt: number; products: string }> }>('/db/products/duplicates'),
  /** Counts of products missing a barcode and any duplicated barcodes. */
  getBarcodeSummary: () =>
    request<{ total: number; missing: number; duplicates: Array<{ barcode: string; count: number }> }>('/db/products/barcodes/summary'),
  /** Assign a specific barcode, or generate one when `barcode` is omitted. */
  generateProductBarcode: (id: string, barcode?: string) =>
    request<{ ok: boolean; id: string; barcode: string; created: boolean }>(`/db/products/${id}/barcode`, {
      method: 'POST',
      body: JSON.stringify(barcode ? { barcode } : {}),
    }),
  /** Backfill barcodes for products that have none. `dryRun` previews only. */
  generateMissingBarcodes: (opts?: { ids?: string[]; dryRun?: boolean }) =>
    request<{
      ok: boolean
      dryRun: boolean
      candidates: number
      assigned: number
      samples: Array<{ id: string; name: string; sku: string }>
      assignments: Array<{ id: string; name: string; sku: string; barcode: string }>
    }>('/db/products/barcodes/generate', {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    }),
  getCustomerDuplicateEmails: () => request<{ data: Array<{ email: string; cnt: number; customers: string }> }>('/db/customers/duplicate-emails'),
  scanProduct: (code: string) =>
    request<{ data: { id: string; name: string; sku: string; barcode: string | null; stock: number | null; category: string | null } }>(
      `/db/products/scan?code=${encodeURIComponent(code)}`,
    ),
  /**
   * Apply a counted stock sheet at ONE location. The backend reads that
   * location's balance as the baseline and adjusts it, so a count never
   * silently corrects a different shop. Omitting locationId falls back to the
   * default store.
   */
  applyStockCount: (
    counts: Array<{ id: string; counted: number }>,
    mode: 'set' | 'adjust',
    pushToShopify?: boolean,
    locationId?: string,
  ) =>
    request<{ ok: boolean; applied: number; mode: string; errors: string[]; shopifyPush?: { ok: boolean; updated: number; skipped: number; errors: string[] } | null }>(
      '/db/inventory/stock-count',
      {
        method: 'POST',
        body: JSON.stringify({ counts, mode, pushToShopify: pushToShopify === true, locationId }),
      },
    ),
  /**
   * Set a product's count at ONE location (from the product edit dialog).
   * The backend records a count_adjust movement and keeps the rollup in sync.
   */
  setProductStock: (productId: string, stock: number, locationId?: string) =>
    request<{ ok: boolean; changed: boolean; stock: number; previous: number; locationId: string }>(
      `/db/products/${encodeURIComponent(productId)}/stock`,
      { method: 'PATCH', body: JSON.stringify(locationId ? { stock, locationId } : { stock }) },
    ),
  createInvoiceForOrder: (orderId: string) =>
    request<{ created: boolean; invoiceNumber: string | null }>(`/db/sales-orders/${encodeURIComponent(orderId)}/create-invoice`, {
      method: 'POST',
    }),
  duplicateInvoice: (id: string) =>
    request<Invoice>(`/db/invoices/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }),
  createPOsFromReorder: (ids?: string[]) =>
    request<{ ok: boolean; created: Array<{ number: string; supplier: string; items: number; qty: number }>; suppliers: number; products: number }>(
      '/db/purchase-orders/from-reorder',
      { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) },
    ),
  getDues: () =>
    request<{ dues: Array<{ customer: string; invoiceCount: number; total: number; oldestDate: string | null; invoiceNumbers: string[] }>; total: number; customerCount: number }>('/db/dues'),
  emailDuesStatement: (to?: string) =>
    request<{ sent: boolean; reason?: string; recipient?: string; total?: number; customerCount?: number }>('/db/dues/email', {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),
  sendPaymentReminders: (): Promise<{ sent: number; skipped: number; failures?: string[]; reason?: string }> =>
    request('/db/dues/remind', { method: 'POST' }),
  recordPayment: (payload: { customer: string; amount: number; method: string }) =>
    request<{ ok: boolean; ref: string; settled: string[]; remainingOutstanding: number }>('/db/dues/pay', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getPurchaseOrders: () => list<PurchaseOrder>('/db/purchase-orders', PAGED),
  getQuotations: () => list<Quotation>('/db/quotations', PAGED),
  getQuotationById: (id: string) => request<Quotation>(`/db/quotations/${id}`),
  createQuotation: (payload: Record<string, unknown>) =>
    request<Quotation>('/db/quotations', { method: 'POST', body: JSON.stringify(payload) }),
  updateQuotation: (id: string, payload: Record<string, unknown>) =>
    request<Quotation>(`/db/quotations/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteQuotation: (id: string) => request<{ ok: boolean }>(`/db/quotations/${id}`, { method: 'DELETE' }),
  /** Email the quotation to the customer with the PDF attached. */
  emailQuotation: (id: string, to?: string): Promise<{ ok: boolean; to?: string; message?: string; error?: string }> =>
    request(`/db/quotations/${encodeURIComponent(id)}/email`, {
      method: 'POST',
      body: JSON.stringify(to ? { to } : {}),
    }),
  /** Send the quotation summary on WhatsApp (marks a draft as sent). */
  sendQuotationWhatsApp: (id: string) =>
    request<{ ok: boolean; to?: string; messageId?: string; markedSent?: boolean; error?: string }>(
      `/whatsapp/quotation/${encodeURIComponent(id)}`,
      { method: 'POST' },
    ),
  /** E-invoicing: IRN status, generation and cancellation. */
  getEInvoiceStatus: (invoiceId: string): Promise<EInvoiceStatus> =>
    request(`/db/einvoice/${encodeURIComponent(invoiceId)}`),
  generateEInvoice: (invoiceId: string): Promise<{ ok: boolean; irn: string; irnDate: string; qrCode: string | null; provider: string }> =>
    request(`/db/einvoice/${encodeURIComponent(invoiceId)}/generate`, { method: 'POST' }),
  cancelEInvoice: (invoiceId: string, reason?: string): Promise<{ ok: boolean; cancelDate?: string }> =>
    request(`/db/einvoice/${encodeURIComponent(invoiceId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  /** Quotations, pipeline orders and bookings that need chasing. */
  getSalesFollowUps: (customer?: string): Promise<SalesFollowUpsResponse> =>
    request(`/sales/followups${customer ? `?customer=${encodeURIComponent(customer)}` : ''}`),
  /** Lifecycle: draft → sent → approved (→ converted), plus cancelled / reopen. */
  setQuotationStatus: (id: string, status: Quotation['status']) =>
    request<{ ok: boolean; previousStatus?: string; quotation: Quotation }>(`/db/quotations/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
  convertQuotation: (id: string) =>
    request<{ ok: boolean; invoiceNumber: string; invoiceId: string }>(`/db/quotations/${id}/convert`, { method: 'POST' }),
  convertQuotationToOrder: (id: string) =>
    request<{ ok: boolean; orderNumber: string; orderId: string }>(`/db/quotations/${id}/convert-order`, { method: 'POST' }),
  getPurchaseInvoices: () => list<PurchaseInvoice>('/db/purchase-invoices', PAGED),
  /** Line items + live balance for one purchase invoice. */
  getPurchaseInvoiceWithItems: (id: string): Promise<PurchaseInvoiceDetail> =>
    request(`/db/purchase-invoices/${encodeURIComponent(id)}/with-items`),
  /** Record a purchase: line items are required so each one lands in stock. */
  createPurchaseInvoice: (payload: PurchaseInvoiceInput): Promise<PurchaseInvoice & { lines: number; stockedSkus: number }> =>
    request('/db/purchase-invoices', { method: 'POST', body: JSON.stringify(payload) }),
  /** Edit a purchase: replacing lines restocks the difference, cancelling removes it. */
  updatePurchaseInvoice: (
    id: string,
    payload: Partial<PurchaseInvoiceInput> & { status?: string; orderId?: string | null },
  ): Promise<PurchaseInvoice & { balance: number; reversedSkus: number; stockedSkus: number }> =>
    request(`/db/purchase-invoices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  /** Permanently remove a purchase invoice, reversing any stock it added. */
  deletePurchaseInvoice: (id: string): Promise<{ ok: boolean; id: string }> =>
    request(`/db/purchase-invoices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Purchase returns with their line items. */
  getPurchaseReturnsWithLines: (): Promise<PurchaseReturn[]> => list('/db/purchase-returns/with-lines', PAGED),
  /** Record a return; stock only leaves when status is `received`. */
  createPurchaseReturn: (payload: {
    number: string
    supplier: string
    invoiceId?: string | null
    status?: string
    items: Array<{ product: string; sku: string; qty: number; weight: number; rate: number }>
  }): Promise<PurchaseReturn & { linesSaved: number; reversedSkus: number }> =>
    request('/db/purchase-returns', { method: 'POST', body: JSON.stringify(payload) }),
  /** Receiving a return takes the goods out of stock; leaving that state puts them back. */
  setPurchaseReturnStatus: (id: string, status: string): Promise<PurchaseReturn & { stockMoved: number }> =>
    request(`/db/purchase-returns/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  /** Ordered vs received for a purchase order (cancelled invoices ignored). */
  getOrderReceipt: (orderId: string): Promise<PurchaseOrderReceipt> =>
    request(`/db/purchase-orders/${encodeURIComponent(orderId)}/receipt`),
  /** Purchase orders with their line items attached. */
  getPurchaseOrdersWithItems: (): Promise<PurchaseOrder[]> => list('/db/purchase-orders/with-items', PAGED),
  getPurchaseOrderWithItems: (id: string): Promise<PurchaseOrder> =>
    request(`/db/purchase-orders/${encodeURIComponent(id)}/with-items`),
  /** Replace a PO's line items (stock only moves when the purchase invoice lands). */
  setPurchaseOrderLines: (
    id: string,
    items: Array<{ product: string; sku: string; qty: number; weight: number; rate: number }>,
  ): Promise<PurchaseOrder> =>
    request(`/db/purchase-orders/${encodeURIComponent(id)}/lines`, { method: 'PATCH', body: JSON.stringify({ items }) }),
  /**
   * Full PO edit — header fields plus replacement lines in one call. Totals
   * (subtotal, GST, grand total) are recomputed server-side.
   */
  updatePurchaseOrder: (
    id: string,
    body: {
      supplier?: string
      supplierId?: string | null
      status?: string
      date?: string
      expectedDate?: string | null
      notes?: string | null
      gst?: number
      discount?: number
      lines?: Array<{ product: string; sku: string; qty: number; weight: number; rate: number }>
    },
  ): Promise<PurchaseOrder> =>
    request(`/db/purchase-orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  getSalesReturns: () => list<SalesReturn>('/db/sales-returns', PAGED),
  getPurchaseReturns: () => list<PurchaseReturn>('/db/purchase-returns', PAGED),
  getStockTransfers: () => list<StockTransfer>('/db/inventory/transfers', PAGED),
  getInventoryLocations: () => list<InventoryLocation>('/db/inventory/locations', PAGED),
  getBankAccounts: () => list<BankAccount>('/db/bank-accounts', PAGED),
  getLedgerEntries: () => list<LedgerEntry>('/db/ledger', PAGED),
  getExpenses: () => list<Expense>('/db/expenses', PAGED),
  getPayments: () => list<Payment>('/db/payments', PAGED),
  getUsers: () => list<User>('/db/users', PAGED),
  getAuditLogs: () => list<AuditLogEntry>('/db/audit-logs', PAGED),
  getActivityLogs: () => list<ActivityLogEntry>('/db/activity-logs', PAGED),
  getSyncLogs: () => list<SyncLog>('/db/sync-logs', PAGED),
  getStockCategories: async (): Promise<StockCategory[]> => {
    const res = await request<StockCategory[]>('/db/dashboard/stock-categories')
    return res
  },
  getStockRunning: async () => {
    const res = await request('/db/dashboard/stock-running')
    return res as {
      /** Per-location breakdown; the product rows below are the rollup. */
      byLocation: Array<{
        id: string
        name: string
        type: string
        products: number
        quantity: number
        valueAtCost: number
        valueAtRetail: number
        margin: number
        marginPct: number
      }>
      products: Array<{
        id: string
        name: string
        sku: string
        category: string
        currentStock: number
        reorderLevel: number
        totalSold: number
        avgDailySales: number
        daysOfStock: number
        demandLevel: 'high' | 'medium' | 'low' | 'none'
        stockValue: number
        stockValueAtCost: number
        potentialMargin: number
        marginPct: number
        activeDays: number
      }>
      summary: {
        totalProducts: number
        highDemand: number
        mediumDemand: number
        atRisk: number
        totalStockValue: number
        totalStockValueAtCost: number
        totalPotentialMargin: number
      }
    }
  },
  /** Append-only stock ledger, optionally scoped to one SKU. */
  getStockMovements: async (sku?: string, range?: { from?: string; to?: string }) => {
    const params = new URLSearchParams()
    if (sku) params.set('sku', sku)
    if (range?.from) params.set('from', range.from)
    if (range?.to) params.set('to', range.to)
    params.set('limit', '500')
    const res = await request(`/db/inventory/movements?${params.toString()}`)
    return res as Array<{
      id: string
      productId: string | null
      sku: string | null
      locationId: string | null
      type: string
      qty: number
      stockAfter: number | null
      unitCost: number | null
      refType: string | null
      refId: string | null
      note: string | null
      createdBy: string | null
      date: string | null
    }>
  },
  /** Stock on hand per location. */
  getStockLevels: async (sku?: string) => {
    const qs = sku ? `?sku=${encodeURIComponent(sku)}` : ''
    const res = await request(`/db/inventory/levels${qs}`)
    return res as Array<{ productId: string; sku: string | null; locationId: string; qty: number }>
  },
  /** Create a pending transfer. Stock moves on dispatch, not on creation. */
  createStockTransfer: async (body: { sku: string; qty: number; from: string; to: string; number?: string; weight?: number }) => {
    return request<{ id: string; number: string; status: string }>('/db/inventory/transfers', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
  /** Dispatch a pending transfer — the goods leave the source location. */
  dispatchStockTransfer: async (id: string) =>
    request<{ id: string; status: string }>(`/db/inventory/transfers/${id}/dispatch`, { method: 'POST' }),
  /**
   * Receive an in-transit transfer — the goods arrive at the destination.
   * Pass the counted quantity when it differs from what was dispatched; the
   * shortfall or overage is recorded on the transfer rather than silently
   * absorbed. Omitting it receives the dispatched quantity in full.
   */
  receiveStockTransfer: async (id: string, receivedQty?: number) =>
    request<{ id: string; status: string; receivedQty: number; variance: number }>(
      `/db/inventory/transfers/${id}/receive`,
      { method: 'POST', body: JSON.stringify(receivedQty == null ? {} : { receivedQty }) },
    ),
  /** Aggregates (product count, units, value at cost) per location id. */
  getLocationStockSummary: async () => {
    const res = await request('/db/inventory/locations/stock-summary')
    return res as Record<string, LocationStockSummary>
  },
  /**
   * Create a location, optionally counting stock in at the point of opening it.
   * The counted quantities post as `opening` movements, so the total across all
   * locations rises — this is stock coming into the business, not a split of an
   * existing position (that is a transfer).
   */
  createInventoryLocation: async (body: {
    name: string
    type?: string
    city?: string
    manager?: string
    openingBalances?: Array<{ sku: string; qty: number }>
  }) =>
    request<InventoryLocation & { openingLines: number }>('/db/inventory/locations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Cancel a transfer; an in-transit one returns its stock to the source. */
  cancelStockTransfer: async (id: string) =>
    request<{ id: string; status: string }>(`/db/inventory/transfers/${id}/cancel`, { method: 'POST' }),
  search: (q: string) =>
    request<SearchResults>(`/db/search?q=${encodeURIComponent(q)}`),

  create: <T = Record<string, unknown>>(resource: string, body: Record<string, unknown>) =>
    request<T>(`/db/${resource}`, { method: 'POST', body: JSON.stringify(body) }),
  get: <T>(resource: string) => request<T>(`/db/${resource}`),
  update: <T = Record<string, unknown>>(resource: string, id: string, body: Record<string, unknown>) =>
    request<T>(`/db/${resource}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (resource: string, id: string) =>
    request<{ ok: boolean }>(`/db/${resource}/${id}`, { method: 'DELETE' }),
}
