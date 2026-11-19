import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { resolveClientRange, rangeToQuery } from '@/lib/dashboardRange'
import {
  ArrowRight,
  Banknote,
  Boxes,
  Calendar,
  ChevronDown,
  Clock,
  CloudCog,
  Database,
  FileText,
  Gem,
  IndianRupee,
  LayoutGrid,
  Landmark,
  PackageX,
  Plus,
  Repeat,
  ShieldAlert,
  ShoppingBag,
  ShoppingCart,
  Tag,
  TrendingUp,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/auth/auth-context'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StatusPill } from '@/components/ui/status-pill'
import { StatCard } from '@/components/ui/stat-card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { FinancialAnalytics } from '@/components/dashboard/financial-analytics'
import { SalesOrdersRevenueChart } from '@/components/charts/sales-orders-revenue-chart'
import { SalesKpiCards } from '@/components/dashboard/sales-overview-analytics'
import { SilverRateHistoryCard } from '@/components/dashboard/silver-rate-history'
import { PaymentDonutChart } from '@/components/charts/payment-donut-chart'
import { StatusDonutChart } from '@/components/charts/dashboard-widget-charts'
import { PAYMENT_STATUS_COLORS, SERIES_COLORS } from '@/components/charts/chart-theme'
import {
  OrderSummaryCard,
  PurchaseOrdersCard,
  RecentInvoicesCard,
  SupplierPaymentsCard,
} from '@/components/dashboard/summary-widgets'
import { productImageSrc } from '@/lib/product-image'
import { dbApi } from '@/lib/api'
import { shopifyApi } from '@/lib/api'
import type {
  Activity,
  AnalyticsStat,
  KpiCardData,
  LowStockItem,
  PaymentStatusSegment,
  SalesOverviewPoint,
  SalesInsights,
  TopCategory,
  TopProduct,
  PeriodKey,
  DateRange,
  RangeQuery,
} from '@/types'
import type { ShopifyStatus } from '@/types/shopify'
import { compactCurrency, formatCurrency, formatDateTime, formatPieces, formatWeight } from '@/lib/format'
import { cn } from '@/lib/utils'

const kpiIcons: Record<string, LucideIcon> = {
  'indian-rupee': IndianRupee,
  'shopping-bag': ShoppingBag,
  'file-text': FileText,
  'trending-up': TrendingUp,
  clock: Clock,
  'package-x': PackageX,
}

const activityIcons: Record<Activity['type'], { icon: LucideIcon; className: string }> = {
  'silver-rate': { icon: Tag, className: 'bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300' },
  'shopify-import': { icon: ShoppingBag, className: 'bg-info-50 text-info-700' },
  invoice: { icon: FileText, className: 'bg-success-50 text-success-700' },
  payment: { icon: IndianRupee, className: 'bg-success-50 text-success-700' },
  product: { icon: Gem, className: 'bg-warning-50 text-warning-700' },
  sync: { icon: Repeat, className: 'bg-info-50 text-info-700' },
  user: { icon: Users, className: 'bg-muted text-muted-foreground' },
  purchase: { icon: ShoppingCart, className: 'bg-warning-50 text-warning-700' },
}

const ListOrderedIcon = FileText

type SalesSource = 'all' | 'shopify' | 'erp'

const SALES_SOURCES: { key: SalesSource; label: string; icon: LucideIcon }[] = [
  { key: 'all', label: 'All Sales', icon: LayoutGrid },
  { key: 'shopify', label: 'Shopify Sales', icon: ShoppingBag },
  { key: 'erp', label: 'ERP Sales', icon: Database },
]

const quickActions: { label: string; icon: LucideIcon; path: string; module: string }[] = [
  { label: 'Sales Invoice', icon: FileText, path: '/sales/invoices', module: 'sales' },
  { label: 'Sales Order', icon: ListOrderedIcon, path: '/sales/orders', module: 'sales' },
  { label: 'Purchase', icon: ShoppingCart, path: '/purchase/orders', module: 'purchase' },
  { label: 'Product', icon: Gem, path: '/inventory/products', module: 'inventory' },
  { label: 'Customer', icon: Users, path: '/sales/customers', module: 'sales' },
  { label: 'Silver Rate', icon: Tag, path: '/silver-rate', module: 'silver-rate' },
  { label: 'Expense', icon: Wallet, path: '/accounts/expenses', module: 'accounts' },
  { label: 'Stock Transfer', icon: Repeat, path: '/inventory/transfers', module: 'inventory' },
  { label: 'Reports', icon: TrendingUp, path: '/reports/business', module: 'reports' },
  { label: 'More', icon: Plus, path: '#', module: '' },
]

export default function DashboardPage() {
  const navigate = useNavigate()
  const [kpis, setKpis] = useState<KpiCardData[]>([])
  const [summary, setSummary] = useState<Record<string, string | number | null> | null>(null)
  const [salesData, setSalesData] = useState<SalesOverviewPoint[]>([])
  const [salesSource, setSalesSource] = useState<SalesSource>('all')
  const [salesInsights, setSalesInsights] = useState<SalesInsights | null>(null)
  const [salesInsightsLoading, setSalesInsightsLoading] = useState(true)
  const [salesInsightsError, setSalesInsightsError] = useState<string | null>(null)
  const [salesInsightsRetry, setSalesInsightsRetry] = useState(0)
  const [topProducts, setTopProducts] = useState<TopProduct[]>([])
  const [topProductsLoading, setTopProductsLoading] = useState(true)
  const [topProductsError, setTopProductsError] = useState<string | null>(null)
  const [topCategory, setTopCategory] = useState<TopCategory[]>([])
  const [topCategoryError, setTopCategoryError] = useState<string | null>(null)
  const [paymentStatus, setPaymentStatus] = useState<{ segments: PaymentStatusSegment[]; total: number } | null>(null)
  const [paymentStatusError, setPaymentStatusError] = useState<string | null>(null)
  const [paymentStatusLoading, setPaymentStatusLoading] = useState(true)
  const [lowStock, setLowStock] = useState<LowStockItem[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [analytics, setAnalytics] = useState<AnalyticsStat[]>([])
  const [shopifyStatus, setShopifyStatus] = useState<ShopifyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodKey>(() => loadStoredRange()?.period ?? 'today')
  const [customRange, setCustomRange] = useState<DateRange>(() => loadStoredRange()?.range ?? defaultRange())
  const [kpisError, setKpisError] = useState<string | null>(null)
  const [dbError, setDbError] = useState<string | null>(null)

  // Persist the page-wide range in sessionStorage: it survives in-app
  // navigation and a reload, and clears when the app closes.
  useEffect(() => {
    try {
      sessionStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify({ period, range: customRange }))
    } catch {
      /* storage unavailable — the range just won't persist */
    }
  }, [period, customRange])

  // One range drives every widget here. The non-range widgets (silver rate, low
  // stock, aging, system status) are fetched alongside and don't change with it.
  useEffect(() => {
    let cancelled = false
    const q = rangeToQuery(period, customRange)
    const range: RangeQuery = q as RangeQuery
    Promise.allSettled([
      dbApi.getDashboardKpis(range),
      dbApi.getDashboardSummary(range),
      dbApi.getSalesOverview(range),
      dbApi.getTopCategory(range),
      dbApi.getLowStock(),
      dbApi.getRecentActivities(range, { latest: true }),
      dbApi.getAnalyticsStats(range),
      shopifyApi.getStatus(),
    ]).then((results) => {
      if (cancelled) return
      const kpisResult = results[0]
      const summaryResult = results[1]
      const salesOverviewResult = results[2]
      const topCategoryResult = results[3]
      const lowStockResult = results[4]
      const activitiesResult = results[5]
      const analyticsResult = results[6]
      const shopifyStatusResult = results[7]

      // Helper: if fulfilled, return value; if rejected, log error and return default
      const safe = (result: PromiseSettledResult<any>): any => {
        if (result.status === 'fulfilled') return result.value
        console.error('Dashboard API error:', result.reason)
        return {}
      }

      // KPIs: fulfilled → real data, rejected → error state
      const kpis = kpisResult.status === 'fulfilled' ? kpisResult.value : []
      const kpisError = kpisResult.status === 'rejected' ? 'Couldn\'t load sales data' : null

      // Summary
      const summary = safe(summaryResult)
      // Ensure default values when error
      const safeSummary = {
        totalProducts: summary.totalProducts ?? 0,
        activeProducts: summary.activeProducts ?? 0,
        totalCustomers: summary.totalCustomers ?? 0,
        activeCustomers: summary.activeCustomers ?? 0,
        totalSuppliers: summary.totalSuppliers ?? 0,
        activeSuppliers: summary.activeSuppliers ?? 0,
        totalStockQty: summary.totalStockQty ?? 0,
        totalStockWeight: summary.totalStockWeight ?? 0,
        todayExpenses: summary.todayExpenses ?? 0,
        rangeExpenses: summary.rangeExpenses ?? 0,
        pendingPayments: summary.pendingPayments ?? 0,
        totalOrders: summary.totalOrders ?? 0,
        totalInvoices: summary.totalInvoices ?? 0,
        lastSyncAt: summary.lastSyncAt ?? null,
      }

      // Sales Overview
      const salesData = salesOverviewResult.status === 'fulfilled' ? salesOverviewResult.value : []

      // Top Category
      const topCategory = topCategoryResult.status === 'fulfilled' ? topCategoryResult.value : []
      const topCategoryError = topCategoryResult.status === 'rejected' ? 'Couldn\'t load category sales' : null

      // Low Stock
      const lowStock = lowStockResult.status === 'fulfilled' ? lowStockResult.value : []

      // Activities — the endpoint answers { items, total, nextCursor }, so the
      // payload has to be unwrapped (the header notification bell does the same).
      const activitiesRes = activitiesResult.status === 'fulfilled' ? activitiesResult.value : []
      const activities: Activity[] = Array.isArray(activitiesRes)
        ? activitiesRes
        : activitiesRes?.items ?? []

      // Analytics
      const analytics = analyticsResult.status === 'fulfilled' ? analyticsResult.value : []

      // Shopify Status
      const shopifyStatus = shopifyStatusResult.status === 'fulfilled' ? shopifyStatusResult.value : null

      setKpis(kpis)
      setKpisError(kpisError ?? null)
      setSummary(safeSummary)
      setSalesData(salesData)
      setTopCategory(topCategory)
      setTopCategoryError(topCategoryError ?? null)
      setLowStock(lowStock)
      setActivities(activities)
      setAnalytics(analytics)
      setShopifyStatus(shopifyStatus)
      // If critical widgets (KPIs or summary) had errors, mark DB as unreachable
      if (kpisResult.status === 'rejected' || summaryResult.status === 'rejected') {
        setDbError('Database not reachable')
      } else {
        setDbError(null)
      }
      setLoading(false)
    }).catch((err) => {
      if (!cancelled) setLoading(false)
      console.error('Dashboard critical error:', err)
    })
    return () => {
      cancelled = true
    }
  }, [period, customRange])

  // All three source splits and the previous-period comparison arrive in one
  // response, so the source buttons never wait on a second round-trip.
  useEffect(() => {
    let cancelled = false
    // A new range replaces every figure in these cards, so show the skeleton
    // instead of last range's totals while the request is in flight.
    setSalesInsightsLoading(true)
    dbApi
      .getSalesInsights(rangeToQuery(period, customRange))
      .then((data) => {
        if (!cancelled) {
          setSalesInsights(data)
          setSalesInsightsError(null)
        }
      })
      .catch(() => {
        if (!cancelled) setSalesInsightsError("Couldn't load sales insights")
      })
      .finally(() => {
        if (!cancelled) setSalesInsightsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period, customRange, salesInsightsRetry])

  // Rankings are platform-specific, so they follow the source buttons while
  // the rest of the dashboard keeps its own range-driven data.
  useEffect(() => {
    let cancelled = false
    // Rankings belong to one platform and one range. Clearing the loading flag
    // keeps the previous selection's best sellers off the screen while the new
    // ranking is fetched, so a Shopify card can never show ERP numbers.
    setTopProductsLoading(true)
    dbApi
      .getTopProducts(rangeToQuery(period, customRange), salesSource)
      .then((data) => {
        if (!cancelled) {
          setTopProducts(data)
          setTopProductsError(null)
        }
      })
      .catch(() => {
        if (!cancelled) setTopProductsError("Couldn't load top products")
      })
      .finally(() => {
        if (!cancelled) setTopProductsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period, customRange, salesSource])

  // Payment Status follows the source buttons too: All (default) reads
  // Shopify + ERP, each filter reads only its own invoices and orders. It has
  // its own effect so switching a source refetches just this card.
  useEffect(() => {
    let cancelled = false
    setPaymentStatusLoading(true)
    dbApi
      .getPaymentStatus(rangeToQuery(period, customRange), salesSource)
      .then((data) => {
        if (!cancelled) {
          setPaymentStatus(data)
          setPaymentStatusError(null)
        }
      })
      .catch(() => {
        if (!cancelled) setPaymentStatusError("Couldn't load payment status")
      })
      .finally(() => {
        if (!cancelled) setPaymentStatusLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period, customRange, salesSource])

  const range = rangeToQuery(period, customRange) as RangeQuery

  // The API sends every platform in one payload, so switching filters is
  // instant and the chart, tooltip and summary cards share one dataset.
  const visibleSales = salesData.map((point) => ({
    ...point,
    orders: salesSource === 'all' ? point.orders : salesSource === 'shopify' ? (point.shopifyOrders ?? 0) : (point.erpOrders ?? 0),
    revenue: salesSource === 'all' ? point.revenue : salesSource === 'shopify' ? (point.shopifyRevenue ?? 0) : (point.erpRevenue ?? 0),
  }))
  const hasVisibleSales = visibleSales.some((point) => Number(point.orders ?? 0) > 0 || Math.abs(Number(point.revenue ?? 0)) > 0.005)
  const sourceLabel = SALES_SOURCES.find((source) => source.key === salesSource)?.label ?? 'All Sales'

  return (
    <div className="print-area mx-auto w-full max-w-[1600px] space-y-6 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Dashboard"
        subtitle="Here's what's happening with your ecommerce business today."
        actions={
          <div className="no-print flex items-center gap-2">
            <PeriodSelect
              value={period}
              onChange={setPeriod}
              range={customRange}
              onRangeChange={setCustomRange}
              variant="range"
              align="right"
            />
          </div>
        }
      />

      <div className="hidden print:block">
        <h1 className="text-lg font-bold text-foreground">Opal Line Billing — Dashboard</h1>
        <p className="text-xs text-muted-foreground">
          Generated {new Date().toLocaleString('en-IN')} · {resolveClientRange(period, customRange).rangeText}
        </p>
      </div>

      <ConnectionBanner
        lastSyncAt={typeof summary?.lastSyncAt === 'string' ? summary.lastSyncAt : null}
        shopifyStatus={shopifyStatus}
      />

      {dbError ? (
        <Card className="mb-6">
          <CardContent>
            <EmptyState
              icon={ShieldAlert}
              title="Database not reachable"
              description="The dashboard cannot connect to the database. Some data may be stale or unavailable."
            />
          </CardContent>
        </Card>
      ) : (
        <QuickActions />
      )}

      {loading ? (
        <DashboardSkeleton />
      ) : (
        <>
          {kpisError ? (
              <Card>
                <CardContent>
                  <EmptyState
                    icon={ShieldAlert}
                    title="Couldn't load sales data"
                    description="There was an error fetching the dashboard data. Please try again."
                    action={
                      <Button size="sm" variant="soft-primary" onClick={() => window.location.reload()}>
                        Retry
                      </Button>
                    }
                  />
                </CardContent>
              </Card>
            ) : (kpis.length > 0 ? (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
                {kpis.map((kpi) => (
                  <StatCard
                    key={kpi.key}
                    icon={kpiIcons[kpi.icon] ?? Banknote}
                    title={kpi.label}
                    value={kpi.value}
                    trend={kpi.trend}
                    delta={kpi.delta}
                    deltaLabel={kpi.deltaLabel}
                    support={kpi.rangeLabel}
                    accent={kpi.accent}
                    variant="gradient"
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent>
                  <EmptyState
                    icon={TrendingUp}
                    title="Nothing to report yet"
                    description="Add products, set today's silver rate or create your first invoice — the dashboard fills up as you work."
                    action={
                      <Button size="sm" variant="soft-primary" onClick={() => navigate('/inventory/products')}>
                        Add Products
                      </Button>
                    }
                  />
                </CardContent>
              </Card>
            ))}

          {summary ? (
            <OperationalStrip
              summary={summary}
              analytics={analytics}
              rangeText={resolveClientRange(period, customRange).rangeText}
            />
          ) : null}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
            <CardHeader className="flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <TrendingUp className="h-4 w-4 text-[#7C5CE6]" /> Sales Overview
                </CardTitle>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {resolveClientRange(period, customRange).rangeText} · {sourceLabel}
                </p>
              </div>
              <div className="no-print flex w-fit flex-wrap items-center gap-1 rounded-xl border border-border/70 bg-muted/30 p-1">
                {SALES_SOURCES.map((source) => {
                  const Icon = source.icon
                  return (
                    <button
                      key={source.key}
                      type="button"
                      aria-pressed={salesSource === source.key}
                      onClick={() => setSalesSource(source.key)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-all sm:px-3 sm:text-[11.5px]',
                        salesSource === source.key
                          ? 'border-[#7C5CE6] bg-[#7C5CE6] text-white shadow-sm'
                          : 'border-border bg-card text-foreground shadow-sm hover:border-[#7C5CE6]/40 hover:bg-muted',
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {source.label}
                    </button>
                  )
                })}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {salesInsightsLoading ? (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-[108px] rounded-xl" />)}
                </div>
              ) : salesInsights ? (
                <SalesKpiCards insights={salesInsights} source={salesSource} />
              ) : null}
              {salesInsightsError ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                  <span>{salesInsightsError}. The chart still shows invoiced sales.</span>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setSalesInsightsRetry((n) => n + 1)}>
                    Retry
                  </Button>
                </div>
              ) : null}

              <div className="min-w-0 rounded-xl border border-border/70 bg-card p-3 shadow-sm sm:p-4">
                {hasVisibleSales ? (
                  <SalesOrdersRevenueChart data={visibleSales} />
                ) : salesSource !== 'all' ? (
                  <EmptyState
                    icon={TrendingUp}
                    title={`No ${salesSource === 'shopify' ? 'Shopify' : 'ERP'} sales in this period`}
                    description={`There were no ${salesSource === 'shopify' ? 'Shopify' : 'ERP'} sales in the selected range. Try another source or a wider date range.`}
                  />
                ) : summary && Number(summary.totalOrders ?? 0) === 0 ? (
                  <EmptyState
                    icon={ShoppingBag}
                    title="No orders imported yet"
                    description="Run Orders Sync to import your paid Shopify orders — invoices and sales will appear here automatically."
                    action={
                      <Button size="sm" variant="soft-primary" onClick={() => navigate('/shopify/orders')}>
                        Run Orders Sync
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={TrendingUp}
                    title="No sales in this period"
                    description="There were no sales in the selected period. Try a wider date range."
                  />
                )}
              </div>
            </CardContent>
            </Card>
            <div className="h-full xl:col-span-1">
              <PaymentStatusPanel
                data={paymentStatus}
                error={paymentStatusError}
                loading={paymentStatusLoading}
                onViewDetails={() => navigate('/accounts/payments')}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <Card className="h-full xl:col-span-5">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Gem className="h-4 w-4 text-[#7C5CE6]" /> Top Selling Products
                  </CardTitle>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Best sellers by revenue · {sourceLabel}</p>
                </div>
                <Button variant="ghost" size="sm" className="gap-1 px-2 text-link" onClick={() => navigate('/reports/sales')}>
                  View All <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </CardHeader>
              <CardContent>
                {topProductsLoading ? (
                  <div className="grid h-[347px] grid-cols-1 gap-2.5 overflow-hidden sm:grid-cols-2">
                    {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-[92px] rounded-xl" />)}
                  </div>
                ) : topProductsError ? (
                  <Card>
                    <CardContent>
                      <EmptyState
                        icon={ShieldAlert}
                        title="Couldn't load top products"
                        description="There was an error fetching top selling products. Please try again."
                        action={
                          <Button size="sm" variant="soft-primary" onClick={() => window.location.reload()}>
                            Retry
                          </Button>
                        }
                      />
                    </CardContent>
                  </Card>
                ) : topProducts.length > 0 ? (
                  <div
                    tabIndex={0}
                    aria-label="Top selling products list"
                    className="h-[347px] overflow-y-auto overscroll-contain scroll-smooth pr-1.5 [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-0 [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/40"
                  >
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {topProducts.map((p, index) => {
                        const max = topProducts[0]?.revenue || 1
                        const image = productImageSrc(p)
                        return (
                          <div
                            key={p.id}
                            className="rounded-xl border border-border/70 bg-muted/20 p-2.5 transition-colors hover:bg-muted/40"
                          >
                            <div className="flex items-center gap-2">
                              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
                                {image ? (
                                  <img src={image} alt={p.name} className="h-full w-full object-cover" loading="lazy" />
                                ) : (
                                  <Gem className="h-4 w-4" />
                                )}
                                <span className="absolute left-0 top-0 rounded-br-md bg-foreground/70 px-1 text-[9px] font-bold leading-4 text-background">
                                  {index + 1}
                                </span>
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-[12px] font-medium text-foreground">{p.name}</p>
                                <p className="truncate text-[10px] text-muted-foreground">{p.sku}</p>
                              </div>
                            </div>
                            <div className="mt-2 flex items-baseline justify-between gap-2">
                              <span className="text-[12.5px] font-semibold tabular-nums text-foreground">
                                {compactCurrency(p.revenue)}
                              </span>
                              <span className="text-[10px] text-muted-foreground">{formatNumber(p.qty)} pcs</span>
                            </div>
                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${Math.max(4, Math.round((p.revenue / max) * 100))}%`,
                                    background: SERIES_COLORS[0],
                                  }}
                                />
                              </div>
                              <span className="shrink-0 text-[9.5px] tabular-nums text-muted-foreground">
                                {formatWeight(p.weight)}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ) : salesSource !== 'all' ? (
                  <EmptyState
                    icon={ShoppingBag}
                    title={`No ${salesSource === 'shopify' ? 'Shopify' : 'ERP'} sales in this period`}
                    description={`No ${salesSource === 'shopify' ? 'Shopify' : 'ERP'} sales in the selected range, so there is nothing to rank. Try another source or a wider date range.`}
                  />
                ) : (
                  <EmptyState
                    icon={ShoppingBag}
                    title="No sales recorded yet"
                    description="Your best sellers will appear here once the first invoice is raised."
                    action={
                      <Button size="sm" variant="soft-primary" onClick={() => navigate('/sales/invoices')}>
                        Create Invoice
                      </Button>
                    }
                  />
                )}
              </CardContent>
            </Card>

            <div className="h-full xl:col-span-4">
              <SupplierPaymentsCard range={range} />
            </div>
            <div className="h-full xl:col-span-3">
              <PurchaseOrdersCard range={range} />
            </div>

            <Card className="xl:col-span-4">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-sm">Top Selling Category</CardTitle>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Revenue grouped by product category</p>
                </div>
                <Button variant="ghost" size="sm" className="gap-1 px-2 text-link" onClick={() => navigate('/reports/sales')}>
                  View All <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </CardHeader>
              <CardContent>
                {topCategoryError ? (
              <Card>
                <CardContent>
                  <EmptyState
                    icon={ShieldAlert}
                    title="Couldn't load category sales"
                    description="There was an error fetching category sales data. Please try again."
                    action={
                      <Button size="sm" variant="soft-primary" onClick={() => window.location.reload()}>
                        Retry
                      </Button>
                    }
                  />
                </CardContent>
              </Card>
            ) : (topCategory.length > 0 ? (
                  (() => {
                    const total = topCategory.reduce((sum, c) => sum + c.revenue, 0)
                    const slices = topCategory.map((c, index) => ({
                      name: c.category,
                      value: c.revenue,
                      color: SERIES_COLORS[index % SERIES_COLORS.length],
                    }))
                    return (
                      <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-2">
                        <StatusDonutChart
                          data={slices}
                          centerLabel="Revenue"
                          centerValue={compactCurrency(total)}
                          height={180}
                        />
                        <div className="space-y-2">
                          {slices.map((slice, index) => (
                            <div key={slice.name} className="flex items-center gap-2 text-[11.5px]">
                              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: slice.color }} />
                              <span className="truncate text-muted-foreground">{slice.name}</span>
                              <span className="ml-auto font-semibold tabular-nums text-foreground">
                                {compactCurrency(slice.value)}
                              </span>
                              <span className="w-8 text-right tabular-nums text-muted-foreground">
                                {total > 0 ? `${Math.round((slice.value / total) * 100)}%` : '0%'}
                              </span>
                              <span className="hidden text-[10px] text-muted-foreground sm:inline">
                                {formatNumber(topCategory[index]?.qty ?? 0)} pcs
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })()
                ) : (
                  <EmptyState
                    icon={Tag}
                    title="No category sales yet"
                    description="Sales grouped by product category appear here once invoices are raised."
                  />
                ))}
              </CardContent>
            </Card>

            <div className="xl:col-span-8">
              <SilverRateHistoryCard onSetRate={() => navigate('/silver-rate')} />
            </div>
          </div>

          <OrderSummaryCard />

          {/* Self-fetching: independent of the page-wide range above. */}
          <FinancialAnalytics />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-sm">Low Stock Alert</CardTitle>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">At or below their reorder level</p>
                </div>
                <Button variant="ghost" size="sm" className="gap-1 px-2 text-link" onClick={() => navigate('/inventory/low-stock')}>
                  View All <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                {lowStock.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Stock</TableHead>
                      <TableHead className="text-right">Reorder</TableHead>
                      <TableHead className="text-center">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lowStock.slice(0, 5).map((l) => {
                      const critical = l.stock === 0 || l.status === 'critical'
                      return (
                      <TableRow
                        key={l.id}
                        className={cn(
                          'border-b-0',
                          critical
                            ? 'bg-red-50/60 hover:bg-red-50 dark:bg-red-500/10 dark:hover:bg-red-500/15'
                            : 'bg-amber-50/40 hover:bg-amber-50 dark:bg-amber-500/10 dark:hover:bg-amber-500/15',
                        )}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-warning-50 text-warning-700">
                              <PackageX className="h-4 w-4" />
                            </div>
                            <div>
                              <p className="font-medium text-foreground">{l.product}</p>
                              <p className="text-[11px] text-muted-foreground">{l.sku}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-red-600 dark:text-red-400">{formatPieces(l.stock)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatPieces(l.reorderLevel)}</TableCell>
                        <TableCell className="text-center">
                          <StatusPill status={l.stock === 0 ? 'Out of Stock' : l.status === 'critical' ? 'Critical' : 'Low'} />
                        </TableCell>
                      </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
                ) : (
                  <EmptyState
                    icon={PackageX}
                    title="Stock levels look healthy"
                    description="Products at or below their reorder level will be flagged here."
                    action={
                      <Button size="sm" variant="soft-primary" onClick={() => navigate('/inventory/products')}>
                        Manage Products
                      </Button>
                    }
                  />
                )}
              </CardContent>
            </Card>

            <RecentInvoicesCard range={range} source={salesSource} />
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-sm">Recent Activities</CardTitle>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Latest invoice, payment and sync events</p>
              </div>
              <Button variant="ghost" size="sm" className="gap-1 px-2 text-link" onClick={() => navigate('/system/activity')}>
                View All <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <div className="relative px-5 pb-5">
                {activities.length === 0 ? (
                  <EmptyState
                    icon={Repeat}
                    title="No activity yet"
                    description="Invoice, payment and sync events will show up here as you work."
                  />
                ) : (
                  activities.slice(0, 8).map((a, i) => {
                    const cfg = activityIcons[a.type]
                    return (
                      <div key={a.id} className="relative flex gap-3 pb-4 last:pb-0">
                        {i < Math.min(activities.length, 8) - 1 ? (
                          <span className="absolute left-[15px] top-8 h-[calc(100%-28px)] w-px bg-border" />
                        ) : null}
                        <div className={cn('z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', cfg.className)}>
                          <cfg.icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 pt-0.5">
                          <p className="text-[13px] font-medium leading-snug text-foreground">{a.title}</p>
                          {a.detail ? <p className="text-[11.5px] text-muted-foreground">{a.detail}</p> : null}
                          <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-muted-foreground">
                            <span className="font-medium text-link">by {a.actor}</span>
                            <span>·</span>
                            <span>{a.time}</span>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

const formatNumber = (v: number) => v.toLocaleString('en-IN')

const RANGE_STORAGE_KEY = 'opal-line.dashboard.range'

function loadStoredRange(): { period: PeriodKey; range: DateRange } | null {
  try {
    const raw = sessionStorage.getItem(RANGE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { period?: PeriodKey; range?: DateRange }
    if (!parsed.period || !parsed.range?.start || !parsed.range?.end) return null
    if (parsed.period === 'custom') {
      const s = parseISODate(parsed.range.start)
      const e = parseISODate(parsed.range.end)
      if (!s || !e || e < s) return null
      return { period: parsed.period, range: { start: parsed.range.start, end: parsed.range.end } }
    }
    const ok = ['today', 'week', 'last7', 'last30', 'month', 'lastMonth', 'year'].includes(parsed.period)
    return ok ? { period: parsed.period as PeriodKey, range: parsed.range } : null
  } catch {
    return null
  }
}

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'last7', label: 'Last 7 Days' },
  { key: 'last30', label: 'Last 30 Days' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'lastMonth', label: 'Last Month' },
  { key: 'year', label: 'This Year' },
]

function toISODate(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function parseISODate(value: string) {
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

function defaultRange(): DateRange {
  const end = new Date()
  const start = new Date(end)
  start.setDate(end.getDate() - 6)
  return { start: toISODate(start), end: toISODate(end) }
}

function periodRangeLabel(key: PeriodKey, range?: DateRange) {
  const fmt = (d: Date) => d.toLocaleDateString('en-IN', { month: 'short', day: '2-digit', year: 'numeric' })
  if (key === 'custom' && range) {
    const s = parseISODate(range.start)
    const e = parseISODate(range.end)
    if (s && e) return `${fmt(s)} - ${fmt(e)}`
    return 'Custom Range'
  }
  const end = new Date()
  const start = new Date(end)
  if (key === 'today') return fmt(end)
  if (key === 'last7') {
    start.setDate(end.getDate() - 6)
    return `${fmt(start)} - ${fmt(end)}`
  }
  if (key === 'last30') {
    start.setDate(end.getDate() - 29)
    return `${fmt(start)} - ${fmt(end)}`
  }
  if (key === 'week') {
    const back = (end.getDay() + 6) % 7
    start.setDate(end.getDate() - back)
    return `${fmt(start)} - ${fmt(end)}`
  }
  if (key === 'month') {
    start.setDate(1)
    return `${fmt(start)} - ${fmt(end)}`
  }
  if (key === 'lastMonth') {
    const first = new Date(end.getFullYear(), end.getMonth() - 1, 1)
    const last = new Date(end.getFullYear(), end.getMonth(), 0)
    return `${fmt(first)} - ${fmt(last)}`
  }
  start.setTime(new Date(end.getFullYear(), 0, 1).getTime())
  return `${fmt(start)} - ${fmt(end)}`
}

function PeriodSelect({
  value,
  onChange,
  range,
  onRangeChange,
  variant,
  align = 'right',
}: {
  value: PeriodKey
  onChange: (next: PeriodKey) => void
  range?: DateRange
  onRangeChange?: (next: DateRange) => void
  variant: 'pill' | 'range'
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [draft, setDraft] = useState<DateRange>(range ?? defaultRange())

  const selected = PERIODS.find((p) => p.key === value) ?? PERIODS[1]
  const display =
    variant === 'range' ? periodRangeLabel(value, range) : value === 'custom' ? 'Custom Range' : selected.label

  const openPanel = () => {
    setDraft(range ?? defaultRange())
    setCustomMode(value === 'custom')
    setOpen(true)
  }

  const applyCustom = () => {
    const s = parseISODate(draft.start)
    const e = parseISODate(draft.end)
    if (!s || !e || e < s) return
    onRangeChange?.(draft)
    onChange('custom')
    setOpen(false)
  }

  const rangeValid = (() => {
    const s = parseISODate(draft.start)
    const e = parseISODate(draft.end)
    return Boolean(s && e && e >= s)
  })()

  return (
    <div className="relative">
      <button
        onClick={() => (open ? setOpen(false) : openPanel())}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted',
          variant === 'range' && 'text-[12.5px]',
        )}
      >
        {variant === 'range' ? <Calendar className="h-3.5 w-3.5 text-muted-foreground" /> : null}
        {display}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={cn(
              'absolute top-8 z-20 min-w-[150px] animate-scale-in rounded-md border bg-popover p-1 shadow-popover',
              align === 'right' ? 'right-0' : 'left-0',
            )}
          >
            {customMode ? (
              <div className="w-60 p-1.5">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Custom Range</p>
                  <button
                    onClick={() => setCustomMode(false)}
                    className="text-[11px] font-medium text-primary-700 hover:underline"
                  >
                    Presets
                  </button>
                </div>
                <label className="mb-1 block text-[11px] text-muted-foreground">From</label>
                <input
                  type="date"
                  value={draft.start}
                  onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))}
                  className="mb-2 h-7 w-full rounded-md border bg-card px-2 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <label className="mb-1 block text-[11px] text-muted-foreground">To</label>
                <input
                  type="date"
                  value={draft.end}
                  max={toISODate(new Date())}
                  onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))}
                  className="h-7 w-full rounded-md border bg-card px-2 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="mt-2 flex justify-end gap-1.5">
                  <button
                    onClick={() => setOpen(false)}
                    className="rounded-sm px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={applyCustom}
                    disabled={!rangeValid}
                    className="rounded-sm bg-primary-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Apply
                  </button>
                </div>
              </div>
            ) : (
              <>
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => {
                      onChange(p.key)
                      setOpen(false)
                    }}
                    className={cn(
                      'block w-full rounded-sm px-2.5 py-1.5 text-left text-[13px]',
                      value === p.key ? 'bg-primary-50 font-medium text-primary-700' : 'hover:bg-muted',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
                <button
                  onClick={() => setCustomMode(true)}
                  className={cn(
                    'block w-full rounded-sm px-2.5 py-1.5 text-left text-[13px]',
                    value === 'custom' ? 'bg-primary-50 font-medium text-primary-700' : 'hover:bg-muted',
                  )}
                >
                  Custom Range
                </button>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

function PaymentStatusPanel({
  data,
  error,
  loading,
  onViewDetails,
}: {
  data: { segments: PaymentStatusSegment[]; total: number } | null
  error: string | null
  loading: boolean
  onViewDetails: () => void
}) {
  const total = data?.total ?? 0
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <IndianRupee className="h-4 w-4 text-[#2F5BE0]" /> Payment Status
          </CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Sales grouped by payment state</p>
        </div>
        <Badge variant="muted" className="text-[10px]">{formatCurrency(total, { compact: true })}</Badge>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {loading ? (
          <div className="flex flex-1 flex-col justify-center gap-3">
            <Skeleton className="mx-auto h-[200px] w-[200px] rounded-full" />
            <div className="space-y-1.5">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-3.5 w-full rounded" />
              ))}
            </div>
          </div>
        ) : error ? (
          <EmptyState
            icon={ShieldAlert}
            title="Couldn't load payment status"
            description="There was an error fetching payment status data. Please try again."
            action={
              <Button size="sm" variant="soft-primary" onClick={() => window.location.reload()}>
                Retry
              </Button>
            }
          />
        ) : data && total > 0 ? (
          <>
            <div className="flex flex-1 flex-col justify-center">
              <PaymentDonutChart data={data.segments} centerTotal={total} height={220} />
              <div className="mt-1 space-y-1.5">
                {data.segments.map((s) => (
                  <div key={s.status} className="flex items-center gap-2 text-[11.5px]">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: PAYMENT_STATUS_COLORS[s.status] }}
                    />
                    <span className="truncate text-muted-foreground">{s.label}</span>
                    <span className="ml-auto font-semibold tabular-nums text-foreground">{compactCurrency(s.value)}</span>
                    <span className="w-8 text-right tabular-nums text-muted-foreground">
                      {total > 0 ? `${Math.round((s.value / total) * 100)}%` : '0%'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-auto pt-3">
              <Button variant="soft-primary" className="w-full" size="sm" onClick={onViewDetails}>
                View Details
              </Button>
            </div>
          </>
        ) : data ? (
          <EmptyState
            icon={IndianRupee}
            title="No payments yet"
            description="Once you record invoices, their paid and pending amounts break down here."
          />
        ) : null}
      </CardContent>
    </Card>
  )
}

function ConnectionBanner({
  lastSyncAt,
  shopifyStatus,
}: {
  lastSyncAt: string | null
  shopifyStatus: ShopifyStatus | null
}) {
  const fallbackSync = shopifyStatus
    ? Object.values(shopifyStatus.lastSync ?? {})
        .filter(Boolean)
        .sort()
        .pop() ?? null
    : null
  const syncedAt = lastSyncAt ?? fallbackSync
  return (
    <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 border-primary-100 bg-gradient-to-r from-primary-50/70 via-card to-card px-4 py-3">
      <ConnectionPill healthy={Boolean(shopifyStatus?.configured)} label="Shopify" sublabel={shopifyStatus?.configured ? 'Connected' : 'Not configured'} />
        <ConnectionPill healthy label="System" sublabel="Healthy" />
      <div className="ml-auto hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
        <CloudCog className="h-3.5 w-3.5 text-info-700" />
        Last sync: {syncedAt ? formatDateTime(syncedAt) : 'Never'}
      </div>
    </Card>
  )
}

function ConnectionPill({ healthy, label, sublabel }: { healthy: boolean; label: string; sublabel: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex h-2 w-2">
        <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', healthy ? 'bg-success' : 'bg-destructive')} />
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', healthy ? 'bg-success' : 'bg-destructive')} />
      </span>
      <div className="leading-tight">
        <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-xs font-semibold text-foreground">{sublabel}</p>
      </div>
    </div>
  )
}

function QuickActions() {
  const { hasPermission } = useAuth()
  const filtered = quickActions.filter((a) => !a.module || hasPermission(a.module, 'view'))
  return (
    <div className="flex flex-wrap items-center gap-2">
      {filtered.map((a) => (
        <a
          key={a.label}
          href={a.path}
          onClick={(e) => {
            if (a.path === '#') e.preventDefault()
          }}
          className="group flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 text-[12.5px] font-medium text-muted-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-primary-50 hover:text-primary-700"
        >
          <a.icon className="h-3.5 w-3.5" />
          {a.label}
        </a>
      ))}
    </div>
  )
}

function OperationalStrip({
  summary,
  analytics,
  rangeText,
}: {
  summary: Record<string, string | number | null>
  analytics: AnalyticsStat[]
  /** The selected period, so the expenses tile follows the page-wide date filter. */
  rangeText: string
}) {
  const statValue = (label: string) => analytics.find((s) => s.label === label)?.value ?? '—'
  const items: { label: string; value: string; icon: LucideIcon; tint: string }[] = [
    { label: 'Total Products', value: `${summary.totalProducts}`, icon: Gem, tint: 'bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300' },
    { label: 'Total Customers', value: `${summary.totalCustomers}`, icon: Users, tint: 'bg-info-50 text-info-700' },
    { label: 'Total Suppliers', value: `${summary.totalSuppliers}`, icon: BuildingIcon, tint: 'bg-warning-50 text-warning-700' },
    { label: 'Total Stock (Qty)', value: `${formatNumber(Number(summary.totalStockQty))} pcs`, icon: Boxes, tint: 'bg-success-50 text-success-700' },
    { label: 'Total Stock (Wt)', value: formatWeight(Number(summary.totalStockWeight)), icon: ScaleIcon, tint: 'bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300' },
    {
      // Follows the page-wide range: `rangeExpenses` covers the selected
      // window, while `todayExpenses` is always the current day only.
      label: `Expenses · ${rangeText}`,
      value: compactCurrency(Number(summary.rangeExpenses ?? summary.todayExpenses ?? 0)),
      icon: Wallet,
      tint: 'bg-warning-50 text-warning-700',
    },
    { label: 'Pending Payments', value: compactCurrency(Number(summary.pendingPayments)), icon: Clock, tint: 'bg-red-50 text-red-600 dark:text-red-400' },
    { label: 'Avg Order Value', value: statValue('Average Order Value'), icon: IndianRupee, tint: 'bg-success-50 text-success-700' },
    { label: 'Return Rate', value: statValue('Return Rate'), icon: Repeat, tint: 'bg-info-50 text-info-700' },
    { label: 'Inventory Value', value: statValue('Inventory Value'), icon: Boxes, tint: 'bg-warning-50 text-warning-700' },
  ]
  return (
    <Card className="divide-y divide-border overflow-hidden">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((it, i) => (
          <div key={it.label} className={cn('flex items-center gap-2.5', i < items.length - 1 && 'xl:border-r xl:border-border/70 xl:pr-4')}>
            <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', it.tint)}>
              <it.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[10.5px] uppercase tracking-wide text-muted-foreground">{it.label}</p>
              <p className="truncate text-[13px] font-semibold tabular-nums text-foreground">{it.value}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

const BuildingIcon = Landmark
const ScaleIcon = Boxes

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[120px] rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-16 rounded-lg" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Skeleton className="h-[320px] rounded-lg xl:col-span-1" />
        <Skeleton className="h-[320px] rounded-lg xl:col-span-1" />
        <Skeleton className="h-[320px] rounded-lg xl:col-span-1" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Skeleton className="h-[260px] rounded-lg xl:col-span-1" />
        <Skeleton className="h-[260px] rounded-lg xl:col-span-1" />
        <Skeleton className="h-[260px] rounded-lg xl:col-span-1" />
      </div>
    </div>
  )
}












