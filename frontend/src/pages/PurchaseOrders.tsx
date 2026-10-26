import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@/lib/table'
import { Building2, Check, CheckCircle2, Copy, Download, Eye, Loader2, PackageCheck, Pencil, Plus, Save, Search, ShoppingCart, Trash2, Wallet, Weight, XCircle } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi } from '@/lib/api'
import { toast } from '@/components/ui/confirm'
import { exportTable } from '@/lib/export'
import type { Product, PurchaseOrder, PurchaseOrderReceipt, Supplier } from '@/types'
import { formatCurrency, formatDate, formatWeight } from '@/lib/format'

/** One editable line on the new-PO form. */
interface DraftLine {
  sku: string
  product: string
  /** True when the row was chosen as "Other / type manually". */
  custom: boolean
  qty: string
  weight: string
  rate: string
  /** Ticked with the row's green check — counted, totalled and saved. */
  confirmed: boolean
}

function emptyLine(): DraftLine {
  return { sku: '', product: '', custom: false, qty: '1', weight: '0', rate: '0', confirmed: false }
}

/** A "custom" option lets a line be typed in when the SKU is not in the catalog. */
const CUSTOM_SKU = '__custom__'

/** Line total: Qty × Weight (g) × Rate (₹/g) — weight is the per-piece weight. */
function lineAmount(line: DraftLine): number {
  const qty = Math.max(1, Math.floor(Number(line.qty) || 1))
  const weight = Number(line.weight) || 0
  const rate = Number(line.rate) || 0
  return Math.round(qty * weight * rate * 100) / 100
}

/** All dialog currency: en-IN locale, ₹ symbol, 2 decimals. */
const inr = (n: number) => n.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })

