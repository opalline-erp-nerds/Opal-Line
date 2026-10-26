import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@/lib/table'
import { Boxes, Clock, Download, Gem, Lightbulb, Package, PackageX, Search, TrendingUp, Weight } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { StatCard } from '@/components/ui/stat-card'
import { DataTable } from '@/components/ui/data-table'
import { dbApi } from '@/lib/api'
import { exportTable } from '@/lib/export'
import type {
  Product,
  ReorderSuggestion,
  SilverRate,
  StockAgingBucket,
  StockAgingBucketKey,
  StockAgingRow,
  StockCategory,
} from '@/types'
import { formatCurrency, formatDate, formatNumber, formatWeight } from '@/lib/format'
import { agingBadgeVariant, filterAgingRows, formatDaysInStock } from '@/lib/stockAging'
import { cn } from '@/lib/utils'

interface OverviewStats {
  totalProducts: number
  totalQuantity: number
  totalWeight: number
  inventoryValue: number
  lowStock: number
  outOfStock: number
}

const stockVariant: Record<string, { label: string; variant: 'success' | 'warning' | 'danger' | 'muted' }> = {
  ok: { label: 'In Stock', variant: 'success' },
  low: { label: 'Low Stock', variant: 'warning' },
  out: { label: 'Out of Stock', variant: 'danger' },
}

