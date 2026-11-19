import { Router, type Response } from 'express'
import { and, asc, desc, eq, gte, ilike, inArray, lt, ne, or, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { CONSTANTS } from '../constants'
import { logger } from '../logger'
import { computeInputGst, computeTcs, netPayable } from '../gst'
import { getLockoutPolicy } from './auth'
import { computeUserPermissions } from '../rbac'
import { routeParam } from '../lib/routeParams'
import { resolveDashboardRange, enumerateBuckets, type DashboardRange } from '../lib/dashboardRange'
import { DEFAULT_REORDER_LEVEL, lowStockWhere } from '../lib/lowStock'

export const dashboardRouter = Router()

function requireDb(res: Response) {
  if (!db) {
    res.status(503).json({ error: 'Database is temporarily unavailable' })
    return false
  }
  return true
}

const round2 = (n: number) => Math.round(n * 100) / 100

// Paise are kept so the KPI reads exactly the same figure as the Sales
// Overview card (which formats the raw amount), not a rounded look-alike.
const inr = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function localDayStart(offsetDays = 0) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`
}

const num = (v: unknown): number => Number(v ?? 0) || 0
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

// SQL aggregation note: dates are stored as local-naive 'YYYY-MM-DD HH:MM:SS'
// timestamps (drizzle timestamp mode:'string'). The dashboard page endpoints
// aggregate in SQL against proper timestamp literals, so results are immune to
// the string-format quirks ('T' vs ' ') that JS-side string compares had.
const OUTSTANDING_WHERE = sql`(payment_status in ('pending','partial') or status = 'overdue')`

// One receivable definition everywhere: the actual unpaid balance of an open
// invoice. An invoice already marked paid is fully collected even when the
// imported row carries no payment entry; otherwise the money received is the
// sum of successful payments (the app writes 'success', the seed/imports write
// 'settled' and 'paid' — all three settle money). Failed and refunded entries
// never reduce a balance. Shared by the Outstanding KPI, the summary strip, the
// aging widget and the Receivable Summary so their totals always agree.
const COLLECTED_ON_INVOICE = sql`case
  when lower(coalesce(${schema.salesInvoices.paymentStatus}, '')) = 'paid'
    or lower(coalesce(${schema.salesInvoices.status}, '')) = 'paid'
    then coalesce(${schema.salesInvoices.grandTotal}, 0)
  else least(
    coalesce(${schema.salesInvoices.grandTotal}, 0),
    coalesce((
      select sum(coalesce(${schema.payments.amount}, 0))
        from ${schema.payments}
       where ${schema.payments.invoice} = ${schema.salesInvoices.number}
         and coalesce(${schema.payments.amount}, 0) > 0
         and lower(coalesce(${schema.payments.status}, '')) in ('success', 'settled', 'paid')
    ), 0)
  )
end`

const UNPAID_INVOICE = sql`greatest(coalesce(${schema.salesInvoices.grandTotal}, 0) - (${COLLECTED_ON_INVOICE}), 0)`

/** JS mirror of COLLECTED_ON_INVOICE for endpoints that age open invoices. */
function collectedAmount(
  row: { grandTotal?: unknown; paymentStatus?: string | null; status?: string | null; number?: string | null },
  paidByInvoice: Map<string, number>,
): number {
  const gross = num(row.grandTotal)
  const paidFlag = String(row.paymentStatus ?? '').toLowerCase() === 'paid'
    || String(row.status ?? '').toLowerCase() === 'paid'
  return paidFlag ? gross : Math.min(gross, paidByInvoice.get(row.number ?? '') ?? 0)
}

// B2B vs B2C GST split heuristic. The JS pattern is the original matcher; the
// string form runs the same alternation in Postgres via case-insensitive ~*.
const BUSINESS_NAME_PATTERN = /house|jewels|llp|pvt|ltd|exports|trading|industries|firm|company|corp/i
const BUSINESS_NAME_RE = 'house|jewels|llp|pvt|ltd|exports|trading|industries|firm|company|corp'

// Voided invoices are not sales: a cancelled or refunded invoice must never
// count towards revenue, order counts or the chart. Refund is checked on BOTH
// columns — the payment-status widget reports an invoice as Refunded when
// either one says so, so the Sales KPI, chart, rankings and Net Revenue must
// drop it too or the widgets totals disagree (money reported as refunded and
// as sales at the same time).
const NOT_VOIDED = sql`coalesce(${schema.salesInvoices.status}, '') not in ('cancelled', 'refunded') and coalesce(${schema.salesInvoices.paymentStatus}, '') <> 'refunded'`

// An invoice whose Shopify order was left behind by a previous Shopify
// connection (the importer tags it 'not-in-store') is history, not a sale of
// the connected shop: the dashboard must not count it as today's orders or
// revenue. The row itself is kept; this only scopes sales figures to the shop
// the app is actually connected to.
const NOT_FOREIGN_SHOPIFY = sql`not exists (select 1 from ${schema.salesOrders} as foreign_order where foreign_order.shopify_id = ${schema.salesInvoices.shopifyOrder} and foreign_order.shopify_store = 'not-in-store')`

// A credit note belongs to the platform of the sale it credits. When that sale
// is a foreign-store invoice, the invoice is excluded from the connected
// shop's sales — so its return must be excluded too, or the dashboard reports
// a return on money it never counted as revenue (which understated This Year
// by the full value of every foreign return). The link may come from the
// invoice row or, for older returns, from the `#order` text alone.
const FOREIGN_RETURN = sql`(
  exists (
    select 1
      from ${schema.salesInvoices} as return_invoice
      join ${schema.salesOrders} as return_invoice_order
        on return_invoice_order.shopify_id = return_invoice.shopify_order
     where return_invoice.id = ${schema.salesReturns.invoiceId}
       and return_invoice_order.shopify_store = 'not-in-store'
  )
  or exists (
    select 1
      from ${schema.salesOrders} as return_order
     where return_order.shopify_id = ${schema.salesReturns.order}
       and return_order.shopify_store = 'not-in-store'
  )
)`

/** Resolve the page-wide range from the request, or send a 400 and return null. */
function rangeFromQuery(req: { query: unknown }, res: Response, defaultPeriod?: string): DashboardRange | null {
  const query = req.query as Record<string, unknown>
  const withDefault = defaultPeriod && query.period === undefined ? { ...query, period: defaultPeriod } : query
  const resolved = resolveDashboardRange(withDefault)
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error })
    return null
  }
  return resolved.range
}

function bucketFormat(range: DashboardRange): string {
  return range.bucket === 'hour' ? 'HH24' : range.bucket === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'
}

/** Fill every chart bucket from SQL sums, so flat/empty days still render. */
function seriesPoints(range: DashboardRange, values: Map<string, number>) {
  return enumerateBuckets(range).map((b) => ({
    date: b.date,
    label: b.label,
    value: round2(values.get(b.key) ?? 0),
  }))
}

/** Percentage delta and trend vs the equivalent previous window. A non-positive
 * previous total is reported as flat with a dash, never an infinite increase. */
function compare(cur: number, prev: number): { trend: 'up' | 'down' | 'flat'; delta: string } {
  if (prev <= 0) return { trend: 'flat', delta: '—' }
  const pct = Math.round((((cur - prev) / prev) * 100) * 10) / 10
  return { trend: cur > prev ? 'up' : cur < prev ? 'down' : 'flat', delta: `${pct}%` }
}

const iconFor = (name: string, category: string | null): string => {
  const n = `${name} ${category ?? ''}`.toLowerCase()
  if (/ring|band/.test(n)) return 'ring'
  if (/chain|necklace|mala|locket/.test(n)) return 'chain'
  if (/bracelet|bangle/.test(n)) return 'bracelet'
  if (/pendant|lock/.test(n)) return 'pendant'
  if (/earring|jhumka/.test(n)) return 'earrings'
  return 'package'
}

