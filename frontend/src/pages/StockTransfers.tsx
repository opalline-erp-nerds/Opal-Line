import { toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  CheckCircle2,
  Eye,
  Loader2,
  Plus,
  Search,
  Truck,
  XCircle,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { DataTable } from '@/components/ui/data-table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi } from '@/lib/api'
import type { InventoryLocation, Product, ProductVariant, StockTransfer, StockTransferDetail, TransferHistoryEntry, TransferStatus } from '@/types'
import { formatDateTime, formatNumber, formatWeight } from '@/lib/format'
import { resolveRouteEndpoint, routeOptionLabel, transferOwnerLabel, type RouteEndpoint } from '@/lib/transferRoute'

const statusVariant: Record<TransferStatus, { label: string; variant: 'success' | 'warning' | 'info' | 'muted' }> = {
  pending: { label: 'Pending', variant: 'warning' },
  'in-transit': { label: 'In Transit', variant: 'info' },
  received: { label: 'Received', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
}

export default function StockTransfersPage() {
  const [transfers, setTransfers] = useState<StockTransfer[]>([])
  const [locations, setLocations] = useState<InventoryLocation[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const [dialogOpen, setDialogOpen] = useState(false)
  const [receiveDialogOpen, setReceiveDialogOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detail, setDetail] = useState<StockTransferDetail | null>(null)
  const [form, setForm] = useState({ product: '', variant: '', from: '', to: '', qty: '' })
  // Variants of the picked product: a transfer moves ONE of them.
  const [variants, setVariants] = useState<ProductVariant[]>([])

  useEffect(() => {
    Promise.all([dbApi.getStockTransfers(), dbApi.getInventoryLocations(), dbApi.getProducts()]).then(
      ([t, l, p]) => {
        setTransfers(t)
        setLocations(l)
        setProducts(p)
        setLoading(false)
      },
    ).catch(() => setLoading(false))
  }, [])

  const load = useCallback(() => {
    dbApi.getStockTransfers().then(setTransfers).catch(() => {})
  }, [])

  const counts = useMemo(
    () => ({
      pending: transfers.filter((t) => t.status === 'pending').length,
      transit: transfers.filter((t) => t.status === 'in-transit').length,
      received: transfers.filter((t) => t.status === 'received').length,
      cancelled: transfers.filter((t) => t.status === 'cancelled').length,
    }),
    [transfers],
  )

  /**
   * The API resolves from/to into readable endpoints; resolveRouteEndpoint
   * also covers older payloads (id- or name-valued rows) and degrades a
   * deleted location to "Removed location" instead of leaking a UUID — which
   * is exactly what the old screen showed (`LOC-DEFAULT → <uuid>`).
   */
  const endpointFor = useCallback(
    (raw: string | null | undefined, enriched?: { name: string; type?: string | null; city?: string | null } | null): RouteEndpoint =>
      resolveRouteEndpoint(enriched, raw, locations),
    [locations],
  )
  const locationLabel = useCallback(
    (value: string | null | undefined, enriched?: { name: string; type?: string | null; city?: string | null } | null) =>
      endpointFor(value, enriched).title,
    [endpointFor],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return transfers.filter((t) => {
      const matchQ =
        !q ||
        t.number.toLowerCase().includes(q) ||
        t.product.toLowerCase().includes(q) ||
        t.sku.toLowerCase().includes(q) ||
        String(t.variantTitle ?? '').toLowerCase().includes(q) ||
        String(t.variantSku ?? '').toLowerCase().includes(q) ||
        locationLabel(t.from, t.fromLocation).toLowerCase().includes(q) ||
        locationLabel(t.to, t.toLocation).toLowerCase().includes(q)
      const matchStatus = !statusFilter || t.status === statusFilter
      return matchQ && matchStatus
    })
  }, [transfers, query, statusFilter, locationLabel])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const selectedProduct = products.find((p) => p.id === form.product)
  const selectedVariant = variants.find((v) => v.id === form.variant) ?? null
  // A product with more than one variant cannot be moved "as a whole": which
  // colour left the shelf would be a guess. Exactly one variant means the
  // choice is already made for the user.
  const needsVariant = variants.length > 1

  // The variant set belongs to the picked product. A single-variant product
  // selects its one variant automatically so the ordinary case needs no extra
  // click (and the backend resolves it anyway, belt and braces). The previous
  // product's set is cleared in the change handler rather than here: setState
  // synchronously inside an effect would re-render on every product change.
  useEffect(() => {
    let cancelled = false
    if (!form.product) return
    const productId = form.product
    queueMicrotask(() => {
      dbApi.getProductVariants(productId)
        .then((r) => {
          if (cancelled) return
          const list = r.variants ?? []
          setVariants(list)
          if (list.length === 1) {
            setForm((f) => (f.product === productId ? { ...f, variant: list[0]!.id } : f))
          }
        })
        .catch(() => { if (!cancelled) setVariants([]) })
    })
    return () => { cancelled = true }
  }, [form.product])

  // Stock is held per location AND per variant, so the source dropdown shows
  // what that location holds for the SELECTED variant — never the product's
  // total across variants (which is what made a Red transfer read White's
  // balance before).
  const [levels, setLevels] = useState<Array<{ locationId: string; qty: number }>>([])
  const selectedSku = selectedProduct?.sku
  const levelVariantId = form.variant

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!selectedSku) {
        setLevels([])
        return
      }
      dbApi.getStockLevels(selectedSku, levelVariantId || undefined).then((rows) => {
        if (!cancelled) setLevels(rows.map((r) => ({ locationId: r.locationId, qty: r.qty })))
      }).catch(() => { if (!cancelled) setLevels([]) })
    })
    return () => { cancelled = true }
  }, [selectedSku, levelVariantId])

  const availableAtSource = useMemo(() => {
    if (!selectedProduct || !form.from) return null
    // Nothing can be said about availability until the variant is chosen:
    // showing the product total there would invite an over-transfer.
    if (needsVariant && !form.variant) return null
    // form.from is the location's ID, the same key the stock-levels API uses.
    return levels.find((x) => x.locationId === form.from)?.qty ?? 0
  }, [selectedProduct, form.from, form.variant, needsVariant, levels])

  const handleCreate = async () => {
    const product = products.find((p) => p.id === form.product)
    if (!product || !form.from || !form.to || !form.qty || form.from === form.to) return
    const qty = Number(form.qty)
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      setError('Enter a positive whole-number quantity')
      return
    }
    if (needsVariant && !form.variant) {
      setError(`"${product.name}" has ${variants.length} variants — select the variant to move`)
      return
    }
    setSaving(true)
    setError('')
    try {
      // No number is sent: the backend mints it. A number derived from the
      // loaded list collides the moment two computers create transfers.
      // The variant names the exact units; a product with one variant sends it
      // too (auto-selected), and a variant-less legacy product sends none.
      await dbApi.createStockTransfer({
        from: form.from,
        to: form.to,
        sku: selectedVariant?.sku ?? product.sku,
        variantId: form.variant || undefined,
        qty,
        weight: Number((qty * (selectedVariant?.grossWeight ?? product.netWeight)).toFixed(1)),
      })
      setDialogOpen(false)
      setForm({ product: '', variant: '', from: '', to: '', qty: '' })
      toast.success('Transfer created — dispatch it to move the stock')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create transfer')
    } finally {
      setSaving(false)
    }
  }

  // Status is not a free-text field: each transition moves stock, so it has to
  // go through the endpoint that performs the matching ledger entries.
  const updateStatus = useCallback(async (id: string, status: TransferStatus, receivedQty?: number) => {
    try {
      if (status === 'received') await dbApi.receiveStockTransfer(id, receivedQty)
      else if (status === 'cancelled') await dbApi.cancelStockTransfer(id)
      else if (status === 'in-transit') await dbApi.dispatchStockTransfer(id)
      else return
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update transfer')
      throw e
    }
  }, [load])

  /** Detail view: one fetch, rendered from the enriched payload. */
  const openDetail = useCallback(async (id: string) => {
    setDetailOpen(true)
    setDetailLoading(true)
    setDetail(null)
    try {
      setDetail(await dbApi.getStockTransferDetail(id))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load transfer details')
      setDetailOpen(false)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  /**
   * Counted quantity per in-transit transfer. Seeded with the dispatched
   * quantity so a good delivery needs no typing, and any edit becomes the
   * variance the backend records.
   */
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({})

  const openReceive = useCallback((id: string, dispatched: number) => {
    setReceiveQty((prev) => ({ ...prev, [id]: prev[id] ?? String(dispatched) }))
    setReceiveDialogOpen(true)
  }, [])

  const receive = useCallback(async (t: StockTransfer) => {
    const raw = receiveQty[t.id]
    const counted = raw == null || raw === '' ? Number(t.qty) : Math.floor(Number(raw))
    if (!Number.isFinite(counted) || counted < 0) {
      toast.error('Enter a counted quantity of zero or more')
      return
    }
    const variance = counted - Number(t.qty)
    try {
      await dbApi.receiveStockTransfer(t.id, counted)
      setReceiveDialogOpen(false)
      setReceiveQty((prev) => { const next = { ...prev }; delete next[t.id]; return next })
      toast.success(
        variance === 0
          ? `${t.number} received in full`
          : `${t.number} received ${counted} of ${t.qty} — ${Math.abs(variance)} ${variance < 0 ? 'short' : 'over'}`,
      )
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to receive transfer')
    }
  }, [receiveQty, load])

  const columns = useMemo<ColumnDef<StockTransfer>[]>(
    () => [
      {
        accessorKey: 'number',
        header: 'Transfer',
        meta: { headerClassName: 'min-w-[140px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <ArrowLeftRight className="h-4 w-4" />
            </div>
            <div>
              <p className="font-medium text-foreground">{row.original.number}</p>
              <p className="text-[11px] text-muted-foreground">{formatDateTime(row.original.date)}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'product',
        header: 'Product',
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-foreground">{row.original.product}</p>
            <p className="text-[11px] text-muted-foreground">
              {row.original.variantTitle ? `${row.original.variantTitle} · ` : ''}
              {row.original.variantSku ?? row.original.sku}
            </p>
          </div>
        ),
      },
      {
        id: 'route',
        header: 'Route',
        meta: { headerClassName: 'min-w-[320px]' },
        cell: ({ row }) => {
          const from = endpointFor(row.original.from, row.original.fromLocation)
          const to = endpointFor(row.original.to, row.original.toLocation)
          return (
            <div className="min-w-0 space-y-1">
              <div className="flex items-start gap-2">
                <RouteEnd label="From" endpoint={from} />
                <span className="mt-5 shrink-0"><ArrowRightIcon /></span>
                <RouteEnd label="To" endpoint={to} />
              </div>
              {/* Where the stock sits right now — the question the old list never answered. */}
              <p className="text-[11px] text-muted-foreground">{transferOwnerLabel(row.original, locations)}</p>
            </div>
          )
        },
      },
      {
        accessorKey: 'qty',
        header: 'Qty',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums font-medium text-foreground">{formatNumber(row.original.qty)} pcs</span>,
      },
      {
        accessorKey: 'weight',
        header: 'Weight',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatWeight(row.original.weight)}</span>,
      },
      {
        accessorKey: 'initiatedBy',
        header: 'By',
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.initiatedByName ?? row.original.initiatedBy}</span>
        ),
      },
      {
        id: 'variance',
        header: 'Variance',
        meta: { align: 'right' as const },
        cell: ({ row }) => {
          const v = row.original.variance
          // Only a variance is news; a clean receipt shows a quiet dash.
          if (row.original.status !== 'received' || v == null || v === 0) {
            return <span className="text-xs text-muted-foreground">—</span>
          }
          return (
            <span className={`text-xs font-medium ${v < 0 ? 'text-destructive' : 'text-warning-600 dark:text-warning-500'}`}>
              {v < 0 ? `${Math.abs(v)} short` : `${v} over`}
              <span className="ml-1 font-normal text-muted-foreground">of {row.original.qty}</span>
            </span>
          )
        },
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const s = statusVariant[row.original.status]
          return <Badge variant={s.variant} dot>{s.label}</Badge>
        },
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const, headerClassName: 'w-10' },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <TooltipProvider delayDuration={200}>
              {row.original.status === 'pending' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => updateStatus(row.original.id, 'in-transit')}>
                      <Truck className="h-3.5 w-3.5 text-info-700" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Dispatch — stock leaves {locationLabel(row.original.from, row.original.fromLocation)}</TooltipContent>
                </Tooltip>
              )}
              {row.original.status === 'in-transit' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => updateStatus(row.original.id, 'received')}>
                      <ArrowDownToLine className="h-3.5 w-3.5 text-success-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Receive — stock arrives at {locationLabel(row.original.to, row.original.toLocation)}</TooltipContent>
                </Tooltip>
              )}
              {(row.original.status === 'pending' || row.original.status === 'in-transit') && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => updateStatus(row.original.id, 'cancelled')}>
                      <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel transfer</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => openDetail(row.original.id)}>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View transfer details</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [updateStatus, openDetail, locations, endpointFor, locationLabel],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Stock Transfer"
        subtitle="Move silver stock between stores, warehouses and the workshop."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => {
              const inTransit = transfers.find((t) => t.status === 'in-transit')
              if (inTransit) openReceive(inTransit.id, Number(inTransit.qty))
              else setReceiveDialogOpen(true)
            }}>
              <ArrowDownToLine className="h-3.5 w-3.5" /> Receive
            </Button>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" /> New Transfer
            </Button>
            <AppDialog
              open={receiveDialogOpen}
              onOpenChange={setReceiveDialogOpen}
              size="md"
              title="Receive Transfer"
              description="Select an in-transit transfer to mark as received."
              footer={
                <DialogFooter>
                  <Button variant="outline" onClick={() => setReceiveDialogOpen(false)}>Close</Button>
                </DialogFooter>
              }
            >
                {transfers.filter((t) => t.status === 'in-transit').length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">No transfers in transit.</p>
                ) : (
                  <div className="max-h-[340px] space-y-2 overflow-y-auto">
                    {transfers.filter((t) => t.status === 'in-transit').map((t) => {
                      const raw = receiveQty[t.id] ?? String(t.qty)
                      const counted = Number(raw)
                      const variance = Number.isFinite(counted) ? Math.floor(counted) - Number(t.qty) : 0
                      const invalid = raw === '' || !Number.isFinite(counted) || Math.floor(counted) < 0
                      return (
                        <div key={t.id} className="rounded-lg border p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-medium text-foreground">{t.number}</p>
                              <p className="truncate text-xs text-muted-foreground">{t.product} · dispatched {t.qty} pcs · {locationLabel(t.from, t.fromLocation)} → {locationLabel(t.to, t.toLocation)}</p>
                            </div>
                            <Button size="sm" disabled={invalid} onClick={() => receive(t)}>
                              <CheckCircle2 className="h-3.5 w-3.5" /> Receive
                            </Button>
                          </div>
                          <div className="mt-2.5 flex items-center gap-2">
                            <Label htmlFor={`recv-${t.id}`} className="text-xs text-muted-foreground">Counted</Label>
                            <Input
                              id={`recv-${t.id}`}
                              type="number"
                              min={0}
                              className="h-8 w-24 text-xs"
                              value={raw}
                              onChange={(e) => setReceiveQty((prev) => ({ ...prev, [t.id]: e.target.value }))}
                            />
                            {variance === 0 ? (
                              <span className="text-xs text-muted-foreground">matches dispatch</span>
                            ) : (
                              <span className={`text-xs font-medium ${variance < 0 ? 'text-destructive' : 'text-warning-600 dark:text-warning-500'}`}>
                                {variance < 0 ? `${Math.abs(variance)} short` : `${variance} over`}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
            </AppDialog>
            <AppDialog
              open={dialogOpen}
              onOpenChange={setDialogOpen}
              size="sm"
              isDirty={dialogOpen && Boolean(form.product || form.variant || form.from || form.to || form.qty)}
              title="New Stock Transfer"
              description="Select a product, the variant to move and the two locations."
              footer={
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                  <Button
                    onClick={handleCreate}
                    disabled={!form.product || !form.from || !form.to || form.from === form.to || !form.qty || Number(form.qty) < 1 || (needsVariant && !form.variant) || saving || (availableAtSource != null && Number(form.qty) > availableAtSource)}
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />} Create Transfer
                  </Button>
                </DialogFooter>
              }
            >
                <div className="grid gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="transfer-product">Product</Label>
                    <Select
                      id="transfer-product"
                      options={products.map((p) => ({ value: p.id, label: `${p.name} (${p.stock} in stock)` }))}
                      value={form.product}
                      onValueChange={(v) => {
                        setVariants([])
                        setForm((f) => ({ ...f, product: v, variant: '' }))
                      }}
                      placeholder="Select product"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="transfer-variant">Variant</Label>
                    <Select
                      id="transfer-variant"
                      options={variants.map((v) => ({
                        value: v.id,
                        label: `${v.title || v.name || 'Default'} · ${v.sku} · ${formatNumber(v.stock ?? 0)} pcs`,
                      }))}
                      value={form.variant}
                      onValueChange={(v) => setForm((f) => ({ ...f, variant: v }))}
                      placeholder={
                        !form.product
                          ? 'Select a product first'
                          : variants.length === 0
                            ? 'No variants — stock moves as one'
                            : 'Select variant'
                      }
                      disabled={!form.product || variants.length <= 1}
                    />
                    {needsVariant && !form.variant ? (
                      <p className="text-xs text-destructive">This product has {variants.length} variants — choose the one to move.</p>
                    ) : selectedVariant ? (
                      <p className="text-xs text-muted-foreground">
                        Moving <span className="font-medium text-foreground">{selectedVariant.title || selectedVariant.sku}</span> ({selectedVariant.sku})
                      </p>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="transfer-from">From</Label>
                      <Select
                        id="transfer-from"
                        options={locations.map((l) => {
                          // Per-VARIANT balance at each location; unknown until
                          // the variant is chosen (never the product total).
                          const held = needsVariant && !form.variant
                            ? null
                            : levels.find((x) => x.locationId === l.id)?.qty ?? 0
                          return {
                            value: l.id,
                            label: held != null && selectedProduct ? `${routeOptionLabel(l)} (${held} pcs)` : routeOptionLabel(l),
                            // The destination can never be the source: the
                            // option greys out instead of failing on submit.
                            disabled: form.to === l.id,
                          }
                        })}
                        value={form.from}
                        onValueChange={(v) => setForm((f) => ({ ...f, from: v }))}
                        placeholder="From location"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="transfer-to">To</Label>
                      <Select
                        id="transfer-to"
                        options={locations.map((l) => ({
                          value: l.id,
                          label: routeOptionLabel(l),
                          disabled: form.from === l.id,
                        }))}
                        value={form.to}
                        onValueChange={(v) => setForm((f) => ({ ...f, to: v }))}
                        placeholder="To location"
                      />
                    </div>
                  </div>
                  {form.from && form.to ? (
                    form.from === form.to ? (
                      <p className="text-xs text-destructive">Source and destination must be different locations.</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Route:{' '}
                        <span className="font-medium text-foreground">{endpointFor(form.from).title}</span>
                        {' → '}
                        <span className="font-medium text-foreground">{endpointFor(form.to).title}</span>
                      </p>
                    )
                  ) : null}
                  <div className="space-y-1.5">
                    <Label htmlFor="transfer-qty">Quantity (pcs)</Label>
                    <Input
                      id="transfer-qty"
                      type="number"
                      min={1}
                      placeholder={availableAtSource != null ? `Available here: ${availableAtSource}` : 'Enter quantity'}
                      value={form.qty}
                      onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))}
                    />
                    {availableAtSource != null ? (
                      form.qty && Number(form.qty) > availableAtSource ? (
                        <p className="text-xs text-destructive">
                          Only {availableAtSource} pcs{selectedVariant ? ` of ${selectedVariant.sku}` : ''} at the source — this transfer would take {form.qty}.
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">Available at source: {availableAtSource} pcs</p>
                      )
                    ) : needsVariant && !form.variant ? (
                      <p className="text-xs text-muted-foreground">Pick a variant to see what the source holds.</p>
                    ) : null}
                  </div>
                  {selectedProduct && form.qty ? (
                    <p className="text-xs text-muted-foreground">
                      Weight:{' '}
                      <span className="font-medium text-foreground">
                        {formatWeight(Number(form.qty) * (selectedVariant?.grossWeight ?? selectedProduct.netWeight))}
                      </span>{' '}
                      · {selectedVariant ? `${selectedProduct.name} — ${selectedVariant.title || selectedVariant.sku}` : selectedProduct.name}
                    </p>
                  ) : null}
                </div>
                {error ? <p className="px-6 pb-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
            </AppDialog>
            <AppDialog
              open={detailOpen}
              onOpenChange={(o) => {
                setDetailOpen(o)
                if (!o) setDetail(null)
              }}
              size="lg"
              title={detail ? `Transfer ${detail.number}` : 'Transfer details'}
              description="Full trail: who moved what, where it went, and who holds it now."
              footer={
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDetailOpen(false)}>Close</Button>
                </DialogFooter>
              }
            >
              {detailLoading || !detail ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {detailLoading ? 'Loading transfer…' : 'Transfer could not be loaded.'}
                </p>
              ) : (
                <div className="space-y-4">
                  {/* The one answer the old view never gave: who owns the stock now. */}
                  <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Stock now belongs to</p>
                    <p className="text-sm font-semibold text-foreground">
                      {detail.owner?.inTransit
                        ? 'In transit — held at neither location'
                        : detail.owner?.name ?? 'Unknown location'}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border p-3">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">From</p>
                      <p className="truncate text-sm font-medium text-foreground">
                        {endpointFor(detail.from, detail.fromLocation).title}
                      </p>
                      {endpointFor(detail.from, detail.fromLocation).subtitle ? (
                        <p className="text-xs text-muted-foreground">{endpointFor(detail.from, detail.fromLocation).subtitle}</p>
                      ) : null}
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">To</p>
                      <p className="truncate text-sm font-medium text-foreground">
                        {endpointFor(detail.to, detail.toLocation).title}
                      </p>
                      {endpointFor(detail.to, detail.toLocation).subtitle ? (
                        <p className="text-xs text-muted-foreground">{endpointFor(detail.to, detail.toLocation).subtitle}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-4">
                    <DetailField label="Product" value={detail.productName ?? detail.product} />
                    <DetailField label="Variant" value={detail.variantTitle ?? '—'} />
                    <DetailField label="SKU" value={detail.variantSku ?? detail.sku} mono />
                    <DetailField label="Quantity" value={`${formatNumber(detail.qty)} pcs`} />
                  </div>
                  <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-3">
                    <DetailField label="Weight" value={formatWeight(detail.weight)} />
                    <DetailField label="Transfer" value={`${detail.number}`} mono />
                    <DetailField label="Status" value={statusVariant[detail.status].label} />
                  </div>

                  <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-3">
                    <DetailField
                      label="Created by"
                      value={`${detail.initiatedByName ?? detail.initiatedBy ?? '—'} · ${formatDateTime(detail.date)}`}
                    />
                    <DetailField
                      label="Dispatched by"
                      value={
                        detail.dispatch
                          ? `${detail.dispatch.byName ?? detail.dispatch.by ?? '—'} · ${formatDateTime(detail.dispatch.at)}`
                          : 'Not dispatched'
                      }
                    />
                    <DetailField
                      label="Received by"
                      value={
                        detail.receive
                          ? `${detail.receive.byName ?? detail.receive.by ?? '—'} · ${formatDateTime(detail.receive.at)}`
                          : detail.status === 'received'
                            ? 'Received'
                            : 'Not received'
                      }
                    />
                  </div>

                  {(detail.status === 'received' || detail.receive?.note || detail.cancel) && (
                    <div className="space-y-1 rounded-lg border p-3 text-sm">
                      {detail.status === 'received' && (
                        <p className="text-foreground">
                          <span className="font-medium">Variance:</span>{' '}
                          {detail.variance == null || detail.variance === 0
                            ? 'none — counted quantity matched the dispatch'
                            : `${formatNumber(Math.abs(detail.variance))} ${detail.variance < 0 ? 'short' : 'over'} of ${formatNumber(detail.qty)} dispatched`}
                          {detail.receive?.note ? (
                            <span className="text-muted-foreground"> · {detail.receive.note}</span>
                          ) : null}
                        </p>
                      )}
                      {detail.cancel ? (
                        <p className="text-muted-foreground">
                          Cancelled by {detail.cancel.byName ?? detail.cancel.by ?? '—'} · {formatDateTime(detail.cancel.at)}
                        </p>
                      ) : null}
                    </div>
                  )}

                  <div>
                    <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Transfer history
                      {detail.variantTitle || detail.variantSku ? (
                        <span className="ml-2 normal-case tracking-normal text-foreground/70">
                          · {detail.variantTitle ?? ''}{detail.variantTitle && detail.variantSku ? ' ' : ''}{detail.variantSku ? `(${detail.variantSku})` : ''}
                        </span>
                      ) : null}
                    </p>
                    {(detail.history ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No stock movements yet{detail.status === 'pending' ? ' — the goods are still at the source.' : '.'}
                      </p>
                    ) : (
                      <ol className="space-y-2">
                        {(detail.history ?? []).map((h) => (
                          <li key={h.id} className="flex items-start gap-2.5 text-[12.5px]">
                            <span
                              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                                h.type === 'transfer_out' ? 'bg-info-500' : 'bg-success-500'
                              }`}
                            />
                            <div className="min-w-0">
                              <p className="text-foreground">
                                <span className="font-medium">{historyLine(h)}</span>
                                {h.stockAfter != null ? (
                                  <span className="text-muted-foreground"> · balance {formatNumber(h.stockAfter)}</span>
                                ) : null}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                {formatDateTime(h.date)}
                                {h.byName ?? h.by ? ` · ${h.byName ?? h.by}` : ''}
                                {h.note ? ` · ${h.note}` : ''}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
              )}
            </AppDialog>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={ArrowUpFromLine} title="Pending" value={String(counts.pending)} accent="orange" support="Awaiting dispatch" />
        <StatCard icon={Truck} title="In Transit" value={String(counts.transit)} accent="blue" support="On the move" />
        <StatCard icon={CheckCircle2} title="Received" value={String(counts.received)} accent="green" support="Completed" />
        <StatCard icon={XCircle} title="Cancelled" value={String(counts.cancelled)} accent="slate" support="Not dispatched" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search transfer, product, SKU, location..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[
                { value: '', label: 'All Status' },
                { value: 'pending', label: 'Pending' },
                { value: 'in-transit', label: 'In Transit' },
                { value: 'received', label: 'Received' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
              value={statusFilter}
              onValueChange={setStatusFilter}
              className="w-[140px]"
            />
            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <span><span className="font-semibold text-foreground">{filtered.length}</span> of {transfers.length} transfers</span>
            </div>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No transfers match your filters"
          />
        </CardContent>
      </Card>
    </div>
  )
}

function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 8h9M9 4.5L12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** One end of the route: tiny From/To label over the name and its context line. */
function RouteEnd({ label, endpoint }: { label: string; endpoint: RouteEndpoint }) {
  return (
    <div className="min-w-0 max-w-[150px]">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`truncate text-[12.5px] ${endpoint.missing ? 'italic text-muted-foreground' : 'font-medium text-foreground'}`}
        title={endpoint.subtitle ? `${endpoint.title} (${endpoint.subtitle})` : endpoint.title}
      >
        {endpoint.title}
      </p>
      {endpoint.subtitle ? <p className="truncate text-[10.5px] text-muted-foreground">{endpoint.subtitle}</p> : null}
    </div>
  )
}

/** Label/value pair inside the detail dialog. */
function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`truncate text-foreground ${mono ? 'font-mono text-[12.5px]' : ''}`} title={value}>
        {value}
      </p>
    </div>
  )
}

/** One ledger row as a sentence: dispatched / received / returned. */
function historyLine(h: TransferHistoryEntry): string {
  const where = h.locationName ?? (h.type === 'transfer_out' ? 'the source' : 'the destination')
  if (h.type === 'transfer_out') return `Dispatched ${formatNumber(h.qty)} pcs from ${where}`
  if (String(h.note ?? '').toLowerCase().includes('cancel')) {
    return `Returned ${formatNumber(h.qty)} pcs to ${where} — transfer cancelled`
  }
  return `Received ${formatNumber(h.qty)} pcs at ${where}`
}
