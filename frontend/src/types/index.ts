export type Trend = 'up' | 'down' | 'flat'

export interface AppSettings {
  id: string
  businessName: string
  gstin: string
  phone: string
  email: string
  address: string
  defaultPurity: number
  makingCharge: number
  gstRate: number
  currency: string
  invoicePrefix: string
  rateSource: string
  autoUpdateMcx: boolean
  /**
   * Legacy flag. Staff rate changes always require Admin / Super Admin
   * approval now, so this value is ignored by the backend.
   */
  requireRateApproval: boolean
  einvoiceEnabled?: boolean
  /** IRN generation mode: off | manual | automatic. */
  einvoiceMode?: EInvoiceMode
  autoReconcileRazorpay: boolean
  paymentReminders: boolean
  lowStockAlerts: boolean
  dailySummary: boolean
  orderImports: boolean
  /**
   * Account lockout after repeated failed sign-ins. Off by default
   * (testing); the attempts/minutes below are editable from
   * Settings → Security → Login lockout (defaults 5 / 15).
   */
  loginLockoutEnabled?: boolean
  lockoutThreshold?: number
  lockoutDurationMinutes?: number
  /**
   * Settings → Product codes: auto-generation rules consumed by
   * src/lib/productCodes.ts. Undefined/empty means the shipped house style
   * (prefix SLV, template {PREFIX}-{CATEGORY}-{SEQ}, 5-digit sequence,
   * EAN-13 barcode prefix 890).
   */
  skuPrefix?: string | null
  skuSuffix?: string | null
  skuFormat?: string | null
  skuSeqLength?: number | null
  barcodePrefix?: string | null
  updatedAt: string | null
  notificationSettings?: NotificationSettings
}

export interface NotificationSettings {
  dailySummaryEnabled: boolean
  monthlyStatementsEnabled: boolean
  dueRemindersEnabled: boolean
  weeklyReportEnabled: boolean
  recipientEmail: string
}

export interface ConnectionSettings {
  shopifyStoreUrl: string
  shopifyAccessToken: string
  shopifyApiVersion: string
  webhookSecret: string
  shopifyConfigured: boolean
  dbHost: string
  dbPort: string
  dbDatabase: string
  dbUser: string
  dbPassword: string
  dbConfigured: boolean
}

export interface DbStatus {
  connected: boolean
  latencyMs?: number
  error?: string
  host?: string
  port?: string
  database?: string
  user?: string
}

export interface EnvConfigDef {
  key: string
  group: 'shopify' | 'email' | 'notifications' | 'payments' | 'whatsapp' | 'backup' | 'server'
  label: string
  secret?: boolean
  placeholder?: string
  hint?: string
}

export interface EnvConfigData {
  defs: EnvConfigDef[]
  values: Record<string, string>
  configured: Record<string, boolean>
}

export interface GstReportResult {
  summary: {
    taxable: number
    outputGst: number
    inputGst: number
    netGst: number
    itcUtilised: number
    /** Tax collected at source on bullion — a separate liability, not credit. */
    tcs: number
    cgst: number
    sgst: number
  }
  gstr1: {
    b2b: { invoices: number; taxable: number }
    b2c: { invoices: number; taxable: number }
    exports: { invoices: number; taxable: number }
    notes: { invoices: number; taxable: number }
    nilRated: { invoices: number; taxable: number }
  }
  monthly: Array<{ label: string; gst: number }>
  filing: Array<{ month: string; status: string; variant: 'success' | 'warning' }>
  gstin: string
}

export type PeriodKey = 'today' | 'week' | 'last7' | 'last30' | 'month' | 'year' | 'custom'

/** The custom window chosen for the `custom` period (inclusive `YYYY-MM-DD`). */
export interface DateRange {
  start: string
  end: string
}

/** Query the dashboard endpoints with one page-wide range. */
export interface RangeQuery {
  period: PeriodKey
  start?: string
  end?: string
}

export interface KpiCardData {
  key: string
  label: string
  value: string
  trend?: Trend
  delta?: string
  deltaLabel?: string
  /** Label of the range the figures cover, e.g. "This Week". */
  rangeLabel?: string
  icon: string
  accent: 'purple' | 'green' | 'orange' | 'red' | 'blue' | 'slate'
}

