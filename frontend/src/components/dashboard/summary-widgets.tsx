import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Calendar,
  ChevronLeft,
  ChevronRight,
  IndianRupee,
  Search,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Wallet,
} from 'lucide-react'
import { dbApi } from '@/lib/api'
import type {
  CustomerPaymentsWidget,
  OrderSummary,
  PurchaseOrdersWidget,
  RangeQuery,
  RecentInvoicesWidget,
  SalesOrdersWidget,
  SupplierPaymentsWidget,
} from '@/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { OrderSummaryBarChart, StatusDonutChart, WidgetBarChart } from '@/components/charts/dashboard-widget-charts'
import { SERIES_COLORS } from '@/components/charts/chart-theme'
import { StatusPill } from '@/components/ui/status-pill'
import { humanizeStatus, statusTone } from '@/lib/status'
import { compactCurrency, formatDate, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

const STATUS_BAR_COLORS = {
  success: SERIES_COLORS[2],
  warning: SERIES_COLORS[3],
  danger: '#E5484D',
  info: SERIES_COLORS[1],
  neutral: '#94A3B8',
} as const

function WidgetAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="gap-1 px-2 text-link" onClick={onClick}>
      {label} <ArrowRight className="h-3.5 w-3.5" />
    </Button>
  )
}

function ErrorRow({ message }: { message: string }) {
  return <p className="py-8 text-center text-xs text-muted-foreground">{message}</p>
}

function EmptyRow({ message }: { message: string }) {
  return <p className="py-8 text-center text-xs text-muted-foreground">{message}</p>
}

function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
}

function shiftMonth(value: string, months: number): string {
  const [year, month] = value.split('-').map(Number)
  const date = new Date(year, month - 1 + months, 1)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}

function monthTitle(value: string): string {
  const [year, month] = value.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
}

