import { useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import { AlertTriangle, ArrowUpRight, Boxes, Download, Search, TrendingUp, Warehouse } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, type SelectOption } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { dbApi } from '@/lib/api'
import { exportTable } from '@/lib/export'
import { LOCATION_UNAVAILABLE, locationTypeLabel } from '@/lib/locations'
import { formatCurrency, formatNumber } from '@/lib/format'
import { StockDemandBarChart, StockDemandDonut } from '@/components/charts/stock-demand-chart'

const demandFilterOptions: SelectOption[] = [
  { label: 'All Demand Levels', value: 'all' },
  { label: 'High Demand', value: 'high' },
  { label: 'Medium Demand', value: 'medium' },
  { label: 'Low Demand', value: 'low' },
  { label: 'No Sales', value: 'none' },
  { label: 'At Risk (≤7 days)', value: 'at-risk' },
]

type DemandFilter = 'all' | 'high' | 'medium' | 'low' | 'none' | 'at-risk'

export interface StockRunningLocation {
  id: string
  name: string
  type: string
  city?: string | null
  products: number
  quantity: number
  valueAtCost: number
  valueAtRetail: number
  margin: number
  marginPct: number
}

export interface StockRunningProduct {
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
}

interface StockRunningResponse {
  products: StockRunningProduct[]
  byLocation: StockRunningLocation[]
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

const demandBadge: Record<StockRunningProduct['demandLevel'], { label: string; variant: 'success' | 'warning' | 'danger' | 'muted' }> = {
  high: { label: 'High Demand', variant: 'success' },
  medium: { label: 'Medium Demand', variant: 'warning' },
  low: { label: 'Low Demand', variant: 'muted' },
  none: { label: 'No Sales', variant: 'muted' },
}

export default function StockRunningPage() {
  const [data, setData] = useState<StockRunningResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [demandFilter, setDemandFilter] = useState<DemandFilter>('all')
  // The product table is the cross-location rollup, which cannot answer
  // "what is sitting in the Andheri branch". This switches to the per-location
  // view that can.
  const [groupByLocation, setGroupByLocation] = useState(false)

  useEffect(() => {
    const fetch = async () => {
      setLoading(true)
      try {
        const d = await dbApi.getStockRunning()
        setData(d)
      } catch (e) {
        console.error('Failed to fetch stock running data:', e)
      } finally {
        setLoading(false)
      }
    }
    fetch()
  }, [])

  const filteredProducts = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.products.filter((p) => {
      const matchQ = !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
      const matchDemand = demandFilter === 'all' ||
        (demandFilter === 'at-risk' ? p.daysOfStock <= 7 && p.daysOfStock > 0 : p.demandLevel === demandFilter)
      return matchQ && matchDemand
    })
  }, [data, query, demandFilter])

  const columns = useMemo<ColumnDef<StockRunningProduct>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Product',
        meta: { headerClassName: 'min-w-[200px]' },
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.name}</p>
            <p className="text-[11px] text-muted-foreground">{row.original.sku}</p>
          </div>
        ),
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.category}</span>,
      },
      {
        accessorKey: 'currentStock',
        header: 'Stock',
        meta: { align: 'right' as const },
        cell: ({ row }) => {
          const stock = row.original.currentStock
          const reorder = row.original.reorderLevel
          const isLow = stock <= reorder
          return (
            <span className={isLow ? 'text-red-600 dark:text-red-400 font-bold' : 'font-semibold tabular-nums'}>
              {formatNumber(stock)}{isLow && <AlertTriangle className="ml-1 h-3 w-3 inline-block" />}
            </span>
          )
        },
      },
      {
        accessorKey: 'totalSold',
        header: 'Total Sold',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-semibold tabular-nums">{formatNumber(row.original.totalSold)}</span>,
      },
      {
        accessorKey: 'avgDailySales',
        header: 'Avg Daily Sales',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="font-mono tabular-nums text-primary-700">{row.original.avgDailySales.toFixed(2)}/day</span>
        ),
      },
      {
        accessorKey: 'daysOfStock',
        header: 'Days of Stock',
        meta: { align: 'right' as const },
        cell: ({ row }) => {
          const days = row.original.daysOfStock
          if (days >= 999) return <span className="text-muted-foreground">—</span>
          const isAtRisk = days <= 7 && days > 0
          const isLow = days <= 14 && days > 7
          return (
            <span className={isAtRisk ? 'text-red-600 dark:text-red-400 font-bold' : isLow ? 'text-orange-600' : 'text-foreground'}>
              {days}d {isAtRisk && <AlertTriangle className="ml-1 h-3 w-3 inline-block" />}
            </span>
          )
        },
      },
      {
        accessorKey: 'stockValue',
        header: 'Value at Cost',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-mono tabular-nums text-foreground">{formatCurrency(row.original.stockValueAtCost)}</span>,
      },
      {
        accessorKey: 'demandLevel',
        header: 'Demand',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const b = demandBadge[row.original.demandLevel]
          return <Badge variant={b.variant} dot>{b.label}</Badge>
        },
      },
    ],
    []
  )

  const locationColumns = useMemo<ColumnDef<StockRunningLocation>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Location',
        cell: ({ row }) => (
          // A level whose location row was deleted arrives as the shared
          // fallback from the API — styled quietly, never as a raw id.
          <span className={row.original.name === LOCATION_UNAVAILABLE ? 'italic text-muted-foreground' : 'font-medium text-foreground'}>
            {row.original.name}
          </span>
        ),
      },
      { accessorKey: 'type', header: 'Type', cell: ({ row }) => <Badge variant="muted">{locationTypeLabel(row.original.type) || '—'}</Badge> },
      { accessorKey: 'city', header: 'City', cell: ({ row }) => <span className="text-muted-foreground">{row.original.city || '—'}</span> },
      { accessorKey: 'products', header: 'Products', meta: { align: 'right' as const }, cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.products)}</span> },
      { accessorKey: 'quantity', header: 'Units', meta: { align: 'right' as const }, cell: ({ row }) => <span className="tabular-nums font-medium">{formatNumber(row.original.quantity)}</span> },
      { accessorKey: 'valueAtCost', header: 'Value at Cost', meta: { align: 'right' as const }, cell: ({ row }) => <span className="tabular-nums">{formatCurrency(row.original.valueAtCost)}</span> },
      {
        id: 'margin',
        header: 'Retail / Margin',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {formatCurrency(row.original.valueAtRetail)} · {row.original.marginPct}%
          </span>
        ),
      },
    ],
    [],
  )

  const highDemandCount = data?.products.filter(p => p.demandLevel === 'high').length || 0
  const mediumDemandCount = data?.products.filter(p => p.demandLevel === 'medium').length || 0
  const atRiskCount = data?.products.filter(p => p.daysOfStock > 0 && p.daysOfStock <= 7).length || 0

  return (
    <div className="mx-auto w-full max-w-[1800px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="Stock Running / Demand Analytics"
        subtitle="Track which products sell fastest, forecast stockouts, and prioritize reorders."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setGroupByLocation((v) => !v)}>
              <Warehouse className="h-4 w-4" /> {groupByLocation ? 'By location' : 'By product'}
            </Button>
          <Button variant="outline" size="sm" onClick={() => exportTable('stock-running', columns.filter(c => 'accessorKey' in c && typeof c.accessorKey === 'string'), filteredProducts)}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Products Analyzed</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground flex items-center gap-1"><Boxes className="h-5 w-5" /> {data?.summary.totalProducts || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">High Demand</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-success-600 flex items-center gap-1"><TrendingUp className="h-5 w-5" /> {highDemandCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Medium Demand</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-warning-600 flex items-center gap-1"><ArrowUpRight className="h-5 w-5" /> {mediumDemandCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">At Risk (≤7 days)</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-destructive flex items-center gap-1"><AlertTriangle className="h-5 w-5" /> {atRiskCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Inventory Value at Cost</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(data?.summary.totalStockValueAtCost || 0)}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Retail {formatCurrency(data?.summary.totalStockValue || 0)} · margin {formatCurrency(data?.summary.totalPotentialMargin || 0)}
            </p>
          </CardContent>
        </Card>
      </div>

      {groupByLocation ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-sm">Stock by location</CardTitle>
                <CardDescription>Where the stock physically sits, valued at cost.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => setGroupByLocation(false)}>
                <Boxes className="h-3.5 w-3.5" /> View by product
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={locationColumns}
              data={(data?.byLocation ?? []).filter((l) => {
                const q = query.trim().toLowerCase()
                return !q || l.name.toLowerCase().includes(q)
              })}
              loading={loading}
              emptyMessage="No per-location stock recorded yet"
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-sm">Top Products by Demand</CardTitle>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Average units sold per day (top 10)</p>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex h-[260px] items-center justify-center text-muted-foreground">Loading chart...</div>
            ) : data && data.products.length > 0 ? (
              <StockDemandBarChart products={data.products} />
            ) : (
              <div className="flex h-[260px] items-center justify-center text-muted-foreground">No data to display</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-sm">Demand Distribution</CardTitle>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Products grouped by sales velocity</p>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex h-[200px] items-center justify-center text-muted-foreground">Loading chart...</div>
            ) : data && data.products.length > 0 ? (
              <StockDemandDonut products={data.products} />
            ) : (
              <div className="flex h-[200px] items-center justify-center text-muted-foreground">No data to display</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search product name or SKU..." value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
            </div>
            <Select options={demandFilterOptions} value={demandFilter} onValueChange={(v: string) => setDemandFilter(v as DemandFilter)} className="w-[200px]" />
          </div>

          {loading ? (
            <div className="flex h-80 items-center justify-center text-muted-foreground">Loading demand analytics...</div>
          ) : filteredProducts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No products match the current filters</div>
          ) : (
            <DataTable columns={columns} data={filteredProducts} />
          )}

          {filteredProducts.length > 0 && (
            <div className="mt-6 pt-4 border-t">
              <h4 className="font-semibold mb-3">Quick Actions</h4>
              <div className="flex flex-wrap gap-3">
                {atRiskCount > 0 && (
                  <Button variant="destructive" size="sm" onClick={() => setDemandFilter('at-risk')}>
                    <AlertTriangle className="h-4 w-4" /> View {atRiskCount} At-Risk Products
                  </Button>
                )}
                {highDemandCount > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setDemandFilter('high')}>
                    <TrendingUp className="h-4 w-4" /> View {highDemandCount} High-Demand Products
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}