export interface SilverRate {
  purity: number
  rate: number
  previousRate: number
  updatedAt: string
  change: number
  changePercent: number
  currency: string
}

export interface SalesOverviewPoint {
  date: string
  label: string
  revenue: number
  orders: number
}

export interface TopProduct {
  id: string
  name: string
  sku: string
  qty: number
  weight: number
  revenue: number
  image?: string | null
  icon: string
}

/** One bucket of the Order Summary grouped bars. */
export interface OrderSummaryPoint {
  label: string
  online: number
  inStore: number
  revenue: number
}

export interface OrderSummary {
  grain: 'week' | 'month' | 'year'
  label: string
  points: OrderSummaryPoint[]
}

/** A filled chart bucket (day, hour or month, per the page range). */
export interface DashboardSeriesPoint {
  date: string
  label: string
  value: number
}

/** Status split for the purchase/sales order donuts. */
export interface DashboardStatusSegment {
  status: string
  count: number
  value: number
}

export interface SupplierPaymentRow {
  id: string
  ref: string
  supplier: string
  purchaseStatus: string
  paymentStatus: string
  method: string
  total: number
  date: string | null
}

export interface SupplierPaymentsWidget {
  points: DashboardSeriesPoint[]
  rows: SupplierPaymentRow[]
}

export interface PurchaseOrderRow {
  id: string
  number: string
  supplier: string
  expectedDate: string | null
  status: string
  total: number
  date: string | null
}

export interface PurchaseOrdersWidget {
  segments: DashboardStatusSegment[]
  rows: PurchaseOrderRow[]
}

export interface CustomerPaymentRow {
  id: string
  ref: string
  customer: string
  invoice: string
  fulfillment: string
  paymentStatus: string
  method: string
  total: number
  date: string | null
}

export interface CustomerPaymentsWidget {
  points: DashboardSeriesPoint[]
  rows: CustomerPaymentRow[]
}

export interface SalesOrderRow {
  id: string
  number: string
  customer: string
  fulfillment: string
  status: string
  total: number
  date: string | null
}

export interface SalesOrdersWidget {
  segments: DashboardStatusSegment[]
  rows: SalesOrderRow[]
}

export interface RecentInvoiceRow {
  id: string
  number: string
  customer: string
  total: number
  paymentStatus: string
  status: string
  date: string | null
}

export interface RecentInvoicesWidget {
  points: DashboardSeriesPoint[]
  rows: RecentInvoiceRow[]
}

export interface ProfitMonthPoint {
  month: string
  revenue: number
  cogs: number
  grossProfit: number
  grossMargin: number
  expenses: number
  purchases: number
  netProfit: number
  invoices: number
}

export interface BestSellerRow {
  sku: string
  name: string
  qty: number
  revenue: number
  profit: number
}

export interface ProfitAnalytics {
  months: ProfitMonthPoint[]
  totals: { revenue: number; grossProfit: number; expenses: number; netProfit: number; grossMargin: number }
  bestSellers: BestSellerRow[]
  expenseBreakdown: Array<{ category: string; amount: number }>
}

export interface PaymentStatusSegment {
  status: 'paid' | 'pending' | 'failed' | 'refunded'
  label: string
  value: number
  count: number
}

export interface AgingBucket {
  key: 'current' | 'd1_30' | 'd31_60' | 'd60plus'
  label: string
  value: number
  count: number
}

export interface ReceivablesAging {
  buckets: AgingBucket[]
  total: number
  invoiceCount: number
  overdueTotal: number
  overdueCount: number
}

/** One expense category's total within the selected range. */
export interface ExpenseCategorySlice {
  category: string
  amount: number
  /** Share of the range's total expenses, in percent. */
  share: number
}

/** One bucket of the Financial Analytics chart series (aligned with the Sales
 * Overview buckets). Income is invoiced less returns for the bucket; expense
 * is recorded expenses for the same bucket. */
export interface FinancialPoint {
  key: string
  label: string
  date: string
  income: number
  expense: number
}

/** Receivable aging band — days past the effective due date (invoice due date,
 * or invoice date + 30 days when no due date is set). */
export interface FinancialAgingBand {
  key: 'current' | 'over30' | 'over60' | 'over90' | 'over120' | 'older'
  label: string
  value: number
  count: number
}