/** Grouped Online vs In-store bars with its own week/month/year grain. */
export function OrderSummaryCard() {
  const [grain, setGrain] = useState<'week' | 'month' | 'year'>('week')
  const [month, setMonth] = useState(currentMonth)
  const [data, setData] = useState<OrderSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    dbApi
      .getOrderSummary(grain, month)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load order summary")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [grain, month])

  const step = grain === 'week' ? 1 : 12
  const totalOnline = data?.points.reduce((sum, p) => sum + p.online, 0) ?? 0
  const totalInStore = data?.points.reduce((sum, p) => sum + p.inStore, 0) ?? 0

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShoppingBag className="h-4 w-4 text-primary-700" /> Order Summary
          </CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {data?.label ?? monthTitle(month)} · Online vs in-store orders
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous period"
            onClick={() => setMonth((m) => shiftMonth(m, -step))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[88px] text-center text-xs font-medium tabular-nums text-foreground">
            {grain === 'week' ? monthTitle(month) : grain === 'month' ? month.slice(0, 4) : data?.label ?? month.slice(0, 4)}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next period"
            onClick={() => setMonth((m) => shiftMonth(m, step))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <select
            aria-label="Order summary grain"
            value={grain}
            onChange={(e) => setGrain(e.target.value as 'week' | 'month' | 'year')}
            className="h-8 rounded-md border border-input bg-card px-2 text-xs font-medium text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : error ? (
          <ErrorRow message={error} />
        ) : !data || data.points.every((p) => p.online === 0 && p.inStore === 0) ? (
          <EmptyRow message="No orders in this period" />
        ) : (
          <>
            <OrderSummaryBarChart data={data.points} />
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: SERIES_COLORS[1] }} />
                Online <span className="font-semibold tabular-nums text-foreground">{formatNumber(totalOnline)}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: SERIES_COLORS[3] }} />
                In-store <span className="font-semibold tabular-nums text-foreground">{formatNumber(totalInStore)}</span>
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Latest supplier payments: daily spend chart + five latest rows. */
export function SupplierPaymentsCard({ range }: { range: RangeQuery }) {
  const { period, start, end } = range
  const navigate = useNavigate()
  const [data, setData] = useState<SupplierPaymentsWidget | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    dbApi
      .getSupplierPayments({ period, start, end }, { q: query, status })
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load supplier payments")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period, start, end, query, status])

  const tabs = [
    { key: 'all', label: 'All' },
    { key: 'settled', label: 'Settled' },
    { key: 'partial', label: 'Partial' },
    { key: 'unallocated', label: 'Unallocated' },
  ]

  return (
    <Card className="xl:col-span-2">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Wallet className="h-4 w-4 text-primary-700" /> Latest Payments
          </CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Payments made to suppliers</p>
        </div>
        <WidgetAction label="View all" onClick={() => navigate('/reports/supplier-dues')} />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[84px] w-full" />
        ) : error ? (
          <ErrorRow message={error} />
        ) : (
          <WidgetBarChart
            data={data?.points ?? []}
            color={SERIES_COLORS[1]}
            tooltipLabel="Paid"
            emptyMessage="No supplier payments in this period"
          />
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setStatus(tab.key)}
                className={cn(
                  'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                  status === tab.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <label className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search supplier or ref"
              className="h-8 w-44 rounded-md border border-input bg-card pl-7 pr-2 text-[11px] text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        </div>

        <div className="mt-2">
          {loading ? (
            <LoadingRows rows={4} />
          ) : (data?.rows.length ?? 0) === 0 ? (
            <EmptyRow message="No supplier payments in this period" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[11px]">Payment ID</TableHead>
                  <TableHead className="text-[11px]">Supplier</TableHead>
                  <TableHead className="text-[11px]">Purchase status</TableHead>
                  <TableHead className="text-[11px]">Payment status</TableHead>
                  <TableHead className="text-right text-[11px]">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-foreground">{row.ref}</TableCell>
                    <TableCell className="max-w-[150px] truncate text-muted-foreground">{row.supplier}</TableCell>
                    <TableCell>
                      <StatusPill status={row.purchaseStatus} />
                    </TableCell>
                    <TableCell>
                      <StatusPill status={row.paymentStatus} />
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums text-foreground">
                      {compactCurrency(row.total)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** Purchase order donut + latest incoming orders. */
export function PurchaseOrdersCard({ range }: { range: RangeQuery }) {
  const { period, start, end } = range
  const navigate = useNavigate()
  const [data, setData] = useState<PurchaseOrdersWidget | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    dbApi
      .getPurchaseOrdersWidget({ period, start, end })
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load purchase orders")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period, start, end])

  const totalOrders = data?.segments.reduce((sum, s) => sum + s.count, 0) ?? 0
  const slices =
    data?.segments.map((segment, index) => ({
      name: humanizeStatus(segment.status),
      value: segment.count,
      color: SERIES_COLORS[index % SERIES_COLORS.length],
    })) ?? []

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Truck className="h-4 w-4 text-primary-700" /> Purchase Orders
          </CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Incoming purchase orders</p>
        </div>
        <WidgetAction label="View all" onClick={() => navigate('/purchase/orders')} />
      </CardHeader>
      <CardContent>
        {loading ? (
          <LoadingRows rows={5} />
        ) : error ? (
          <ErrorRow message={error} />
        ) : totalOrders === 0 ? (
          <EmptyRow message="No purchase orders in this period" />
        ) : (
          <>
            <div className="grid grid-cols-2 items-center gap-2">
              <StatusDonutChart data={slices} centerLabel="Orders" centerValue={formatNumber(totalOrders)} height={150} />
              <div className="space-y-1.5">
                {slices.map((slice) => (
                  <div key={slice.name} className="flex items-center gap-1.5 text-[11px]">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: slice.color }} />
                    <span className="truncate text-muted-foreground">{slice.name}</span>
                    <span className="ml-auto font-semibold tabular-nums text-foreground">{slice.value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-2 divide-y">
              {data?.rows.map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate('/purchase/orders')}
                  className="flex w-full items-center gap-2 py-2 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] font-medium text-foreground">{row.number}</p>
                    <p className="truncate text-[10.5px] text-muted-foreground">
                      {row.supplier} · {row.expectedDate ? formatDate(row.expectedDate) : 'No ETA'}
                    </p>
                  </div>
                  <StatusPill status={row.status} />
                  <span className="w-16 text-right text-[11px] font-semibold tabular-nums text-foreground">
                    {compactCurrency(row.total)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Latest customer collections: daily receipts + five latest rows. */
export function CustomerPaymentsCard({ range }: { range: RangeQuery }) {
  const { period, start, end } = range
  const navigate = useNavigate()
  const [data, setData] = useState<CustomerPaymentsWidget | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    dbApi
      .getCustomerPayments({ period, start, end }, { q: query, status })
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load collections")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period, start, end, query, status])

  const tabs = [
    { key: 'all', label: 'All' },
    { key: 'paid', label: 'Paid' },
    { key: 'pending', label: 'Pending' },
  ]

  return (
    <Card className="xl:col-span-2">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <IndianRupee className="h-4 w-4 text-primary-700" /> Latest Collection
          </CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Collections received from customers</p>
        </div>
        <WidgetAction label="View all" onClick={() => navigate('/accounts/payments')} />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[84px] w-full" />
        ) : error ? (
          <ErrorRow message={error} />
        ) : (
          <WidgetBarChart
            data={data?.points ?? []}
            color={SERIES_COLORS[2]}
            tooltipLabel="Collected"
            emptyMessage="No collections in this period"
          />
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setStatus(tab.key)}
                className={cn(
                  'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                  status === tab.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <label className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customer or invoice"
              className="h-8 w-48 rounded-md border border-input bg-card pl-7 pr-2 text-[11px] text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        </div>

        <div className="mt-2">
          {loading ? (
            <LoadingRows rows={4} />
          ) : (data?.rows.length ?? 0) === 0 ? (
            <EmptyRow message="No collections in this period" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[11px]">Payment ID</TableHead>
                  <TableHead className="text-[11px]">Customer</TableHead>
                  <TableHead className="text-[11px]">Fulfilment status</TableHead>
                  <TableHead className="text-[11px]">Collection status</TableHead>
                  <TableHead className="text-right text-[11px]">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-foreground">{row.ref}</TableCell>
                    <TableCell className="max-w-[150px] truncate text-muted-foreground">{row.customer}</TableCell>
                    <TableCell>
                      <StatusPill status={row.fulfillment} />
                    </TableCell>
                    <TableCell>
                      <StatusPill status={row.paymentStatus} />
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums text-foreground">
                      {compactCurrency(row.total)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** Sales order donut + latest orders, beside Latest Collection. */
export function SalesOrdersCard({ range }: { range: RangeQuery }) {
  const { period, start, end } = range
  const navigate = useNavigate()
  const [data, setData] = useState<SalesOrdersWidget | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    dbApi
      .getSalesOrdersWidget({ period, start, end })
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load sales orders")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period, start, end])

  const totalOrders = data?.segments.reduce((sum, s) => sum + s.count, 0) ?? 0
  const slices =
    data?.segments.map((segment, index) => ({
      name: humanizeStatus(segment.status),
      value: segment.count,
      color: SERIES_COLORS[index % SERIES_COLORS.length],
    })) ?? []

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShoppingCart className="h-4 w-4 text-primary-700" /> Sales Orders
          </CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Latest sales orders</p>
        </div>
        <WidgetAction label="View all" onClick={() => navigate('/sales/orders')} />
      </CardHeader>
      <CardContent>
        {loading ? (
          <LoadingRows rows={5} />
        ) : error ? (
          <ErrorRow message={error} />
        ) : totalOrders === 0 ? (
          <EmptyRow message="No sales orders in this period" />
        ) : (
          <>
            <div className="grid grid-cols-2 items-center gap-2">
              <StatusDonutChart data={slices} centerLabel="Orders" centerValue={formatNumber(totalOrders)} height={150} />
              <div className="space-y-1.5">
                {slices.map((slice) => (
                  <div key={slice.name} className="flex items-center gap-1.5 text-[11px]">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: slice.color }} />
                    <span className="truncate text-muted-foreground">{slice.name}</span>
                    <span className="ml-auto font-semibold tabular-nums text-foreground">{slice.value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-2 divide-y">
              {data?.rows.map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate('/sales/orders')}
                  className="flex w-full items-center gap-2 py-2 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] font-medium text-foreground">{row.number}</p>
                    <p className="truncate text-[10.5px] text-muted-foreground">
                      {row.customer} · {formatDate(row.date)}
                    </p>
                  </div>
                  <StatusPill status={row.status} />
                  <span className="w-16 text-right text-[11px] font-semibold tabular-nums text-foreground">
                    {compactCurrency(row.total)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Recent invoices: six latest, click a row to open the invoice. */
export function RecentInvoicesCard({ range }: { range: RangeQuery }) {
  const { period, start, end } = range
  const navigate = useNavigate()
  const [data, setData] = useState<RecentInvoicesWidget | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    dbApi
      .getRecentInvoices({ period, start, end })
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load recent invoices")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [period, start, end])

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-primary-700" /> Recent Invoices
          </CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Latest invoices raised</p>
        </div>
        <WidgetAction label="View all" onClick={() => navigate('/sales/invoices')} />
      </CardHeader>
      <CardContent>
        {loading ? (
          <LoadingRows rows={6} />
        ) : error ? (
          <ErrorRow message={error} />
        ) : (data?.rows.length ?? 0) === 0 ? (
          <EmptyRow message="No invoices in this period" />
        ) : (
          <>
            <WidgetBarChart
              data={data?.statusPoints ?? []}
              getBarColor={(point) => STATUS_BAR_COLORS[statusTone(point.status ?? '')]}
              height={62}
              tooltipLabel="Invoiced"
              emptyMessage="No invoices in this period"
            />
            <div className="mt-2 divide-y">
              {data?.rows.map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/sales/invoices/${row.id}`)}
                  className="flex w-full items-center gap-2 py-2 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] font-medium text-foreground">{row.number}</p>
                    <p className="truncate text-[10.5px] text-muted-foreground">
                      {row.customer} · {formatDate(row.date)}
                    </p>
                  </div>
                  <StatusPill status={row.paymentStatus} />
                  <span className="w-16 text-right text-[11px] font-semibold tabular-nums text-foreground">
                    {compactCurrency(row.total)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
