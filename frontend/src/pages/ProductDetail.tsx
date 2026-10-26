import { toast } from '@/components/ui/confirm'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeftRight,
  ChevronRight,
  Download,
  Edit,
  Gem,
  History,
  Package,
  PackageSearch,
  Receipt,
  RefreshCw,
  ShoppingBag,
  Tags,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateTime } from '@/lib/format'
import { exportTable } from '@/lib/export'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { ProductDialog } from '@/components/product-dialog'
import { productImageGallery } from '@/lib/product-image'
import { dbApi, shopifyApi } from '@/lib/api'
import type { Product, ProductVariant, SilverRate } from '@/types'
import { formatCurrency, formatDate, formatWeight } from '@/lib/format'
import { cn } from '@/lib/utils'

export default function ProductDetailPage() {
  const { id } = useParams()
  const [product, setProduct] = useState<Product | null>(null)
  const [loading, setLoading] = useState(true)
  const [silverRate, setSilverRate] = useState<SilverRate | null>(null)
  const [error, setError] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [galleryIdx, setGalleryIdx] = useState(0)
  // Shopify-style variant rows (loaded only when the product has options).
  const [variants, setVariants] = useState<ProductVariant[]>([])

  const loadVariants = (p: Product | null) => {
    if (!p?.id || !Array.isArray(p.options) || p.options.length === 0) {
      queueMicrotask(() => setVariants([]))
      return
    }
    dbApi.getProductVariants(p.id)
      .then(({ variants: rows }) => setVariants(rows ?? []))
      .catch(() => setVariants([]))
  }

  useEffect(() => {
    // Defer out of the effect body: setLoading fires synchronously
    // (react/set-state-in-effect).
    queueMicrotask(() => {
      setLoading(true)
      setError('')
      dbApi.getProductById(id ?? '')
        .then((p) => {
          setProduct(p ?? null)
          loadVariants(p ?? null)
          setLoading(false)
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : 'Could not load product')
          setLoading(false)
        })
      dbApi.getSilverRate().then(setSilverRate).catch(() => {})
    })
  }, [id])

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-10 w-96" />
        <Skeleton className="h-96 rounded-lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-[1400px] px-4 py-6">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      </div>
    )
  }

  if (!product) {
    return (
      <div className="mx-auto w-full max-w-[1400px] px-4 py-6">
        <p className="text-sm text-muted-foreground">Product not found.</p>
      </div>
    )
  }

  const syncShopify = async () => {
    if (!product) return
    setSyncing(true)
    try {
      const res = await shopifyApi.sync(['products'])
      const fresh = await dbApi.getProductById(product.id)
      if (fresh) setProduct(fresh)
      setNotice(`Shopify sync complete — ${res.results.products?.count ?? 0} products up to date.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  const rate = silverRate?.rate ?? product.silverRate ?? 0
  const gallerySrcs = productImageGallery(product)
  const mainIdx = Math.min(galleryIdx, Math.max(gallerySrcs.length - 1, 0))
  const netWeight = product.netWeight ?? 0
  const makingCharge = product.makingCharge ?? 0
  const stock = product.stock ?? 0
  const reorderLevel = product.reorderLevel ?? 0
  const costPrice = Number(product.costPrice ?? 0)
  const silverValue = netWeight * rate
  const makingTotal = netWeight * makingCharge
  const subtotal = silverValue + makingTotal
  const gstAmount = (subtotal * (product.gst ?? 3)) / 100

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/inventory/products" className="hover:text-primary-700">Products</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">{product.name}</span>
      </div>

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {gallerySrcs[0] ? (
              <img src={gallerySrcs[0]} alt="" className="h-11 w-11 rounded-lg object-cover ring-1 ring-border" />
            ) : (
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300 ring-1 ring-primary-100">
                <Gem className="h-5 w-5" />
              </div>
            )}
            {product.name}
            <Badge variant="success" className="align-middle">{product.status}</Badge>
          </span>
        }
        subtitle={`${product.sku} · ${product.category} · ${product.collection ?? '—'}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={syncShopify} disabled={syncing}>
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} /> Sync Shopify
            </Button>
            <Button size="sm" onClick={() => setEditOpen(true)}>
              <Edit className="h-3.5 w-3.5" /> Edit Product
            </Button>
          </>
        }
      />

      {notice ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-success-100 bg-success-50/60 px-4 py-3 text-sm text-success-700">
          <span className="mt-0.5 block h-2 w-2 shrink-0 rounded-full bg-success-600" />
          <p>{notice}</p>
        </div>
      ) : null}

      <ProductDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        mode="edit"
        product={product}
        onSaved={(saved, pushed) => {
          setProduct(saved)
          loadVariants(saved)
          setNotice(pushed
            ? `Updated "${saved.name}" and pushed it to Shopify (content, images and price where changed).`
            : `Updated "${saved.name}".`)
        }}
      />

      {gallerySrcs.length > 0 ? (
        <Card className="overflow-hidden">
          <CardContent className="flex gap-4 p-4">
            <div className="relative h-52 w-52 shrink-0 overflow-hidden rounded-lg bg-muted">
              <img src={gallerySrcs[mainIdx]} alt={product.name} className="h-full w-full object-cover" />
            </div>
            {gallerySrcs.length > 1 ? (
              <div className="flex max-h-52 flex-col gap-2 overflow-y-auto pr-1">
                {gallerySrcs.map((src, i) => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => setGalleryIdx(i)}
                    className={cn(
                      'h-16 w-16 shrink-0 overflow-hidden rounded-md ring-2 transition',
                      i === mainIdx ? 'ring-primary-500' : 'ring-transparent hover:ring-primary-200',
                    )}
                  >
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <QuickFact label="Selling Price" value={formatCurrency(product.sellingPrice)} sub={`Silver rate ₹${product.silverRate ?? '—'}/g · Making ₹${product.makingCharge ?? '—'}/g`} tint="purple" />
        <QuickFact label="Net Silver Weight" value={formatWeight(product.netWeight)} sub={`Gross ${formatWeight(product.grossWeight)} · Stone ${formatWeight(product.stoneWeight)}`} tint="green" />
        <QuickFact label="Available Stock" value={`${stock} pcs`} sub={`Reorder level ${reorderLevel} pcs`} tint={stock <= reorderLevel ? 'red' : 'blue'} />
      </div>

      {variants.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Variants</CardTitle>
            <CardDescription>
              {product.options?.map((o) => o.name).join(' × ') ?? 'Options'} — {variants.length} combination
              {variants.length === 1 ? '' : 's'}, each with its own SKU, price and stock.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Variant</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {variants.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-medium text-foreground">{v.title}</TableCell>
                      <TableCell className="font-mono text-xs">{v.sku}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(v.sellingPrice ?? 0)}</TableCell>
                      <TableCell className="text-right tabular-nums">{Math.floor(Number(v.stock) || 0)} pcs</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Tabs defaultValue="overview">
        <TabsList className="w-full justify-start overflow-x-auto bg-transparent p-0 shadow-none sm:w-auto sm:bg-muted/70 sm:p-1">
          {[
            { v: 'overview', label: 'Overview', icon: Gem },
            { v: 'pricing', label: 'Pricing', icon: Tags },
            { v: 'inventory', label: 'Inventory', icon: Package },
            { v: 'movements', label: 'Stock History', icon: ArrowLeftRight },
            { v: 'shopify', label: 'Shopify', icon: ShoppingBag },
            { v: 'sales', label: 'Sales History', icon: Receipt },
            { v: 'purchase', label: 'Purchase History', icon: PackageSearch },
            { v: 'audit', label: 'Audit History', icon: History },
          ].map((t) => (
            <TabsTrigger key={t.v} value={t.v} className="border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary-700 data-[state=active]:shadow-none rounded-none px-4 py-2">
              <t.icon className="h-3.5 w-3.5" /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm">Product Information</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
                <InfoRow label="Product Name" value={product.name} />
                <InfoRow label="SKU" value={product.sku} />
                <InfoRow label="HUID / Batch" value={product.huid ?? '—'} mono />
                <InfoRow label="Category" value={product.category} />
                <InfoRow label="Collection" value={product.collection} />
                <InfoRow label="Purity" value={product.purity != null ? `${product.purity}% Sterling Silver` : '—'} />
                <InfoRow label="Gross Weight" value={formatWeight(product.grossWeight)} />
                <InfoRow label="Stone Weight" value={formatWeight(product.stoneWeight)} />
                <InfoRow label="Net Silver Weight" value={formatWeight(product.netWeight)} />
                <InfoRow label="GST Rate" value={product.gst != null ? `${product.gst}%` : '—'} />
                <InfoRow label="HSN Code" value={product.hsn} mono />
                <InfoRow label="Supplier" value={product.supplier} />
                <InfoRow label="Created On" value={formatDate(product.createdAt)} />
                <InfoRow label="Status" value={product.status ?? '—'} />
                <InfoRow label="Shopify ID" value={product.shopifyId ?? 'Not listed'} mono />
                {product.description ? (
                  <div className="col-span-2 md:col-span-3">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Description</p>
                    <div
                      className="mt-1 text-sm text-foreground [&_b]:font-semibold [&_em]:italic [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-1 [&_strong]:font-semibold [&_ul]:list-inside"
                      dangerouslySetInnerHTML={{ __html: product.description }}
                    />
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Price Breakdown</CardTitle>
                <CardDescription>At current silver rate ₹{rate}/gm</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2.5">
                <PriceRow label="Silver Value" value={formatCurrency(silverValue)} />
                <PriceRow label="Making Charge" value={formatCurrency(makingTotal)} />
                <Separator />
                <PriceRow label="Subtotal" value={formatCurrency(subtotal)} />
                <PriceRow label={`GST @ 3%`} value={formatCurrency(gstAmount)} />
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-foreground">Final Price</span>
                  <span className="text-lg font-bold text-primary-700">{formatCurrency(subtotal + gstAmount)}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Listed on Shopify: {formatCurrency(product.sellingPrice)}
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="pricing">
          <Card>
            <CardContent className="p-5">
              <PricingEngine
                netWeight={product.netWeight}
                rate={rate}
                makingCharge={product.makingCharge}
                sellingPrice={product.sellingPrice}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inventory">
          <Card>
            <CardContent className="space-y-5 p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-semibold">Stock: {stock} pcs</p>
                  <p className="text-xs text-muted-foreground">
                    Reorder level {reorderLevel} pcs · {formatWeight(netWeight * stock)} net weight on hand
                  </p>
                </div>
                <Badge variant={stock <= reorderLevel ? 'danger' : 'success'} dot>
                  {stock <= reorderLevel ? 'Low Stock' : 'Healthy'}
                </Badge>
              </div>
              <div>
                <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
                  <span>Stock level</span>
                  <span>{stock} / {reorderLevel}</span>
                </div>
                <Progress
                  value={reorderLevel > 0 ? Math.min(100, (stock / reorderLevel) * 100) : 0}
                  indicatorClassName={stock <= reorderLevel ? 'bg-destructive' : 'bg-success'}
                />
              </div>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <MiniStat label="Available" value={`${stock} pcs`} />
                <MiniStat label="Weight on hand" value={formatWeight(netWeight * stock)} />
                <MiniStat
                  label="Value at cost"
                  value={costPrice > 0 ? formatCurrency(costPrice * stock) : '—'}
                  sub={costPrice > 0 ? `₹${costPrice.toFixed(0)}/pc` : 'no purchase cost yet'}
                />
                <MiniStat
                  label="Value at retail"
                  value={formatCurrency(silverValue * stock)}
                  sub={costPrice > 0 && silverValue > 0 ? `margin ${(((silverValue - costPrice) / silverValue) * 100).toFixed(1)}%` : undefined}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="movements">
          <StockHistory sku={product.sku} productName={product.name} />
        </TabsContent>

        <TabsContent value="shopify">
          <Card>
            <CardContent className="p-5">
              <ShopifySyncState id={product.shopifyId} status={product.shopifyStatus} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sales">
          <HistoryTable kind="sales" sku={product.sku} productName={product.name} />
        </TabsContent>

        <TabsContent value="purchase">
          <HistoryTable kind="purchase" sku={product.sku} productName={product.name} />
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardContent className="p-5">
              <HistoryTable kind="audit" sku={product.sku} productName={product.name} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function QuickFact({ label, value, sub, tint }: { label: string; value: string; sub?: string; tint: 'purple' | 'green' | 'blue' | 'red' }) {
  const tints = {
    purple: 'border-primary-100 bg-primary-50/60',
    green: 'border-success-100 bg-success-50/60',
    blue: 'border-info-100 bg-info-50/60',
    red: 'border-red-100 bg-red-50/60',
  }
  return (
    <div className={cn('rounded-lg border p-4', tints[tint])}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold text-foreground">{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('text-[13px] font-medium text-foreground', mono && 'font-mono')}>{value}</p>
    </div>
  )
}

function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-foreground">{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  )
}

const MOVEMENT_LABEL: Record<string, string> = {
  purchase_in: 'Purchase received',
  purchase_return_out: 'Purchase returned',
  sale_out: 'Sold',
  sale_return_in: 'Sales return',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  count_adjust: 'Stock count',
  shopify_sync: 'Shopify sync',
  opening: 'Opening balance',
  manual: 'Manual adjustment',
}

/** Column layout for the CSV export — plain accessors, no cells. */
const EXPORT_COLUMNS: Array<{ accessorKey: string; header: string }> = [
  { accessorKey: 'date', header: 'Date' },
  { accessorKey: 'type', header: 'Movement' },
  { accessorKey: 'location', header: 'Location' },
  { accessorKey: 'qty', header: 'Qty' },
  { accessorKey: 'stockAfter', header: 'Balance After' },
  { accessorKey: 'reference', header: 'Reference' },
  { accessorKey: 'note', header: 'Note' },
]

/**
 * The stock ledger for one product: every movement with the balance it left
 * behind, plus where the stock sits right now. Stock used to be a bare number
 * with no way to ask why.
 */
function StockHistory({ sku, productName }: { sku: string; productName: string }) {
  const [movements, setMovements] = useState<Awaited<ReturnType<typeof dbApi.getStockMovements>>>([])
  const [levels, setLevels] = useState<Awaited<ReturnType<typeof dbApi.getStockLevels>>>([])
  const [loading, setLoading] = useState(true)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      setLoading(true)
      Promise.all([dbApi.getStockMovements(sku, { from, to }), dbApi.getStockLevels(sku)])
        .then(([m, l]) => {
          if (cancelled) return
          setMovements(m)
          setLevels(l)
        })
        .catch(() => undefined)
        .finally(() => { if (!cancelled) setLoading(false) })
    })
    return () => { cancelled = true }
  }, [sku, from, to])

  // Ranges are for reading and reporting ("what left the shop in March"), so the
  // filtered set is what gets exported — not the whole ledger.
  const filtered = Boolean(from || to)

  const handleExport = () => {
    const rows = movements.map((m) => ({
      date: m.date ? new Date(m.date).toISOString() : '',
      type: MOVEMENT_LABEL[m.type] ?? m.type,
      location: m.locationId ?? '',
      qty: Number(m.qty ?? 0),
      stockAfter: Number(m.stockAfter ?? 0),
      reference: m.refType ? `${m.refType}${m.refId ? `:${m.refId}` : ''}` : '',
      note: m.note ?? '',
    }))
    exportTable(`stock-history-${productName.replace(/[^\w-]+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}`, EXPORT_COLUMNS, rows)
    toast.success(`Exported ${rows.length} movement${rows.length === 1 ? '' : 's'}`)
  }

  const clearRange = () => {
    setFrom('')
    setTo('')
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Stock by location</CardTitle>
          <CardDescription>Where this product is physically held right now.</CardDescription>
        </CardHeader>
        <CardContent>
          {levels.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No per-location balances yet. Stock is recorded against a location as soon as it first moves.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {levels.map((l) => (
                <div key={l.locationId} className="rounded-md border bg-card p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{l.locationId}</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{l.qty} pcs</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">Movement history</CardTitle>
              <CardDescription>
                Every change to this product&apos;s stock, with the balance it left behind.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="date"
                aria-label="From date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-8 w-[140px] text-xs"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                aria-label="To date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-8 w-[140px] text-xs"
              />
              {filtered ? (
                <Button variant="ghost" size="sm" onClick={clearRange} className="h-8 text-xs">
                  Clear
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={loading || movements.length === 0}
                className="h-8 text-xs"
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading history…</p>
          ) : movements.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {filtered
                ? 'No movements recorded in this date range.'
                : 'No movements recorded yet. Stock changes appear here from the moment the ledger starts tracking this product.'}
            </p>
          ) : (
            <ul className="divide-y">
              {movements.slice(0, 100).map((m) => {
                const qty = Number(m.qty ?? 0)
                const incoming = qty > 0
                return (
                  <li key={m.id} className="flex items-center justify-between gap-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {MOVEMENT_LABEL[m.type] ?? m.type}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {m.date ? formatDateTime(m.date) : '—'}
                        {m.locationId ? ` · ${m.locationId}` : ''}
                        {m.note ? ` · ${m.note}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={`text-sm font-semibold tabular-nums ${incoming ? 'text-success-600' : 'text-destructive'}`}>
                        {incoming ? '+' : ''}{qty}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        → {Number(m.stockAfter ?? 0)} on hand
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {!loading && movements.length > 100 ? (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Showing the 100 most recent of {movements.length} movements in range. Narrow the dates or export to
              CSV to see them all.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function PricingEngine({ netWeight, rate, makingCharge, sellingPrice }: { netWeight: number; rate: number; makingCharge: number; sellingPrice: number }) {
  const sv = netWeight * rate
  const mc = netWeight * makingCharge
  const sub = sv + mc
  const g = (sub * 3) / 100
  const total = sub + g
  const diff = total - sellingPrice
  return (
    <div className="grid grid-cols-1 gap-6 md:gap-8 md:grid-cols-2">
      <div className="space-y-2.5">
        <p className="text-sm font-semibold">Pricing Engine</p>
        <PriceRow label="Net Silver Weight" value={formatWeight(netWeight)} />
        <PriceRow label="Current Silver Rate" value={`₹${rate.toFixed(2)} / gm`} />
        <PriceRow label="Silver Value" value={formatCurrency(sv)} />
        <PriceRow label={`Making Charge @ ₹${makingCharge}/g`} value={formatCurrency(mc)} />
        <Separator />
        <PriceRow label="Subtotal" value={formatCurrency(sub)} />
        <PriceRow label={`GST @ 3%`} value={formatCurrency(g)} />
        <Separator />
        <PriceRow label="Computed Final Price" value={formatCurrency(total)} />
      </div>
      <div className="rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-semibold">Compare</p>
        <div className="mt-3 space-y-2">
          <PriceRow label="Computed price" value={formatCurrency(total)} />
          <PriceRow label="Current Shopify price" value={formatCurrency(sellingPrice)} />
          <div className={cn('mt-2 flex items-center justify-between rounded-md px-3 py-2', Math.abs(diff) < 0.5 ? 'bg-success-50 text-success-700' : 'bg-warning-50 text-warning-700')}>
            <span className="text-sm font-medium">Difference</span>
            <span className="text-sm font-bold tabular-nums">
              {diff >= 0 ? '+' : ''}{formatCurrency(diff)}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Price sync to Shopify is triggered only after admin approval in Silver Rate management.
          </p>
        </div>
      </div>
    </div>
  )
}

function ShopifySyncState({ id, status }: { id?: string; status: Product['shopifyStatus'] }) {
  const states: Record<NonNullable<Product['shopifyStatus']>, { label: string; cls: string }> = {
    synced: { label: 'Product is synced with Shopify', cls: 'bg-success-50 text-success-700' },
    pending: { label: 'Price update pending admin approval', cls: 'bg-warning-50 text-warning-700' },
    'not-listed': { label: 'Not listed on Shopify yet', cls: 'bg-muted text-muted-foreground' },
    error: { label: 'Sync failed — retry required', cls: 'bg-red-50 text-red-600 dark:text-red-400' },
  }
  const s = states[status ?? 'not-listed'] ?? { label: 'Not listed on Shopify yet', cls: 'bg-muted text-muted-foreground' }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="flex items-center gap-3">
          <div className={cn('flex h-10 w-10 items-center justify-center rounded-md', s.cls)}>
            <ShoppingBag className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Shopify listing</p>
            <p className="text-xs text-muted-foreground">{s.label}</p>
          </div>
        </div>
        <Badge variant={status === 'synced' ? 'success' : status === 'pending' ? 'warning' : status === 'error' ? 'danger' : 'muted'} dot>
          {s.label.split(' ')[0]}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MiniStat label="Shopify ID" value={id ?? '—'} />
        <MiniStat label="Sync status" value={status ?? '—'} />
      </div>
    </div>
  )
}

interface HistoryRow {
  cells: string[]
  first?: boolean
}

function HistoryTable({ kind, sku, productName }: { kind: 'sales' | 'purchase' | 'audit'; sku: string; productName: string }) {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [available, setAvailable] = useState(true)

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      setLoading(true)
      setAvailable(true)

    const load =
      kind === 'sales'
        ? dbApi.getInvoicesWithItems().then((invoices) =>
            invoices.flatMap((inv) =>
              (inv.items ?? [])
                .filter((it) => it.sku === sku)
                .map((it) => ({
                  cells: [
                    inv.number,
                    formatDate(inv.date),
                    inv.customer,
                    `${it.qty} pcs`,
                    `${Number(it.weight).toFixed(2)} gm`,
                    formatCurrency(Number(it.amount)),
                  ],
                })),
            ),
          )
        : kind === 'purchase'
          ? Promise.resolve([])
          : dbApi
              .getAuditLogs()
              .then((logs) =>
                logs
                  .filter((l) => (l.entity ?? '').toLowerCase().includes(sku.toLowerCase()) || (l.entity ?? '').toLowerCase().includes(productName.toLowerCase()))
                  .slice(0, 20)
                  .map((l) => ({
                    first: true,
                    cells: [formatDate(l.timestamp), l.user, l.action, l.changes],
                  })),
              )
              .then((rows) => {
                setAvailable(rows.length > 0)
                return rows
              })

    load
      .then((data) => {
        if (!cancelled) {
          if (kind === 'purchase') {
            setAvailable(false)
          } else if (kind === 'sales' && data.length === 0) {
            setAvailable(false)
          }
          setRows(data)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable(false)
          setLoading(false)
        }
      })
    })

    return () => {
      cancelled = true
    }
  }, [kind, sku, productName])

  const columns: { label: string; align?: 'right' }[] =
    kind === 'sales'
      ? [
          { label: 'Invoice' },
          { label: 'Date' },
          { label: 'Customer' },
          { label: 'Qty' },
          { label: 'Weight' },
          { label: 'Amount', align: 'right' },
        ]
      : kind === 'purchase'
        ? [
            { label: 'Purchase Invoice' },
            { label: 'Date' },
            { label: 'Supplier' },
            { label: 'Rate' },
            { label: 'Qty' },
            { label: 'Cost', align: 'right' },
          ]
        : [
            { label: 'Timestamp' },
            { label: 'User' },
            { label: 'Action' },
            { label: 'Changes' },
          ]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{kind === 'sales' ? 'Sales History' : kind === 'purchase' ? 'Purchase History' : 'Audit History'}</CardTitle>
        <CardDescription>Recent activity for {sku}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">Loading...</div>
        ) : !available ? (
          <div className="flex h-24 items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {kind === 'purchase'
              ? 'Purchase line items are not tracked per product yet.'
              : kind === 'sales'
                ? 'No sales recorded for this product.'
                : 'No audit events reference this product.'}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c.label} className={cn(c.align === 'right' && 'text-right')}>{c.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  {r.cells.map((cell, ci) => (
                    <TableCell key={ci} className={cn(columns[ci]?.align === 'right' && 'text-right tabular-nums')}>
                      <span className={cn(r.first || ci === 0 ? 'font-medium text-foreground' : 'text-muted-foreground')}>{cell}</span>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