/** Point-in-time receivable picture (independent of the selected range):
 * every non-voided invoice's invoiced total, how much of it has been received
 * (successful payments), and how the still-open remainder is aging. */
export interface FinancialReceivable {
  paid: number
  outstanding: number
  invoicedTotal: number
  invoiceCount: number
  aging: FinancialAgingBand[]
}

/** Range keys the Financial Analytics section can request on its own. */
export type FinancialRangeKey = 'last30' | 'last3m' | 'last6m' | 'last12m' | 'year'

/** Range-aware figures behind the dashboard Financial Analytics section. */
export interface FinancialSummary {
  label: string
  prevLabel: string
  sales: number
  returns: number
  invoiceCount: number
  netRevenue: number
  netRevenueDelta: string
  netRevenueTrend: Trend
  income: number
  expense: number
  expenseCount: number
  expenseDelta: string
  expenseTrend: Trend
  net: number
  expenses: ExpenseCategorySlice[]
  topExpense: ExpenseCategorySlice | null
  points: FinancialPoint[]
  receivable: FinancialReceivable
}

export interface AgingInvoice {
  id: string
  number: string
  customer: string
  date: string | null
  dueDate: string | null
  grandTotal: number
  /** Unpaid remainder (grand total net of successful payments) — what the bucket counts. */
  outstanding: number
  paymentStatus: string
  status: string
  daysOverdue: number
}

/** Preset windows of the dashboard Silver Rate History chart. */
export type SilverHistoryDays = 7 | 30 | 90

/** Selected tab: one of the presets or the custom date range. */
export type SilverHistoryWindow = SilverHistoryDays | 'custom'

/** Inclusive custom window for the Silver Rate History chart. */
export interface SilverHistoryRange {
  from: string
  to: string
}

/** One backfilled silver-rate point: `date` is an IST calendar day (YYYY-MM-DD). */
export interface SilverRatePoint {
  date: string
  rate: number
}

/** A row of the silver rate history table (audit-enriched). */
export interface SilverRateRow {
  id: string
  rate: number
  previousRate: number | null
  updatedAt: string | null
  change: number | null
  changePercent: number | null
  updatedBy: string | null
  /** manual | auto | approval (null on legacy rows) */
  source: string | null
  /** synced | skipped | failed (null on legacy rows) */
  syncStatus: string | null
  approvedBy: string | null
}

/** Staff silver-rate change request awaiting admin approval. */
export interface SilverRateRequestRow {
  id: string
  rate: number | null
  previousRate: number | null
  status: 'pending' | 'approved' | 'rejected'
  syncFirst: boolean
  requestedBy: string | null
  requestedByRole: string | null
  requestedAt: string | null
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  resultNote: string | null
}

export interface SilverRateRequestsResponse {
  isApprover: boolean
  requests: SilverRateRequestRow[]
}

export interface SilverRateUpdateResult {
  ok: boolean
  rate: number
  previousRate: number
  affected: number
  matched: number
  updated: number
  skipped: number
  errors: string[]
  message?: string
  steps?: Array<{ key: string; label: string; status: 'done' | 'failed' | 'skipped'; detail?: string }>
}

/** Submitting a rate change either applies it directly or queues a request. */
export type SilverRateSubmitResponse =
  | ({ direct: true } & SilverRateUpdateResult)
  | { direct: false; ok: true; request: SilverRateRequestRow; message: string }

/** Live progress of an in-flight silver-rate apply (polled by the wizard). */
export interface SilverRateProgress {
  running: boolean
  phase: 'idle' | 'syncing' | 'repricing' | 'matching' | 'pushing' | 'done'
  label: string
  done: number
  total: number
  startedAt: string | null
  error: string | null
}

export interface SilverRateAutoStatus {
  enabled: boolean
  nextRunAt: string
  lastRunAt: string | null
  lastResult: 'success' | 'failed' | 'skipped' | null
  lastRate: number | null
  lastError: string | null
  fetching: boolean
  /** Configured run days/time for the auto-update (Asia/Kolkata). */
  schedule: { days: number[]; time: string }
  apiUrlConfigured: boolean
  /** Always true — staff rate changes cannot bypass approval. */
  approvalRequired: boolean
  /** Admin / Super Admin: may apply rate changes and fetch the spot rate. */
  isApprover: boolean
}

