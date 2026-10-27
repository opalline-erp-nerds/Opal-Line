import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@/lib/table'
import {
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Gem,
  Images,
  MoreHorizontal,
  Package,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  Upload,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { DialogFooter } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ProductDialog } from '@/components/product-dialog'
import { BulkImportDialog } from '@/components/bulk-import-dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi, shopifyApi, backupApi } from '@/lib/api'
import { exportTable } from '@/lib/export'
import type { Product } from '@/types'
import { formatCurrency, formatWeight } from '@/lib/format'
import { cn } from '@/lib/utils'
import { productImageSrc } from '@/lib/product-image'
import { PreviousSilverRate } from '@/components/products/previous-silver-rate'
import { useSilverRate } from '@/lib/silver-rate-context'

const shopifyVariant: Record<NonNullable<Product['shopifyStatus']>, { label: string; variant: 'success' | 'warning' | 'muted' | 'danger' }> = {
  synced: { label: 'Synced', variant: 'success' },
  pending: { label: 'Pending', variant: 'warning' },
  'not-listed': { label: 'Not Listed', variant: 'muted' },
  error: { label: 'Error', variant: 'danger' },
}

const statusVariant: Record<NonNullable<Product['status']>, 'success' | 'muted' | 'warning'> = {
  active: 'success',
  inactive: 'muted',
  draft: 'warning',
}

const PURE = '#7c3aed'
const GREEN = '#16a34a'
const ORANGE = '#f59e0b'
const RED = '#ef4444'

const productTints: Record<string, { bg: string; text: string }> = {
  'Silver Classic Ring': { bg: 'bg-primary-50', text: 'text-primary-700' },
  'Silver Bracelet': { bg: 'bg-info-50', text: 'text-info-700' },
  'Silver Chain': { bg: 'bg-success-50', text: 'text-success-700' },
  'Silver Pendant': { bg: 'bg-warning-50', text: 'text-warning-700' },
  'Silver Earrings': { bg: 'bg-red-50', text: 'text-red-600 dark:text-red-400' },
}

