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
import type { InventoryLocation, Product, StockTransfer, TransferStatus } from '@/types'
import { formatDateTime, formatNumber, formatWeight } from '@/lib/format'

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
  const [form, setForm] = useState({ product: '', from: '', to: '', qty: '' })

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return transfers.filter((t) => {
      const matchQ =
        !q ||
        t.number.toLowerCase().includes(q) ||
        t.product.toLowerCase().includes(q) ||
        t.sku.toLowerCase().includes(q) ||
        (t.from ?? '').toLowerCase().includes(q)
      const matchStatus = !statusFilter || t.status === statusFilter
      return matchQ && matchStatus
    })
  }, [transfers, query, statusFilter])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const selectedProduct = products.find((p) => p.id === form.product)
  // Stock is held per location, so the source dropdown must show what that
  // location actually holds rather than the product's global total.
  const [levels, setLevels] = useState<Array<{ locationId: string; qty: number }>>([])
  const selectedSku = selectedProduct?.sku

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!selectedSku) {
        setLevels([])
        return
      }
      dbApi.getStockLevels(selectedSku).then((rows) => {
        if (!cancelled) setLevels(rows.map((r) => ({ locationId: r.locationId, qty: r.qty })))
      }).catch(() => { if (!cancelled) setLevels([]) })
    })
    return () => { cancelled = true }
  }, [selectedSku])

  const availableAtSource = useMemo(() => {
    if (!selectedProduct || !form.from) return null
    const loc = locations.find((l) => l.name === form.from)
    return levels.find((x) => x.locationId === loc?.id || x.locationId === form.from)?.qty ?? 0
  }, [selectedProduct, form.from, levels, locations])

  const handleCreate = async () => {
    const product = products.find((p) => p.id === form.product)
    if (!product || !form.from || !form.to || !form.qty || form.from === form.to) return
    const qty = Number(form.qty)
    if (Number.isNaN(qty) || qty <= 0) {
      setError('Enter a valid quantity')
      return
    }
    setSaving(true)
    setError('')
    try {
      await dbApi.createStockTransfer({
        number: `ST-${new Date().getFullYear()}-${String(transfers.length + 1).padStart(4, '0')}`,
        from: form.from,
        to: form.to,
        sku: product.sku,
        qty,
        weight: Number((qty * product.netWeight).toFixed(1)),
      })
      setDialogOpen(false)
      setForm({ product: '', from: '', to: '', qty: '' })
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
            <p className="text-[11px] text-muted-foreground">{row.original.sku}</p>
          </div>
        ),
      },
      {
        id: 'route',
        header: 'Route',
        meta: { headerClassName: 'min-w-[240px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5 text-[12.5px]">
            <span className="max-w-[130px] truncate text-muted-foreground">{row.original.from}</span>
            <ArrowRightIcon />
            <span className="max-w-[130px] truncate font-medium text-foreground">{row.original.to}</span>
          </div>
        ),
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
      { accessorKey: 'initiatedBy', header: 'By', cell: ({ row }) => <span className="text-muted-foreground">{row.original.initiatedBy}</span> },
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
                  <TooltipContent>Dispatch — stock leaves {row.original.from}</TooltipContent>
                </Tooltip>
              )}
              {row.original.status === 'in-transit' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => updateStatus(row.original.id, 'received')}>
                      <ArrowDownToLine className="h-3.5 w-3.5 text-success-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Receive — stock arrives at {row.original.to}</TooltipContent>
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
                  <Button variant="ghost" size="icon-sm" disabled>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{row.original.status === 'received' ? 'Received' : 'Available once received'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [updateStatus],
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
                              <p className="truncate text-xs text-muted-foreground">{t.product} · dispatched {t.qty} pcs · {t.from} → {t.to}</p>
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
              isDirty={dialogOpen && Boolean(form.product || form.from || form.to || form.qty)}
              title="New Stock Transfer"
              description="Select a product and the locations to move stock between."
              footer={
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                  <Button
                    onClick={handleCreate}
                    disabled={!form.product || !form.from || !form.to || form.from === form.to || !form.qty || Number(form.qty) < 1 || saving || (availableAtSource != null && Number(form.qty) > availableAtSource)}
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
                      onValueChange={(v) => setForm((f) => ({ ...f, product: v }))}
                      placeholder="Select product"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="transfer-from">From</Label>
                      <Select
                        id="transfer-from"
                        options={locations.map((l) => {
                          const held = levels.find((x) => x.locationId === l.id || x.locationId === l.name)?.qty
                          return {
                            value: l.name,
                            label: selectedProduct ? `${l.name} (${held ?? 0} pcs)` : l.name,
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
                        options={locations.map((l) => ({ value: l.name, label: l.name }))}
                        value={form.to}
                        onValueChange={(v) => setForm((f) => ({ ...f, to: v }))}
                        placeholder="To location"
                      />
                    </div>
                  </div>
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
                  </div>
                  {selectedProduct && form.qty ? (
                    <p className="text-xs text-muted-foreground">
                      Weight: <span className="font-medium text-foreground">{formatWeight(Number(form.qty) * selectedProduct.netWeight)}</span> · {selectedProduct.name}
                    </p>
                  ) : null}
                </div>
                {error ? <p className="px-6 pb-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
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