/** A one-off rate change queued from the Silver Rate page (pending only). */
export interface PendingRateChange {
  id: string
  /** New 92.5% silver rate in ₹/gm. */
  rate: number
  /** When it applies — ISO-8601 instant (displayed in IST). */
  applyAt: string
  requestedBy: string | null
  /** Optional short reason shown on the queued row ("weekend rate"). */
  note?: string | null
}

export interface LowStockItem {
  id: string
  product: string
  sku: string
  stock: number
  reorderLevel: number
  status: 'critical' | 'low'
}

export interface InventoryLocation {
  id: string
  name: string
  type: 'store' | 'warehouse' | 'workshop'
  city: string
  manager: string
}

/** Per-location aggregates shown on the locations list. */
export interface LocationStockSummary {
  products: number
  quantity: number
  valueAtCost: number
}

export type TransferStatus = 'pending' | 'in-transit' | 'received' | 'cancelled'

export interface StockTransfer {
  id: string
  number: string
  from: string
  to: string
  product: string
  sku: string
  qty: number
  weight: number
  initiatedBy: string
  status: TransferStatus
  date: string
  /** Quantity counted on arrival. Undefined when received in full. */
  receivedQty?: number
  /** receivedQty - qty. Negative is short in transit, positive is an overage. */
  variance?: number
}

export interface StockCategory {
  category: string
  products: number
  qty: number
  weight: number
  value: number
}

export type ActivityType =
  | 'silver-rate'
  | 'shopify-import'
  | 'invoice'
  | 'payment'
  | 'product'
  | 'sync'
  | 'user'
  | 'purchase'

export interface Activity {
  id: string
  type: ActivityType
  title: string
  detail?: string
  actor: string
  time: string
}

export interface AnalyticsStat {
  label: string
  value: string
  delta?: string
  trend?: Trend
  rangeLabel?: string
  prevLabel?: string
}

/** Revenue rolled up by product category. */
export interface TopCategory {
  category: string
  qty: number
  weight: number
  revenue: number
}

export interface Product {
  id: string
  name: string
  sku: string
  barcode: string
  huid?: string | null
  category: string
  collection: string
  purity: number
  grossWeight: number
  stoneWeight: number
  netWeight: number
  makingCharge: number
  gst: number
  hsn: string
  supplier: string
  /** Id of the linked supplier record, when the product was linked to one. */
  supplierId?: string | null
  silverRate: number
  sellingPrice: number
  /** Weighted-average unit cost, maintained from purchase invoices. */
  costPrice?: number | null
  compareAtPrice?: number | null
  stock: number
  reorderLevel: number
  shopifyStatus: 'synced' | 'pending' | 'not-listed' | 'error' | null
  shopifyId?: string
  status: 'active' | 'inactive' | 'draft' | null
  image?: string | null
  images?: string[] | null
  vendor?: string | null
  productType?: string | null
  description?: string | null
  tags?: string | null
  trackInventory?: boolean
  chargeOnTax?: boolean
  /**
   * Shopify-style option definitions: [{ name: 'Size', values: ['Small', 'Large'] }].
   * Each option-value combination is a ProductVariant row; null/empty = simple product.
   */
  options?: ProductOption[] | null
  /**
   * Variants of this product, when the product-variant feature has expanded
   * the product. Absent or empty means the flat single-SKU product that the
   * rest of the ERP still assumes; consumers must treat that as "no variants".
   * Invoice/order flows read this through lib/productVariants, which
   * normalizes defensively; catalog screens read `options` + the variant rows.
   */
  variants?: ProductVariant[] | null
  createdAt: string
}

/** One option definition on a product (Shopify's product options, max 3). */
export interface ProductOption {
  name: string
  values: string[]
}

/**
 * One option-value combination of a product, with its own codes and stock.
 * Fields the invoice-flow adapter (lib/productVariants) does not supply are
 * optional so a normalized foreign wire shape satisfies this type too.
 */