const statusBadge: Record<PurchaseOrder['status'], { label: string; variant: 'warning' | 'success' | 'info' | 'muted' }> = {
  open: { label: 'Open', variant: 'warning' },
  received: { label: 'Received', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
  draft: { label: 'Draft', variant: 'info' },
  closed: { label: 'Closed', variant: 'muted' },
}

export default function PurchaseOrdersPage() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ supplier: '', supplierId: '', date: '', expectedDate: '', gst: '3' })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()])
  // Snapshot of the PO form as it opened, for the unsaved-changes close guard.
  const [formBaseline, setFormBaseline] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ supplier?: string; date?: string; lines?: string }>({})
  const [lineErrors, setLineErrors] = useState<Record<number, string>>({})
  const [viewPo, setViewPo] = useState<PurchaseOrder | null>(null)
  const [receipt, setReceipt] = useState<PurchaseOrderReceipt | null>(null)
  const [receiptLoading, setReceiptLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    dbApi.getPurchaseOrdersWithItems().then((d) => {
      setOrders(d)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  useEffect(() => {
    dbApi.getSuppliers().then(setSuppliers).catch(() => setSuppliers([]))
    dbApi.getProducts().then(setProducts).catch(() => setProducts([]))
  }, [])

  const openView = useCallback(async (po: PurchaseOrder) => {
    setViewPo(po)
    setReceipt(null)
    setReceiptLoading(true)
    try {
      setReceipt(await dbApi.getOrderReceipt(po.id))
    } catch {
      setReceipt(null)
    } finally {
      setReceiptLoading(false)
    }
  }, [])

  const openDialog = () => {
    const nextForm = {
      supplier: '',
      supplierId: '',
      date: new Date().toISOString().slice(0, 10),
      expectedDate: '',
      gst: '3',
    }
    const nextLines = [emptyLine()]
    setEditingId(null)
    setForm(nextForm)
    setLines(nextLines)
    setFormBaseline(JSON.stringify({ form: nextForm, lines: nextLines }))
    setError('')
    setFieldErrors({})
    setLineErrors({})
    setDialogOpen(true)
  }

  // Edit an existing PO — every field is prefilled and saved through the
  // full-edit endpoint (header fields + lines in one call).
  const openEdit = useCallback((po: PurchaseOrder) => {
    const nextForm = {
      supplier: po.supplier ?? '',
      supplierId: po.supplierId ?? '',
      date: po.date ? po.date.slice(0, 10) : '',
      expectedDate: po.expectedDate ? po.expectedDate.slice(0, 10) : '',
      gst: String(po.gst ?? 3),
    }
    // Saved lines arrive already "added" — they open confirmed.
    const nextLines =
      (po.lines ?? []).length > 0
        ? po.lines!.map((l) => ({
            sku: l.sku ?? '',
            product: l.product ?? '',
            custom: !(l.sku ?? '') && !!(l.product ?? ''),
            qty: String(l.qty ?? 1),
            weight: l.weight != null ? String(l.weight) : '0',
            rate: l.rate != null ? String(l.rate) : '0',
            confirmed: true,
          }))
        : [emptyLine()]
    setEditingId(po.id)
    setForm(nextForm)
    setLines(nextLines)
    setFormBaseline(JSON.stringify({ form: nextForm, lines: nextLines }))
    setError('')
    setFieldErrors({})
    setLineErrors({})
    setViewPo(null)
    setDialogOpen(true)
  }, [])

  const pickProduct = (index: number, sku: string) => {
    setLineErrors({})
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== index) return l
        if (sku === '') return { ...l, sku: '', custom: false, product: '', confirmed: false }
        if (sku === CUSTOM_SKU) return { ...l, sku: '', custom: true, product: '', confirmed: false }
        const p = products.find((x) => x.sku === sku)
        return { ...l, sku, custom: false, product: p?.name ?? l.product, weight: p ? String(p.netWeight ?? '') : l.weight }
      }),
    )
  }

  const setLine = (index: number, patch: Partial<DraftLine>) => {
    setLineErrors((prev) => {
      if (!(index in prev)) return prev
      const next = { ...prev }
      delete next[index]
      return next
    })
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  // Green check: a row only joins the "N items added" counter, the summary
  // and the saved payload once it has been confirmed.
  const confirmLine = (index: number) => {
    const line = lines[index]
    if (line.sku.trim() === '' && line.product.trim() === '') {
      setLineErrors((prev) => ({ ...prev, [index]: 'Select a product first' }))
      return
    }
    setLineErrors((prev) => {
      const next = { ...prev }
      delete next[index]
      return next
    })
    setFieldErrors((prev) => (prev.lines ? { ...prev, lines: undefined } : prev))
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, confirmed: !l.confirmed } : l)))
  }

  const duplicateLine = (index: number) => {
    setLineErrors({})
    setLines((prev) => {
      const next = [...prev]
      next.splice(index + 1, 0, { ...prev[index], confirmed: false })
      return next
    })
  }

  const removeLine = (index: number) => {
    setLineErrors({})
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))
  }

  // Confirmed rows only — the counter, the summary and the saved payload all
  // agree on what has actually been "added".
  const lineTotals = useMemo(() => {
    const added = lines.filter((l) => l.confirmed && (l.sku.trim() !== '' || l.product.trim() !== ''))
    return {
      count: added.length,
      qty: added.reduce((a, l) => a + (Math.max(1, Math.floor(Number(l.qty) || 1))), 0),
      weight: Math.round(added.reduce((a, l) => a + (Number(l.qty) || 1) * (Number(l.weight) || 0), 0) * 100) / 100,
      value: Math.round(added.reduce((a, l) => a + lineAmount(l), 0) * 100) / 100,
    }
  }, [lines])

  // Live GST breakdown — same math as the server (poMoneyTotals). Discount,
  // notes and status are not part of this form any more.
  const money = useMemo(() => {
    const subtotal = lineTotals.value
    const gstRate = Math.max(0, Number(form.gst) || 0)
    const gstAmount = Math.round(subtotal * gstRate) / 100
    const grandTotal = Math.round((subtotal + gstAmount) * 100) / 100
    return { subtotal, gstRate, gstAmount, grandTotal }
  }, [lineTotals.value, form.gst])

  const submit = async () => {
    // Required: Supplier and Order Date show inline errors; at least one line
    // must be confirmed with its green check.
    const nextErrors: { supplier?: string; date?: string; lines?: string } = {}
    if (!form.supplierId && !form.supplier) nextErrors.supplier = 'Supplier is required'
    if (!form.date) nextErrors.date = 'Order date is required'
    if (lineTotals.count === 0) nextErrors.lines = 'Confirm at least one line item'
    setFieldErrors(nextErrors)
    if (nextErrors.supplier || nextErrors.date || nextErrors.lines) return

    const gstRate = Math.max(0, Number(form.gst) || 0)
    if (gstRate > 100) {
      setError('GST must be between 0 and 100')
      return
    }
    const added = lines.filter((l) => l.confirmed && (l.sku.trim() !== '' || l.product.trim() !== ''))
    const linePayload = added.map((l) => ({
      product: l.product.trim(),
      sku: l.sku.trim(),
      qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
      weight: Number(l.weight) || 0,
      rate: Number(l.rate) || 0,
    }))
    setSaving(true)
    setError('')
    try {
      // The backend raises (or refreshes) the order's purchase invoice whenever
      // its lines are saved — surface the invoice number in the success toast.
      let autoInvoice: string | undefined
      const wasEditing = Boolean(editingId)
      if (editingId) {
        // One call: header fields + replacement lines. Totals (subtotal,
        // GST amount, grand total) are recomputed server-side. Discount,
        // notes and status are not sent — the stored values stay untouched.
        const res = await dbApi.updatePurchaseOrder(editingId, {
          supplier: form.supplier,
          supplierId: form.supplierId || null,
          // Date-only strings are stored as-is (the quotations validUntil
          // convention) so re-editing round-trips without timezone drift.
          date: form.date || undefined,
          expectedDate: form.expectedDate || null,
          gst: gstRate,
          lines: linePayload,
        }) as PurchaseOrder & { autoInvoice?: string }
        autoInvoice = res.autoInvoice
      } else {
        const count = orders.length + 1
        const created = await dbApi.create<PurchaseOrder>('purchase-orders', {
          number: `PO-${new Date().getFullYear()}-${String(count + 17).padStart(4, '0')}`,
          supplier: form.supplier || (suppliers.find((s) => s.id === form.supplierId)?.name ?? ''),
          supplierId: form.supplierId || null,
          items: lineTotals.count,
          qty: lineTotals.qty,
          weight: lineTotals.weight,
          value: lineTotals.value,
          gst: gstRate,
          expectedDate: form.expectedDate || null,
          date: form.date || new Date().toISOString().slice(0, 10),
          status: 'open',
        })
        // Lines second: this endpoint recomputes value + GST + grand total
        // from them, using the gst stored by the create above — and raises
        // the linked purchase invoice automatically.
        const linesRes = await dbApi.setPurchaseOrderLines(created.id, linePayload) as PurchaseOrder & { autoInvoice?: string }
        autoInvoice = linesRes.autoInvoice
      }
      setDialogOpen(false)
      setEditingId(null)
      load()
      if (autoInvoice) {
        toast.success(
          wasEditing
            ? `Purchase order updated — invoice ${autoInvoice} refreshed`
            : `Purchase order created — purchase invoice ${autoInvoice} raised automatically`,
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : editingId ? 'Failed to update purchase order' : 'Failed to create purchase order')
    } finally {
      setSaving(false)
    }
  }

  const setStatus = useCallback(async (order: PurchaseOrder, status: PurchaseOrder['status']) => {
    await dbApi.update('purchase-orders', order.id, { status })
    load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return orders.filter((o) => {
      const matchQ = !q || o.number.toLowerCase().includes(q) || o.supplier.toLowerCase().includes(q)
      const matchStatus = !statusFilter || o.status === statusFilter
      return matchQ && matchStatus
    })
  }, [orders, query, statusFilter])

  const totalValue = orders.filter((o) => o.status === 'open').reduce((a, o) => a + o.value, 0)
  const totalWeight = orders.reduce((a, o) => a + o.weight, 0)

  const columns = useMemo<ColumnDef<PurchaseOrder>[]>(
    () => [
      {
        accessorKey: 'number',
        header: 'PO Number',
        meta: { headerClassName: 'min-w-[170px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <ShoppingCart className="h-4 w-4" />
            </div>
            <div>
              <p className="font-mono font-medium text-foreground">{row.original.number}</p>
              <p className="text-[11px] text-muted-foreground">{formatDate(row.original.date)}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'supplier',
        header: 'Supplier',
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground" /> {row.original.supplier}
          </span>
        ),
      },
      {
        accessorKey: 'items',
        header: 'Items',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.items}</span>,
      },
      {
        accessorKey: 'qty',
        header: 'Qty',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.qty}</span>,
      },
      {
        accessorKey: 'weight',
        header: 'Weight',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatWeight(row.original.weight)}</span>,
      },
      {
        accessorKey: 'value',
        header: 'Order Value',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.value)}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const s = statusBadge[row.original.status] ?? { label: row.original.status ?? "—", variant: "muted" as const }
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => openView(row.original)}>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View PO</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(row.original)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit PO</TooltipContent>
              </Tooltip>
              {row.original.status === 'open' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => setStatus(row.original, 'received')}>
                      <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Mark Received</TooltipContent>
                </Tooltip>
              )}
              {row.original.status !== 'cancelled' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => navigate('/purchase/invoices')}>
                      <Wallet className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Create Purchase Invoice</TooltipContent>
                </Tooltip>
              )}
              {row.original.status !== 'cancelled' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => setStatus(row.original, 'cancelled')}>
                      <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel PO</TooltipContent>
                </Tooltip>
              )}
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [setStatus, navigate, openView, openEdit],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Purchase Orders"
        subtitle="Orders raised with silver suppliers for raw material and finished pieces."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => exportTable('purchase-orders.csv', columns, filtered)}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" onClick={openDialog}>
              <Plus className="h-4 w-4" /> New Purchase Order
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniCard icon={ShoppingCart} label="Total POs" value={String(orders.length)} sub="All purchase orders" tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
        <MiniCard icon={ShoppingCart} label="Open" value={String(orders.filter((o) => o.status === 'open').length)} sub="Awaiting receipt" tint="bg-warning-50 text-warning-700" />
        <MiniCard icon={Weight} label="Total Weight" value={formatWeight(totalWeight)} sub="Gross across POs" tint="bg-info-50 text-info-700" />
        <MiniCard icon={Building2} label="Open Value" value={formatCurrency(totalValue)} sub="Committed to suppliers" tint="bg-success-50 text-success-700" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search PO number, supplier..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[
                { value: '', label: 'All Status' },
                { value: 'open', label: 'Open' },
                { value: 'received', label: 'Received' },
                { value: 'draft', label: 'Draft' },
                { value: 'closed', label: 'Closed' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
              value={statusFilter}
              onValueChange={setStatusFilter}
              className="w-[140px]"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {orders.length} POs
            </div>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No purchase orders found"
            onRowClick={openView}
          />
        </CardContent>
      </Card>

      <AppDialog
        open={viewPo !== null}
        onOpenChange={(open) => { if (!open) setViewPo(null) }}
        size="xl"
        title={`Purchase Order ${viewPo?.number ?? ''}`}
        description={viewPo ? formatDate(viewPo.date) : ''}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewPo(null)}>Close</Button>
            <Button onClick={() => viewPo && openEdit(viewPo)}>
              <Pencil className="h-4 w-4" /> Edit Purchase Order
            </Button>
          </DialogFooter>
        }
      >
          {viewPo && (
            <div className="space-y-3 text-sm">
              <div className="space-y-2">
                <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span className="font-medium">{viewPo.supplier}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Status</span><Badge variant={statusBadge[viewPo.status].variant} dot>{statusBadge[viewPo.status].label}</Badge></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Quantity</span><span>{viewPo.qty}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Weight</span><span>{formatWeight(viewPo.weight)}</span></div>
              </div>

              {(viewPo.lines ?? []).length > 0 ? (
                <div className="overflow-hidden rounded-md border border-border/60">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Item</th>
                        <th className="px-3 py-2 font-medium">SKU</th>
                        <th className="px-3 py-2 text-right font-medium">Qty</th>
                        <th className="px-3 py-2 text-right font-medium">Weight</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(viewPo.lines ?? []).map((l, i) => (
                        <tr key={`${l.sku}-${i}`} className="border-b border-border/40 last:border-0">
                          <td className="px-3 py-2">{l.product || '—'}</td>
                          <td className="px-3 py-2 font-mono text-xs">{l.sku || '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{l.qty}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatWeight(l.weight)}</td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(l.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {/* GST breakdown: stored values with a computed fallback for
                  rows that predate the GST columns. */}
              <div className="space-y-1 border-t pt-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Order value (subtotal)</span>
                  <span className="tabular-nums">{formatCurrency(viewPo.value)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">GST ({viewPo.gst ?? 3}%)</span>
                  <span className="tabular-nums">
                    {formatCurrency(viewPo.gstAmount ?? Math.round((viewPo.value ?? 0) * (viewPo.gst ?? 3)) / 100)}
                  </span>
                </div>
                {(viewPo.discount ?? 0) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Discount</span>
                    <span className="tabular-nums">− {formatCurrency(viewPo.discount ?? 0)}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold">
                  <span>Grand total</span>
                  <span className="tabular-nums">
                    {formatCurrency(
                      viewPo.grandTotal ??
                        (viewPo.value ?? 0) + (viewPo.gstAmount ?? Math.round((viewPo.value ?? 0) * (viewPo.gst ?? 3)) / 100) - (viewPo.discount ?? 0),
                    )}
                  </span>
                </div>
              </div>
              {viewPo.expectedDate && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Expected delivery</span>
                  <span>{formatDate(viewPo.expectedDate)}</span>
                </div>
              )}
              {viewPo.notes && <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">{viewPo.notes}</p>}
            </div>
          )}

          {/* Ordered vs received — cancelled invoices are excluded. */}
          <div className="rounded-md border border-border/60 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <PackageCheck className="h-3.5 w-3.5" /> Received against this order
            </p>
            {receiptLoading ? (
              <p className="text-xs text-muted-foreground">Loading receipt…</p>
            ) : !receipt ? (
              <p className="text-xs text-muted-foreground">No receipt information available.</p>
            ) : receipt.invoiceCount === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing received yet — record a purchase invoice against this order to see it here.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-[11px] text-muted-foreground">Ordered</p>
                    <p className="font-medium tabular-nums">{receipt.orderedQty} pcs</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Received</p>
                    <p className="font-medium tabular-nums">{receipt.receivedQty} pcs</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Variance</p>
                    {receipt.shortBy > 0 ? (
                      <p className="font-medium tabular-nums text-red-600 dark:text-red-400">−{receipt.shortBy} short</p>
                    ) : receipt.overBy > 0 ? (
                      <p className="font-medium tabular-nums text-warning-600 dark:text-warning-400">+{receipt.overBy} over</p>
                    ) : (
                      <p className="font-medium text-success-600 dark:text-success-400">Complete</p>
                    )}
                  </div>
                </div>
                <ul className="mt-2 space-y-1">
                  {receipt.invoices.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between text-xs">
                      <span className="font-mono">{inv.number}</span>
                      <span className="text-muted-foreground">
                        {inv.qty} pcs · {formatWeight(inv.weight)} · {formatDate(inv.date)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
      </AppDialog>

      <AppDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        size="lg"
        isDirty={dialogOpen && JSON.stringify({ form, lines }) !== formBaseline}
        title={editingId ? `Edit Purchase Order ${orders.find((o) => o.id === editingId)?.number ?? ''}` : 'New Purchase Order'}
        description={editingId ? 'Update supplier, dates, line items and GST.' : 'Raise a purchase order with a supplier.'}
        footer={
          <DialogFooter className="items-center gap-3">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {editingId ? 'Save Changes' : 'Save as Draft'}
            </Button>
          </DialogFooter>
        }
      >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <FormLabel required>Supplier</FormLabel>
              <Select
                options={[
                  { value: '', label: 'Select a supplier' },
                  ...suppliers.map((s) => ({ value: s.id, label: s.name })),
                ]}
                value={form.supplierId}
                onValueChange={(id) => {
                  const s = suppliers.find((x) => x.id === id)
                  setForm((f) => ({ ...f, supplierId: id, supplier: s?.name ?? '' }))
                  setFieldErrors((e) => ({ ...e, supplier: undefined }))
                }}
                className="h-9 rounded-lg border border-gray-200 text-[14px] text-[#2e1065]"
              />
              {fieldErrors.supplier ? <p className="text-[12px] text-red-600">{fieldErrors.supplier}</p> : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <FormLabel required>Order Date</FormLabel>
                <Input
                  type="date"
                  value={form.date}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, date: e.target.value }))
                    setFieldErrors((err) => ({ ...err, date: undefined }))
                  }}
                  className="h-9 rounded-lg border border-gray-200 text-[14px] text-[#2e1065]"
                />
                {fieldErrors.date ? <p className="text-[12px] text-red-600">{fieldErrors.date}</p> : null}
              </div>
              <div className="space-y-1.5">
                <FormLabel>Expected Delivery Date</FormLabel>
                <Input
                  type="date"
                  value={form.expectedDate}
                  onChange={(e) => setForm((f) => ({ ...f, expectedDate: e.target.value }))}
                  className="h-9 rounded-lg border border-gray-200 text-[14px] text-[#2e1065]"
                />
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[13px] font-semibold text-[#2e1065]">Line Items</p>
                <span className="text-[12px] text-muted-foreground">
                  {lineTotals.count} item{lineTotals.count === 1 ? '' : 's'} added
                </span>
              </div>

              <div className="space-y-2.5">
                {lines.map((line, index) => {
                  const amount = lineAmount(line)
                  return (
                    <div
                      key={index}
                      className={`space-y-2.5 rounded-lg border p-3 transition-colors ${
                        line.confirmed ? 'border-[#7c3aed]/40 bg-[#f5f3ff]/60' : 'border-gray-200 bg-white'
                      }`}
                    >
                      <div className="space-y-1.5">
                        <ColLabel>Product</ColLabel>
                        <Select
                          options={[
                            { value: '', label: 'Select product' },
                            ...products.map((p) => ({ value: p.sku, label: `${p.name} (${p.sku})` })),
                            { value: CUSTOM_SKU, label: 'Other / type manually' },
                          ]}
                          value={line.custom ? CUSTOM_SKU : line.sku}
                          onValueChange={(v) => pickProduct(index, v)}
                          className="h-9 rounded-lg border border-gray-200 text-[14px] text-[#2e1065]"
                        />
                        {line.custom ? (
                          <Input
                            value={line.product}
                            onChange={(e) => setLine(index, { product: e.target.value })}
                            placeholder="Item name / SKU"
                            className="h-9 rounded-lg border border-gray-200 text-[14px] text-[#2e1065]"
                          />
                        ) : null}
                      </div>

                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <div className="space-y-1.5">
                          <ColLabel>Qty</ColLabel>
                          <Input
                            type="number"
                            min="1"
                            value={line.qty}
                            onChange={(e) => setLine(index, { qty: e.target.value })}
                            className="h-9 rounded-lg border border-gray-200 text-right text-[14px] text-[#2e1065]"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <ColLabel>Weight (g)</ColLabel>
                          <Input
                            type="number"
                            min="0"
                            step="0.001"
                            value={line.weight}
                            onChange={(e) => setLine(index, { weight: e.target.value })}
                            className="h-9 rounded-lg border border-gray-200 text-right text-[14px] text-[#2e1065]"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <ColLabel>Rate (₹/g)</ColLabel>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.rate}
                            onChange={(e) => setLine(index, { rate: e.target.value })}
                            className="h-9 rounded-lg border border-gray-200 text-right text-[14px] text-[#2e1065]"
                          />
                        </div>
                      </div>

                      <div className="flex items-end justify-between gap-2">
                        <div className="space-y-1.5">
                          <ColLabel>Total</ColLabel>
                          <p className="text-[14px] font-semibold tabular-nums text-[#2e1065]">{inr(amount)}</p>
                        </div>
                        <div className="flex items-center gap-1 pb-1">
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={line.confirmed ? 'Unconfirm item' : 'Confirm item'}
                            onClick={() => confirmLine(index)}
                            className={line.confirmed ? 'bg-green-600 text-white hover:bg-green-700' : 'text-green-600 hover:bg-green-50'}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Duplicate item"
                            onClick={() => duplicateLine(index)}
                            className="text-[#7c3aed] hover:bg-[#f5f3ff] hover:text-[#6d28d9]"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Delete item"
                            onClick={() => removeLine(index)}
                            className="text-red-600 hover:bg-red-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      {lineErrors[index] ? <p className="text-[12px] text-red-600">{lineErrors[index]}</p> : null}
                    </div>
                  )
                })}
              </div>

              <button
                type="button"
                onClick={() => {
                  setLineErrors({})
                  setLines((prev) => [...prev, emptyLine()])
                }}
                className="mt-2.5 inline-flex items-center gap-1 text-[13px] font-medium text-[#7c3aed] hover:underline"
              >
                <Plus className="h-3.5 w-3.5" /> Add Another Item
              </button>
              {fieldErrors.lines ? <p className="mt-1 text-[12px] text-red-600">{fieldErrors.lines}</p> : null}
            </div>

            {/* Summary — lavender box with the live GST math (poMoneyTotals) */}
            <div className="space-y-2.5 rounded-lg bg-[#f5f3ff] p-4">
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-[#2e1065]/80">Subtotal</span>
                <span className="font-medium tabular-nums text-[#2e1065]">{inr(money.subtotal)}</span>
              </div>
              <div className="flex items-center justify-between text-[13px]">
                <span className="flex items-center gap-2 text-[#2e1065]/80">
                  GST %
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={form.gst}
                    onChange={(e) => setForm((f) => ({ ...f, gst: e.target.value }))}
                    aria-label="GST percent"
                    className="h-7 w-16 rounded-md border border-gray-200 bg-white px-2 text-right text-[13px] text-[#2e1065]"
                  />
                </span>
                <span className="tabular-nums text-[#2e1065]">{inr(money.gstAmount)}</span>
              </div>
              <div className="border-t border-[#2e1065]" />
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-bold text-[#2e1065]">Total Amount</span>
                <span className="text-[17px] font-bold tabular-nums text-[#2e1065]">{inr(money.grandTotal)}</span>
              </div>
            </div>

            {error ? <p className="text-[12.5px] text-red-600">{error}</p> : null}
          </div>
      </AppDialog>
    </div>
  )
}

/** Compact form label — 12.5px deep indigo, with an optional required star. */
function FormLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <p className="text-[12.5px] font-medium text-[#2e1065]">
      {children}
      {required ? <span className="ml-0.5 text-red-500">*</span> : null}
    </p>
  )
}

/** Small column label above each line-item input. */
function ColLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] font-medium text-[#2e1065]/80">{children}</p>
}

function MiniCard({ icon: Icon, label, value, sub, tint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; tint: string }) {
  return (
    <Card className="p-3 sm:p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{value}</p>
          {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
        </div>
      </div>
    </Card>
  )
}