dashboardRouter.get('/dashboard/kpis', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res)
  if (!range) return
  try {
    // Aggregated in SQL: the invoice table can outgrow a load-everything scan.
    // Cost basis = silver_value + making_charge; only invoices that carry both
    // contribute to profit/cost. An invoice imported without a basis would
    // otherwise report its whole grand_total as profit (100% margin), so the
    // KPI discloses how many invoices the figure is based on.
    const invAgg = async (from: string, to: string) => {
      const rows = await db!
        .select({
          total: sql<number>`coalesce(sum(grand_total), 0)`,
          count: sql<number>`count(*)`,
          profit: sql<number>`coalesce(sum(grand_total - coalesce(silver_value, 0) - coalesce(making_charge, 0)) filter (where silver_value is not null and making_charge is not null), 0)`,
          cost: sql<number>`coalesce(sum(coalesce(silver_value, 0) + coalesce(making_charge, 0)) filter (where silver_value is not null and making_charge is not null), 0)`,
          costedCount: sql<number>`count(*) filter (where silver_value is not null and making_charge is not null)`,
        })
        .from(schema.salesInvoices)
        .where(and(gte(schema.salesInvoices.date, from), sql`${schema.salesInvoices.date} < ${to}`, NOT_VOIDED, NOT_FOREIGN_SHOPIFY))
      const r = rows[0]
      return { total: num(r.total), count: Number(r.count), profit: num(r.profit), cost: num(r.cost), costedCount: Number(r.costedCount) }
    }
    const [cur, prev, curTotals, prevTotals, lowStockRows, outstandingRows] = await Promise.all([
      invAgg(range.from, range.to),
      invAgg(range.prevFrom, range.prevTo),
      salesTotals(range),
      salesTotals({ ...range, from: range.prevFrom, to: range.prevTo }),
      db!.select({ n: sql<number>`count(*)` }).from(schema.products).where(lowStockWhere()),
      db!.select({
        total: sql<number>`coalesce(sum(${UNPAID_INVOICE}), 0)`,
        count: sql<number>`count(*) filter (where ${UNPAID_INVOICE} > 0)`,
      }).from(schema.salesInvoices).where(and(OUTSTANDING_WHERE, NOT_VOIDED, NOT_FOREIGN_SHOPIFY)),
    ])

    // Sales, orders and invoice count all come from the shared ledger — the
    // exact figures the Sales Overview cards and graph render for this range.
    const curSales = curTotals.revenue
    const prevSales = prevTotals.revenue
    const salesCompare = compare(curSales, prevSales)
    const orderCompare = compare(curTotals.orders, prevTotals.orders)
    const invoiceCompare = compare(curTotals.invoiceCount, prevTotals.invoiceCount)
    // Gross profit uses metal + making (the app's cost basis), counted only
    // over invoices that carry both components. With no costed invoice in the
    // window it reads N/A instead of a misleading 100% margin, and the caption
    // states how many invoices the figure is based on.
    const hasCost = cur.costedCount > 0
    const profitCompare = hasCost ? compare(cur.profit, prev.costedCount > 0 ? prev.profit : 0) : { trend: 'flat' as const, delta: '—' }
    const profitCaption = hasCost
      ? `based on ${cur.costedCount} of ${curTotals.invoiceCount} invoices`
      : 'no cost basis in range'
    const outstanding = num(outstandingRows[0]?.total)
    const outstandingCount = Number(outstandingRows[0]?.count ?? 0)

    res.json([
      { key: 'sales', label: 'Sales', value: inr(curSales), trend: salesCompare.trend, delta: salesCompare.delta, deltaLabel: range.prevLabel, rangeLabel: range.label, icon: 'indian-rupee', accent: 'purple' },
      { key: 'orders', label: 'Orders', value: String(curTotals.orders), trend: orderCompare.trend, delta: orderCompare.delta, deltaLabel: range.prevLabel, rangeLabel: range.label, icon: 'shopping-bag', accent: 'blue' },
      { key: 'invoices', label: 'Invoices', value: String(curTotals.invoiceCount), trend: invoiceCompare.trend, delta: invoiceCompare.delta, deltaLabel: range.prevLabel, rangeLabel: range.label, icon: 'file-text', accent: 'green' },
      { key: 'grossProfit', label: 'Gross Profit', value: hasCost ? inr(cur.profit) : 'N/A', trend: profitCompare.trend, delta: profitCompare.delta, deltaLabel: profitCaption, rangeLabel: range.label, icon: 'trending-up', accent: 'orange' },
      { key: 'outstanding', label: 'Outstanding', value: inr(outstanding), trend: 'flat', delta: '—', deltaLabel: `${outstandingCount} invoices`, rangeLabel: 'As of now', icon: 'clock', accent: 'red' },
      { key: 'lowStock', label: 'Low Stock Items', value: String(Number(lowStockRows[0]?.n ?? 0)), trend: 'flat', delta: '—', deltaLabel: 'Needs Reorder', rangeLabel: 'As of now', icon: 'package-x', accent: 'slate' },
    ])
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dashboardRouter.get('/dashboard/summary', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res)
  if (!range) return
  try {
    const todayStart = localDayStart(0)
    const todayEnd = localDayStart(1)
    // Aggregated in SQL: full-table loads here scaled with every product,
    // customer, supplier, expense and invoice row for a handful of numbers.
    const [productAgg, customerAgg, supplierAgg, expenseAgg, outstandingRows, orderAgg, invoiceAgg, lastSyncRows] = await Promise.all([
      db!.select({
        total: sql<number>`count(*)`,
        active: sql<number>`count(*) filter (where status = 'active')`,
        stockQty: sql<number>`coalesce(sum(coalesce(stock, 0)), 0)`,
        stockWeight: sql<number>`coalesce(sum(coalesce(stock, 0) * coalesce(net_weight, 0)), 0)`,
      }).from(schema.products),
      db!.select({
        total: sql<number>`count(*)`,
        active: sql<number>`count(*) filter (where status = 'active')`,
      }).from(schema.customers),
      db!.select({
        total: sql<number>`count(*)`,
        active: sql<number>`count(*) filter (where status = 'active')`,
      }).from(schema.suppliers),
      db!.select({
        today: sql<number>`coalesce(sum(coalesce(amount, 0)) filter (where date >= ${todayStart} and date < ${todayEnd}), 0)`,
        ranged: sql<number>`coalesce(sum(coalesce(amount, 0)) filter (where date >= ${range.from} and date < ${range.to}), 0)`,
      }).from(schema.expenses),
      db!.select({ total: sql<number>`coalesce(sum(${UNPAID_INVOICE}), 0)` }).from(schema.salesInvoices).where(and(OUTSTANDING_WHERE, NOT_VOIDED, NOT_FOREIGN_SHOPIFY)),
      db!.select({ total: sql<number>`count(*)` }).from(schema.salesOrders),
      db!.select({ total: sql<number>`count(*)` }).from(schema.salesInvoices),
      db!.select({ at: sql<string | null>`max(${schema.syncLogs.time})` }).from(schema.syncLogs),
    ])

    res.json({
      totalProducts: Number(productAgg[0]?.total ?? 0),
      activeProducts: Number(productAgg[0]?.active ?? 0),
      totalCustomers: Number(customerAgg[0]?.total ?? 0),
      activeCustomers: Number(customerAgg[0]?.active ?? 0),
      totalSuppliers: Number(supplierAgg[0]?.total ?? 0),
      activeSuppliers: Number(supplierAgg[0]?.active ?? 0),
      totalStockQty: num(productAgg[0]?.stockQty),
      totalStockWeight: round2(num(productAgg[0]?.stockWeight)),
      todayExpenses: round2(num(expenseAgg[0]?.today)),
      rangeExpenses: round2(num(expenseAgg[0]?.ranged)),
      pendingPayments: round2(num(outstandingRows[0]?.total)),
      // Whether anything has been imported/persisted yet — drives the dashboard
      // "No orders imported yet. Run Orders Sync" empty state. A store can have
      // orders but no invoices (e.g. all unpaid), so both are reported.
      totalOrders: Number(orderAgg[0]?.total ?? 0),
      totalInvoices: Number(invoiceAgg[0]?.total ?? 0),
      lastSyncAt: lastSyncRows[0]?.at ?? null,
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Grouped revenue for the chart. Invoice revenue is netted against sales
// returns so each bucket matches the period totals, and voided invoices are
// excluded. Returns only subtract money; the order count is the invoice count.
export async function salesBuckets(format: string, range: { from: string; to: string }) {
  const bucketSql = sql`to_char(${schema.salesInvoices.date}, ${format})`
  const rows = await db!
    .select({
      bucket: bucketSql,
      revenue: sql<number>`coalesce(sum(grand_total), 0)`,
      orders: sql<number>`count(*)`,
    })
    .from(schema.salesInvoices)
    .where(and(
      sql`${schema.salesInvoices.date} is not null`,
      gte(schema.salesInvoices.date, range.from),
      sql`${schema.salesInvoices.date} < ${range.to}`,
      NOT_VOIDED,
      // Same revenue scope as the Sales KPI and the chart: without this the
      // Financial income series counted foreign-store invoices the headline
      // (netRevenue) excludes, so the bars never summed to the tile.
      NOT_FOREIGN_SHOPIFY,
    ))
    .groupBy(sql`1`)
  const map = new Map<string, { revenue: number; orders: number }>()
  for (const r of rows) map.set(String(r.bucket ?? ''), { revenue: num(r.revenue), orders: Number(r.orders) })
  return map
}

// A sale belongs to Shopify when its invoice carries a Shopify order reference
// (`#1027`). An invoice raised for an order that exists only in the ERP carries
// the ERP reference (`MO-…`, `SO…`) and must stay an ERP sale — keying on
// "any non-empty reference" silently moved those to Shopify.
// The invoice row is the revenue record, so counting it once prevents a Shopify
// order and its return/refund rows from being added as extra sales.
const SHOPIFY_INVOICE = sql`coalesce(trim(${schema.salesInvoices.shopifyOrder}), '') like '#%'`
const ERP_INVOICE = sql`not (${SHOPIFY_INVOICE})`

/**
 * ERP sales that exist only as an order row. Manual orders (and orders
 * converted from quotations) are saved in `sales_orders`; an invoice is only
 * raised when someone asks for one. Reading invoices alone therefore reported
 * zero ERP sales while the Sales Orders page listed those orders.
 *
 * An order is counted here when it is a live sale (confirmed or further down
 * the pipeline, never cancelled/booked), is not a Shopify-imported order, and
 * has no invoice of its own — the invoice already carries its revenue. A synced
 * ERP order whose Shopify copy was imported back as its own invoiced order is
 * skipped too, so All Sales counts that sale once.
 */
const ERP_ORDER_SALE = sql`(
  lower(coalesce(${schema.salesOrders.status}, '')) in ('confirmed', 'processing', 'fulfilled')
  and coalesce(${schema.salesOrders.isBooking}, false) = false
  and ${schema.salesOrders.cancelledAt} is null
  and coalesce(nullif(trim(${schema.salesOrders.invoice}), ''), '') = ''
  -- ERP origin: a manual order must stay an ERP sale even after it claimed the
  -- Shopify display name (#1027) when it was synced.
  and (coalesce(${schema.salesOrders.shopifyId}, '') not like '#%' or ${schema.salesOrders.internalId} like 'MO-%')
  and not exists (
    select 1
      from ${schema.salesOrders} as twin
     where twin.id <> ${schema.salesOrders.id}
       and nullif(trim(twin.invoice), '') is not null
       and (
         (${schema.salesOrders.shopifyGid} is not null and twin.shopify_gid = ${schema.salesOrders.shopifyGid})
         or (${schema.salesOrders.internalId} is not null and twin.shopify_id = ${schema.salesOrders.shopifyId})
       )
  )
)`

/**
 * A live Shopify order that has no invoice yet. Its revenue lives only on the
 * order row, exactly like an uninvoiced ERP order, so the Shopify split of the
 * ledger adds it instead of silently dropping the sale. An order that owns an
 * invoice is excluded, so the invoice remains the single money record and no
 * sale is counted twice.
 */
const SHOPIFY_ORDER_SALE = sql`(
  coalesce(${schema.salesOrders.shopifyId}, '') like '#%'
  and lower(coalesce(${schema.salesOrders.status}, '')) not in ('cancelled', 'draft')
  and coalesce(${schema.salesOrders.isBooking}, false) = false
  and ${schema.salesOrders.cancelledAt} is null
  and lower(coalesce(${schema.salesOrders.payment}, '')) <> 'refunded'
  and coalesce(nullif(trim(${schema.salesOrders.invoice}), ''), '') = ''
  and coalesce(${schema.salesOrders.shopifyStore}, '') <> 'not-in-store'
)`

/**
 * A manual (ERP) order that was pushed to Shopify and imported back as its own
 * Shopify order row is the SAME sale represented twice. The Orders KPI and the
 * Order Summary counted both rows, so a synced order inflated the order count
 * (and showed up as one online + one in-store order) even though the Sales
 * Overview already collapses the pair. Identify the ERP half of the pair by its
 * non-`#` shopify id and the Shopify half by the shared gid (or by the twin's
 * `#` id matching this row's internal id).
 */
const SYNCED_ERP_TWIN = sql`(
  coalesce(${schema.salesOrders.shopifyId}, '') not like '#%'
  and exists (
    select 1
      from ${schema.salesOrders} as order_twin
     where order_twin.id <> ${schema.salesOrders.id}
       and coalesce(order_twin.shopify_id, '') like '#%'
       and (
         (${schema.salesOrders.shopifyGid} is not null and order_twin.shopify_gid = ${schema.salesOrders.shopifyGid})
         or (${schema.salesOrders.internalId} is not null and order_twin.shopify_id = ${schema.salesOrders.internalId})
       )
  )
)`

/** A Shopify-imported order; manual ERP orders carry their `MO-…` id in the
 * same column, so a non-null id alone does not mean the sale came from Shopify. */
const SHOPIFY_ORDER = sql`coalesce(${schema.salesOrders.shopifyId}, '') like '#%'`

type SourceKey = 'all' | 'shopify' | 'erp'

function sourceFilter(value: unknown): SourceKey | null {
  const source = String(value ?? 'all')
  return source === 'all' || source === 'shopify' || source === 'erp' ? source : null
}

const sourceWhere = (source: SourceKey) => source === 'shopify' ? SHOPIFY_INVOICE : source === 'erp' ? ERP_INVOICE : sql`true`

/**
 * THE sales calculation. Every dashboard surface — the Sales KPI, the Sales
 * Overview cards and graph, Financial Net Revenue and Analytics Total Sales —
 * reads revenue from this one ledger, so no two widgets can drift apart.
 *
 * Revenue definition (per bucket):
 *   eligible invoices (not cancelled/refunded, not foreign-store)
 * + uninvoiced live ERP orders (their value exists only on the order row)
 * − sales returns / credit notes
 * The Shopify and ERP splits use the same invoice rows: an invoice with a
 * Shopify `#order` reference is Shopify revenue, anything else is ERP. An ERP
 * order that already owns an invoice is not added again (ERP_ORDER_SALE), so
 * `All` is exactly Shopify + ERP with every sale counted once.
 */
export type SalesLedgerBucket = {
  gross: number
  erpOrderRevenue: number
  shopifyOrderRevenue: number
  returns: number
  revenue: number
  orders: number
  invoiceCount: number
  shopifyRevenue: number
  shopifyOrders: number
  shopifyReturns: number
  erpRevenue: number
  erpOrders: number
  erpReturns: number
}

export async function salesLedgerBuckets(format: string, range: { from: string; to: string }): Promise<Map<string, SalesLedgerBucket>> {
  const [invoiceRows, orderRows, erpOrderRows, returnRows] = await Promise.all([
    // Gross invoiced value by platform comes from the invoice (the money
    // record). Returns are netted off below, not here.
    db!
      .select({
        bucket: sql`to_char(${schema.salesInvoices.date}, ${format})`,
        shopifyGross: sql<number>`coalesce(sum(case when ${SHOPIFY_INVOICE} then grand_total else 0 end), 0)`,
        erpGross: sql<number>`coalesce(sum(case when ${ERP_INVOICE} then grand_total else 0 end), 0)`,
        invoiceCount: sql<number>`count(*)`,
      })
      .from(schema.salesInvoices)
      .where(and(
        sql`${schema.salesInvoices.date} is not null`,
        gte(schema.salesInvoices.date, range.from),
        sql`${schema.salesInvoices.date} < ${range.to}`,
        NOT_VOIDED,
        NOT_FOREIGN_SHOPIFY,
      ))
      .groupBy(sql`1`),
    // Order counts come from the order rows, not from invoices: one order can
    // carry several invoices (a reissue, a split bill) and a manual invoice can
    // exist without an order, so counting invoices as orders reported 50
    // "orders" where the Orders KPI (and the Orders page) counted 31. The same
    // live scope as the KPI applies here.
    db!
      .select({
        bucket: sql`to_char(${schema.salesOrders.date}, ${format})`,
        orders: sql<number>`count(*)`,
        shopifyOrders: sql<number>`count(*) filter (where ${SHOPIFY_ORDER})`,
        erpOrders: sql<number>`count(*) filter (where not (${SHOPIFY_ORDER}))`,
      })
      .from(schema.salesOrders)
      .where(and(
        gte(schema.salesOrders.date, range.from),
        sql`${schema.salesOrders.date} < ${range.to}`,
        sql`coalesce(${schema.salesOrders.status}, '') <> 'cancelled'`,
        // A booking/quotation and a draft are not completed sales; they must
        // not inflate Total Orders or the order-summary bars.
        sql`lower(coalesce(${schema.salesOrders.status}, '')) <> 'draft'`,
        sql`coalesce(${schema.salesOrders.isBooking}, false) = false`,
        sql`coalesce(${schema.salesOrders.shopifyStore}, '') <> 'not-in-store'`,
        sql`not (${SYNCED_ERP_TWIN})`,
      ))
      .groupBy(sql`1`),
    // Uninvoiced orders hold revenue no invoice carries. Their order count is
    // already in `orderRows`; only their value is added here, split by platform
    // with the same open-order definitions the order counts use.
    db!
      .select({
        bucket: sql`to_char(${schema.salesOrders.date}, ${format})`,
        shopifyRevenue: sql<number>`coalesce(sum(case when ${SHOPIFY_ORDER_SALE} then coalesce(${schema.salesOrders.value}, 0) else 0 end), 0)`,
        erpRevenue: sql<number>`coalesce(sum(case when ${ERP_ORDER_SALE} then coalesce(${schema.salesOrders.value}, 0) else 0 end), 0)`,
      })
      .from(schema.salesOrders)
      .where(and(
        gte(schema.salesOrders.date, range.from),
        sql`${schema.salesOrders.date} < ${range.to}`,
        or(ERP_ORDER_SALE, SHOPIFY_ORDER_SALE),
      ))
      .groupBy(sql`1`),
    returnSourceBuckets(format, range),
  ])
  const map = new Map<string, SalesLedgerBucket>()
  const bucketFor = (key: string) => {
    const existing = map.get(key)
    if (existing) return existing
    const created: SalesLedgerBucket = {
      gross: 0, erpOrderRevenue: 0, shopifyOrderRevenue: 0, returns: 0, revenue: 0, orders: 0, invoiceCount: 0,
      shopifyRevenue: 0, shopifyOrders: 0, shopifyReturns: 0,
      erpRevenue: 0, erpOrders: 0, erpReturns: 0,
    }
    map.set(key, created)
    return created
  }
  for (const r of invoiceRows) {
    const bucket = bucketFor(String(r.bucket ?? ''))
    bucket.shopifyRevenue = num(r.shopifyGross)
    bucket.erpRevenue = num(r.erpGross)
    bucket.gross = round2(bucket.shopifyRevenue + bucket.erpRevenue)
    bucket.invoiceCount = Number(r.invoiceCount ?? 0)
  }
  for (const r of orderRows) {
    const bucket = bucketFor(String(r.bucket ?? ''))
    bucket.orders = Number(r.orders)
    bucket.shopifyOrders = Number(r.shopifyOrders)
    bucket.erpOrders = Number(r.erpOrders)
  }
  for (const r of erpOrderRows) {
    const bucket = bucketFor(String(r.bucket ?? ''))
    bucket.erpOrderRevenue = num(r.erpRevenue)
    bucket.shopifyOrderRevenue = num(r.shopifyRevenue)
  }
  for (const [key, value] of returnRows) {
    const bucket = bucketFor(key)
    bucket.shopifyReturns = num(value.shopify)
    bucket.erpReturns = num(value.erp)
    bucket.returns = round2(bucket.shopifyReturns + bucket.erpReturns)
  }
  for (const bucket of map.values()) {
    bucket.revenue = round2(bucket.gross + bucket.erpOrderRevenue + bucket.shopifyOrderRevenue - bucket.returns)
    // Gross by platform plus that platform's uninvoiced orders, less its
    // returns. An order with an invoice is never added again.
    bucket.shopifyRevenue = round2(bucket.shopifyRevenue + bucket.shopifyOrderRevenue - bucket.shopifyReturns)
    bucket.erpRevenue = round2(bucket.erpRevenue + bucket.erpOrderRevenue - bucket.erpReturns)
  }
  return map
}

export type SalesTotals = Omit<SalesLedgerBucket, 'gross'> & { gross: number }

/** Period totals, derived from the same buckets the charts render, so the KPI
 * and the graph sums are the same numbers by construction. */
export async function salesTotals(range: DashboardRange): Promise<SalesTotals> {
  const buckets = await salesLedgerBuckets(bucketFormat(range), range)
  const totals: SalesTotals = {
    gross: 0, erpOrderRevenue: 0, shopifyOrderRevenue: 0, returns: 0, revenue: 0, orders: 0, invoiceCount: 0,
    shopifyRevenue: 0, shopifyOrders: 0, shopifyReturns: 0,
    erpRevenue: 0, erpOrders: 0, erpReturns: 0,
  }
  for (const bucket of buckets.values()) {
    totals.gross += bucket.gross
    totals.erpOrderRevenue += bucket.erpOrderRevenue
    totals.shopifyOrderRevenue += bucket.shopifyOrderRevenue
    totals.returns += bucket.returns
    totals.revenue += bucket.revenue
    totals.orders += bucket.orders
    totals.invoiceCount += bucket.invoiceCount
    totals.shopifyRevenue += bucket.shopifyRevenue
    totals.shopifyOrders += bucket.shopifyOrders
    totals.shopifyReturns += bucket.shopifyReturns
    totals.erpRevenue += bucket.erpRevenue
    totals.erpOrders += bucket.erpOrders
    totals.erpReturns += bucket.erpReturns
  }
  for (const key of Object.keys(totals) as Array<keyof SalesTotals>) {
    totals[key] = round2(totals[key])
  }
  return totals
}

/**
 * Returns split by the platform of the invoice they credit. A return linked to
 * a Shopify invoice reduces Shopify revenue even if it was entered in the ERP;
 * unlinked rows fall back to their own source/order marker. Every return is
 * attributed to exactly one platform, so combined revenue remains the old
 * invoice-minus-return figure.
 */
export async function returnSourceBuckets(format: string, range: { from: string; to: string }) {
  const bucketSql = sql`to_char(${schema.salesReturns.date}, ${format})`
  const shopifyReturn = sql<boolean>`case
    when ${schema.salesReturns.invoiceId} is not null and ${schema.salesInvoices.id} is not null
      then (${SHOPIFY_INVOICE})
    else (
      lower(coalesce(${schema.salesReturns.source}, '')) = 'shopify'
      or nullif(${schema.salesReturns.shopifyReturnId}, '') is not null
      or coalesce(${schema.salesReturns.order}, '') like '#%'
    )
  end`
  const rows = await db!
    .select({
      bucket: bucketSql,
      amount: sql<number>`coalesce(sum(coalesce(amount, 0)), 0)`,
      shopifyAmount: sql<number>`coalesce(sum(case when ${shopifyReturn} then coalesce(amount, 0) else 0 end), 0)`,
    })
    .from(schema.salesReturns)    .leftJoin(schema.salesInvoices, eq(schema.salesInvoices.id, schema.salesReturns.invoiceId))
    .where(and(
      gte(schema.salesReturns.date, range.from),
      sql`${schema.salesReturns.date} < ${range.to}`,
      sql`coalesce(${schema.salesReturns.status}, '') <> 'cancelled'`,
      sql`not (${FOREIGN_RETURN})`,
    ))
    .groupBy(sql`1`)
  const map = new Map<string, { shopify: number; erp: number }>()
  for (const r of rows) {
    const total = num(r.amount)
    const shopify = num(r.shopifyAmount)
    map.set(String(r.bucket ?? ''), { shopify, erp: total - shopify })
  }
  return map
}

export async function returnBuckets(format: string, range: { from: string; to: string }) {
  const bucketSql = sql`to_char(${schema.salesReturns.date}, ${format})`
  const rows = await db!
    .select({ bucket: bucketSql, amount: sql<number>`coalesce(sum(coalesce(amount, 0)), 0)` })
    .from(schema.salesReturns)
    .where(and(
      gte(schema.salesReturns.date, range.from),
      sql`${schema.salesReturns.date} < ${range.to}`,
      sql`coalesce(${schema.salesReturns.status}, '') <> 'cancelled'`,
      sql`not (${FOREIGN_RETURN})`,
    ))
    .groupBy(sql`1`)
  const map = new Map<string, number>()
  for (const r of rows) map.set(String(r.bucket ?? ''), num(r.amount))
  return map
}

/** Expenses grouped into the same chart buckets as sales (no status filter —
 * every recorded expense counts against its period). */
async function expenseBuckets(format: string, range: { from: string; to: string }) {
  const bucketSql = sql`to_char(${schema.expenses.date}, ${format})`
  const rows = await db!
    .select({ bucket: bucketSql, amount: sql<number>`coalesce(sum(coalesce(amount, 0)), 0)` })
    .from(schema.expenses)
    .where(and(gte(schema.expenses.date, range.from), sql`${schema.expenses.date} < ${range.to}`))
    .groupBy(sql`1`)
  const map = new Map<string, number>()
  for (const r of rows) map.set(String(r.bucket ?? ''), num(r.amount))
  return map
}

type SalesPoint = {
  key: string; date: string; label: string; revenue: number; orders: number
  shopifyRevenue: number; shopifyOrders: number
  erpRevenue: number; erpOrders: number
}

/** Current-period chart points, straight from the shared sales ledger. The
 * ledger already nets returns and adds uninvoiced ERP orders, so a point's
 * revenue is the same definition the KPI uses. */
async function buildSalesPoints(range: Pick<DashboardRange, 'from' | 'to' | 'days' | 'bucket'>): Promise<SalesPoint[]> {
  const format = range.bucket === 'hour' ? 'HH24' : range.bucket === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'
  const ledger = await salesLedgerBuckets(format, range)
  return enumerateBuckets(range).map((b) => {
    const bucket = ledger.get(b.key)
    return {
      key: b.key,
      date: b.date,
      label: b.label,
      revenue: round2(num(bucket?.revenue)),
      orders: Number(bucket?.orders ?? 0),
      shopifyRevenue: round2(num(bucket?.shopifyRevenue)),
      shopifyOrders: Number(bucket?.shopifyOrders ?? 0),
      erpRevenue: round2(num(bucket?.erpRevenue)),
      erpOrders: Number(bucket?.erpOrders ?? 0),
    }
  })
}

dashboardRouter.get('/dashboard/sales-overview', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res)
  if (!range) return
  try {
    res.json(await buildSalesPoints(range))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Per-platform customers and paid orders, used by the KPI/insight cards. The
// invoice is the transaction boundary for invoiced sales; uninvoiced ERP orders
// are counted through the order row that holds them. The unique invoice number
// prevents a retry from adding another row.
async function customerTotals(range: { from: string; to: string }) {
  const [rows, erpOrderRows, allCustomers, erpCustomers] = await Promise.all([
    db!
      .select({
        customersShopify: sql<number>`count(distinct case when ${SHOPIFY_INVOICE} then lower(nullif(trim(customer), '')) end)`,
        paidAll: sql<number>`coalesce(sum(case when lower(coalesce(payment_status, '')) = 'paid' then 1 else 0 end), 0)`,
        paidShopify: sql<number>`coalesce(sum(case when ${SHOPIFY_INVOICE} and lower(coalesce(payment_status, '')) = 'paid' then 1 else 0 end), 0)`,
        paidErp: sql<number>`coalesce(sum(case when ${ERP_INVOICE} and lower(coalesce(payment_status, '')) = 'paid' then 1 else 0 end), 0)`,
      })
      .from(schema.salesInvoices)
      .where(and(
        sql`${schema.salesInvoices.date} is not null`,
        gte(schema.salesInvoices.date, range.from),
        sql`${schema.salesInvoices.date} < ${range.to}`,
        NOT_VOIDED,
        NOT_FOREIGN_SHOPIFY,
      )),
    db!
      .select({
        paid: sql<number>`coalesce(sum(case when lower(coalesce(${schema.salesOrders.payment}, '')) = 'paid' then 1 else 0 end), 0)`,
      })
      .from(schema.salesOrders)
      .where(and(
        gte(schema.salesOrders.date, range.from),
        sql`${schema.salesOrders.date} < ${range.to}`,
        ERP_ORDER_SALE,
      )),
    countDistinctCustomers(range, 'all'),
    countDistinctCustomers(range, 'erp'),
  ])
  const r = rows[0]
  const paidErpOrders = num(erpOrderRows[0]?.paid)
  return {
    customersAll: allCustomers,
    customersShopify: Number(r?.customersShopify ?? 0),
    customersErp: erpCustomers,
    paidAll: num(r?.paidAll) + paidErpOrders,
    paidShopify: num(r?.paidShopify),
    paidErp: num(r?.paidErp) + paidErpOrders,
  }
}

/**
 * Distinct customers over every row the Sales Overview counts: invoices (all
 * sales, or ERP only) plus the uninvoiced ERP orders. Counting the two sets
 * separately and adding them would double a customer who has both an invoice
 * and a manual order in the same period.
 */
async function countDistinctCustomers(range: { from: string; to: string }, source: 'all' | 'erp'): Promise<number> {
  const invoiceWhere = source === 'erp' ? ERP_INVOICE : sql`true`
  const rows = (await db!.execute(sql`
    select count(distinct c)::int as n
      from (
        select lower(nullif(trim(customer), '')) as c
          from ${schema.salesInvoices}
         where ${schema.salesInvoices.date} is not null
           and ${schema.salesInvoices.date} >= ${range.from}
           and ${schema.salesInvoices.date} < ${range.to}
           and ${NOT_VOIDED}
           and ${NOT_FOREIGN_SHOPIFY}
           and ${invoiceWhere}
        union all
        select lower(nullif(trim(${schema.salesOrders.customer}), '')) as c
          from ${schema.salesOrders}
         where ${schema.salesOrders.date} >= ${range.from}
           and ${schema.salesOrders.date} < ${range.to}
           and ${ERP_ORDER_SALE}
      ) counted
     where c is not null
  `)) as unknown as Array<{ n: number | string }>
  return Number(rows[0]?.n ?? 0)
}

async function customerBuckets(format: string, range: { from: string; to: string }) {
  const bucketSql = sql`to_char(${schema.salesInvoices.date}, ${format})`
  const [rows, erpPaidRows, allCustomers, erpCustomers] = await Promise.all([
    db!
      .select({
        bucket: bucketSql,
        customersShopify: sql<number>`count(distinct case when ${SHOPIFY_INVOICE} then lower(nullif(trim(customer), '')) end)`,
        paidAll: sql<number>`coalesce(sum(case when lower(coalesce(payment_status, '')) = 'paid' then 1 else 0 end), 0)`,
        paidShopify: sql<number>`coalesce(sum(case when ${SHOPIFY_INVOICE} and lower(coalesce(payment_status, '')) = 'paid' then 1 else 0 end), 0)`,
        paidErp: sql<number>`coalesce(sum(case when ${ERP_INVOICE} and lower(coalesce(payment_status, '')) = 'paid' then 1 else 0 end), 0)`,
      })
      .from(schema.salesInvoices)
      .where(and(
        sql`${schema.salesInvoices.date} is not null`,
        gte(schema.salesInvoices.date, range.from),
        sql`${schema.salesInvoices.date} < ${range.to}`,
        NOT_VOIDED,
        NOT_FOREIGN_SHOPIFY,
      ))
      .groupBy(sql`1`),
    db!
      .select({
        bucket: sql`to_char(${schema.salesOrders.date}, ${format})`,
        paid: sql<number>`coalesce(sum(case when lower(coalesce(${schema.salesOrders.payment}, '')) = 'paid' then 1 else 0 end), 0)`,
      })
      .from(schema.salesOrders)
      .where(and(
        gte(schema.salesOrders.date, range.from),
        sql`${schema.salesOrders.date} < ${range.to}`,
        ERP_ORDER_SALE,
      ))
      .groupBy(sql`1`),
    distinctCustomersByBucket(format, range, 'all'),
    distinctCustomersByBucket(format, range, 'erp'),
  ])
  const invoiceByBucket = new Map(rows.map((r) => [String(r.bucket ?? ''), r]))
  const erpPaidByBucket = new Map(erpPaidRows.map((r) => [String(r.bucket ?? ''), num(r.paid)]))
  const map = new Map<string, {
    customersAll: number; customersShopify: number; customersErp: number
    paidAll: number; paidShopify: number; paidErp: number
  }>()
  const keys = new Set([
    ...invoiceByBucket.keys(),
    ...allCustomers.keys(),
    ...erpPaidByBucket.keys(),
  ])
  for (const key of keys) {
    const inv = invoiceByBucket.get(key)
    const erpPaid = erpPaidByBucket.get(key) ?? 0
    map.set(key, {
      customersAll: allCustomers.get(key) ?? 0,
      customersShopify: Number(inv?.customersShopify ?? 0),
      customersErp: erpCustomers.get(key) ?? 0,
      paidAll: num(inv?.paidAll) + erpPaid,
      paidShopify: num(inv?.paidShopify),
      paidErp: num(inv?.paidErp) + erpPaid,
    })
  }
  return map
}

/** Per-bucket distinct customers, including the uninvoiced ERP orders. */
async function distinctCustomersByBucket(
  format: string,
  range: { from: string; to: string },
  source: 'all' | 'erp',
): Promise<Map<string, number>> {
  const invoiceWhere = source === 'erp' ? ERP_INVOICE : sql`true`
  const rows = (await db!.execute(sql`
    select bucket, count(distinct c)::int as n
      from (
        select to_char(${schema.salesInvoices.date}, ${format}) as bucket,
               lower(nullif(trim(customer), '')) as c
          from ${schema.salesInvoices}
         where ${schema.salesInvoices.date} is not null
           and ${schema.salesInvoices.date} >= ${range.from}
           and ${schema.salesInvoices.date} < ${range.to}
           and ${NOT_VOIDED}
           and ${NOT_FOREIGN_SHOPIFY}
           and ${invoiceWhere}
        union all
        select to_char(${schema.salesOrders.date}, ${format}) as bucket,
               lower(nullif(trim(${schema.salesOrders.customer}), '')) as c
          from ${schema.salesOrders}
         where ${schema.salesOrders.date} >= ${range.from}
           and ${schema.salesOrders.date} < ${range.to}
           and ${ERP_ORDER_SALE}
      ) counted
     where c is not null
     group by 1
  `)) as unknown as Array<{ bucket: string | null; n: number | string }>
  return new Map(rows.map((r) => [String(r.bucket ?? ''), Number(r.n)]))
}

type CustomerSummary = {
  customersAll: number; customersShopify: number; customersErp: number
  paidAll: number; paidShopify: number; paidErp: number
}

function sourceMetrics(points: SalesPoint[], customers: CustomerSummary, source: SourceKey) {
  const orders = points.reduce((sum, point) => sum + (source === 'all' ? point.orders : source === 'shopify' ? point.shopifyOrders : point.erpOrders), 0)
  const revenue = points.reduce((sum, point) => sum + (source === 'all' ? point.revenue : source === 'shopify' ? point.shopifyRevenue : point.erpRevenue), 0)
  const customerCount = source === 'all' ? customers.customersAll : source === 'shopify' ? customers.customersShopify : customers.customersErp
  const paidOrders = source === 'all' ? customers.paidAll : source === 'shopify' ? customers.paidShopify : customers.paidErp
  return {
    orders,
    revenue: round2(revenue),
    aov: orders > 0 ? round2(revenue / orders) : 0,
    customers: Number(customerCount),
    paidOrders: Number(paidOrders),
    conversionRate: orders > 0 ? round2((Number(paidOrders) / orders) * 100) : 0,
  }
}

// Every metric the Sales Overview needs, for all three filters at once. The
// client switches filters without another request, and previous-period values
// use the same invoice/return basis so growth is comparable.
dashboardRouter.get('/dashboard/sales-insights', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res)
  if (!range) return
  try {
    const previousRange = { from: range.prevFrom, to: range.prevTo, days: range.days, bucket: range.bucket }
    const [currentPoints, previousPoints, currentCustomers, previousCustomers, buckets] = await Promise.all([
      buildSalesPoints(range),
      buildSalesPoints(previousRange),
      customerTotals(range),
      customerTotals(previousRange),
      customerBuckets(bucketFormat(range), range),
    ])
    const current = {
      all: sourceMetrics(currentPoints, currentCustomers, 'all'),
      shopify: sourceMetrics(currentPoints, currentCustomers, 'shopify'),
      erp: sourceMetrics(currentPoints, currentCustomers, 'erp'),
    }
    const previous = {
      all: sourceMetrics(previousPoints, previousCustomers, 'all'),
      shopify: sourceMetrics(previousPoints, previousCustomers, 'shopify'),
      erp: sourceMetrics(previousPoints, previousCustomers, 'erp'),
    }
    const trends = Object.fromEntries((['all', 'shopify', 'erp'] as const).map((source) => {
      const orders = currentPoints.map((point) => source === 'all' ? point.orders : source === 'shopify' ? point.shopifyOrders : point.erpOrders)
      const revenue = currentPoints.map((point) => source === 'all' ? point.revenue : source === 'shopify' ? point.shopifyRevenue : point.erpRevenue)
      const customers = currentPoints.map((point) => {
        const bucket = buckets.get(point.key)
        return source === 'all' ? (bucket?.customersAll ?? 0) : source === 'shopify' ? (bucket?.customersShopify ?? 0) : (bucket?.customersErp ?? 0)
      })
      const paid = currentPoints.map((point) => {
        const bucket = buckets.get(point.key)
        return source === 'all' ? (bucket?.paidAll ?? 0) : source === 'shopify' ? (bucket?.paidShopify ?? 0) : (bucket?.paidErp ?? 0)
      })
      return [source, {
        orders,
        revenue,
        aov: orders.map((count, i) => count > 0 ? round2(revenue[i] / count) : 0),
        customers,
        conversion: orders.map((count, i) => count > 0 ? round2((paid[i] / count) * 100) : 0),
      }]
    }))
    res.json({
      label: range.label,
      previousLabel: range.prevLabel,
      labels: currentPoints.map((point) => point.label),
      current,
      previous,
      trends,
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dashboardRouter.get('/dashboard/top-products', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res)
  if (!range) return
  const source = sourceFilter(req.query.source)
  if (!source) { res.status(400).json({ error: 'Unknown sales source' }); return }
  try {
    // Grouped and joined in SQL; the old version loaded every invoice item AND
    // every product row and aggregated in JS.
    const rows = await db!
      .select({
        sku: sql<string>`max(${schema.salesInvoiceItems.sku})`,
        id: sql<string>`coalesce(max(${schema.products.id}), max(${schema.salesInvoiceItems.sku}))`,
        name: sql<string>`coalesce(max(${schema.products.name}), max(${schema.salesInvoiceItems.product}), max(${schema.salesInvoiceItems.sku}))`,
        category: sql<string | null>`max(${schema.products.category})`,
        qty: sql<number>`coalesce(sum(coalesce(${schema.salesInvoiceItems.qty}, 0)), 0)`,
        weight: sql<number>`coalesce(sum(coalesce(${schema.salesInvoiceItems.weight}, 0)), 0)`,
        revenue: sql<number>`coalesce(sum(coalesce(${schema.salesInvoiceItems.amount}, 0)), 0)`,
        image: sql<string | null>`max(${schema.products.image})`,
      })
      .from(schema.salesInvoiceItems)
      .innerJoin(schema.salesInvoices, eq(schema.salesInvoices.id, schema.salesInvoiceItems.invoiceId))
      .leftJoin(schema.products, sql`lower(${schema.products.sku}) = lower(${schema.salesInvoiceItems.sku})`)
      .where(and(
        sql`coalesce(${schema.salesInvoiceItems.sku}, '') <> ''`,
        gte(schema.salesInvoices.date, range.from),
        sql`${schema.salesInvoices.date} < ${range.to}`,
        NOT_VOIDED,
        NOT_FOREIGN_SHOPIFY,
        sourceWhere(source),
      ))
      .groupBy(sql`lower(${schema.salesInvoiceItems.sku})`)
      .orderBy(sql`coalesce(sum(coalesce(${schema.salesInvoiceItems.amount}, 0)), 0) desc`)
      // More than the rows returned: a SKU that also appears on an uninvoiced
      // ERP order may move up once that order's lines are merged in below.
      .limit(100)

    // Uninvoiced orders are sales the Sales Overview counts (and the matching
    // filter shows) but they have no invoice items, so ranking from invoices
    // alone reported "No sales recorded yet" for an order-only period. Both
    // open-order definitions already exclude orders that have an invoice or a
    // Shopify twin, so nothing is counted twice.
    const orderSaleScope = source === 'shopify'
      ? SHOPIFY_ORDER_SALE
      : source === 'erp'
        ? ERP_ORDER_SALE
        : sql`(${ERP_ORDER_SALE} or ${SHOPIFY_ORDER_SALE})`
    const orderLines = await db!
      .select({ lineItems: schema.salesOrders.lineItems })
      .from(schema.salesOrders)
      .where(and(
        gte(schema.salesOrders.date, range.from),
        sql`${schema.salesOrders.date} < ${range.to}`,
        orderSaleScope,
      ))

    const merged = new Map<string, {
      id: string; name: string; sku: string; category: string | null
      qty: number; weight: number; revenue: number; image: string | null
    }>()
    const keyOf = (sku: string) => sku.trim().toLowerCase()
    for (const r of rows) {
      const sku = r.sku ?? ''
      merged.set(keyOf(sku), {
        id: r.id,
        name: r.name,
        sku,
        category: r.category,
        qty: num(r.qty),
        weight: num(r.weight),
        revenue: num(r.revenue),
        image: r.image ?? null,
      })
    }
    for (const order of orderLines) {
      const items = Array.isArray(order.lineItems) ? order.lineItems : []
      for (const raw of items) {
        const line = raw as Record<string, unknown>
        const sku = String(line.sku ?? '').trim()
        if (!sku) continue
        const entry = merged.get(keyOf(sku)) ?? {
          id: sku,
          name: String(line.title ?? sku),
          sku,
          category: null,
          qty: 0,
          weight: 0,
          revenue: 0,
          image: null,
        }
        entry.qty += num(line.quantity)
        entry.weight += num(line.weight)
        entry.revenue += num(line.amount)
        merged.set(keyOf(sku), entry)
      }
    }

    // Twelve rows of two cards: the card shows three rows and scrolls through
    // the rest, so a busy period lists more than one extra row.
    const top = [...merged.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 24)
    // ERP-only SKUs have no invoice->product join, so resolve their catalogue
    // fields (name / photo / category) in one lookup.
    const missing = top.filter((r) => r.category == null && r.image == null).map((r) => r.sku)
    if (missing.length > 0) {
      const productsForSkus = await db!
        .select({
          id: schema.products.id,
          sku: schema.products.sku,
          name: schema.products.name,
          category: schema.products.category,
          image: schema.products.image,
        })
        .from(schema.products)
        .where(inArray(schema.products.sku, missing))
      const bySku = new Map(productsForSkus.map((p) => [keyOf(p.sku ?? ''), p]))
      for (const row of top) {
        const product = bySku.get(keyOf(row.sku))
        if (!product) continue
        row.id = product.id
        row.name = product.name ?? row.name
        row.category = product.category
        row.image = product.image ?? null
      }
    }

    res.json(
      top.map((r) => ({
        id: r.id,
        name: r.name,
        sku: r.sku,
        qty: r.qty,
        weight: round2(r.weight),
        revenue: round2(r.revenue),
        image: r.image,
        icon: iconFor(r.name, r.category),
      })),
    )
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Revenue by product category, backing the "Top Selling Category" card.
dashboardRouter.get('/dashboard/top-category', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res)
  if (!range) return
  try {
    const rows = await db!
      .select({
        category: sql<string>`coalesce(nullif(${schema.products.category}, ''), 'Uncategorized')`,
        qty: sql<number>`coalesce(sum(coalesce(${schema.salesInvoiceItems.qty}, 0)), 0)`,
        weight: sql<number>`coalesce(sum(coalesce(${schema.salesInvoiceItems.weight}, 0)), 0)`,
        revenue: sql<number>`coalesce(sum(coalesce(${schema.salesInvoiceItems.amount}, 0)), 0)`,
      })
      .from(schema.salesInvoiceItems)
      .innerJoin(schema.salesInvoices, eq(schema.salesInvoices.id, schema.salesInvoiceItems.invoiceId))
      .leftJoin(schema.products, sql`lower(${schema.products.sku}) = lower(${schema.salesInvoiceItems.sku})`)
      .where(and(
        gte(schema.salesInvoices.date, range.from),
        sql`${schema.salesInvoices.date} < ${range.to}`,
        NOT_VOIDED,
        NOT_FOREIGN_SHOPIFY,
      ))
      .groupBy(sql`coalesce(nullif(${schema.products.category}, ''), 'Uncategorized')`)
      .orderBy(sql`coalesce(sum(coalesce(${schema.salesInvoiceItems.amount}, 0)), 0) desc`)
      .limit(6)

    res.json(
      rows.map((r) => ({
        category: r.category,
        qty: num(r.qty),
        weight: round2(num(r.weight)),
        revenue: round2(num(r.revenue)),
      })),
    )
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Dashboard summary widgets ──────────────────────────────────────────
// Every list below is aggregated and limited in SQL (five rows, six for recent
// invoices) and every daily series is grouped by the shared range buckets.

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parseMonthParam(value: unknown): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value ?? ''))
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null
  return { year, month }
}

function yearStart(year: number): string {
  return `${year}-01-01T00:00:00`
}

/** Grouped Online vs In-store orders for the Order Summary card. */
dashboardRouter.get('/dashboard/order-summary', async (req, res) => {
  if (!requireDb(res)) return
  const rawGrain = String(req.query.grain ?? 'week')
  const grain = rawGrain === 'month' || rawGrain === 'year' ? rawGrain : 'week'
  const requestedMonth = req.query.month ? parseMonthParam(req.query.month) : null
  if (req.query.month && !requestedMonth) return res.status(400).json({ error: 'month must be YYYY-MM' })
  // Current month in the server's local (IST) calendar, not UTC: on the 1st
  // before 05:30 IST, toISOString() still reports the previous month.
  const now = new Date()
  const localMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
  const anchor = requestedMonth ?? parseMonthParam(localMonth)
  if (!anchor) return res.status(400).json({ error: 'month must be YYYY-MM' })

  let from: string
  let to: string
  let labels: string[]
  let bucketSql: SQL<number>
  let label: string

  if (grain === 'week') {
    const start = new Date(anchor.year, anchor.month - 1, 1)
    const end = new Date(anchor.year, anchor.month, 1)
    from = `${anchor.year}-${pad(anchor.month)}-01T00:00:00`
    to = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-01T00:00:00`
    // Four equal 7-day buckets; the labels must match the SQL split exactly
    // (days 8–14, 15–21, 22–end) or a bar shows under the wrong week.
    labels = ['01–07', '08–14', '15–21', '22–end']
    bucketSql = sql<number>`least(3, floor((extract(day from ${schema.salesOrders.date}) - 1) / 7))::int`
    label = `${MONTH_LABELS[anchor.month - 1]} ${start.getFullYear()}`
  } else if (grain === 'month') {
    from = yearStart(anchor.year)
    to = yearStart(anchor.year + 1)
    labels = MONTH_LABELS
    bucketSql = sql<number>`extract(month from ${schema.salesOrders.date})::int`
    label = String(anchor.year)
  } else {
    from = yearStart(anchor.year - 4)
    to = yearStart(anchor.year + 1)
    labels = Array.from({ length: 5 }, (_, i) => String(anchor.year - 4 + i))
    bucketSql = sql<number>`extract(year from ${schema.salesOrders.date})::int`
    label = `${anchor.year - 4}–${anchor.year}`
  }

  try {
    // Same live-order scope as the Orders KPI: cancellations, orders left by a
    // previous Shopify connection and the ERP half of a synced pair are out.
    const rows = await db!
      .select({
        bucket: bucketSql,
        online: sql<number>`count(*) filter (where ${SHOPIFY_ORDER})`,
        inStore: sql<number>`count(*) filter (where not (${SHOPIFY_ORDER}))`,
        revenue: sql<number>`coalesce(sum(coalesce(${schema.salesOrders.value}, 0)), 0)`,
      })
      .from(schema.salesOrders)
      .where(and(
        gte(schema.salesOrders.date, from),
        lt(schema.salesOrders.date, to),
        sql`coalesce(${schema.salesOrders.status}, '') <> 'cancelled'`,
        sql`lower(coalesce(${schema.salesOrders.status}, '')) <> 'draft'`,
        sql`coalesce(${schema.salesOrders.isBooking}, false) = false`,
        sql`coalesce(${schema.salesOrders.shopifyStore}, '') <> 'not-in-store'`,
        sql`not (${SYNCED_ERP_TWIN})`,
      ))
      .groupBy(sql`1`)
      .orderBy(sql`1`)

    const byBucket = new Map<number, { online: number; inStore: number; revenue: number }>()
    for (const r of rows) byBucket.set(Number(r.bucket), { online: Number(r.online), inStore: Number(r.inStore), revenue: num(r.revenue) })

    const points = labels.map((l, i) => {
      // The week buckets are 0-based (0–3); month buckets are 1-based, and the
      // year buckets are actual years. Using i+1 for week put every bar one
      // bucket early and dropped the last week entirely.
      const bucket = grain === 'year' ? anchor.year - 4 + i : grain === 'week' ? i : i + 1
      const row = byBucket.get(bucket)
      return {
        label: l,
        online: row?.online ?? 0,
        inStore: row?.inStore ?? 0,
        revenue: round2(row?.revenue ?? 0),
      }
    })

    res.json({ grain, label, points })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Latest supplier payments: daily spend series + payment/purchase status rows. */
dashboardRouter.get('/dashboard/supplier-payments', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res, 'last30')
  if (!range) return
  const q = String(req.query.q ?? '').trim()
  const status = String(req.query.status ?? 'all')

  try {
    const [seriesRows, rows] = await Promise.all([
      db!
        .select({
          bucket: sql<string>`to_char(${schema.supplierPayments.date}, ${bucketFormat(range)})`,
          value: sql<number>`coalesce(sum(coalesce(${schema.supplierPayments.amount}, 0)), 0)`,
        })
        .from(schema.supplierPayments)
        .where(and(gte(schema.supplierPayments.date, range.from), lt(schema.supplierPayments.date, range.to)))
        .groupBy(sql`1`),
      db!
        .select({
          id: schema.supplierPayments.id,
          ref: schema.supplierPayments.ref,
          supplier: schema.supplierPayments.supplier,
          amount: schema.supplierPayments.amount,
          method: schema.supplierPayments.method,
          date: schema.supplierPayments.date,
        })
        .from(schema.supplierPayments)
        .where(and(
          gte(schema.supplierPayments.date, range.from),
          lt(schema.supplierPayments.date, range.to),
          q
            ? or(
                ilike(schema.supplierPayments.supplier, `%${q}%`),
                ilike(schema.supplierPayments.ref, `%${q}%`),
              )
            : undefined,
        ))
        .orderBy(desc(schema.supplierPayments.date))
        .limit(100),
    ])

    const allocated = new Map<string, number>()
    const invoiceStatuses = new Map<string, string[]>()
    const ids = rows.map((r) => r.id)
    if (ids.length > 0) {
      const allocations = await db!
        .select({
          paymentId: schema.supplierPaymentAllocations.paymentId,
          amount: schema.supplierPaymentAllocations.amount,
          invoiceStatus: schema.purchaseInvoices.status,
        })
        .from(schema.supplierPaymentAllocations)
        .leftJoin(schema.purchaseInvoices, eq(schema.purchaseInvoices.id, schema.supplierPaymentAllocations.invoiceId))
        .where(inArray(schema.supplierPaymentAllocations.paymentId, ids))
      for (const a of allocations) {
        allocated.set(a.paymentId, (allocated.get(a.paymentId) ?? 0) + num(a.amount))
        if (a.invoiceStatus) {
          const list = invoiceStatuses.get(a.paymentId) ?? []
          list.push(a.invoiceStatus)
          invoiceStatuses.set(a.paymentId, list)
        }
      }
    }

    const list = rows
      .map((r) => {
        const paid = allocated.get(r.id) ?? 0
        const amount = num(r.amount)
        const paymentStatus = paid >= amount - 0.01 ? 'settled' : paid > 0 ? 'partial' : 'unallocated'
        const statuses = invoiceStatuses.get(r.id) ?? []
        const purchaseStatus = statuses.includes('received')
          ? 'received'
          : statuses.includes('open')
            ? 'open'
            : statuses.includes('cancelled')
              ? 'cancelled'
              : 'unallocated'
        return {
          id: r.id,
          ref: r.ref ?? r.id,
          supplier: r.supplier ?? 'Unknown supplier',
          purchaseStatus,
          paymentStatus,
          method: r.method ?? '—',
          total: round2(amount),
          date: r.date,
        }
      })
      .filter((r) => status === 'all' || r.paymentStatus === status)
      .slice(0, 5)

    const values = new Map(seriesRows.map((r) => [String(r.bucket ?? ''), num(r.value)]))
    res.json({ points: seriesPoints(range, values), rows: list })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Purchase order status donut + five latest incoming orders. */
dashboardRouter.get('/dashboard/purchase-orders', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res, 'last30')
  if (!range) return
  try {
    const [segments, rows] = await Promise.all([
      db!
        .select({
          status: sql<string>`coalesce(${schema.purchaseOrders.status}, 'open')`,
          count: sql<number>`count(*)`,
          value: sql<number>`coalesce(sum(coalesce(${schema.purchaseOrders.grandTotal}, 0)), 0)`,
        })
        .from(schema.purchaseOrders)
        .where(and(gte(schema.purchaseOrders.date, range.from), lt(schema.purchaseOrders.date, range.to)))
        .groupBy(sql`coalesce(${schema.purchaseOrders.status}, 'open')`)
        .orderBy(sql`count(*) desc`),
      db!
        .select({
          id: schema.purchaseOrders.id,
          number: schema.purchaseOrders.number,
          supplier: schema.purchaseOrders.supplier,
          expectedDate: schema.purchaseOrders.expectedDate,
          status: schema.purchaseOrders.status,
          total: schema.purchaseOrders.grandTotal,
          date: schema.purchaseOrders.date,
        })
        .from(schema.purchaseOrders)
        .where(and(gte(schema.purchaseOrders.date, range.from), lt(schema.purchaseOrders.date, range.to)))
        .orderBy(desc(schema.purchaseOrders.date))
        .limit(5),
    ])
    res.json({
      segments: segments.map((s) => ({ status: s.status, count: Number(s.count), value: round2(num(s.value)) })),
      rows: rows.map((r) => ({
        id: r.id,
        number: r.number,
        supplier: r.supplier ?? 'Unknown supplier',
        expectedDate: r.expectedDate,
        status: r.status ?? 'open',
        total: round2(num(r.total)),
        date: r.date,
      })),
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Latest customer collections: daily receipts + fulfilment/payment status rows. */
dashboardRouter.get('/dashboard/customer-payments', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res, 'last30')
  if (!range) return
  const q = String(req.query.q ?? '').trim()
  const status = String(req.query.status ?? 'all')

  try {
    const [seriesRows, rows] = await Promise.all([
      db!
        .select({
          bucket: sql<string>`to_char(${schema.payments.date}, ${bucketFormat(range)})`,
          value: sql<number>`coalesce(sum(coalesce(${schema.payments.amount}, 0)), 0)`,
        })
        .from(schema.payments)
        .where(and(gte(schema.payments.date, range.from), lt(schema.payments.date, range.to)))
        .groupBy(sql`1`),
      db!
        .select({
          id: schema.payments.id,
          ref: schema.payments.ref,
          customer: schema.payments.customer,
          invoice: schema.payments.invoice,
          invoiceCustomer: schema.salesInvoices.customer,
          amount: schema.payments.amount,
          method: schema.payments.method,
          status: schema.payments.status,
          date: schema.payments.date,
          fulfillment: schema.salesOrders.fulfillment,
        })
        .from(schema.payments)
        .leftJoin(schema.salesInvoices, eq(schema.salesInvoices.number, schema.payments.invoice))
        .leftJoin(
          schema.salesOrders,
          or(
            eq(schema.salesOrders.shopifyId, schema.salesInvoices.shopifyOrder),
            eq(schema.salesOrders.internalId, schema.salesInvoices.shopifyOrder),
          ),
        )
        .where(and(
          gte(schema.payments.date, range.from),
          lt(schema.payments.date, range.to),
          q
            ? or(
                ilike(schema.payments.customer, `%${q}%`),
                ilike(schema.payments.ref, `%${q}%`),
                ilike(schema.payments.invoice, `%${q}%`),
              )
            : undefined,
          status !== 'all' ? sql`lower(coalesce(${schema.payments.status}, '')) = ${status}` : undefined,
        ))
        .orderBy(desc(schema.payments.date))
        .limit(5),
    ])

    const values = new Map(seriesRows.map((r) => [String(r.bucket ?? ''), num(r.value)]))
    res.json({
      points: seriesPoints(range, values),
      rows: rows.map((r) => ({
        id: r.id,
        ref: r.ref ?? r.id,
        customer: r.customer ?? r.invoiceCustomer ?? 'Unknown customer',
        invoice: r.invoice ?? '—',
        fulfillment: r.fulfillment ?? '—',
        paymentStatus: r.status ?? 'pending',
        method: r.method ?? '—',
        total: round2(num(r.amount)),
        date: r.date,
      })),
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Sales order status donut + latest orders. */
dashboardRouter.get('/dashboard/sales-orders', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res, 'last30')
  if (!range) return
  try {
    const [segments, rows] = await Promise.all([
      db!
        .select({
          status: sql<string>`coalesce(${schema.salesOrders.status}, 'imported')`,
          count: sql<number>`count(*)`,
          value: sql<number>`coalesce(sum(coalesce(${schema.salesOrders.value}, 0)), 0)`,
        })
        .from(schema.salesOrders)
        .where(and(gte(schema.salesOrders.date, range.from), lt(schema.salesOrders.date, range.to)))
        .groupBy(sql`coalesce(${schema.salesOrders.status}, 'imported')`)
        .orderBy(sql`count(*) desc`),
      db!
        .select({
          id: schema.salesOrders.id,
          number: schema.salesOrders.internalId,
          shopifyId: schema.salesOrders.shopifyId,
          customer: schema.salesOrders.customer,
          fulfillment: schema.salesOrders.fulfillment,
          status: schema.salesOrders.status,
          total: schema.salesOrders.value,
          date: schema.salesOrders.date,
        })
        .from(schema.salesOrders)
        .where(and(gte(schema.salesOrders.date, range.from), lt(schema.salesOrders.date, range.to)))
        .orderBy(desc(schema.salesOrders.date))
        .limit(5),
    ])
    res.json({
      segments: segments.map((s) => ({ status: s.status, count: Number(s.count), value: round2(num(s.value)) })),
      rows: rows.map((r) => ({
        id: r.id,
        number: r.number ?? r.shopifyId ?? r.id,
        customer: r.customer ?? 'Unknown customer',
        fulfillment: r.fulfillment ?? 'unfulfilled',
        status: r.status ?? 'imported',
        total: round2(num(r.total)),
        date: r.date,
      })),
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Recent invoices: mini value series + six latest invoices (row opens detail). */
dashboardRouter.get('/dashboard/recent-invoices', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res, 'last30')
  if (!range) return
  const source = sourceFilter(req.query.source)
  if (!source) { res.status(400).json({ error: 'Unknown sales source' }); return }
  try {
    const [seriesRows, rows] = await Promise.all([
      db!
        .select({
          bucket: sql<string>`to_char(${schema.salesInvoices.date}, ${bucketFormat(range)})`,
          value: sql<number>`coalesce(sum(coalesce(${schema.salesInvoices.grandTotal}, 0)), 0)`,
        })
        .from(schema.salesInvoices)
        .where(and(
          gte(schema.salesInvoices.date, range.from),
          lt(schema.salesInvoices.date, range.to),
          NOT_VOIDED,
          NOT_FOREIGN_SHOPIFY,
          sourceWhere(source),
        ))
        .groupBy(sql`1`),
      db!
        .select({
          id: schema.salesInvoices.id,
          number: schema.salesInvoices.number,
          customer: schema.salesInvoices.customer,
          total: schema.salesInvoices.grandTotal,
          paymentStatus: schema.salesInvoices.paymentStatus,
          status: schema.salesInvoices.status,
          date: schema.salesInvoices.date,
          platform: sql<string>`case when ${SHOPIFY_INVOICE} then 'shopify' else 'erp' end`,
        })
        .from(schema.salesInvoices)
        .where(and(
          gte(schema.salesInvoices.date, range.from),
          lt(schema.salesInvoices.date, range.to),
          NOT_VOIDED,
          NOT_FOREIGN_SHOPIFY,
          sourceWhere(source),
        ))
        .orderBy(desc(schema.salesInvoices.date))
        .limit(6),
    ])

    const values = new Map(seriesRows.map((r) => [String(r.bucket ?? ''), num(r.value)]))
    const invoiceRows = rows.map((r) => ({
      id: r.id,
      number: r.number,
      customer: r.customer ?? 'Walk-in customer',
      total: round2(num(r.total)),
      paymentStatus: r.paymentStatus ?? 'pending',
      status: r.status ?? 'issued',
      date: r.date,
      platform: r.platform === 'shopify' ? 'shopify' : 'erp',
    }))
    res.json({
      points: seriesPoints(range, values),
      // One bar per latest invoice so the chart can colour by payment state.
      statusPoints: invoiceRows.map((r) => ({
        date: r.date ?? '',
        label: r.number ?? '',
        value: r.total,
        status: r.paymentStatus,
      })),
      rows: invoiceRows,
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dashboardRouter.get('/dashboard/payment-status', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res)
  if (!range) return
  // The widget follows the Sales Overview source buttons: All (the default)
  // reads Shopify invoices, ERP invoices and uninvoiced ERP orders; each
  // platform filter reads only its own rows, from the same scope the sales
  // ledger uses.
  const source = sourceFilter(req.query.source)
  if (source === null) return res.status(400).json({ error: 'source must be all, shopify or erp' })
  try {
    // Five mutually exclusive segments over the same eligible sales the ledger
    // counts, with accounting meanings rather than invoice labels:
    //   Paid    = money actually collected, net of refunds
    //   Pending = unpaid balance not yet due
    //   Failed  = unpaid balance whose payment attempt failed (not added again)
    //   Overdue = unpaid balance past its due date
    //   Refunded = money actually refunded (credit notes + completed refunds)
    // An invoice marked fully refunded contributes its full value to Refunded
    // and nothing to Paid, so no amount is counted twice.
    //
    // ERP sales raised without an invoice live only on the order row; reading
    // sales_invoices alone dropped them from the widget (₹14,988.42 on one day
    // where Sales showed ₹1,48,382.44 and this card showed only Shopify's
    // ₹1,33,394.02). The order rows are the same ERP_ORDER_SALE set the sales
    // ledger adds, so an invoiced ERP order is never counted twice.
    const collectedSub = sql`(
      select ${schema.payments.invoice} as invoice,
             sum(coalesce(${schema.payments.amount}, 0)) as paid
        from ${schema.payments}
       where coalesce(${schema.payments.amount}, 0) > 0
         and lower(coalesce(${schema.payments.status}, '')) in ('success', 'settled', 'paid')
       group by ${schema.payments.invoice}
    )`
    // Refunds come from the two places the app records them: negative payment
    // entries (ERP credit notes) and completed Shopify refunds. They never
    // overlap for one refund, and a full-refund invoice is handled separately.
    const refundSub = sql`(
      select invoice, sum(amount) as refunded
        from (
          select ${schema.payments.invoice} as invoice,
                 -coalesce(${schema.payments.amount}, 0) as amount
            from ${schema.payments}
           where coalesce(${schema.payments.amount}, 0) < 0
             and lower(coalesce(${schema.payments.status}, '')) = 'refunded'
             and ${schema.payments.invoice} is not null
          union all
          select ${schema.refunds.invoiceNumber} as invoice,
                 coalesce(nullif(${schema.refunds.refundedAmount}, 0), ${schema.refunds.amount}, 0) as amount
            from ${schema.refunds}
           where lower(coalesce(${schema.refunds.status}, '')) = 'completed'
             and ${schema.refunds.invoiceNumber} is not null
        ) refund_rows
       group by invoice
    )`
    const today = localDayStart(0)
    const [rows, ledger] = await Promise.all([
      db!.execute(sql`
        with invoice_rows as (
          select
            'invoice'::text as row_kind,
            coalesce(${schema.salesInvoices.grandTotal}, 0) as grand_total,
            (lower(coalesce(${schema.salesInvoices.status}, '')) = 'refunded'
              or lower(coalesce(${schema.salesInvoices.paymentStatus}, '')) = 'refunded') as is_refunded,
            (lower(coalesce(${schema.salesInvoices.paymentStatus}, '')) in ('failed', 'declined', 'error')
              or exists (
                select 1
                  from ${schema.payments} as failed_payment
                 where failed_payment.invoice = ${schema.salesInvoices.number}
                   and lower(coalesce(failed_payment.status, '')) in ('failed', 'error', 'declined')
              )) as is_failed,
            (lower(coalesce(${schema.salesInvoices.status}, '')) = 'overdue'
              or lower(coalesce(${schema.salesInvoices.paymentStatus}, '')) = 'overdue'
              or (${schema.salesInvoices.dueDate} is not null and ${schema.salesInvoices.dueDate} < ${today})) as is_overdue,
            case
              when lower(coalesce(${schema.salesInvoices.paymentStatus}, '')) = 'paid'
                or lower(coalesce(${schema.salesInvoices.status}, '')) = 'paid'
                then coalesce(${schema.salesInvoices.grandTotal}, 0)
              else least(
                coalesce(${schema.salesInvoices.grandTotal}, 0),
                coalesce(p.paid, 0)
              )
            end as collected,
            coalesce(r.refunded, 0) as recorded_refund
          from ${schema.salesInvoices}
          left join ${collectedSub} p on p.invoice = ${schema.salesInvoices.number}
          left join ${refundSub} r on r.invoice = ${schema.salesInvoices.number}
          where ${schema.salesInvoices.date} >= ${range.from}
            and ${schema.salesInvoices.date} < ${range.to}
            and coalesce(${schema.salesInvoices.status}, '') <> 'cancelled'
            and ${NOT_FOREIGN_SHOPIFY}
            and ${sourceWhere(source)}
        ), order_rows as (
          select
            'order'::text as row_kind,
            coalesce(${schema.salesOrders.value}, 0) as grand_total,
            (lower(coalesce(${schema.salesOrders.payment}, '')) = 'refunded') as is_refunded,
            (lower(coalesce(${schema.salesOrders.payment}, '')) in ('failed', 'declined', 'error')) as is_failed,
            (lower(coalesce(${schema.salesOrders.payment}, '')) = 'overdue') as is_overdue,
            case
              when lower(coalesce(${schema.salesOrders.payment}, '')) in ('paid', 'settled', 'completed', 'success')
                then coalesce(${schema.salesOrders.value}, 0)
              else 0
            end as collected,
            0::numeric as recorded_refund
          from ${schema.salesOrders}
          where ${schema.salesOrders.date} >= ${range.from}
            and ${schema.salesOrders.date} < ${range.to}
            and (
              (${ERP_ORDER_SALE} and ${source === 'shopify' ? sql`false` : sql`true`})
              or (${SHOPIFY_ORDER_SALE} and ${source === 'erp' ? sql`false` : sql`true`})
            )
        ), calc as (
          select row_kind, grand_total, is_refunded, is_failed, is_overdue, collected,
                 least(recorded_refund, collected) as refund_amount
            from invoice_rows
          union all
          select row_kind, grand_total, is_refunded, is_failed, is_overdue, collected,
                 least(recorded_refund, collected) as refund_amount
            from order_rows
        )
        select
          coalesce(sum(case when is_refunded then 0 else greatest(collected - refund_amount, 0) end), 0) as paid,
          count(*) filter (where not is_refunded and greatest(collected - refund_amount, 0) > 0) as paid_count,
          coalesce(sum(case when is_refunded then grand_total else refund_amount end), 0) as refunded,
          count(*) filter (where is_refunded or refund_amount > 0) as refunded_count,
          coalesce(sum(case when not is_refunded and grand_total > collected and is_failed then grand_total - collected else 0 end), 0) as failed,
          count(*) filter (where not is_refunded and grand_total > collected and is_failed) as failed_count,
          coalesce(sum(case when not is_refunded and grand_total > collected and not is_failed and is_overdue then grand_total - collected else 0 end), 0) as overdue,
          count(*) filter (where not is_refunded and grand_total > collected and not is_failed and is_overdue) as overdue_count,
          coalesce(sum(case when not is_refunded and grand_total > collected and not is_failed and not is_overdue then grand_total - collected else 0 end), 0) as pending,
          count(*) filter (where not is_refunded and grand_total > collected and not is_failed and not is_overdue) as pending_count,
          coalesce(sum(case when row_kind = 'invoice' and is_refunded then grand_total else 0 end), 0) as refunded_invoice_gross
        from calc
      `) as unknown as Promise<Array<Record<string, unknown>>>,
      salesTotals(range),
    ])
    const r = rows[0] ?? {}

    const segments = [
      { status: 'paid' as const, label: 'Paid', value: round2(num(r.paid)), count: Number(r.paid_count ?? 0) },
      { status: 'pending' as const, label: 'Pending', value: round2(num(r.pending)), count: Number(r.pending_count ?? 0) },
      { status: 'failed' as const, label: 'Failed', value: round2(num(r.failed)), count: Number(r.failed_count ?? 0) },
      { status: 'overdue' as const, label: 'Overdue', value: round2(num(r.overdue)), count: Number(r.overdue_count ?? 0) },
      { status: 'refunded' as const, label: 'Refunded', value: round2(num(r.refunded)), count: Number(r.refunded_count ?? 0) },
    ]
    const total = round2(segments.reduce((sum, s) => sum + s.value, 0))
    // The widget's own total is the sales value it scopes (invoices plus
    // uninvoiced ERP orders). Sales revenue nets sales returns and drops
    // fully-refunded invoices, so it reconciles as
    //   total = salesRevenue + returns + refundedInvoiceGross,
    // which is exactly what the reconciliation test pins.
    const salesRevenue = source === 'shopify' ? ledger.shopifyRevenue : source === 'erp' ? ledger.erpRevenue : ledger.revenue

    res.json({
      segments,
      total,
      source,
      salesRevenue: round2(salesRevenue),
      invoiceGross: round2(ledger.gross),
      erpOrderRevenue: round2(ledger.erpOrderRevenue),
      returns: round2(ledger.returns),
      refundedInvoiceGross: round2(num(r.refunded_invoice_gross)),
    })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'dashboard payment status failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Silver Rate History ────────────────────────────────────────────────
// One point per IST calendar day for either a preset window (7 | 30 | 90
// days ending today) or an explicit inclusive `from`/`to` custom range
// (max 365 days, capped at today). silver_rates only records *changes*, so
// days without an update forward-fill the last known rate (and rates from
// before the window carry in); days before the first rate ever recorded are
// omitted — we never invent history. No rates at all → `{ days, points: [] }`.
const SILVER_HISTORY_WINDOWS = [7, 30, 90]
const SILVER_HISTORY_MAX_DAYS = 365

function parseISODay(value: unknown): string | null {
  const raw = String(value ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const d = new Date(`${raw}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : raw
}

function daysBetweenIso(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime()
  const b = new Date(`${to}T00:00:00Z`).getTime()
  return Math.round((b - a) / 86400000) + 1
}

function shiftIsoDay(dayKey: string, deltaDays: number): string {
  const d = new Date(`${dayKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

dashboardRouter.get('/dashboard/silver-history', async (req, res) => {
  if (!requireDb(res)) return

  const today = istDayKey(new Date())
  const wantsCustom = req.query.from != null || req.query.to != null
  let days: number
  let start: string
  let end: string

  if (wantsCustom) {
    const from = parseISODay(req.query.from)
    const to = parseISODay(req.query.to)
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to must be valid YYYY-MM-DD dates' })
    }
    if (to < from) {
      return res.status(400).json({ error: 'to must be on or after from' })
    }
    days = daysBetweenIso(from, to)
    if (days > SILVER_HISTORY_MAX_DAYS) {
      return res.status(400).json({ error: `Custom range cannot exceed ${SILVER_HISTORY_MAX_DAYS} days` })
    }
    start = from
    // Never invent future points: a range ending later still stops at today.
    end = to > today ? today : to
  } else {
    days = Number(req.query.days ?? 7)
    if (!SILVER_HISTORY_WINDOWS.includes(days)) {
      return res.status(400).json({ error: 'days must be one of 7, 30, 90' })
    }
    start = shiftIsoDay(today, -(days - 1))
    end = today
  }

  try {
    const rows = await db!
      .select({ rate: schema.silverRates.rate, updatedAt: schema.silverRates.updatedAt })
      .from(schema.silverRates)
      .orderBy(asc(schema.silverRates.updatedAt))

    const points: Array<{ date: string; rate: number }> = []
    for (const row of rows) {
      if (row.rate == null) continue
      const raw = row.updatedAt as string | Date | null
      if (raw == null) continue
      const when = raw instanceof Date ? raw : parseTimestamp(raw)
      if (Number.isNaN(when.getTime())) continue
      const day = istDayKey(when)
      if (day < start || day > end) continue
      points.push({ date: when.toISOString(), rate: Number(row.rate) })
    }

    res.json({ days, points })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dashboardRouter.get('/dashboard/low-stock', async (_req, res) => {
  if (!requireDb(res)) return
  try {
    // Out-of-stock (0) sorts first with `stock asc`; NULL reorder levels fall
    // back to the shared default so unimported products still flag.
    const rows = await db!
      .select()
      .from(schema.products)
      .where(lowStockWhere())
      .orderBy(sql`stock asc`)

    res.json(
      rows.map((p) => {
        const reorderLevel = p.reorderLevel ?? DEFAULT_REORDER_LEVEL
        return {
          id: p.id,
          product: p.name,
          sku: p.sku,
          stock: num(p.stock),
          reorderLevel,
          status: num(p.stock) === 0 || num(p.stock) * 2 <= reorderLevel ? ('critical' as const) : ('low' as const),
        }
      }),
    )
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

const IST_TIMEZONE = 'Asia/Kolkata'

function parseTimestamp(value: string): Date {
  const s = value.trim()
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return new Date(s)
  const body = s.includes('T') ? s : s.replace(' ', 'T')
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(body) ? `${body}T00:00:00Z` : `${body}Z`)
}

const istDayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function istDayKey(d: Date): string {
  return istDayKeyFormatter.format(d).replace(/-/g, '-')
}

const istTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
})

const istDayFormatter = new Intl.DateTimeFormat('en-IN', { timeZone: IST_TIMEZONE, day: '2-digit', month: 'short' })

function friendlyTime(iso: string | null) {
  if (!iso) return ''
  const d = parseTimestamp(iso)
  if (Number.isNaN(d.getTime())) return iso
  const sameDay = istDayKey(d) === istDayKey(new Date())
  const hm = istTimeFormatter.format(d)
  if (sameDay) return `Today, ${hm}`
  return `${istDayFormatter.format(d)}, ${hm}`
}

function activityType(module: string | null, action: string | null): string {
  const m = String(module ?? '').toLowerCase()
  const a = String(action ?? '').toLowerCase()
  if (/silver/.test(m)) return 'silver-rate'
  if (/payment/.test(m) || /reconcil/.test(a)) return 'payment'
  if (/invoice|sales/.test(m)) return 'invoice'
  if (/product/.test(m)) return 'product'
  if (/shopify|sync/.test(m)) return a.includes('failed') ? 'sync' : 'shopify-import'
  if (/purchase/.test(m)) return 'purchase'
  if (/user/.test(m)) return 'user'
  return 'sync'
}

/** Merged-feed ordering: newest first; a missing timestamp sorts oldest. */
function newestFirst(a: { timestamp: string | null }, b: { timestamp: string | null }): number {
  const at = a.timestamp ?? ''
  const bt = b.timestamp ?? ''
  return at < bt ? 1 : at > bt ? -1 : 0
}

dashboardRouter.get('/dashboard/activities', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res)
  if (!range) return
  try {
    const q = req.query as Record<string, unknown>
    const limit = clamp(Number(q.limit ?? 8) || 8, 1, 100)
    const latest = q.scope === 'latest'
    const cursor = typeof q.cursor === 'string' ? q.cursor.trim() : ''
    let cursorTs: string | null = null
    let cursorId: string | null = null
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          t: string
          i: string
        }
        if (parsed?.t && parsed?.i) {
          cursorTs = parsed.t
          cursorId = parsed.i
        }
      } catch {
        cursorTs = null
        cursorId = null
      }
    }

    // Merge activity_logs and audit_logs by (timestamp, id) desc using UNION ALL
    // for stable cursor pagination.
    const actWindow = latest
      ? sql`true`
      : and(gte(schema.activityLogs.timestamp, range.from), sql`${schema.activityLogs.timestamp} < ${range.to}`)
    const audWindow = latest
      ? sql`true`
      : and(gte(schema.auditLogs.timestamp, range.from), sql`${schema.auditLogs.timestamp} < ${range.to}`)
    const actWhere = and(
      actWindow,
      cursorTs && cursorId
        ? sql`(${schema.activityLogs.timestamp} < ${cursorTs} OR (${schema.activityLogs.timestamp} = ${cursorTs} AND ${schema.activityLogs.id} < ${cursorId}))`
        : sql`true`,
    )
    const audWhere = and(
      audWindow,
      cursorTs && cursorId
        ? sql`(${schema.auditLogs.timestamp} < ${cursorTs} OR (${schema.auditLogs.timestamp} = ${cursorTs} AND ${schema.auditLogs.id} < ${cursorId}))`
        : sql`true`,
    )

    // Count total in range (for "Showing X of total")
    const [totalAct, totalAud] = await Promise.all([
      db!.select({ n: sql<number>`count(*)` }).from(schema.activityLogs).where(actWindow),
      db!.select({ n: sql<number>`count(*)` }).from(schema.auditLogs).where(audWindow),
    ])
    const total = Number(totalAct[0]?.n ?? 0) + Number(totalAud[0]?.n ?? 0)

    const actSelect = db!
      .select({
        id: schema.activityLogs.id,
        timestamp: schema.activityLogs.timestamp,
        user: schema.activityLogs.user,
        action: schema.activityLogs.action,
        module: schema.activityLogs.module,
        entity: schema.activityLogs.entity,
        detail: schema.activityLogs.details,
      })
      .from(schema.activityLogs)
      .where(actWhere)
    const audSelect = db!
      .select({
        id: schema.auditLogs.id,
        timestamp: schema.auditLogs.timestamp,
        user: schema.auditLogs.user,
        action: schema.auditLogs.action,
        module: schema.auditLogs.module,
        entity: schema.auditLogs.entity,
        detail: schema.auditLogs.changes,
      })
      .from(schema.auditLogs)
      .where(audWhere)

    // db.execute() hands back the driver's own column names, and UNION ALL
    // names its output after the FIRST branch — so every row is keyed
    // `details` (the activity_logs column), carrying the audit branch's
    // `changes` value on audit rows. The `detail` key only exists in the
    // select shape above, which is why reading l.detail yielded undefined and
    // the widget lost its second line.
    const rows = await db!.execute<{
      id: string
      timestamp: string | null
      user: string | null
      action: string | null
      module: string | null
      entity: string | null
      details: string | null
    }>(
      sql`(${actSelect}) UNION ALL (${audSelect}) ORDER BY timestamp DESC, id DESC LIMIT ${limit + 1}`,
    )
    const hasNext = rows.length > limit
    const pageRows = hasNext ? rows.slice(0, limit) : rows
    let nextCursor: string | null = null
    if (hasNext && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]
      if (last.timestamp && last.id) {
        const payload = { t: last.timestamp, i: last.id }
        nextCursor = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
      }
    }
    const items = pageRows.map((l) => ({
      id: l.id,
      type: activityType(l.module, l.action),
      title: `${l.action ?? 'Activity'}${l.entity && !String(l.action ?? '').includes(l.entity) ? ` · ${l.entity}` : ''}`,
      detail: l.details ?? undefined,
      actor: l.user ?? 'System',
      time: friendlyTime(l.timestamp),
      timestamp: l.timestamp,
    }))
    res.json({ items, total, nextCursor })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'dashboard activities failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Security snapshot for the dashboard widget: failed logins in the selected
// period plus active account lockouts (a point-in-time snapshot). Admin-only —
// the payload names accounts that failed to log in, so only Admin / Super
// Admin may read it; the widget hides itself for everyone else.
const SECURITY_ADMIN_ROLES = ['Admin', 'Super Admin']

dashboardRouter.get('/dashboard/security', async (req, res) => {
  if (!requireDb(res)) return
  const userId = req.userId
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }
  const perms = await computeUserPermissions(userId)
  if (!perms || !SECURITY_ADMIN_ROLES.includes(perms.role)) {
    res.status(403).json({ error: 'Admin access required' })
    return
  }
  const range = rangeFromQuery(req, res)
  if (!range) return
  try {
    // Failed logins are written by the auth stack into activity_logs
    // (recordActivity); audit_logs holds recordAudit rows (Shopify sync) and
    // legacy seeds — count and list both so nothing can be missed.
    const failedActivityWhere = and(
      sql`${schema.activityLogs.action} = 'Failed Login Attempt'`,
      gte(schema.activityLogs.timestamp, range.from),
      sql`${schema.activityLogs.timestamp} < ${range.to}`,
    )
    const failedAuditWhere = and(
      sql`${schema.auditLogs.action} = 'Failed Login Attempt'`,
      gte(schema.auditLogs.timestamp, range.from),
      sql`${schema.auditLogs.timestamp} < ${range.to}`,
    )
    // Locked = the install's configured threshold (Settings → Security →
    // Login lockout) AND the lockout window still open — the same rule
    // checkLockout() applies at login (routes/auth.ts); a stale row whose
    // window has lapsed no longer reads as a locked account here, and when
    // lockout is off nothing is enforced, so the widget reports zero.
    const policy = await getLockoutPolicy()
    const lockCutoff = new Date(Date.now() - policy.durationMs).toISOString()
    const [failedActivity, failedAudit, locked, recentActivity, recentAudit] = await Promise.all([
      db!.select({ n: sql<number>`count(*)` }).from(schema.activityLogs).where(failedActivityWhere),
      db!.select({ n: sql<number>`count(*)` }).from(schema.auditLogs).where(failedAuditWhere),
      policy.enabled
        ? db!.select({ n: sql<number>`count(*)` }).from(schema.loginAttempts).where(
            and(
              gte(schema.loginAttempts.count, policy.threshold),
              gte(schema.loginAttempts.lastAttempt, lockCutoff),
            ),
          )
        : Promise.resolve([{ n: 0 }]),
      db!
        .select({ entity: schema.activityLogs.entity, details: schema.activityLogs.details, timestamp: schema.activityLogs.timestamp })
        .from(schema.activityLogs)
        .where(failedActivityWhere)
        .orderBy(desc(schema.activityLogs.timestamp))
        .limit(5),
      db!
        .select({ entity: schema.auditLogs.entity, details: schema.auditLogs.changes, timestamp: schema.auditLogs.timestamp })
        .from(schema.auditLogs)
        .where(failedAuditWhere)
        .orderBy(desc(schema.auditLogs.timestamp))
        .limit(5),
    ])
    const recent = [...recentActivity, ...recentAudit].sort(newestFirst).slice(0, 5)
    res.json({
      failedLogins: Number(failedActivity[0]?.n ?? 0) + Number(failedAudit[0]?.n ?? 0),
      lockedAccounts: Number(locked[0]?.n ?? 0),
      recent,
    })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'dashboard security failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

dashboardRouter.get('/dashboard/analytics', async (req, res) => {
  if (!requireDb(res)) return
  const range = rangeFromQuery(req, res)
  if (!range) return
  try {
    // Period aggregates computed in SQL, compared with the equivalent previous window.
    // Cost and revenue are both restricted to invoices that carry the app's
    // cost basis (silver_value + making_charge), so the margin never pairs the
    // full period's sales with a subset of its costs.
    const agg = async (from: string, to: string) => {
      const rows = await db!
        .select({
          sales: sql<number>`coalesce(sum(grand_total), 0)`,
          count: sql<number>`count(*)`,
          cost: sql<number>`coalesce(sum(coalesce(silver_value, 0) + coalesce(making_charge, 0)) filter (where silver_value is not null and making_charge is not null), 0)`,
          costedSales: sql<number>`coalesce(sum(grand_total) filter (where silver_value is not null and making_charge is not null), 0)`,
          costedCount: sql<number>`count(*) filter (where silver_value is not null and making_charge is not null)`,
        })
        .from(schema.salesInvoices)
        .where(and(gte(schema.salesInvoices.date, from), sql`${schema.salesInvoices.date} < ${to}`, NOT_VOIDED, NOT_FOREIGN_SHOPIFY))
      const r = rows[0]
      return { sales: num(r.sales), count: Number(r.count), cost: num(r.cost), costedSales: num(r.costedSales), costedCount: Number(r.costedCount) }
    }

    const [cur, prev, curTotals, prevTotals, invRows] = await Promise.all([
      agg(range.from, range.to),
      agg(range.prevFrom, range.prevTo),
      salesTotals(range),
      salesTotals({ ...range, from: range.prevFrom, to: range.prevTo }),
      db!.select({ value: sql<number>`coalesce(sum(coalesce(stock, 0) * coalesce(selling_price, 0)), 0)` }).from(schema.products),
    ])

    // Same sales ledger as the KPI and the Sales Overview: net revenue, the
    // order rows behind it, and the same return figure.
    const curSales = curTotals.revenue
    const prevSales = prevTotals.revenue
    const inventoryValue = num(invRows[0]?.value)
    // Return rate is returns over gross sales (net + returns), so it can never
    // exceed 100% just because returns exceeded the net figure.
    const grossSales = round2(curTotals.revenue + curTotals.returns)
    const returnRate = grossSales > 0 ? (curTotals.returns / grossSales) * 100 : 0
    const aov = curTotals.orders > 0 ? curSales / curTotals.orders : 0
    const prevAov = prevTotals.orders > 0 ? prevSales / prevTotals.orders : 0
    // Margin needs a cost basis; without one it reads N/A, never 100%.
    // Both sides come from the costed invoice subset (returns are reported by
    // the separate Return Rate card), so the ratio stays internally consistent.
    const curMargin = cur.costedCount > 0 && cur.costedSales > 0 ? (cur.costedSales - cur.cost) / cur.costedSales : null
    const prevMargin = prev.costedCount > 0 && prev.costedSales > 0 ? (prev.costedSales - prev.cost) / prev.costedSales : null

    const salesCmp = compare(curSales, prevSales)
    const orderCmp = compare(curTotals.orders, prevTotals.orders)
    const aovCmp = compare(aov, prevAov)
    const marginCmp =
      curMargin == null || prevMargin == null
        ? { trend: 'flat' as const, delta: '—' }
        : { trend: curMargin >= prevMargin ? ('up' as const) : ('down' as const), delta: `${round2((curMargin - prevMargin) * 100)} pts` }

    res.json([
      { label: 'Total Sales', value: inr(curSales), delta: salesCmp.delta, trend: salesCmp.trend, rangeLabel: range.label, prevLabel: range.prevLabel },
      { label: 'Total Orders', value: String(curTotals.orders), delta: orderCmp.delta, trend: orderCmp.trend, rangeLabel: range.label, prevLabel: range.prevLabel },
      { label: 'Average Order Value', value: inr(aov), delta: aovCmp.delta, trend: aovCmp.trend, rangeLabel: range.label, prevLabel: range.prevLabel },
      { label: 'Return Rate', value: `${round2(returnRate)}%`, rangeLabel: range.label },
      { label: 'Gross Profit Margin', value: curMargin == null ? 'N/A' : `${round2(curMargin * 100)}%`, delta: marginCmp.delta, trend: marginCmp.trend, rangeLabel: range.label, prevLabel: range.prevLabel },
      { label: 'Inventory Value', value: inr(inventoryValue) },
    ])
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dashboardRouter.get('/dashboard/inventory-overview', async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const products = await db!.select().from(schema.products)
    res.json({
      totalProducts: products.length,
      totalQuantity: products.reduce((a, p) => a + num(p.stock), 0),
      totalWeight: round2(products.reduce((a, p) => a + num(p.stock) * num(p.netWeight), 0)),
      inventoryValue: round2(products.reduce((a, p) => a + num(p.stock) * num(p.sellingPrice), 0)),
      lowStock: products.filter((p) => p.trackInventory && p.stock != null && num(p.stock) <= (p.reorderLevel ?? DEFAULT_REORDER_LEVEL)).length,
      outOfStock: products.filter((p) => num(p.stock) === 0).length,
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL ANALYTICS: net revenue, income vs expense, top expense (range-aware)
// ─────────────────────────────────────────────────────────────────────────────

dashboardRouter.get('/dashboard/financial', async (req, res) => {
  if (!requireDb(res)) return
  // The Financial Analytics section owns its range (default Last 12 Months)
  // and is independent of the page-wide filter.
  const range = rangeFromQuery(req, res, 'last12m')
  if (!range) return
  try {
    // Expenses grouped by category for the window: total/count for the
    // income-vs-expense tile, top categories for the "Top Expense" tile.
    // One extra row beyond the display cap lets us fold the remainder into
    // "Other" so the slices always sum to the window total.
    const expenseAgg = async (from: string, to: string) => {
      const inWindow = and(gte(schema.expenses.date, from), sql`${schema.expenses.date} < ${to}`)
      const [agg, cats] = await Promise.all([
        db!
          .select({ total: sql<number>`coalesce(sum(coalesce(amount, 0)), 0)`, count: sql<number>`count(*)` })
          .from(schema.expenses)
          .where(inWindow),
        db!
          .select({
            category: sql<string>`coalesce(nullif(${schema.expenses.category}, ''), 'Other')`,
            amount: sql<number>`coalesce(sum(coalesce(${schema.expenses.amount}, 0)), 0)`,
          })
          .from(schema.expenses)
          .where(inWindow)
          .groupBy(sql`coalesce(nullif(${schema.expenses.category}, ''), 'Other')`)
          .orderBy(sql`coalesce(sum(coalesce(${schema.expenses.amount}, 0)), 0) desc`)
          .limit(7),
      ])
      return { total: num(agg[0]?.total), count: Number(agg[0]?.count ?? 0), cats }
    }

    const bucketFmt = range.bucket === 'hour' ? 'HH24' : range.bucket === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'
    const [curTotals, prevTotals, curExp, prevExp, ledger, expMap, invTotals, openRows, paidRows] = await Promise.all([
      salesTotals(range),
      salesTotals({ ...range, from: range.prevFrom, to: range.prevTo }),
      expenseAgg(range.from, range.to),
      expenseAgg(range.prevFrom, range.prevTo),
      salesLedgerBuckets(bucketFmt, range),
      expenseBuckets(bucketFmt, range),
      // Point-in-time receivables below: no range predicates on purpose.
      db!.select({ total: sql<number>`coalesce(sum(grand_total), 0)`, count: sql<number>`count(*)` })
        .from(schema.salesInvoices)
        .where(and(NOT_VOIDED, NOT_FOREIGN_SHOPIFY)),
      db!
        .select({
          number: schema.salesInvoices.number,
          grandTotal: schema.salesInvoices.grandTotal,
          dueDate: schema.salesInvoices.dueDate,
          date: schema.salesInvoices.date,
          status: schema.salesInvoices.status,
          paymentStatus: schema.salesInvoices.paymentStatus,
        })
        .from(schema.salesInvoices)
        .where(and(OUTSTANDING_WHERE, NOT_VOIDED, NOT_FOREIGN_SHOPIFY)),
      db!
        .select({ invoice: schema.payments.invoice, paid: sql<number>`coalesce(sum(coalesce(amount, 0)), 0)` })
        .from(schema.payments)
        .where(and(
          sql`coalesce(${schema.payments.amount}, 0) > 0`,
          sql`lower(coalesce(${schema.payments.status}, '')) in ('success', 'settled', 'paid')`,
        ))
        .groupBy(schema.payments.invoice),
    ])

    // Net revenue is the shared ledger figure — the same number the Sales KPI,
    // the Sales Overview cards and its graph show for this range.
    const netRevenue = curTotals.revenue
    const prevNetRevenue = prevTotals.revenue
    const netCmp = compare(netRevenue, prevNetRevenue)
    const expCmp = compare(curExp.total, prevExp.total)

    // Per-bucket series for the charts: each point is the ledger's net revenue
    // for that bucket, so the points always sum back to the headline figure.
    const points = enumerateBuckets(range).map((b) => ({
      key: b.key,
      label: b.label,
      date: b.date,
      income: round2(num(ledger.get(b.key)?.revenue)),
      expense: round2(expMap.get(b.key) ?? 0),
    }))

    // Expense slices for the donut: top 5 categories, remainder folded into
    // "Other" so shares always add up to the window's expense total.
    const rawCats = curExp.cats.map((c) => ({ category: c.category, amount: round2(num(c.amount)) }))
    const cappedCats = rawCats.length > 6
      ? [...rawCats.slice(0, 5), { category: 'Other', amount: round2(Math.max(0, curExp.total - rawCats.slice(0, 5).reduce((a, c) => a + c.amount, 0))) }]
      : rawCats
    const slices = cappedCats.map((c) => ({
      category: c.category,
      amount: c.amount,
      share: curExp.total > 0 ? round2((c.amount / curExp.total) * 100) : 0,
    }))

    // ── Receivable Summary (as of now, ignores the range) ──────────────────
    // Outstanding = the unpaid part of every open invoice (unpaid or partly
    // paid), excluding voided/cancelled ones. Aging bands are days past the
    // effective due date: invoices without a due date fall back to invoice
    // date + 30 days (the app has no payment-terms field to read).
    const invoicedTotal = num(invTotals[0]?.total)
    const invoicedCount = Number(invTotals[0]?.count ?? 0)
    const paidByInvoice = new Map(paidRows.map((r) => [r.invoice ?? '', num(r.paid)]))
    const nowDay = localDayStart(0)
    const today = new Date(nowDay.replace('T', ' '))
    const DAY = 86400000
    const AGING_BANDS = [
      { key: 'current', label: 'Current' },
      { key: 'over30', label: '>30 Days' },
      { key: 'over60', label: '>60 Days' },
      { key: 'over90', label: '>90 Days' },
      { key: 'over120', label: '>120 Days' },
      { key: 'older', label: 'Older' },
    ] as const
    const aging = AGING_BANDS.map((b) => ({ key: b.key, label: b.label, value: 0, count: 0 }))
    let outstanding = 0
    for (const row of openRows) {
      const unpaid = Math.max(0, num(row.grandTotal) - collectedAmount(row, paidByInvoice))
      outstanding += unpaid
      // Effective due date: real due date, else invoice date + 30 days (the
      // settings table has no payment-terms field), else today = not overdue.
      let due = parseNaive(row.dueDate)
      if (!due) {
        const invoiceDate = parseNaive(row.date)
        if (invoiceDate) {
          invoiceDate.setDate(invoiceDate.getDate() + 30)
          due = invoiceDate
        }
      }
      if (!due) due = new Date(today)
      const overdueDays = Math.floor((today.getTime() - due.getTime()) / DAY)
      const bandIdx = overdueDays <= 30 ? 0 : overdueDays <= 60 ? 1 : overdueDays <= 90 ? 2 : overdueDays <= 120 ? 3 : overdueDays <= 365 ? 4 : 5
      aging[bandIdx].value = round2(aging[bandIdx].value + unpaid)
      aging[bandIdx].count += 1
    }
    outstanding = round2(outstanding)

    res.json({
      label: range.label,
      prevLabel: range.prevLabel,
      // Gross sales = net revenue + returns, so the tile caption reconciles
      // with the headline even when uninvoiced ERP orders add revenue.
      sales: round2(curTotals.revenue + curTotals.returns),
      returns: round2(curTotals.returns),
      invoiceCount: curTotals.invoiceCount,
      netRevenue: round2(netRevenue),
      netRevenueDelta: netCmp.delta,
      netRevenueTrend: netCmp.trend,
      income: round2(netRevenue),
      expense: round2(curExp.total),
      expenseCount: curExp.count,
      expenseDelta: expCmp.delta,
      expenseTrend: expCmp.trend,
      // Operating result for the window: net revenue less recorded expenses.
      // COGS is not part of this figure (that basis lives on the Profit page).
      net: round2(netRevenue - curExp.total),
      expenses: slices,
      topExpense: slices.length > 0 ? slices[0] : null,
      points,
      receivable: {
        paid: round2(Math.max(0, invoicedTotal - outstanding)),
        outstanding,
        invoicedTotal: round2(invoicedTotal),
        invoiceCount: invoicedCount,
        aging,
      },
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// RECEIVABLES AGING: outstanding balance bucketed by invoice due date
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a stored naive timestamp ('YYYY-MM-DD' or with a time part). */
function parseNaive(s: string | null): Date | null {
  if (!s) return null
  const body = s.includes('T') ? s : s.replace(' ', 'T')
  const d = new Date(body)
  return Number.isNaN(d.getTime()) ? null : d
}

dashboardRouter.get('/dashboard/aging', async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const today = localDayStart(0)
    // Open invoices only (never voided/cancelled — OUTSTANDING_WHERE alone can
    // still match a cancelled invoice whose payment_status lingers at
    // 'pending'), value net of successful payments so a part-paid invoice
    // contributes only its unpaid remainder. Same basis as the Receivable
    // Summary; bucket membership still comes from the due date.
    const [openRows, paidRows] = await Promise.all([
      db!
        .select({
          number: schema.salesInvoices.number,
          grandTotal: schema.salesInvoices.grandTotal,
          dueDate: schema.salesInvoices.dueDate,
          status: schema.salesInvoices.status,
          paymentStatus: schema.salesInvoices.paymentStatus,
        })
        .from(schema.salesInvoices)
        .where(and(OUTSTANDING_WHERE, NOT_VOIDED, NOT_FOREIGN_SHOPIFY)),
      db!
        .select({ invoice: schema.payments.invoice, paid: sql<number>`coalesce(sum(coalesce(amount, 0)), 0)` })
        .from(schema.payments)
        .where(and(
          sql`coalesce(${schema.payments.amount}, 0) > 0`,
          sql`lower(coalesce(${schema.payments.status}, '')) in ('success', 'settled', 'paid')`,
        ))
        .groupBy(schema.payments.invoice),
    ])
    const paidByInvoice = new Map(paidRows.map((r) => [r.invoice ?? '', num(r.paid)]))
    const todayDate = new Date(today.replace('T', ' '))
    const day30 = new Date(todayDate.getTime() - 30 * 86400000)
    const day60 = new Date(todayDate.getTime() - 60 * 86400000)

    const buckets = [
      { key: 'current', label: 'Current / Not yet due', value: 0, count: 0 },
      { key: 'd1_30', label: '1–30 days overdue', value: 0, count: 0 },
      { key: 'd31_60', label: '31–60 days overdue', value: 0, count: 0 },
      { key: 'd60plus', label: '60+ days overdue', value: 0, count: 0 },
    ]
    let total = 0
    let overdueTotal = 0
    let overdueCount = 0
    for (const row of openRows) {
      const unpaid = Math.max(0, num(row.grandTotal) - collectedAmount(row, paidByInvoice))
      total += unpaid
      const due = parseNaive(row.dueDate)
      if (!due || due > todayDate) {
        buckets[0].value += unpaid
        buckets[0].count += 1
      } else {
        overdueTotal += unpaid
        overdueCount += 1
        const band = due > day30 ? 1 : due > day60 ? 2 : 3
        buckets[band].value += unpaid
        buckets[band].count += 1
      }
    }

    res.json({
      buckets: buckets.map((b) => ({ ...b, value: round2(b.value) })),
      total: round2(total),
      invoiceCount: openRows.length,
      overdueTotal: round2(overdueTotal),
      overdueCount,
    })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'dashboard aging failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Per-bucket drill-down for the receivables aging widget: the invoices behind
// each bucket, oldest due date first (50 rows max).
dashboardRouter.get('/dashboard/aging/invoices', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const bucket = String(req.query.bucket ?? 'current')
    const today = localDayStart(0)
    const predicates: Record<string, SQL> = {
      current: sql`(${schema.salesInvoices.dueDate} is null or ${schema.salesInvoices.dueDate} > ${today})`,
      d1_30: sql`${schema.salesInvoices.dueDate} is not null and ${schema.salesInvoices.dueDate} <= ${today} and ${schema.salesInvoices.dueDate} > (${today}::timestamp - interval '30 days')`,
      d31_60: sql`${schema.salesInvoices.dueDate} is not null and ${schema.salesInvoices.dueDate} <= (${today}::timestamp - interval '30 days') and ${schema.salesInvoices.dueDate} > (${today}::timestamp - interval '60 days')`,
      d60plus: sql`${schema.salesInvoices.dueDate} is not null and ${schema.salesInvoices.dueDate} <= (${today}::timestamp - interval '60 days')`,
    }
    const predicate = predicates[bucket]
    if (!predicate) return res.status(400).json({ error: 'Unknown bucket' })

    const [rows, paidRows] = await Promise.all([
      db!
        .select({
          id: schema.salesInvoices.id,
          number: schema.salesInvoices.number,
          customer: schema.salesInvoices.customer,
          date: schema.salesInvoices.date,
          dueDate: schema.salesInvoices.dueDate,
          grandTotal: schema.salesInvoices.grandTotal,
          paymentStatus: schema.salesInvoices.paymentStatus,
          status: schema.salesInvoices.status,
          daysOverdue: sql<number>`greatest(0, floor(extract(epoch from (${today}::timestamp - ${schema.salesInvoices.dueDate})) / 86400))::int`,
        })
        .from(schema.salesInvoices)
        .where(and(OUTSTANDING_WHERE, NOT_VOIDED, NOT_FOREIGN_SHOPIFY, predicate))
        .orderBy(sql`${schema.salesInvoices.dueDate} asc nulls last`, sql`${schema.salesInvoices.number} asc`)
        .limit(50),
      // Same paid basis as the bucket totals, so a row's amount always adds
      // back up to the bucket it was expanded from.
      db!
        .select({ invoice: schema.payments.invoice, paid: sql<number>`coalesce(sum(coalesce(amount, 0)), 0)` })
        .from(schema.payments)
        .where(and(
          sql`coalesce(${schema.payments.amount}, 0) > 0`,
          sql`lower(coalesce(${schema.payments.status}, '')) in ('success', 'settled', 'paid')`,
        ))
        .groupBy(schema.payments.invoice),
    ])
    const paidByInvoice = new Map(paidRows.map((r) => [r.invoice ?? '', num(r.paid)]))

    res.json({
      bucket,
      invoices: rows.map((r) => ({
        id: r.id,
        number: r.number,
        customer: r.customer ?? '',
        date: r.date,
        dueDate: r.dueDate,
        grandTotal: round2(num(r.grandTotal)),
        outstanding: round2(Math.max(0, num(r.grandTotal) - collectedAmount(r, paidByInvoice))),
        paymentStatus: r.paymentStatus ?? '',
        status: r.status ?? '',
        daysOverdue: r.dueDate ? Number(r.daysOverdue ?? 0) : 0,
      })),
    })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown error' }, 'dashboard aging drill-down failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// PROFIT ANALYTICS: owner-level profit trends, best sellers, expenses netting
// ─────────────────────────────────────────────────────────────────────────────

dashboardRouter.get('/dashboard/profit', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const months = Math.min(24, Math.max(3, Number(req.query.months) || 12))

    // Build the last N months (oldest first) keyed by YYYY-MM in IST
    const monthKeys: string[] = []
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date()
      d.setDate(1)
      d.setMonth(d.getMonth() - i)
      monthKeys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`)
    }
    // Aggregated in SQL: monthly revenue/COGS, returns, purchases and the
    // expense breakdown are grouped server-side, so the profit report no
    // longer scans every invoice, expense and purchase row in JS.
    const firstMonth = `${monthKeys[0]}-01T00:00:00`
    const lastMonth = monthKeys[monthKeys.length - 1]
    const invoiceMonth = sql<string>`to_char(${schema.salesInvoices.date}, 'YYYY-MM')`
    const returnMonth = sql<string>`to_char(${schema.salesReturns.date}, 'YYYY-MM')`
    const expenseMonth = sql<string>`to_char(${schema.expenses.date}, 'YYYY-MM')`
    const purchaseMonth = sql<string>`to_char(${schema.purchaseInvoices.date}, 'YYYY-MM')`

    const [invoiceRows, returnRows, expenseRows, purchaseRows] = await Promise.all([
      db!
        .select({
          m: invoiceMonth,
          revenue: sql<number>`coalesce(sum(grand_total), 0)`,
          cogs: sql<number>`coalesce(sum(coalesce(silver_value, 0) + coalesce(making_charge, 0)), 0)`,
          count: sql<number>`count(*)`,
        })
        .from(schema.salesInvoices)
        .where(and(gte(schema.salesInvoices.date, firstMonth), sql`${invoiceMonth} <= ${lastMonth}`))
        .groupBy(invoiceMonth),
      db!
        .select({ m: returnMonth, amount: sql<number>`coalesce(sum(coalesce(amount, 0)), 0)` })
        .from(schema.salesReturns)
        .where(gte(schema.salesReturns.date, firstMonth))
        .groupBy(returnMonth),
      db!
        .select({
          m: expenseMonth,
          category: sql<string>`coalesce(${schema.expenses.category}, 'Other')`,
          amount: sql<number>`coalesce(sum(coalesce(amount, 0)), 0)`,
        })
        .from(schema.expenses)
        .where(gte(schema.expenses.date, firstMonth))
        .groupBy(expenseMonth, sql`coalesce(${schema.expenses.category}, 'Other')`),
      db!
        .select({ m: purchaseMonth, cost: sql<number>`coalesce(sum(coalesce(cost, 0)), 0)` })
        .from(schema.purchaseInvoices)
        .where(gte(schema.purchaseInvoices.date, firstMonth))
        .groupBy(purchaseMonth),
    ])

    const invoicesByMonth = new Map(invoiceRows.map((r) => [String(r.m ?? ''), r]))
    const returnsByMonth = new Map(returnRows.map((r) => [String(r.m ?? ''), num(r.amount)]))
    const purchasesByMonth = new Map(purchaseRows.map((r) => [String(r.m ?? ''), num(r.cost)]))
    const expensesByMonth = new Map<string, number>()
    const expenseByCategory = new Map<string, number>()
    for (const e of expenseRows) {
      const m = String(e.m ?? '')
      expensesByMonth.set(m, (expensesByMonth.get(m) ?? 0) + num(e.amount))
      const cat = e.category ?? 'Other'
      expenseByCategory.set(cat, (expenseByCategory.get(cat) ?? 0) + num(e.amount))
    }

    const monthly = monthKeys.map((m) => {
      const inv = invoicesByMonth.get(m)
      const revenue = num(inv?.revenue) - (returnsByMonth.get(m) ?? 0)
      const cogs = num(inv?.cogs)
      const exp = expensesByMonth.get(m) ?? 0
      const purchases = purchasesByMonth.get(m) ?? 0
      return {
        month: m,
        revenue: round2(revenue),
        cogs: round2(cogs),
        grossProfit: round2(revenue - cogs),
        grossMargin: revenue > 0 ? round2(((revenue - cogs) / revenue) * 100) : 0,
        expenses: round2(exp),
        purchases: round2(purchases),
        netProfit: round2(revenue - cogs - exp),
        invoices: Number(inv?.count ?? 0),
      }
    })

    // Best sellers by profit contribution: grouped in SQL over all invoice
    // items (key = SKU when present, else the product name); item profit is
    // amount minus metal value (weight × rate).
    const itemKey = sql<string>`coalesce(nullif(${schema.salesInvoiceItems.sku}, ''), ${schema.salesInvoiceItems.product}, '')`
    const itemProfit = sql<number>`coalesce(sum(coalesce(${schema.salesInvoiceItems.amount}, 0) - coalesce(${schema.salesInvoiceItems.weight}, 0) * coalesce(${schema.salesInvoiceItems.silverRate}, 0)), 0)`
    const bestSellerRows = await db!
      .select({
        sku: itemKey,
        name: sql<string>`coalesce(max(${schema.salesInvoiceItems.product}), max(${schema.salesInvoiceItems.sku}), '')`,
        qty: sql<number>`coalesce(sum(coalesce(${schema.salesInvoiceItems.qty}, 0)), 0)`,
        revenue: sql<number>`coalesce(sum(coalesce(${schema.salesInvoiceItems.amount}, 0)), 0)`,
        profit: itemProfit,
      })
      .from(schema.salesInvoiceItems)
      .where(sql`${itemKey} <> ''`)
      .groupBy(itemKey)
      .orderBy(sql`${itemProfit} desc`)
      .limit(10)
    const bestSellers = bestSellerRows.map((r) => ({
      sku: r.sku,
      name: r.name,
      qty: num(r.qty),
      revenue: round2(num(r.revenue)),
      profit: round2(num(r.profit)),
    }))

    // Expense breakdown for the period (already grouped by month + category)
    const expenseBreakdown = [...expenseByCategory.entries()]
      .map(([category, amount]) => ({ category, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount)

    const totals = monthly.reduce(
      (acc, m) => ({
        revenue: acc.revenue + m.revenue,
        grossProfit: acc.grossProfit + m.grossProfit,
        expenses: acc.expenses + m.expenses,
        netProfit: acc.netProfit + m.netProfit,
      }),
      { revenue: 0, grossProfit: 0, expenses: 0, netProfit: 0 },
    )

    res.json({
      months: monthly,
      totals: {
        revenue: round2(totals.revenue),
        grossProfit: round2(totals.grossProfit),
        expenses: round2(totals.expenses),
        netProfit: round2(totals.netProfit),
        grossMargin: totals.revenue > 0 ? round2((totals.grossProfit / totals.revenue) * 100) : 0,
      },
      bestSellers,
      expenseBreakdown,
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dashboardRouter.get('/dashboard/stock-categories', async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!
      .select({
        category: schema.products.category,
        products: sql<number>`count(*)::int`,
        qty: sql<number>`coalesce(sum(stock),0)::int`,
        weight: sql<number>`coalesce(sum(stock * coalesce(net_weight,0)),0)`,
        value: sql<number>`coalesce(sum(stock * coalesce(selling_price,0)),0)`,
      })
      .from(schema.products)
      .where(and(ne(schema.products.category, '')))
      .groupBy(schema.products.category)
    res.json(rows.sort((a, b) => b.qty - a.qty))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Product-level profit margins: revenue vs metal-value cost per SKU, with margin %
dashboardRouter.get('/reports/product-margins', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const months = Math.min(24, Math.max(1, Number(req.query.months) || 12))
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - months)

    const itemRows = await db!
      .select({
        sku: schema.salesInvoiceItems.sku,
        product: schema.salesInvoiceItems.product,
        qty: schema.salesInvoiceItems.qty,
        amount: schema.salesInvoiceItems.amount,
        weight: schema.salesInvoiceItems.weight,
        silverRate: schema.salesInvoiceItems.silverRate,
        makingCharge: schema.salesInvoiceItems.makingCharge,
        invoiceDate: schema.salesInvoices.date,
      })
      .from(schema.salesInvoiceItems)
      .innerJoin(schema.salesInvoices, eq(schema.salesInvoiceItems.invoiceId, schema.salesInvoices.id))

    const bySku = new Map<string, { name: string; qty: number; revenue: number; cost: number }>()
    for (const it of itemRows) {
      const key = String(it.sku ?? it.product ?? '')
      if (!key) continue
      if (it.invoiceDate && new Date(String(it.invoiceDate)) < cutoff) continue
      const entry = bySku.get(key) ?? { name: String(it.product ?? key), qty: 0, revenue: 0, cost: 0 }
      entry.qty += num(it.qty)
      entry.revenue += num(it.amount)
      // Cost basis = metal value (weight × rate); making charge is revenue-generating labour
      entry.cost += num(it.weight) * num(it.silverRate)
      bySku.set(key, entry)
    }

    const rows = [...bySku.entries()]
      .map(([sku, v]) => ({
        sku,
        name: v.name,
        qty: v.qty,
        revenue: round2(v.revenue),
        cost: round2(v.cost),
        profit: round2(v.revenue - v.cost),
        marginPct: v.revenue > 0 ? round2(((v.revenue - v.cost) / v.revenue) * 100) : 0,
      }))
      .sort((a, b) => b.profit - a.profit)

    const totalRevenue = round2(rows.reduce((a, r) => a + r.revenue, 0))
    const totalProfit = round2(rows.reduce((a, r) => a + r.profit, 0))
    res.json({
      months,
      rows,
      totals: {
        revenue: totalRevenue,
        cost: round2(rows.reduce((a, r) => a + r.cost, 0)),
        profit: totalProfit,
        marginPct: totalRevenue > 0 ? round2((totalProfit / totalRevenue) * 100) : 0,
      },
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dashboardRouter.get('/reports/gst', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const monthParam = Number(req.query.month)
    const target = Number.isFinite(monthParam) && monthParam >= 1 && monthParam <= 12 ? monthParam : new Date().getMonth() + 1
    const yearParam = Number(req.query.year)
    const year = Number.isFinite(yearParam) && yearParam >= 2000 && yearParam <= 2200 ? yearParam : new Date().getFullYear()
    const prefix = `${year}-${pad(target)}`

    // Aggregated in SQL: the month's B2B/B2C split (the business-name regex
    // runs in Postgres), the 6-month output-GST chart and the filing statuses
    // all come from grouped queries instead of loading every invoice in JS.
    const monthCond = sql`${schema.salesInvoices.date}::text like ${prefix + '%'}`
    const businessCond = sql`coalesce(${schema.salesInvoices.customer}, '') ~* ${BUSINESS_NAME_RE}`
    const taxableAgg = sql<number>`coalesce(sum(coalesce(subtotal, 0) - coalesce(discount, 0)), 0)`
    const gstAgg = sql<number>`coalesce(sum(coalesce(gst_amount, 0)), 0)`
    const monthAgg = async (extra: SQL | undefined) => {
      const aggRows = await db!
        .select({ taxable: taxableAgg, gst: gstAgg, count: sql<number>`count(*)` })
        .from(schema.salesInvoices)
        .where(extra)
      const r = aggRows[0]
      return { taxable: num(r.taxable), gst: num(r.gst), count: Number(r.count) }
    }

    const now = new Date()
    const sixMonthStartDate = new Date(now.getFullYear(), now.getMonth() - 5, 1)
    const threeMonthStartDate = new Date(now.getFullYear(), now.getMonth() - 2, 1)
    const sixMonthStart = `${sixMonthStartDate.getFullYear()}-${pad(sixMonthStartDate.getMonth() + 1)}-01T00:00:00`
    const threeMonthStart = `${threeMonthStartDate.getFullYear()}-${pad(threeMonthStartDate.getMonth() + 1)}-01T00:00:00`
    const invoiceMonth = sql<string>`to_char(${schema.salesInvoices.date}, 'YYYY-MM')`

    const [all, b2b, b2c, noteRows, nilRows, purchaseRows, monthlyRows, filingRows] = await Promise.all([
      monthAgg(monthCond),
      monthAgg(and(monthCond, businessCond)),
      monthAgg(and(monthCond, sql`not (${businessCond})`)),
      db!.select({ n: sql<number>`count(*)` }).from(schema.salesInvoices).where(and(monthCond, sql`status in ('refunded', 'cancelled')`)),
      db!.select({ n: sql<number>`count(*)` }).from(schema.salesInvoices).where(and(monthCond, sql`coalesce(grand_total, 0) = 0`)),
      db!.select({
        tax: schema.purchaseInvoices.tax,
        cgst: schema.purchaseInvoices.cgst,
        sgst: schema.purchaseInvoices.sgst,
        igst: schema.purchaseInvoices.igst,
        tcsAmount: schema.purchaseInvoices.tcsAmount,
        tcsRate: schema.purchaseInvoices.tcsRate,
        status: schema.purchaseInvoices.status,
      }).from(schema.purchaseInvoices).where(sql`${schema.purchaseInvoices.date}::text like ${prefix + '%'}`).limit(10000),
      db!.select({ m: invoiceMonth, gst: gstAgg }).from(schema.salesInvoices).where(gte(schema.salesInvoices.date, sixMonthStart)).groupBy(invoiceMonth),
      db!.select({ m: invoiceMonth, n: sql<number>`count(*)` }).from(schema.salesInvoices).where(gte(schema.salesInvoices.date, threeMonthStart)).groupBy(invoiceMonth),
    ])

    const taxable = all.taxable
    const outputGst = all.gst
    // Input credit uses the CGST/SGST/IGST split where the supplier GSTIN is on
    // file and ignores cancelled invoices; TCS is a separate liability.
    const inputGst = computeInputGst(purchaseRows)
    const tcs = computeTcs(purchaseRows)
    const netGst = Math.max(0, round2(outputGst - inputGst))
    const itcUtilised = round2(Math.min(inputGst, outputGst))

    const gstByMonth = new Map(monthlyRows.map((r) => [String(r.m ?? ''), num(r.gst)]))
    const months: { label: string; gst: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const p = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
      months.push({ label: d.toLocaleDateString('en-IN', { month: 'short' }), gst: round2(gstByMonth.get(p) ?? 0) })
    }

    const monthsWithInvoices = new Set(filingRows.filter((r) => Number(r.n) > 0).map((r) => String(r.m ?? '')))
    const filingMonths: { month: string; status: string; variant: 'warning' | 'success' | 'muted' }[] = []
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
      const label = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
      const hasInvoices = monthsWithInvoices.has(key)
      filingMonths.push({ month: label, status: i === 0 ? 'In Progress' : hasInvoices ? 'Filed' : 'No Data', variant: i === 0 ? 'warning' : hasInvoices ? 'success' : 'muted' })
    }

    res.json({
      summary: { taxable: round2(taxable), outputGst: round2(outputGst), inputGst: round2(inputGst), netGst, itcUtilised, tcs, cgst: round2(netGst / 2), sgst: round2(netGst / 2) },
      gstr1: {
        b2b: { invoices: b2b.count, taxable: round2(b2b.taxable) },
        b2c: { invoices: b2c.count, taxable: round2(b2c.taxable) },
        exports: { invoices: 0, taxable: 0 },
        notes: { invoices: Number(noteRows[0]?.n ?? 0), taxable: 0 },
        nilRated: { invoices: Number(nilRows[0]?.n ?? 0), taxable: 0 },
      },
      monthly: months,
      filing: filingMonths,
      gstin: CONSTANTS.GSTIN_DEFAULT,
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GSTR-1 style CSV export (b2b + b2c rows, one line per invoice) + JSON summary
dashboardRouter.get('/reports/gst/export', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const monthParam = Number(req.query.month)
    const target = Number.isFinite(monthParam) && monthParam >= 1 && monthParam <= 12 ? monthParam : new Date().getMonth() + 1
    const yearParam = Number(req.query.year)
    const year = Number.isFinite(yearParam) && yearParam >= 2000 && yearParam <= 2200 ? yearParam : new Date().getFullYear()
    const prefix = `${year}-${pad(target)}`
    // Only the requested month's rows are fetched (the CSV needs one row per
    // invoice), instead of loading the entire invoice table.
    const rows = await db!
      .select({
        number: schema.salesInvoices.number,
        customer: schema.salesInvoices.customer,
        date: schema.salesInvoices.date,
        subtotal: schema.salesInvoices.subtotal,
        discount: schema.salesInvoices.discount,
        gstAmount: schema.salesInvoices.gstAmount,
        grandTotal: schema.salesInvoices.grandTotal,
        status: schema.salesInvoices.status,
      })
      .from(schema.salesInvoices)
      .where(sql`${schema.salesInvoices.date}::text like ${prefix + '%'}`)

    const isBusiness = (name: string) => BUSINESS_NAME_PATTERN.test(String(name ?? ''))
    const esc = (v: unknown) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines: string[] = []
    lines.push('GSTR-1 Export,Period,' + `${prefix}`)
    lines.push('GSTIN,' + CONSTANTS.GSTIN_DEFAULT)
    lines.push('')
    lines.push('Section,GSTIN of Recipient,Receiver Name,Invoice Number,Invoice Date,Invoice Value,Taxable Value,Rate,CGST,SGST,IGST')
    for (const inv of rows) {
      if (String(inv.status) === 'cancelled' || String(inv.status) === 'refunded') continue
      const taxable = num(inv.subtotal) - num(inv.discount)
      const gst = num(inv.gstAmount)
      const ratePct = taxable > 0 ? Math.round((gst / taxable) * 100) : 0
      const section = isBusiness(String(inv.customer ?? '')) ? 'B2B' : 'B2C'
      lines.push(
        [
          section,
          '',
          esc(inv.customer),
          esc(inv.number),
          inv.date ? new Date(inv.date).toISOString().slice(0, 10) : '',
          num(inv.grandTotal).toFixed(2),
          taxable.toFixed(2),
          `${ratePct}%`,
          (gst / 2).toFixed(2),
          (gst / 2).toFixed(2),
          '0.00',
        ].join(','),
      )
    }
    lines.push('')
    const totalTaxable = rows.filter((i) => i.status !== 'cancelled' && i.status !== 'refunded').reduce((a, i) => a + num(i.subtotal) - num(i.discount), 0)
    const totalGst = rows.filter((i) => i.status !== 'cancelled' && i.status !== 'refunded').reduce((a, i) => a + num(i.gstAmount), 0)
    lines.push(`TOTAL,,,,,${round2(totalTaxable + totalGst)},${round2(totalTaxable)},,${round2(totalGst / 2)},${round2(totalGst / 2)},0.00`)

    const json = {
      gstin: CONSTANTS.GSTIN_DEFAULT,
      period: prefix,
      summary: { taxable: round2(totalTaxable), outputGst: round2(totalGst), cgst: round2(totalGst / 2), sgst: round2(totalGst / 2), invoiceCount: rows.length },
    }
    if (String(req.query.format) === 'json') {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="gstr1-${prefix}.json"`)
      return res.send(JSON.stringify(json, null, 2))
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="gstr1-${prefix}.csv"`)
    return res.send('\ufeff' + lines.join('\n'))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

dashboardRouter.get('/dashboard/stock-running', async (_req, res) => {
  if (!requireDb(res)) return
  try {
    // Velocity needs the invoice date, and must ignore cancelled invoices —
    // counting them made stock look like it sold more than it did.
    const items = await db!
      .select({
        sku: schema.salesInvoiceItems.sku,
        qty: schema.salesInvoiceItems.qty,
        date: schema.salesInvoices.date,
        status: schema.salesInvoices.status,
      })
      .from(schema.salesInvoiceItems)
      .innerJoin(schema.salesInvoices, eq(schema.salesInvoices.id, schema.salesInvoiceItems.invoiceId))

    const products = await db!.select().from(schema.products)

    const salesBySku = new Map<string, { qty: number; firstSale: number }>()
    for (const it of items) {
      const sku = String(it.sku ?? '').toLowerCase()
      if (!sku) continue
      if (String(it.status ?? '').toLowerCase() === 'cancelled') continue
      const soldAt = it.date ? new Date(String(it.date)).getTime() : NaN
      const entry = salesBySku.get(sku) ?? { qty: 0, firstSale: Number.POSITIVE_INFINITY }
      entry.qty += num(it.qty)
      if (!Number.isNaN(soldAt) && soldAt < entry.firstSale) entry.firstSale = soldAt
      salesBySku.set(sku, entry)
    }

    const now = Date.now()
    const msPerDay = 86400000
    // Cap the window so a slow starter doesn't drag the average down forever,
    // while still giving a recent product a window proportional to its life.
    const MAX_WINDOW_DAYS = 180

    const results = products.map((p) => {
      const sku = String(p.sku ?? '').toLowerCase()
      const entry = salesBySku.get(sku)
      const totalSold = entry?.qty ?? 0
      // Measure demand over the period the product has actually been selling,
      // not since the row was created. A product listed two years ago and selling
      // steadily every week was being reported as near-dead.
      const activeDays =
        entry && Number.isFinite(entry.firstSale)
          ? Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor((now - entry.firstSale) / msPerDay)))
          : MAX_WINDOW_DAYS
      const avgDailySales = totalSold / activeDays
      const stock = num(p.stock)
      const daysOfStock = avgDailySales > 0 ? Math.round(stock / avgDailySales) : 999
      const demandLevel: 'high' | 'medium' | 'low' | 'none' = avgDailySales >= 2 ? 'high' : avgDailySales >= 0.5 ? 'medium' : avgDailySales > 0 ? 'low' : 'none'
      const stockValue = round2(stock * num(p.sellingPrice))
      // Inventory value is what the stock cost, not what it would sell for.
      // Both are reported so margin on hand is visible too.
      const stockValueAtCost = round2(stock * num(p.costPrice))
      const potentialMargin = round2(stockValue - stockValueAtCost)
      const marginPct = stockValue > 0 ? round2((potentialMargin / stockValue) * 100) : 0

      return {
        id: p.id,
        name: p.name,
        sku: p.sku ?? '',
        category: p.category ?? '',
        currentStock: stock,
        reorderLevel: num(p.reorderLevel),
        totalSold,
        avgDailySales: round2(avgDailySales),
        daysOfStock,
        demandLevel,
        stockValue,
        stockValueAtCost,
        potentialMargin,
        marginPct,
        activeDays,
      }
    })

    results.sort((a, b) => b.avgDailySales - a.avgDailySales)
    const top50 = results.slice(0, 50)

    const highDemand = top50.filter((p) => p.demandLevel === 'high').length
    const mediumDemand = top50.filter((p) => p.demandLevel === 'medium').length
    const atRisk = top50.filter((p) => p.avgDailySales > 0 && p.daysOfStock <= 7).length
    const totalStockValue = round2(top50.reduce((a, p) => a + p.stockValue, 0))
    const totalStockValueAtCost = round2(top50.reduce((a, p) => a + p.stockValueAtCost, 0))
    const totalPotentialMargin = round2(totalStockValue - totalStockValueAtCost)

    res.setHeader('Cache-Control', 'no-store')

    // Per-location breakdown. The product rows above are the cross-location
    // rollup, which answers "what do we hold" but never "what is sitting in
    // the Andheri branch". Per-location stock exists, so the report should be
    // able to say it.
    const [levels, locRows] = await Promise.all([
      db!.select({ locationId: schema.stockLevels.locationId, productId: schema.stockLevels.productId, qty: schema.stockLevels.qty }).from(schema.stockLevels),
      db!.select({ id: schema.inventoryLocations.id, name: schema.inventoryLocations.name, type: schema.inventoryLocations.type, city: schema.inventoryLocations.city }).from(schema.inventoryLocations),
    ])
    const byProductId = new Map(products.map((p) => [p.id, p]))
    const locationMeta = new Map(locRows.map((l) => [l.id, l]))
    // A level whose location row was deleted must NOT surface the raw id as a
    // label — the report shows the same fallback the rest of the inventory
    // module uses, and an unknown type rather than a guessed 'store'.
    const UNAVAILABLE = 'Location unavailable'
    const acc = new Map<string, { name: string; type: string; city: string | null; products: number; quantity: number; valueAtCost: number; valueAtRetail: number }>()
    for (const lv of levels) {
      const product = byProductId.get(lv.productId)
      const qty = num(lv.qty)
      const meta = locationMeta.get(lv.locationId)
      const cur = acc.get(lv.locationId) ?? {
        name: meta?.name ?? UNAVAILABLE,
        type: meta?.type ?? '',
        city: meta?.city ?? null,
        products: 0,
        quantity: 0,
        valueAtCost: 0,
        valueAtRetail: 0,
      }
      if (qty > 0) cur.products += 1
      cur.quantity += qty
      cur.valueAtCost += qty * num(product?.costPrice)
      cur.valueAtRetail += qty * num(product?.sellingPrice)
      acc.set(lv.locationId, cur)
    }
    const byLocation = [...acc.entries()]
      .map(([id, v]) => {
        const valueAtCost = round2(v.valueAtCost)
        const valueAtRetail = round2(v.valueAtRetail)
        return {
          id,
          name: v.name,
          type: v.type,
          city: v.city,
          products: v.products,
          quantity: v.quantity,
          valueAtCost,
          valueAtRetail,
          margin: round2(valueAtRetail - valueAtCost),
          marginPct: valueAtRetail > 0 ? round2(((valueAtRetail - valueAtCost) / valueAtRetail) * 100) : 0,
        }
      })
      .sort((a, b) => b.valueAtCost - a.valueAtCost)

    res.json({
      products: top50,
      byLocation,
      summary: {
        totalProducts: top50.length,
        highDemand,
        mediumDemand,
        atRisk,
        totalStockValue,
        totalStockValueAtCost,
        totalPotentialMargin,
      },
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Day Book: everything that happened today on one page ────────────────────
dashboardRouter.get('/reports/day-book', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const q = String(req.query.date ?? '').trim()
    let start: string
    let end: string
    if (/^\d{4}-\d{2}-\d{2}$/.test(q)) {
      start = `${q}T00:00:00`
      const d = new Date(`${q}T00:00:00`)
      d.setDate(d.getDate() + 1)
      end = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`
    } else {
      start = localDayStart(0)
      end = localDayStart(1)
    }
    const inDay = (col: AnyColumn) => sql`${col} >= ${start} and ${col} < ${end}`

    const [invoices, orders, payments, expenses, shipments, activities] = await Promise.all([
      db!.select().from(schema.salesInvoices).where(inDay(schema.salesInvoices.date)).orderBy(schema.salesInvoices.date),
      db!.select().from(schema.salesOrders).where(inDay(schema.salesOrders.date)).orderBy(schema.salesOrders.date),
      db!.select().from(schema.payments).where(inDay(schema.payments.date)).orderBy(schema.payments.date),
      db!.select().from(schema.expenses).where(inDay(schema.expenses.date)).orderBy(schema.expenses.date),
      db!.select().from(schema.shipments).where(inDay(schema.shipments.createdAt)).orderBy(schema.shipments.createdAt),
      db!.select().from(schema.activityLogs).where(inDay(schema.activityLogs.timestamp)).orderBy(schema.activityLogs.timestamp).limit(100),
    ])

    const totals = {
      invoiced: round2(invoices.reduce((a, r) => a + Number(r.grandTotal ?? 0), 0)),
      collected: round2(payments.reduce((a, r) => a + Number(r.amount ?? 0), 0)),
      expenses: round2(expenses.reduce((a, r) => a + Number(r.amount ?? 0), 0)),
      netCash: round2(payments.reduce((a, r) => a + Number(r.amount ?? 0), 0) - expenses.reduce((a, r) => a + Number(r.amount ?? 0), 0)),
    }

    res.json({
      date: start.slice(0, 10),
      totals,
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, customer: i.customer, grandTotal: i.grandTotal, paymentStatus: i.paymentStatus, date: i.date })),
      orders: orders.map((o) => ({ id: o.id, shopifyId: o.shopifyId, customer: o.customer, value: o.value, status: o.status, date: o.date })),
      payments: payments.map((p) => ({ id: p.id, ref: p.ref, customer: p.customer, amount: p.amount, method: p.method, date: p.date })),
      expenses: expenses.map((e) => ({ id: e.id, category: e.category, description: e.description, amount: e.amount, by: e.by, date: e.date })),
      shipments: shipments.map((s) => ({ id: s.id, orderRef: s.orderRef, customer: s.customer, courier: s.courier, trackingNumber: s.trackingNumber, status: s.status, createdAt: s.createdAt })),
      activities: activities.map((a) => ({ id: a.id, user: a.user, action: a.action, module: a.module, entity: a.entity, details: a.details, timestamp: a.timestamp })),
    })
  } catch {
    res.status(500).json({ error: 'Failed to load day book' })
  }
})

// ─── Order Detail 360: one call = order + items + invoice + payments + shipment + events + customer ──
dashboardRouter.get('/orders/:id/full', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const id = routeParam(req.params.id)
    const [order] = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, id)).limit(1)
    if (!order) return res.status(404).json({ error: 'Order not found' })

    // An invoice links to its order by the Shopify order name (imported
    // orders) or by the invoice number the order row carries (bookings and
    // other ERP-created rows have no Shopify name). Prefer the order's own
    // number — that is the invoice it points at — and keep the Shopify-name
    // lookup as the fallback for rows that carry neither reliably.
    const invoiceQuery = order.invoice
      ? db!.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.number, order.invoice)).limit(1).then(
          (rows) => rows.length > 0
            ? rows
            : db!.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.shopifyOrder, order.shopifyId ?? '')).limit(1),
        )
      : db!.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.shopifyOrder, order.shopifyId ?? '')).limit(1)

    const [invoiceRows, pays, ship, events, customerRows] = await Promise.all([
      invoiceQuery,
      db!.select().from(schema.payments).where(eq(schema.payments.invoice, order.invoice ?? '')).orderBy(desc(schema.payments.date)),
      db!.select().from(schema.shipments).where(eq(schema.shipments.orderId, id)).limit(1),
      db!.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, id)).orderBy(desc(schema.orderEvents.createdAt)),
      order.customer
        ? db!.select().from(schema.customers).where(eq(schema.customers.name, order.customer)).limit(1)
        : Promise.resolve([] as Array<typeof schema.customers.$inferSelect>),
    ])

    const invoice = invoiceRows[0] ?? null
    const customer = customerRows[0] ?? null
    const contact = {
      name: order.customer ?? customer?.name ?? null,
      email: customer?.email ?? invoice?.customerEmail ?? null,
      phone: customer?.phone ?? invoice?.customerPhone ?? null,
      address: (customer as unknown as { address1?: string | null } | null)?.address1 ?? invoice?.customerAddress ?? null,
      city: customer?.city ?? invoice?.customerCity ?? null,
      state: (customer as unknown as { province?: string | null } | null)?.province ?? invoice?.customerState ?? null,
      pincode: (customer as unknown as { zip?: string | null } | null)?.zip ?? invoice?.customerPincode ?? null,
    }

    res.json({
      order,
      items: (order.lineItems as Array<Record<string, unknown>> | null) ?? [],
      invoice,
      payments: pays,
      shipment: ship[0] ?? null,
      events,
      customer,
      contact,
    })
  } catch {
    res.status(500).json({ error: 'Failed to load order detail' })
  }
})

// ─── HSN-wise Summary Report ──────────────────────────────────────
dashboardRouter.get('/reports/hsn', async (req, res) => {
  if (!requireDb(res)) return
  try {
    // Business state, used to split CGST/SGST from IGST.
    const [settingsRow] = await db!
      .select({ address: schema.settings.address })
      .from(schema.settings)
      .limit(1)
    const bizState = String(settingsRow?.address ?? '').toLowerCase()

    const monthParam = Number(req.query.month)
    const target = Number.isFinite(monthParam) && monthParam >= 1 && monthParam <= 12 ? monthParam : new Date().getMonth() + 1
    const yearParam = Number(req.query.year)
    const year = Number.isFinite(yearParam) && yearParam >= 2000 && yearParam <= 2200 ? yearParam : new Date().getFullYear()
    const prefix = `${year}-${pad(target)}`

    // Outward supplies for the month, grouped by the HSN on the product.
    //
    // This used to read a `line_items` JSON column that does not exist on
    // sales_invoices, so the report was always empty. The real line items live
    // in sales_invoice_items, and HSN comes from the product (items only carry
    // a SKU). GST is charged per invoice, so each line's taxable value takes a
    // pro-rata share of (subtotal - discount) and is then taxed at the
    // invoice's rate — which keeps the HSN totals reconciling with the invoice.
    //
    // Intra-state (CGST + SGST) when both states are known and match; a blank
    // customer state is treated as intra-state, which is how walk-in counter
    // sales are charged.
    const rows = (await db!.execute(sql`
      WITH inv AS (
        SELECT i.id,
               coalesce(i.subtotal, 0) - coalesce(i.discount, 0) AS taxable_pool,
               coalesce(i.gst, 0) AS gst,
               lower(coalesce(i.customer_state, '')) AS cstate
        FROM sales_invoices i
        WHERE i.date::text like ${prefix + '%'}
          AND coalesce(i.status, '') NOT IN ('cancelled', 'refunded')
      ),
      lines AS (
        SELECT inv.cstate,
               inv.gst,
               inv.taxable_pool,
               coalesce(it.qty, 0)::bigint AS qty,
               coalesce(it.amount, 0)::float AS amount,
               sum(coalesce(it.amount, 0)) OVER (PARTITION BY inv.id) AS amount_sum,
               coalesce(nullif(trim(p.hsn), ''), 'Unclassified') AS hsn
        FROM inv
        JOIN sales_invoice_items it ON it.invoice_id = inv.id
        LEFT JOIN products p ON lower(p.sku) = lower(coalesce(it.sku, ''))
      ),
      alloc AS (
        SELECT hsn, cstate, gst, qty,
               amount * (CASE WHEN amount_sum > 0 THEN taxable_pool / amount_sum ELSE 1 END) AS taxable
        FROM lines
      )
      SELECT hsn,
             sum(qty)::bigint AS qty,
             round(sum(taxable)::numeric, 2) AS taxable_value,
             round(sum(CASE WHEN cstate = '' OR cstate = lower(${bizState}) THEN taxable * gst / 100 / 2 ELSE 0 END)::numeric, 2) AS cgst,
             round(sum(CASE WHEN cstate = '' OR cstate = lower(${bizState}) THEN taxable * gst / 100 / 2 ELSE 0 END)::numeric, 2) AS sgst,
             round(sum(CASE WHEN cstate <> '' AND cstate <> lower(${bizState}) THEN taxable * gst / 100 ELSE 0 END)::numeric, 2) AS igst
      FROM alloc
      GROUP BY hsn
      ORDER BY sum(taxable) DESC
    `)) as unknown as Array<{
      hsn: string
      qty: string | number
      taxable_value: string | number
      cgst: string | number
      sgst: string | number
      igst: string | number
    }>

    const describe = (hsn: string): string => {
      if (hsn === '7113') return 'Silver jewellery articles'
      if (hsn === 'Unclassified') return 'Unclassified — set an HSN code on these products'
      return 'Goods (as per product master)'
    }

    const out = rows.map((r) => {
      const taxableValue = Number(r.taxable_value ?? 0)
      const cgst = Number(r.cgst ?? 0)
      const sgst = Number(r.sgst ?? 0)
      const igst = Number(r.igst ?? 0)
      return {
        hsn: r.hsn,
        description: describe(r.hsn),
        qty: Number(r.qty ?? 0),
        taxableValue,
        cgst,
        sgst,
        igst,
        totalTax: Math.round((cgst + sgst + igst) * 100) / 100,
      }
    })

    res.json(out)
  } catch (err) {
    logger.error({ err }, 'HSN summary failed')
    res.status(500).json({ error: 'Failed to generate HSN summary' })
  }
})

// ─── GST Reconciliation Report ────────────────────────────────────
dashboardRouter.get('/reports/gst-reconciliation', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const monthParam = Number(req.query.month)
    const target = Number.isFinite(monthParam) && monthParam >= 1 && monthParam <= 12 ? monthParam : new Date().getMonth() + 1
    const yearParam = Number(req.query.year)
    const year = Number.isFinite(yearParam) && yearParam >= 2000 && yearParam <= 2200 ? yearParam : new Date().getFullYear()
    const prefix = `${year}-${pad(target)}`

    // Only the requested month's invoices are fetched (per-invoice mismatch
    // detection needs the rows themselves).
    const monthInvoices = await db!
      .select({
        id: schema.salesInvoices.id,
        number: schema.salesInvoices.number,
        customer: schema.salesInvoices.customer,
        subtotal: schema.salesInvoices.subtotal,
        discount: schema.salesInvoices.discount,
        gst: schema.salesInvoices.gst,
        gstAmount: schema.salesInvoices.gstAmount,
        status: schema.salesInvoices.status,
      })
      .from(schema.salesInvoices)
      .where(sql`${schema.salesInvoices.date}::text like ${prefix + '%'}`)
    const active = monthInvoices.filter((i) => String(i.status) !== 'cancelled' && String(i.status) !== 'refunded')

    // Input GST: prefer the per-invoice CGST/SGST/IGST split (supplier GSTIN
    // on file) and fall back to the `tax` column for older invoices.
    const purchaseRows = await db!
      .select({
        tax: schema.purchaseInvoices.tax,
        cgst: schema.purchaseInvoices.cgst,
        sgst: schema.purchaseInvoices.sgst,
        igst: schema.purchaseInvoices.igst,
        tcsAmount: schema.purchaseInvoices.tcsAmount,
        tcsRate: schema.purchaseInvoices.tcsRate,
        status: schema.purchaseInvoices.status,
        date: schema.purchaseInvoices.date,
      })
      .from(schema.purchaseInvoices)
      .where(sql`${schema.purchaseInvoices.date}::text like ${prefix + '%'}`)
      .limit(10000)
    const inputGst = computeInputGst(purchaseRows)
    const tcs = computeTcs(purchaseRows)

    let outputGst = 0
    let b2bTaxable = 0
    let b2cTaxable = 0
    const mismatches: Array<{ invoiceNumber: string; expected: number; actual: number; diff: number }> = []

    const isBusiness = (name: string) => BUSINESS_NAME_PATTERN.test(String(name ?? ''))

    for (const inv of active) {
      const taxable = num(inv.subtotal) - num(inv.discount)
      const gst = num(inv.gstAmount)
      outputGst += gst
      if (isBusiness(String(inv.customer ?? ''))) {
        b2bTaxable += taxable
      } else {
        b2cTaxable += taxable
      }

      // Check: expected GST = taxable * rate / 100
      const rate = Number(inv.gst || 3)
      const expectedGst = Math.round(taxable * rate / 100 * 100) / 100
      const diff = Math.abs(expectedGst - gst)
      if (diff > 0.01) {
        mismatches.push({
          invoiceNumber: String(inv.number ?? inv.id),
          expected: expectedGst,
          actual: gst,
          diff,
        })
      }
    }

    res.json({
      outputGst: round2(outputGst),
      inputGst: round2(inputGst),
      netPayable: round2(netPayable(outputGst, inputGst)),
      tcs: round2(tcs),
      b2bTaxable: round2(b2bTaxable),
      b2cTaxable: round2(b2cTaxable),
      mismatches,
    })
  } catch {
    res.status(500).json({ error: 'Failed to generate GST reconciliation' })
  }
})