export default function StockOverviewPage() {
  const navigate = useNavigate()
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<StockCategory[]>([])
  const [overview, setOverview] = useState<OverviewStats | null>(null)
  const [rate, setRate] = useState<SilverRate | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [stockStatus, setStockStatus] = useState('')

  useEffect(() => {
    Promise.all([dbApi.getProducts(), dbApi.getStockCategories(), dbApi.getInventoryOverview(), dbApi.getSilverRate().catch(() => null)]).then(
      ([p, c, o, r]) => {
        setProducts(p)
        setCategories(c)
        setOverview(o)
        setRate(r)
        setLoading(false)
      },
    ).catch(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products.filter((p) => {
      const status = p.stock === 0 ? 'out' : p.stock <= p.reorderLevel ? 'low' : 'ok'
      const matchQ = !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
      const matchCategory = !category || p.category === category
      const matchStock = !stockStatus || status === stockStatus
      return matchQ && matchCategory && matchStock
    })
  }, [products, query, category, stockStatus])

  const maxCategoryQty = useMemo(() => Math.max(...categories.map((c) => c.qty), 1), [categories])

  const columns = useMemo<ColumnDef<Product>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Product',
        meta: { headerClassName: 'min-w-[220px]' },
        cell: ({ row }) => (
          <Link to={`/inventory/products/${row.original.id}`} className="group flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <Gem className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground group-hover:text-primary-700">{row.original.name}</p>
              <p className="text-[11px] text-muted-foreground">{row.original.sku}</p>
            </div>
          </Link>
        ),
      },
      { accessorKey: 'category', header: 'Category', cell: ({ row }) => <span className="text-muted-foreground">{row.original.category}</span> },
      { accessorKey: 'stock', header: 'Stock', cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.stock)} pcs</span>, meta: { align: 'right' as const } },
      {
        accessorKey: 'reorderLevel',
        header: 'Reorder Level',
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.reorderLevel}</span>,
        meta: { align: 'right' as const },
      },
      {
        id: 'weight',
        header: 'Weight',
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatWeight(row.original.stock * row.original.netWeight)}</span>,
        meta: { align: 'right' as const },
      },
      {
        accessorKey: 'sellingPrice',
        header: 'Stock Value',
        cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.stock * row.original.sellingPrice)}</span>,
        meta: { align: 'right' as const },
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const status = row.original.stock === 0 ? 'out' : row.original.stock <= row.original.reorderLevel ? 'low' : 'ok'
          const s = stockVariant[status]
          return <Badge variant={s.variant} dot>{s.label}</Badge>
        },
      },
    ],
    [],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Stock Overview"
        subtitle="Live view of product stock levels, weights and valuation across all locations."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/inventory/low-stock')}>
              <PackageX className="h-3.5 w-3.5" /> View Low Stock
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportTable('reorder-report.csv', columns, filtered)}>
              <TrendingUp className="h-3.5 w-3.5" /> Reorder Report
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard icon={Boxes} title="Total Products" value={overview ? formatNumber(overview.totalProducts) : '—'} accent="purple" support="SKUs in catalogue" />
        <StatCard icon={Package} title="Total Quantity" value={overview ? `${formatNumber(overview.totalQuantity)} pcs` : '—'} accent="blue" support="All locations" />
        <StatCard icon={Weight} title="Total Weight" value={overview ? formatWeight(overview.totalWeight) : '—'} accent="green" support="Net weight" />
        <StatCard icon={TrendingUp} title="Inventory Value" value={overview ? formatCurrency(overview.inventoryValue) : '—'} accent="orange" support={rate ? `@ ₹${rate.rate.toFixed(2)}/g` : '@ current rate'} />
        <StatCard icon={PackageX} title="Low Stock" value={overview ? String(overview.lowStock) : '—'} accent="red" support="Below reorder" />
        <StatCard icon={PackageX} title="Out of Stock" value={overview ? String(overview.outOfStock) : '—'} accent="slate" support="Zero quantity" />
      </div>

      <ReorderSuggestionsCard />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm">Category-wise Stock</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading && categories.length === 0 ? (
              <div className="h-5 w-full animate-pulse rounded bg-muted" />
            ) : (
              categories.map((c) => (
                <div key={c.category} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2 text-[13px]">
                    <p className="font-medium text-foreground">{c.category}</p>
                    <p className="tabular-nums text-muted-foreground">
                      {formatNumber(c.qty)} pcs · {formatCurrency(c.value, { compact: true })}
                    </p>
                  </div>
                  <Progress value={(c.qty / maxCategoryQty) * 100} className="h-1.5" />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">Products Stock Levels</CardTitle>
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {products.length} products
            </span>
          </CardHeader>
          <CardContent className="space-y-4 p-4 pt-0">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
              <div className="relative min-w-[220px] flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search name or SKU..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select
                options={[
                  { value: '', label: 'All Categories' },
                  ...categories.map((c) => ({ value: c.category, label: c.category })),
                ]}
                value={category}
                onValueChange={setCategory}
                className="w-[150px]"
              />
              <Select
                options={[
                  { value: '', label: 'All Status' },
                  { value: 'ok', label: 'In Stock' },
                  { value: 'low', label: 'Low Stock' },
                  { value: 'out', label: 'Out of Stock' },
                ]}
                value={stockStatus}
                onValueChange={setStockStatus}
                className="w-[130px]"
              />
            </div>

            <DataTable
              columns={columns}
              data={filtered}
              loading={loading}
              emptyMessage="No products match your filters"
            />
          </CardContent>
        </Card>
      </div>

      <AgingUnsoldStockCard />
    </div>
  )
}

/** Auto reorder suggestions: 90-day sales velocity vs. stock on hand. */
function ReorderSuggestionsCard() {
  const [suggestions, setSuggestions] = useState<ReorderSuggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    dbApi.reorderSuggestions()
      .then((r) => setSuggestions(r.data ?? []))
      .catch(() => setSuggestions([]))
      .finally(() => setLoading(false))
  }, [])

  const priorityBadge = (p: ReorderSuggestion['priority']) =>
    p === 'urgent'
      ? <Badge variant="danger" dot>Order now</Badge>
      : p === 'soon'
        ? <Badge variant="warning" dot>Soon</Badge>
        : <Badge variant="muted">Monitor</Badge>

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm"><Lightbulb className="h-4 w-4 text-amber-500 dark:text-amber-400" /> Smart Reorder Suggestions</CardTitle>
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : `Show (${suggestions.length})`}
        </button>
      </CardHeader>
      {open && (
        <CardContent>
          {loading ? (
            <p className="text-xs text-muted-foreground">Analysing 90-day sales velocity…</p>
          ) : suggestions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No reorder needed — stock levels look healthy across the catalogue.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Priority</th>
                    <th className="py-1.5 pr-3 font-medium">Product</th>
                    <th className="py-1.5 pr-3 font-medium">SKU</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Stock</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Sold 90d</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Weekly velocity</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Weeks of cover</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Suggested qty</th>
                    <th className="py-1.5 font-medium">Supplier</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.slice(0, 25).map((s) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">{priorityBadge(s.priority)}</td>
                      <td className="max-w-[180px] truncate py-1.5 pr-3 font-medium text-foreground">{s.name}</td>
                      <td className="py-1.5 pr-3 font-mono text-muted-foreground">{s.sku}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.stock}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.sold90d}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.weeklyVelocity}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.weeksOfCover >= 99 ? '—' : s.weeksOfCover}</td>
                      <td className="py-1.5 pr-3 text-right font-semibold tabular-nums text-primary-700">{s.suggestedQty}</td>
                      <td className="max-w-[120px] truncate py-1.5 text-muted-foreground">{s.supplier ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {suggestions.length > 25 && (
                <p className="pt-2 text-[11px] text-muted-foreground">Showing top 25 of {suggestions.length} suggestions.</p>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

/** Aging Unsold Stock: FIFO age of the units still on hand, with search/filters. */
function AgingUnsoldStockCard() {
  const [rows, setRows] = useState<StockAgingRow[]>([])
  const [buckets, setBuckets] = useState<StockAgingBucket[]>([])
  const [totals, setTotals] = useState<{ products: number; quantity: number; value: number; neverSold: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [bucket, setBucket] = useState<StockAgingBucketKey | ''>('')

  useEffect(() => {
    dbApi.getStockAging()
      .then((res) => {
        setRows(res.data ?? [])
        setBuckets(res.buckets ?? [])
        setTotals(res.totals ?? null)
      })
      .catch(() => setError('Aging data could not be loaded right now.'))
      .finally(() => setLoading(false))
  }, [])

  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rows],
  )
  const filtered = useMemo(() => filterAgingRows(rows, { query, category, bucket }), [rows, query, category, bucket])
  const hasFilters = Boolean(query.trim() || category || bucket)

  const columns = useMemo<ColumnDef<StockAgingRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Product',
        meta: { headerClassName: 'min-w-[200px]' },
        cell: ({ row }) => (
          <Link to={`/inventory/products/${row.original.id}`} className="group flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <Gem className="h-4 w-4" />
            </div>
            <span className="truncate font-medium text-foreground group-hover:text-primary-700">{row.original.name}</span>
          </Link>
        ),
      },
      {
        accessorKey: 'sku',
        header: 'SKU',
        cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.sku}</span>,
      },
      {
        accessorKey: 'quantity',
        header: 'Quantity',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.quantity)} pcs</span>,
      },
      {
        accessorKey: 'stockEntryDate',
        header: 'Stock Entry Date',
        cell: ({ row }) => <span className="text-muted-foreground">{formatDate(row.original.stockEntryDate)}</span>,
      },
      {
        accessorKey: 'lastSoldDate',
        header: 'Last Sold Date',
        cell: ({ row }) =>
          row.original.lastSoldDate ? (
            <span className="text-muted-foreground">{formatDate(row.original.lastSoldDate)}</span>
          ) : (
            <span className="text-muted-foreground/70">Never sold</span>
          ),
      },
      {
        accessorKey: 'daysInStock',
        header: 'Days in Stock',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums">{formatDaysInStock(row.original.daysInStock)}</span>,
      },
      {
        accessorKey: 'agingStatus',
        header: 'Aging Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => (
          <Badge variant={agingBadgeVariant(row.original.agingBucket)} dot>{row.original.agingStatus}</Badge>
        ),
      },
    ],
    [],
  )

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 text-warning-600 dark:text-warning-400" /> Aging Unsold Stock
        </CardTitle>
        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportTable('aging-unsold-stock.csv', columns, filtered)}
            disabled={loading || filtered.length === 0}
          >
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : `Show (${rows.length})`}
          </button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            
            {totals ? ` ${formatNumber(totals.products)} in-stock products · ${formatNumber(totals.neverSold)} never sold.` : ''}
          </p>

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {buckets.map((b) => {
              const active = bucket === b.key
              return (
                <button
                  key={b.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setBucket((current) => (current === b.key ? '' : b.key))}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors',
                    active
                      ? 'border-primary bg-primary-50/60 ring-1 ring-primary/20 dark:bg-primary-50/20'
                      : 'bg-card hover:bg-muted/40',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{b.label}</span>
                    <Badge variant={agingBadgeVariant(b.key)}>{formatNumber(b.count)}</Badge>
                  </div>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                    {formatNumber(b.quantity)} <span className="text-xs font-normal text-muted-foreground">pcs</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">{formatCurrency(b.value, { compact: true })} retail value</p>
                </button>
              )
            })}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search product name or SKU..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[{ value: '', label: 'All Categories' }, ...categories.map((c) => ({ value: c, label: c }))]}
              value={category}
              onValueChange={setCategory}
              className="w-[150px]"
            />
            <Select
              options={[{ value: '', label: 'All Ages' }, ...buckets.map((b) => ({ value: b.key, label: b.label }))]}
              value={bucket}
              onValueChange={(value) => setBucket(value as StockAgingBucketKey | '')}
              className="w-[140px]"
            />
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery('')
                  setCategory('')
                  setBucket('')
                }}
              >
                Clear
              </Button>
            )}
            <span className="text-xs text-muted-foreground sm:ml-auto">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {rows.length} products
            </span>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No in-stock products match your filters"
          />
        </CardContent>
      )}
    </Card>
  )
}