export default function ProductsPage() {
  const navigate = useNavigate()
  const { rate: silverRate } = useSilverRate()
  const [products, setProducts] = useState<Product[]>([])
  const [lastDayById, setLastDayById] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [error, setError] = useState('')
  const [pushMessage, setPushMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [query, setQuery] = useState('')
  const [colVis, setColVis] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('product-cols') ?? '{}')
    } catch {
      return {}
    }
  })
  const handleColVis = useCallback((v: Record<string, boolean>) => {
    setColVis(v)
    try {
      localStorage.setItem('product-cols', JSON.stringify(v))
    } catch { /* ignore */ }
  }, [])
  // Stable callbacks for the memoized DataTable — inline arrows here would
  // defeat the memo and bring the dialog-open lag back.
  const openProduct = useCallback((p: Product) => navigate(`/inventory/products/${p.id}`), [navigate])
  const [category, setCategory] = useState('')
  const [purity, setPurity] = useState('')
  const [stockStatus, setStockStatus] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Product | null>(null)
  const [duplicateOf, setDuplicateOf] = useState<Product | null>(null)
  const [bulkMode, setBulkMode] = useState<'csv' | 'images' | null>(null)
  const [selectedProducts, setSelectedProducts] = useState<Product[]>([])
  const [viewProduct, setViewProduct] = useState<Product | null>(null)
  const [reorderFor, setReorderFor] = useState<Product | null>(null)
  const [reorderQty, setReorderQty] = useState('')
  const [reorderSaving, setReorderSaving] = useState(false)
  const [duplicates, setDuplicates] = useState<Array<{ sku: string; cnt: number; products: string }>>([])

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    Promise.all([
      dbApi.getProducts(),
      dbApi.getProductLastDayPrices().catch(() => ({ data: [] as Array<{ productId: string; sellingPrice: number }> })),
    ])
      .then(([p, hist]) => {
        // Show newest-added first by default. created_at is a full
        // timestamp, so this sort is deterministic down to the second (ties
        // fall back to the API's stable sequence, so the list never reorders
        // on re-render); the API itself orders newest-first too.
        const withTime = p.map((product, index) => ({
          product,
          index,
          t: Date.parse(product.createdAt ?? ''),
        }))
        withTime.sort((a, b) => {
          const at = Number.isFinite(a.t) ? a.t : Number.NEGATIVE_INFINITY
          const bt = Number.isFinite(b.t) ? b.t : Number.NEGATIVE_INFINITY
          return bt !== at ? bt - at : a.index - b.index
        })
        setProducts(withTime.map((x) => x.product))
        const map: Record<string, number> = {}
        for (const row of hist.data ?? []) {
          if (Number.isFinite(row.sellingPrice)) map[row.productId] = row.sellingPrice
        }
        setLastDayById(map)
        setLoading(false)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Could not load products')
        setLoading(false)
      })
    dbApi
      .getProductDuplicates()
      .then((r) => setDuplicates(r.data))
      .catch(() => setDuplicates([]))
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  const syncShopify = async () => {
    setSyncing(true)
    setError('')
    setPushMessage(null)
    try {
      const result = await shopifyApi.syncProductsToDb()
      if (result.ok) {
        setPushMessage({
          ok: true,
          text: `Synced ${result.synced} live products from Shopify — ${result.created} created, ${result.updated} updated, ${result.removed} removed.`,
        })
      } else {
        setPushMessage({ ok: false, text: result.errors[0] ?? 'Shopify sync failed' })
      }
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Shopify sync failed')
    } finally {
      setSyncing(false)
    }
  }

  const pushProducts = useCallback(async (ids?: string[]) => {
    setPushing(true)
    setError('')
    setPushMessage(null)
    try {
      const result = await shopifyApi.pushProducts(ids)
      if (result.created > 0) {
        setPushMessage({ ok: true, text: `Pushed ${result.created} product${result.created === 1 ? '' : 's'} to Shopify.` })
      } else {
        setPushMessage({ ok: result.errors.length === 0, text: result.errors.length > 0 ? `Push failed: ${result.errors[0]}` : 'Nothing new to push — all products are already listed on Shopify.' })
      }
      if (result.created > 0) load()
    } catch (e) {
      setPushMessage({ ok: false, text: e instanceof Error ? e.message : 'Could not reach the backend server' })
    } finally {
      setPushing(false)
    }
  }, [load])

  const filtered = useMemo(() => {
    return products.filter((p) => {
      const q = query.trim().toLowerCase()
      const matchQuery =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q)
      const matchCategory = !category || p.category === category
      const matchPurity = !purity || String(p.purity) === purity
      const matchStock =
        !stockStatus ||
        (stockStatus === 'low' && (p.stock ?? 0) <= (p.reorderLevel ?? 0)) ||
        (stockStatus === 'out' && (p.stock ?? 0) === 0) ||
        (stockStatus === 'ok' && (p.stock ?? 0) > (p.reorderLevel ?? 0))
      return matchQuery && matchCategory && matchPurity && matchStock
    })
  }, [products, query, category, purity, stockStatus])

  const toggleStatus = useCallback(async (p: Product) => {
    const next = p.status === 'inactive' ? 'active' : 'inactive'
    try {
      await dbApi.update('products', p.id, { status: next })
      setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: next } : x)))
    } catch (e) {
      setPushMessage({ ok: false, text: e instanceof Error ? e.message : 'Could not update product' })
    }
  }, [])

  // Duplicate reuses the Add Product form, prefilled from the source product.
  // The unique field (SKU) is regenerated by the dialog; the user
  // reviews and saves like any new product.
  const duplicateProduct = useCallback((p: Product) => {
    setDuplicateOf(p)
    setAddOpen(true)
  }, [])

  const printLabelsFor = useCallback(
    (list: Product[]) => {
      const withIds = list.filter((p) => p.id)
      if (withIds.length === 0) return
      navigate(`/inventory/barcode?ids=${withIds.map((p) => p.id).join(',')}`)
    },
    [navigate],
  )

  const deleteProduct = useCallback(async (p: Product) => {
    const confirmed = await confirmDialog({
      title: `Delete "${p.name}"?`,
      description: `${p.sku} is removed from the catalog and will not appear in new invoices. Past invoices, stock movements and batches keep their records.`,
      danger: true,
      confirmLabel: 'Delete product',
    })
    if (!confirmed) return
    try {
      await dbApi.remove('products', p.id)
      load()
      // Undo re-creates with the SAME id: the generic create route honours a
      // client-supplied id, so stock levels, movements and variants reattach
      // to the restored product instead of pointing at a ghost row.
      toast.undoable('Product deleted', async () => {
        try {
          await dbApi.create('products', { ...p })
          load()
          toast.success('Delete undone — product restored')
        } catch {
          toast.error('Could not restore product')
        }
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete product')
    }
  }, [load])

  const columns = useMemo<ColumnDef<Product>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Product',
        meta: { headerClassName: 'min-w-[220px]' },
        cell: ({ row }) => {
          const tint = productTints[row.original.name] ?? { bg: 'bg-muted', text: 'text-muted-foreground' }
          return (
            <Link
              to={`/inventory/products/${row.original.id}`}
              className="group flex items-center gap-2.5"
            >
              {productImageSrc(row.original) ? (
                <img
                  src={productImageSrc(row.original)}
                  alt={row.original.name}
                  className="h-8 w-8 shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', tint.bg, tint.text)}>
                  <Gem className="h-4 w-4" />
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground group-hover:text-primary-700">{row.original.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {row.original.sku}
                  {(() => {
                    // Shopify-style options: show the combination count (what
                    // the stock actually splits into), not the option count.
                    const opts = Array.isArray(row.original.options) ? row.original.options : []
                    if (opts.length === 0) return ''
                    const combos = opts.reduce((a, o) => a * Math.max(1, o.values?.length ?? 0), 1)
                    return combos > 0 ? ` · ${combos} variant${combos === 1 ? '' : 's'}` : ''
                  })()}
                  {row.original.huid ? ` · HUID ${row.original.huid}` : ''}
                </p>
              </div>
            </Link>
          )
        },
      },
      {
        accessorKey: 'purity', header: 'Purity', cell: ({ row }) => <span className="tabular-nums">{row.original.purity != null ? `${row.original.purity}%` : '—'}</span>, meta: { align: 'right' as const } },
      { accessorKey: 'collection', header: 'Collection', cell: ({ row }) => <Badge variant="outline">{row.original.collection ?? '—'}</Badge> },
      { accessorKey: 'netWeight', header: 'Net Wt', cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatWeight(row.original.netWeight)}</span>, meta: { align: 'right' as const } },
      { accessorKey: 'makingCharge', header: 'Making', cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.makingCharge != null ? `${row.original.makingCharge} ₹/g` : '—'}</span>, meta: { align: 'right' as const } },
      { accessorKey: 'silverRate', header: 'Silver Rate', cell: ({ row }) => <span className="tabular-nums text-muted-foreground">₹{row.original.silverRate?.toFixed(2) ?? '—'}/g</span>, meta: { align: 'right' as const } },
      { id: 'previousSilverRate', header: 'Previous Silver Rate', cell: () => <PreviousSilverRate previousRate={silverRate?.previousRate} />, meta: { align: 'right' as const } },
      { accessorKey: 'sellingPrice', header: 'Selling Price', cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.sellingPrice)}</span>, meta: { align: 'right' as const } },
      {
        id: 'lastDayPrice',
        header: 'Last Day Price',
        meta: { align: 'right' as const },
        cell: ({ row }) => {
          const last = lastDayById[row.original.id]
          const today = row.original.sellingPrice
          if (last == null || !Number.isFinite(last)) {
            return <span className="text-muted-foreground">—</span>
          }
          const lastLabel = formatCurrency(last, { decimals: true })
          if (today == null || !Number.isFinite(today) || Math.round(today * 100) === Math.round(last * 100)) {
            return <span className="tabular-nums text-muted-foreground">{lastLabel} —</span>
          }
          const down = today < last
          return (
            <span className="inline-flex items-baseline justify-end gap-1.5 tabular-nums">
              <span className="font-medium text-foreground">{lastLabel}</span>
              <span className={down ? 'text-red-600 dark:text-red-400' : 'text-success-700 dark:text-emerald-400'}>
                {down ? '▼' : '▲'} {formatCurrency(Math.abs(today - last), { decimals: true })}
              </span>
            </span>
          )
        },
      },
      {
        id: 'cost',
        header: 'Cost',
        meta: { align: 'right' as const },
        cell: ({ row }) => {
          const cost = row.original.costPrice
          if (cost == null || !Number.isFinite(cost) || cost <= 0) {
            return <span className="text-[11px] text-muted-foreground">not set</span>
          }
          return <span className="tabular-nums text-muted-foreground">{formatCurrency(cost)}</span>
        },
      },
      { accessorKey: 'stock', header: 'Stock', cell: ({ row }) => {
        const stock = row.original.stock ?? 0
        const low = stock <= (row.original.reorderLevel ?? 0)
        return (
          <span className="flex items-center justify-end gap-1.5">
            {low ? <Badge variant="danger" dot>Reorder</Badge> : null}
            <span className={cn('font-medium tabular-nums', low ? 'text-red-600 dark:text-red-400' : 'text-foreground')}>{stock} pcs</span>
          </span>
        )
      }, meta: { align: 'right' as const } },
      {
        id: 'shopify',
        header: 'Shopify',
        cell: ({ row }) => {
          const s = shopifyVariant[row.original.shopifyStatus ?? 'not-listed'] ?? { label: 'Not Listed', variant: 'muted' as const }
          return <Badge variant={s.variant} dot>{s.label}</Badge>
        },
        meta: { align: 'center' as const },
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => <Badge variant={statusVariant[row.original.status ?? 'active'] ?? 'muted'}>{row.original.status ?? '—'}</Badge>,
        meta: { align: 'center' as const },
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const, headerClassName: 'w-10' },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => setEditTarget(row.original)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
            {row.original.shopifyStatus === 'synced' && row.original.shopifyId ? (
              <Tooltip>
                <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" asChild>
                  <a href={`/inventory/products/${row.original.id}`} onClick={(e) => { e.preventDefault(); window.open(`https://admin.shopify.com/products/${row.original.shopifyId}`, '_blank') }}>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
                </TooltipTrigger>
                <TooltipContent>View on Shopify</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" disabled={pushing} onClick={() => pushProducts([row.original.id])}>
                  <Upload className={cn('h-3.5 w-3.5', pushing && 'animate-pulse')} />
                </Button>
                </TooltipTrigger>
                <TooltipContent>Push to Shopify</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => duplicateProduct(row.original)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
              </TooltipTrigger>
              <TooltipContent>Duplicate</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => printLabelsFor([row.original])}
                title="Print label"
              >
                <Tags className="h-3.5 w-3.5" />
              </Button>
              </TooltipTrigger>
              <TooltipContent>Print Label</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="text-xs text-muted-foreground">More actions</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => toggleStatus(row.original)}>
                  {row.original.status === 'inactive' ? 'Activate' : 'Deactivate'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-red-600 dark:text-red-400 focus:text-red-600 dark:text-red-400" onClick={() => void deleteProduct(row.original)}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete product
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [pushProducts, pushing, toggleStatus, duplicateProduct, deleteProduct, printLabelsFor, lastDayById, silverRate],
  )

  return (
    <div className="w-full space-y-4 py-4 sm:space-y-5 sm:py-6">
      <div className="px-4 lg:px-6">
      <PageHeader
        title="Products"
        subtitle="Manage jewellery products, pricing, inventory and Shopify synchronization."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => pushProducts()} disabled={pushing || syncing}>
              <Upload className={cn('h-3.5 w-3.5', pushing && 'animate-pulse')} /> <span className="hidden sm:inline">{pushing ? 'Pushing...' : 'Push to Shopify'}</span><span className="sm:hidden">Push</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setBulkMode('csv')}>
              <FileSpreadsheet className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Import CSV</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setBulkMode('images')}>
              <Images className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Bulk Images</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => backupApi.downloadCatalogPdf()}>
              <Download className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Download Catalog</span>
            </Button>
            {selectedProducts.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => printLabelsFor(selectedProducts)}>
                <Tags className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Print Labels ({selectedProducts.length})</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => exportTable('products.csv', columns, filtered)}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button variant="outline" size="sm" onClick={syncShopify} disabled={syncing}>
              <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} /> <span className="hidden sm:inline">{syncing ? 'Syncing...' : 'Sync Live Products'}</span><span className="sm:hidden">Sync</span>
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        }
      />
      </div>

      {duplicates.length > 0 && (
        <Card className="mx-4 lg:mx-6">
          <CardContent className="flex flex-col gap-2 border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-950/30">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-amber-600 dark:text-amber-400 dark:text-amber-400" />
              <h3 className="font-semibold text-foreground">Duplicate SKUs detected ({duplicates.length})</h3>
            </div>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {duplicates.slice(0, 5).map((d) => (
                <li key={d.sku}>
                  <span className="font-mono font-medium text-foreground">{d.sku}</span> × {d.cnt} — {d.products}
                </li>
              ))}
              {duplicates.length > 5 && <li>…and {duplicates.length - 5} more</li>}
            </ul>
            <p className="text-xs text-muted-foreground">Duplicate SKUs cause inventory and sync conflicts. Rename all but one.</p>
          </CardContent>
        </Card>
      )}

      <ProductDialog
        open={addOpen}
        onOpenChange={(o) => {
          if (!o) setDuplicateOf(null)
          setAddOpen(o)
        }}
        mode="add"
        duplicateOf={duplicateOf}
        products={products}
        onEditProduct={(p) => {
          setAddOpen(false)
          setDuplicateOf(null)
          setEditTarget(p)
        }}
        onSaved={(product, pushed) => {
          setDuplicateOf(null)
          setPushMessage(pushed
            ? { ok: true, text: `Created "${product.name}" and pushed to Shopify.` }
            : { ok: true, text: `Created "${product.name}".` })
          load()
        }}
      />

      <ProductDialog
        open={editTarget !== null}
        onOpenChange={(o) => { if (!o) setEditTarget(null) }}
        mode="edit"
        product={editTarget}
        products={products}
        onSaved={(product, pushed) => {
          setEditTarget(null)
          setPushMessage(pushed
            ? { ok: true, text: `Updated "${product.name}" and pushed to Shopify.` }
            : { ok: true, text: `Updated "${product.name}".` })
          load()
        }}
      />

      <BulkImportDialog
        open={bulkMode !== null}
        onOpenChange={(o) => { if (!o) setBulkMode(null) }}
        mode={bulkMode ?? 'csv'}
        onDone={load}
      />

      <AppDialog
        open={viewProduct !== null}
        onOpenChange={(open) => { if (!open) setViewProduct(null) }}
        size="md"
        titleAdornment={
          productImageSrc(viewProduct ?? {}) ? (
            <img src={productImageSrc(viewProduct ?? {})} alt="" className="h-8 w-8 rounded-md object-cover" />
          ) : null
        }
        title={viewProduct?.name ?? 'Product'}
        description={viewProduct ? `${viewProduct.sku} · ${viewProduct.category}` : ''}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewProduct(null)}>Close</Button>
            <Button onClick={() => { setReorderFor(viewProduct); setReorderQty(String(Math.max(10, (viewProduct?.reorderLevel ?? 5) - (viewProduct?.stock ?? 0)))); setViewProduct(null) }}>
              <PackagePlus className="h-4 w-4" /> Quick Reorder
            </Button>
            <Button asChild>
              <Link to={`/inventory/products/${viewProduct?.id ?? ''}`}>
                <ExternalLink className="h-4 w-4" /> Full Page
              </Link>
            </Button>
          </DialogFooter>
        }
      >
        {viewProduct ? (
          <div className="space-y-0.5 text-sm">
            <DetailRow label="Purity" value={viewProduct.purity != null ? `${viewProduct.purity}%` : '—'} />
            <DetailRow label="Gross Weight" value={viewProduct.grossWeight != null ? formatWeight(viewProduct.grossWeight) : '—'} />
            <DetailRow label="Stone Weight" value={viewProduct.stoneWeight != null ? formatWeight(viewProduct.stoneWeight) : '—'} />
            <DetailRow label="Net Weight" value={viewProduct.netWeight != null ? formatWeight(viewProduct.netWeight) : '—'} />
            <DetailRow label="Making Charge" value={viewProduct.makingCharge != null ? `${viewProduct.makingCharge} ₹/g` : '—'} />
            <DetailRow label="Silver Rate" value={viewProduct.silverRate != null ? `₹${viewProduct.silverRate}/g` : '—'} />
            <DetailRow label="Selling Price" value={formatCurrency(viewProduct.sellingPrice)} />
            {viewProduct.compareAtPrice ? <DetailRow label="Compare At" value={formatCurrency(viewProduct.compareAtPrice)} /> : null}
            <DetailRow label="GST" value={viewProduct.gst != null ? `${viewProduct.gst}%` : '—'} />
            {viewProduct.hsn ? <DetailRow label="HSN" value={viewProduct.hsn} /> : null}
            <DetailRow label="Stock" value={`${viewProduct.stock ?? 0} pcs${(viewProduct.stock ?? 0) <= (viewProduct.reorderLevel ?? 0) ? ' · LOW' : ''}`} />
            <DetailRow label="Reorder Level" value={viewProduct.reorderLevel != null ? `${viewProduct.reorderLevel} pcs` : 'Not set'} />
            {viewProduct.supplier ? <DetailRow label="Supplier" value={viewProduct.supplier} /> : null}
            {viewProduct.collection ? <DetailRow label="Collection" value={viewProduct.collection} /> : null}
            {viewProduct.vendor ? <DetailRow label="Vendor" value={viewProduct.vendor} /> : null}
            {viewProduct.tags ? <DetailRow label="Tags" value={viewProduct.tags.split(',').join(', ')} /> : null}
            <DetailRow label="Shopify" value={viewProduct.shopifyStatus === 'synced' ? 'Synced' : viewProduct.shopifyStatus === 'pending' ? 'Pending' : viewProduct.shopifyStatus === 'error' ? 'Error' : 'Not Listed'} />
            <DetailRow label="Status" value={viewProduct.status ?? '—'} />
          </div>
        ) : null}
      </AppDialog>

      <AppDialog
        open={reorderFor !== null}
        onOpenChange={(open) => { if (!open) setReorderFor(null) }}
        size="sm"
        isDirty={reorderFor !== null && Number(reorderQty) !== Math.max(10, (reorderFor.reorderLevel ?? 5) - (reorderFor.stock ?? 0))}
        title={`Quick Reorder — ${reorderFor?.name ?? ''}`}
        description={reorderFor ? `Add stock for ${reorderFor.sku}` : ''}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setReorderFor(null)}>Cancel</Button>
            <Button
              disabled={reorderSaving || !Number(reorderQty)}
              onClick={async () => {
                if (!reorderFor) return
                setReorderSaving(true)
                try {
                  const qty = Number(reorderQty)
                  await dbApi.update('products', reorderFor.id, { stock: (reorderFor.stock ?? 0) + qty })
                  setPushMessage({ ok: true, text: `Stock updated: ${reorderFor.name} +${qty} pcs.` })
                  setReorderFor(null)
                  load()
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Update failed')
                } finally {
                  setReorderSaving(false)
                }
              }}
            >
              {reorderSaving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />} Add Stock
            </Button>
          </DialogFooter>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="reorder-qty">Quantity to add</Label>
          <Input id="reorder-qty" type="number" min="1" value={reorderQty} onChange={(e) => setReorderQty(e.target.value)} />
          <p className="text-xs text-muted-foreground">Current stock: {reorderFor?.stock ?? 0} pcs · Reorder level: {reorderFor?.reorderLevel ?? '—'}</p>
        </div>
      </AppDialog>

      {error ? (
        <div className="mx-4 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-700 lg:mx-6">
          <span className="mt-0.5 block h-2 w-2 shrink-0 rounded-full bg-red-600" />
          <p>{error}. Start the backend with <code className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs">npm run dev --prefix backend</code>.</p>
        </div>
      ) : null}

      {pushMessage ? (
        <div className={cn('mx-4 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm lg:mx-6', pushMessage.ok ? 'border-success-100 bg-success-50/60 text-success-700' : 'border-red-200 bg-red-50/60 text-red-700')}>
          <span className={cn('mt-0.5 block h-2 w-2 shrink-0 rounded-full', pushMessage.ok ? 'bg-success-600' : 'bg-red-600')} />
          <p>{pushMessage.text}</p>
        </div>
      ) : null}

      <Card className="rounded-none border-x-0 shadow-none">
        <CardContent className="space-y-4 p-0">
          <div className="flex flex-col gap-2 px-4 pt-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-0 flex-1 sm:min-w-[240px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search product name or SKU..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Select
                options={[
                  { value: '', label: 'All Categories' },
                  { value: 'Rings', label: 'Rings' },
                  { value: 'Chains', label: 'Chains' },
                  { value: 'Bracelets', label: 'Bracelets' },
                  { value: 'Earrings', label: 'Earrings' },
                  { value: 'Pendants', label: 'Pendants' },
                  { value: 'Mangalsutra', label: 'Mangalsutra' },
                  { value: 'Anklets', label: 'Anklets' },
                ]}
                value={category}
                onValueChange={setCategory}
                className="w-full sm:w-[150px]"
              />
              <Select
                options={[
                  { value: '', label: 'All Purity' },
                  { value: '92.5', label: '92.5% Sterling' },
                  { value: '99.9', label: '99.9% Fine' },
                ]}
                value={purity}
                onValueChange={setPurity}
                className="w-[calc(50%-4px)] sm:w-[130px]"
              />
              <Select
                options={[
                  { value: '', label: 'All Stock' },
                  { value: 'ok', label: 'In Stock' },
                  { value: 'low', label: 'Low Stock' },
                  { value: 'out', label: 'Out of Stock' },
                ]}
                value={stockStatus}
                onValueChange={setStockStatus}
                className="w-[calc(50%-4px)] sm:w-[130px]"
              />
            </div>
            <div className="ml-auto text-xs text-muted-foreground">
              <span>
                <span className="font-semibold text-foreground">{filtered.length}</span> of {products.length} products
              </span>
            </div>
          </div>

          <DataTable
            className="min-w-0"
            onRowDoubleClick={openProduct}
            onRowClick={setViewProduct}
            onSelectionChange={setSelectedProducts}
            columns={columns}
            data={filtered}
            loading={loading}
            columnVisibility={colVis}
            onColumnVisibilityChange={handleColVis}
            emptyMessage="No products match your filters"
          />
        </CardContent>
      </Card>

      <div className="mx-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 text-xs text-muted-foreground sm:gap-4 lg:mx-6">
        <LegendSwatch color={GREEN} label="Shopify synced" />
        <LegendSwatch color={ORANGE} label="Pending approval" />
        <LegendSwatch color={RED} label="Sync error" />
        <div className="ml-auto flex flex-wrap items-center gap-3 sm:gap-4">
          <span className="flex items-center gap-1.5"><Package className="h-3.5 w-3.5 text-primary" /> {products.length} products</span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-primary" />
            Silver rate applied: ₹{products[0]?.silverRate?.toFixed(2) ?? '—'} / gm
          </span>
        </div>
      </div>
    </div>
  )
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

export { PURE, GREEN, ORANGE, RED }

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  )
}