export interface ProductVariant {
  id: string
  /** Parent product id on catalog rows; absent on foreign wire shapes. */
  productId?: string | null
  /** "Small / Red" — the option values joined in option-definition order. */
  title?: string | null
  /** Option summary (e.g. "16in / Gold"); falls back to the SKU when absent. Legacy alias of `title`. */
  name?: string | null
  /** Aligned with Product.options: ['Small', 'Red']. */
  optionValues?: string[] | null
  sku: string
  barcode?: string | null
  sellingPrice?: number | null
  compareAtPrice?: number | null
  costPrice?: number | null
  grossWeight?: number | null
  stock?: number | null
  reorderLevel?: number | null
  status?: string | null
  createdAt?: string | null
  /** Shopify ProductVariant id (numeric or gid:// form) for order sync. */
  shopifyVariantId?: string | number | null
}

export interface Invoice {
  id: string
  number: string
  shopifyOrder: string
  customer: string
  customerEmail: string
  customerPhone?: string
  customerAddress?: string
  customerCity?: string
  customerState?: string
  customerPincode?: string
  customerGstin?: string
  /** DB column name on sales_invoices; the API returns this key. */
  buyerGstin?: string | null
  customerStateCode?: string
  items: InvoiceItem[]
  silverValue: number
  makingCharge: number
  subtotal: number
  gst: number
  gstAmount: number
  discount: number
  grandTotal: number
  paymentMethod: string
  paymentStatus: 'paid' | 'partial' | 'pending' | 'failed' | 'refunded'
  paymentId?: string
  status: 'paid' | 'draft' | 'issued' | 'overdue' | 'cancelled' | 'refunded'
  date: string
  dueDate?: string | null
  /** GST e-invoice fields, present once an IRN has been generated. */
  irn?: string | null
  irnDate?: string | null
  qrCode?: string | null
  businessName?: string
  businessGstin?: string
  businessAddress?: string
  businessPhone?: string
  businessEmail?: string
}

export interface InvoiceItem {
  product: string
  sku: string
  hsn?: string
  qty: number
  weight: number
  silverRate: number
  makingCharge: number
  tax: number
  amount: number
}

export interface SalesOrderLineItem {
  title: string
  sku?: string
  quantity: number
  price: number
}

export interface SalesOrder {
  id: string
  shopifyId: string
  internalId: string
  customer: string
  customerEmail?: string | null
  customerPhone?: string | null
  value: number
  payment: 'paid' | 'pending' | 'refunded'
  fulfillment: 'unfulfilled' | 'partial' | 'fulfilled' | 'processing' | 'returned'
  invoice: string | null
  status: OrderStatus
  date: string
  items: number
  tags?: string | null
  currency?: string | null
  discount?: number | null
  lineItems?: SalesOrderLineItem[] | null
  billingAddress?: Record<string, string> | null
  shippingAddress?: Record<string, string> | null
  isBooking?: boolean | null
  advancePaid?: number | null
}

export type OrderStatus =
  | 'imported'
  | 'confirmed'
  | 'processing'
  | 'fulfilled'
  | 'cancelled'
  | 'returned'
  | 'refunded'

export interface OrderEvent {
  id: string
  orderId: string
  event: string
  details: string | null
  actor: string | null
  createdAt: string
}

export interface Customer360 {
  customer: string
  totalOrders: number
  lifetimeValue: number
  outstanding: number
  lastOrder: string | null
  lastInvoice: string | null
  orders: SalesOrder[]
  invoices: Array<Pick<Invoice, 'id' | 'number' | 'customer' | 'grandTotal' | 'paymentStatus' | 'status' | 'date'>>
  payments: Array<{ id: string; ref: string | null; invoice: string | null; amount: number | null; method: string | null; date: string | null }>
}

export interface OrderFullDetail {
  order: Record<string, unknown>
  items: Array<Record<string, unknown>>
  invoice: {
    id: string
    number: string
    grandTotal: string | number | null
    subtotal: string | number | null
    gstAmount: string | number | null
    paymentStatus: string | null
    paymentMethod: string | null
    status: string | null
    date: string | null
    dueDate: string | null
  } | null
  payments: Array<{ id: string; ref: string | null; amount: string | number | null; method: string | null; gateway: string | null; status: string | null; date: string | null }>
  shipment: {
    id: string
    courier: string | null
    trackingNumber: string | null
    status: string
    dispatchedAt: string | null
    expectedDelivery: string | null
    deliveredAt: string | null
    notes: string | null
  } | null
  events: Array<{ id: string; event: string; details: string | null; actor: string | null; createdAt: string }>
  customer: Record<string, unknown> | null
  contact: {
    name: string | null
    email: string | null
    phone: string | null
    address: string | null
    city: string | null
    state: string | null
    pincode: string | null
  }
}

export interface ReorderSuggestion {
  id: string
  name: string
  sku: string
  supplier: string | null
  stock: number
  reorderLevel: number
  sold90d: number
  weeklyVelocity: number
  weeksOfCover: number
  suggestedQty: number
  priority: 'urgent' | 'soon' | 'ok'
}

export interface SyncLog {
  id: string
  entity: 'Order' | 'Product' | 'Inventory' | 'Customer' | 'Price' | 'Payment'
  shopifyId: string
  direction: 'in' | 'out'
  action: string
  status: 'success' | 'failed' | 'pending' | 'skipped'
  time: string
  error?: string
  retry?: boolean
}

export interface Supplier {
  id: string
  name: string
  contact: string
  phone: string
  alternatePhone?: string | null
  email?: string | null
  /** 15-character GSTIN, upper-cased. Null when the supplier is unregistered. */
  gstin?: string | null
  city: string
  address?: string | null
  status: 'active' | 'inactive'
  outstanding: number
}

/** One bought line on a purchase invoice — cost is rate × weight. */
export interface PurchaseInvoiceItem {
  id?: string
  product: string
  sku: string
  qty: number
  weight: number
  rate: number
  cost: number
  tax: number
  amount: number
}

export interface PurchaseInvoice {
  id: string
  number: string
  supplier: string
  items: number
  qty: number
  weight: number
  rate: number
  cost: number
  tax: number
  total: number
  status: 'paid' | 'partial' | 'pending' | 'cancelled'
  date: string
  /** How much has been paid against the invoice so far. */
  paidAmount?: number
  /** total − paidAmount; what is still owed. */
  balance?: number
  supplierGstin?: string | null
  supplierState?: string | null
  /** Input GST split: same-state buys split into CGST + SGST, others are IGST. */
  cgst?: number
  sgst?: number
  igst?: number
  /** Tax collected at source on bullion purchases (194Q). */
  tcsRate?: number
  tcsAmount?: number
}

/** A purchase invoice plus its line items and live balance. */
export interface PurchaseInvoiceDetail extends PurchaseInvoice {
  /** `items` on the invoice row is a count, so lines live under their own key. */
  lines: PurchaseInvoiceItem[]
  paidAmount: number
  balance: number
  supplierGstin: string | null
  supplierState: string | null
  cgst: number
  sgst: number
  igst: number
  tcsRate: number
  tcsAmount: number
}

/** Payload for creating a purchase invoice — items are required so stock moves. */
export interface PurchaseInvoiceInput {
  number: string
  supplier: string
  date?: string
  status?: string
  supplierGstin?: string | null
  /** 0 disables TCS; otherwise a percentage of the pre-tax value. */
  tcsRate?: number
  items: Array<{
    product: string
    sku: string
    qty: number
    weight: number
    rate: number
    tax: number
  }>
}

/** Outstanding balance for one supplier, split by how overdue it is. */
export interface SupplierDue {
  supplier: string
  invoiceCount: number
  /** Alias of invoiceCount kept for older callers. */
  count?: number
  total: number
  paid: number
  balance: number
  oldestDate: string | null
  /**
   * Aging buckets, matching the receivables aging used elsewhere: `current` is
   * not yet due, then 1–30, 31–60 and 60+ days overdue.
   */
  current: number
  d1_30: number
  d31_60: number
  d60plus: number
}

export interface SupplierAgingTotals {
  current: number
  d1_30: number
  d31_60: number
  d60plus: number
}

export interface SupplierDuesResponse {
  dues: SupplierDue[]
  total: number
  aging: SupplierAgingTotals
  supplierCount: number
}

/** An open (not yet fully paid) invoice for one supplier. */
export interface SupplierOpenInvoice {
  id: string
  number: string
  date: string | null
  total: number
  paidAmount: number
  balance: number
  ageDays: number
}

/** Where one payment went across the invoices it settled. */
export interface SupplierAllocation {
  id?: string
  paymentId?: string
  invoiceId: string
  invoiceNumber: string
  amount: number
}

/** A row in the supplier payment ledger. */
export interface SupplierPayment {
  id: string
  ref: string
  amount: number
  method: string
  date: string | null
  note: string | null
  allocations: SupplierAllocation[]
}

export interface SupplierDuesDetail {
  supplier: string
  invoices: SupplierOpenInvoice[]
  outstanding: number
  payments: SupplierPayment[]
}

/** One ordered line on a purchase order. */
export interface PurchaseOrderItem {
  id?: string
  product: string
  sku: string
  qty: number
  weight: number
  rate: number
  amount: number
}

export interface PurchaseOrder {
  id: string
  number: string
  supplier: string
  supplierId?: string | null
  items: number
  qty: number
  weight: number
  /** Line-item subtotal, before GST and discount. */
  value: number
  /** GST rate in percent (defaults to 3). */
  gst?: number | null
  gstAmount?: number | null
  discount?: number | null
  /** value + gstAmount − discount. */
  grandTotal?: number | null
  notes?: string | null
  expectedDate?: string | null
  status: 'open' | 'received' | 'cancelled' | 'draft' | 'closed'
  date: string
  lines?: PurchaseOrderItem[]
}

export interface SalesReturn {
  id: string
  number: string
  order: string
  customer: string
  items: number
  amount: number
  status: 'pending' | 'approved' | 'refunded' | 'rejected'
  date: string
}

/** How IRNs get generated: never, per invoice, or on every new invoice. */
export type EInvoiceMode = 'off' | 'manual' | 'automatic'

export interface EInvoiceStatus {
  mode: EInvoiceMode
  provider: string
  gatewayConfigured: boolean
  status: 'generated' | 'pending' | 'disabled'
  irn: string | null
  irnDate: string | null
  qrCode: string | null
}

export type SalesFollowUpKind = 'quotation' | 'quotation-expiring' | 'order' | 'booking' | 'booking-advance'

/** Something in the sales pipeline that needs a person to chase it. */
export interface SalesFollowUp {
  kind: SalesFollowUpKind
  id: string
  customer: string | null
  reference: string
  detail: string
  value: number
  ageDays: number
  dueAt: string | null
  href: string
}

export interface SalesFollowUpSummary {
  total: number
  quotations: number
  orders: number
  bookings: number
  expiring: number
  customerCount: number
  topCustomers: Array<{ customer: string; count: number }>
}

export interface SalesFollowUpsResponse {
  followUps: SalesFollowUp[]
  summary: SalesFollowUpSummary
  customer: string | null
}

export interface QuotationItem {
  id?: string
  product: string
  sku: string
  qty: number
  weight: number
  silverRate: number
  makingCharge: number
  amount: number
}

export interface Quotation {
  id: string
  number: string
  customer: string | null
  customerPhone: string | null
  customerEmail: string | null
  customerAddress: string | null
  customerCity: string | null
  customerState: string | null
  customerPincode: string | null
  subtotal: number
  gst: number
  gstAmount: number
  discount: number
  grandTotal: number
  notes: string | null
  status: 'draft' | 'sent' | 'approved' | 'converted' | 'expired' | 'cancelled'
  validUntil: string | null
  convertedInvoice: string | null
  convertedAt: string | null
  createdBy: string | null
  date: string
  items?: QuotationItem[]
}

/** One line on a purchase return — what is being sent back. */
export interface PurchaseReturnItem {
  id?: string
  product: string
  sku: string
  qty: number
  weight: number
  rate: number
  amount: number
}

export interface PurchaseReturn {
  id: string
  number: string
  supplier: string
  items: number
  weight: number
  amount: number
  status: 'pending' | 'approved' | 'rejected' | 'received' | 'cancelled'
  date: string
  /** The purchase invoice this returns against. */
  invoiceId?: string | null
  lines?: PurchaseReturnItem[]
}

/** What a purchase order actually received. */
export interface PurchaseOrderReceipt {
  orderId: string
  number: string
  supplier: string | null
  status: string | null
  orderedQty: number
  orderedWeight: number
  receivedQty: number
  receivedWeight: number
  invoiceCount: number
  invoices: Array<{ id: string; number: string; status: string | null; qty: number; weight: number; date: string | null }>
  shortBy: number
  overBy: number
}

export interface Customer {
  id: string
  name: string
  email: string
  phone: string
  city: string
  province?: string | null
  shopifyId?: string | null
  emailVerified?: boolean | null
  orders: number
  totalSpent: number
  status: 'active' | 'inactive'
  joined: string
}

export interface BankAccount {
  id: string
  name: string
  bank: string
  accountNumber: string
  balance: number
  ifsc: string
}

export interface LedgerEntry {
  id: string
  date: string
  description: string
  ref: string
  debit: number
  credit: number
}

export interface User {
  id: string
  name: string
  email: string
  username: string
  role: string
  lastLogin: string
  status: 'active' | 'inactive' | 'invited'
  avatarColor: string
  permissions?: Permissions | null
  /** Server refuses every other endpoint until this is cleared. */
  requirePasswordChange?: boolean
}

export interface ModulePermission {
  view: boolean
  create: boolean
  edit: boolean
  delete: boolean
}

export type Permissions = Record<string, ModulePermission>

export interface Role {
  id: string
  name: string
  description: string | null
  permissions: Permissions
  isSystem: boolean
  createdAt: string | null
}

export interface RbacModule {
  key: string
  label: string
  description: string
}

export interface UserPermissions {
  userId: string
  role: string
  rolePermissions: Permissions
  overrides: Permissions | null
  effective: Permissions
}

export interface AuditLogEntry {
  id: string
  timestamp: string
  user: string
  action: string
  module: string
  entity: string
  changes: string
  ip?: string
}

export interface ActivityLogEntry {
  id: string
  timestamp: string
  user: string
  userId?: string | null
  role?: string | null
  action: string
  module: string
  entity: string
  details?: string | null
  ip?: string | null
}

export interface Expense {
  id: string
  category: string
  description: string
  amount: number
  paymentMethod: string
  date: string
  status: 'approved' | 'pending' | 'rejected'
  by: string
}

export interface Payment {
  id: string
  ref: string
  invoice: string
  customer: string
  amount: number
  method: string
  gateway: 'Razorpay' | 'COD' | 'Bank Transfer' | 'UPI'
  status: 'settled' | 'pending' | 'failed' | 'refunded'
  date: string
  reconciled: boolean
}

export interface ReportDefinition {
  id: string
  name: string
  description: string
  category: string
  icon: string
}

export interface Shipment {
  id: string
  orderId: string
  orderRef: string | null
  customer: string | null
  courier: string | null
  trackingNumber: string | null
  status: string
  dispatchedAt: string | null
  expectedDelivery: string | null
  deliveredAt: string | null
  notes: string | null
  createdAt: string | null
}

export interface NotificationLogEntry {
  id: string
  kind: string
  channel: string
  recipient: string | null
  ref: string | null
  status: string
  error: string | null
  createdAt: string | null
}

export interface SystemStatusInfo {
  ok: boolean
  app: { name: string; version: string }
  runtime: { node: string; platform: string; arch: string; env: string | null }
  server: {
    port: number
    uptimeSec: number
    rssMb: number
    heapMb: number
    sessions: { active: number; totalCreated: number }
  }
  database: {
    configured: boolean
    healthy: boolean
    latencyMs: number | null
    stats: { totalConnections: number; idleConnections: number; waitingCount: number } | null
  }
  integrations: { shopify: boolean; emailIngest: boolean }
  paths: { logs: string; env: string | null }
}

export interface SystemPortInfo {
  port: number
  label: string
  inUse: boolean
  pid: number | null
  process: string | null
  isSelf: boolean
  source: 'netstat' | 'probe'
}

export interface SystemPortsInfo {
  block: string
  ports: SystemPortInfo[]
}

export interface SystemLogFileInfo {
  key: string
  name: string
  sizeKb: number
  modifiedAt: string | null
}

export interface SystemLogTail {
  file: string
  directory: string
  lines: string[]
}

export interface UpdateFailureInfo {
  /** ISO timestamp of the failed attempt, when known. */
  at: string
  reason: string
}

export interface UpdateStatusInfo {
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'
  current: string
  latest: string | null
  progress: number
  assetName: string | null
  assetSize: number | null
  filePath: string | null
  error: string | null
  /** Set when the last automatic install gave up; the app is still on the old version. */
  lastFailure: UpdateFailureInfo | null
}

export interface UpdatePrefsInfo {
  autoDownload: boolean
  autoInstall: boolean
  showBanner: boolean
}

