import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import {
  CheckCircle2,
  Eye,
  Loader2,
  PackageMinus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  Weight,
  XCircle,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi } from '@/lib/api'
import type { Product, PurchaseInvoice, PurchaseReturn, Supplier } from '@/types'
import { formatCurrency, formatDate, formatWeight } from '@/lib/format'
import { flattenPurchasableItems, purchasableItemOptions, type SellableItem } from '@/lib/sellableItems'
import { pieceRateAmount, isPieceRateShaped, lineTotalWeight, pickPurchaseLine, purchaseLinePricing, unitPrice } from '@/lib/purchaseLines'

const statusBadge: Record<PurchaseReturn['status'], { label: string; variant: 'success' | 'warning' | 'info' | 'muted' }> = {
  pending: { label: 'Pending', variant: 'warning' },
  approved: { label: 'Approved', variant: 'info' },
  rejected: { label: 'Rejected', variant: 'muted' },
  received: { label: 'Received', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
}

/** One editable line on the new-return form. */
interface DraftLine {
  product: string
  sku: string
  /** Catalogue identity — null on hand-typed and legacy lines. */
  productId: string | null
  variantId: string | null
  /** '' = not resolved yet; see {@link purchaseLinePricing}. */
  pricingType: '' | 'piece_rate' | 'weight_based'
  /** ₹/pc for a piece-rate line; ignored for weight-based ones. */
  price: string
  qty: string
  weight: string
  rate: string
}

function emptyLine(): DraftLine {
  return {
    product: '',
    sku: '',
    productId: null,
    variantId: null,
    pricingType: '',
    price: '',
    qty: '1',
    weight: '',
    rate: '',
  }
}

const CUSTOM_SKU = '__custom__'

/**
 * Line total. Weight-based is `weight × rate` (the stored weight is the
 * line's TOTAL grams); Piece Rate is `qty × ₹/pc` and must never fall back to
 * a weight it does not have.
 */
function lineAmount(line: DraftLine, sellables: SellableItem[]): number {
  if (purchaseLinePricing(line, sellables) === 'piece_rate') return pieceRateAmount(line.qty, line.price)
  const weight = Number(line.weight) || 0
  const rate = Number(line.rate) || 0
  return Math.round(weight * rate * 100) / 100
}

export default function PurchaseReturnsPage() {
  const [returns, setReturns] = useState<PurchaseReturn[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [viewReturn, setViewReturn] = useState<PurchaseReturn | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [header, setHeader] = useState({ number: '', supplier: '', invoiceId: '', receiveNow: false })
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()])
  // Snapshot of the create form as it opened, for the close guard.
  const [formBaseline, setFormBaseline] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    dbApi.getPurchaseReturnsWithLines()
      .then(setReturns)
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  useEffect(() => {
    dbApi.getSuppliers().then(setSuppliers).catch(() => setSuppliers([]))
    dbApi.getProducts().then(setProducts).catch(() => setProducts([]))
    // Which supplier invoice this is going back against. The server reads the
    // STORE off that invoice, so linking one is what stops a return from a
    // branch deducting the Main Store instead.
    dbApi.getPurchaseInvoices().then(setInvoices).catch(() => setInvoices([]))
  }, [])

  /**
   * Receiving a return takes the goods back out of stock; undoing that puts
   * them back on the shelf. Both move stock, so both are confirmed.
   */
  const setReturnStatus = useCallback(async (row: PurchaseReturn, status: string) => {
    const leavingReceived = row.status === 'received' && status !== 'received'
    const enteringReceived = row.status !== 'received' && status === 'received'
    if (enteringReceived) {
      const ok = await confirmDialog({
        title: `Receive return ${row.number}?`,
        description: 'The goods are taken back out of stock for every line on this return.',
        confirmLabel: 'Receive & remove from stock',
      })
      if (!ok) return
    } else if (leavingReceived) {
      const ok = await confirmDialog({
        title: `Undo receipt of ${row.number}?`,
        description: 'The returned goods go back into stock.',
        confirmLabel: 'Put back into stock',
      })
      if (!ok) return
    }
    try {
      const res = await dbApi.setPurchaseReturnStatus(row.id, status)
      toast.success(`${row.number} marked ${status}${res.stockMoved > 0 ? ` — ${res.stockMoved} SKU(s) updated` : ''}`)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    }
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return returns.filter((r) => {
      const matchQ = !q || r.number.toLowerCase().includes(q) || r.supplier.toLowerCase().includes(q)
      const matchStatus = !statusFilter || r.status === statusFilter
      return matchQ && matchStatus
    })
  }, [returns, query, statusFilter])

  const totalWeight = returns.reduce((a, r) => a + r.weight, 0)
  // Parent AND variants, so a legacy parent-SKU line still resolves while a
  // variant code like OL-GIF-001-RED becomes selectable in its own right.
  const sellables = useMemo(() => flattenPurchasableItems(products), [products])
  const productOptions = useMemo(
    () => [
      ...purchasableItemOptions(sellables).filter((o) => o.value !== ''),
      { value: CUSTOM_SKU, label: 'Other / type manually', subtitle: undefined, keywords: '' },
    ],
    [sellables],
  )

  const openDialog = () => {
    const nextHeader = { number: `PR-${new Date().getFullYear()}-${String(returns.length + 1).padStart(4, '0')}`, supplier: '', invoiceId: '', receiveNow: false }
    const nextLines = [emptyLine()]
    setHeader(nextHeader)
    setLines(nextLines)
    setFormBaseline(JSON.stringify({ header: nextHeader, lines: nextLines }))
    setFormError('')
    setFormOpen(true)
  }

  const pickProduct = (index: number, sku: string) => {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== index) return l
        if (sku === CUSTOM_SKU) return { ...l, sku: '' }
        // Re-picking the code already on the line must not touch anything typed
        // after it — an agreed weight or rate used to be rewritten here.
        if (l.sku === sku) return l
        const pick = pickPurchaseLine(sellables, sku)
        // An unknown code keeps the line's own name so a hand-typed row survives.
        if (!pick) return { ...l, sku }
        // This table's Weight column is the line's TOTAL grams (the server
        // costs it as weight × rate), while the catalogue knows per-piece
        // grams — so a qty-3 line opens at 3 × netWeight, not one piece.
        return { ...l, ...pick, weight: lineTotalWeight(pick.weight, l.qty) }
      }),
    )
  }

  const setLine = (index: number, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  const removeLine = (index: number) => {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))
  }

  const totals = useMemo(() => {
    const usable = lines.filter((l) => l.sku.trim() !== '' || l.product.trim() !== '')
    return {
      count: usable.length,
      weight: Math.round(usable.reduce((a, l) => a + (Number(l.weight) || 0), 0) * 100) / 100,
      amount: Math.round(usable.reduce((a, l) => a + lineAmount(l, sellables), 0) * 100) / 100,
    }
  }, [lines, sellables])

  const submit = async () => {
    if (!header.number.trim()) {
      setFormError('Return number is required')
      return
    }
    if (!header.supplier.trim()) {
      setFormError('Select a supplier')
      return
    }
    const usable = lines.filter((l) => l.sku.trim() !== '' || l.product.trim() !== '')
    if (usable.length === 0) {
      setFormError('Add at least one line — that is what comes back out of stock')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const res = await dbApi.createPurchaseReturn({
        number: header.number.trim(),
        supplier: header.supplier.trim(),
        // Ties the return to the receipt it came from: the server resolves the
        // store from that invoice and deducts the variant bucket it credited.
        invoiceId: header.invoiceId || null,
        status: header.receiveNow ? 'received' : 'pending',
        items: usable.map((l) => {
          const pieceRate = purchaseLinePricing(l, sellables) === 'piece_rate'
          return {
            product: l.product.trim(),
            sku: l.sku.trim(),
            productId: l.productId,
            variantId: l.variantId,
            qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
            // A piece-rate line has no weight/rate pair: it sends zeros and its
            // fixed ₹/pc total, which the server takes as-is instead of
            // re-deriving it from grams of silver. Weight-based lines still
            // send their own total as the fallback the server already honours.
            weight: pieceRate ? 0 : Number(l.weight) || 0,
            rate: pieceRate ? 0 : Number(l.rate) || 0,
            amount: lineAmount(l, sellables),
          }
        }),
      })
      toast.success(
        header.receiveNow
          ? `${res.number} received — ${res.reversedSkus} SKU(s) taken out of stock`
          : `${res.number} recorded as pending — nothing moves until it is received`,
      )
      setFormOpen(false)
      load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save the return')
    } finally {
      setSaving(false)
    }
  }

  // Header-only edit: return number, supplier, date. Line items and stock
  // are driven by the receive/undo lifecycle, not edited here.
  const [editTarget, setEditTarget] = useState<PurchaseReturn | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [editForm, setEditForm] = useState({ number: '', supplier: '', date: '' })
  // Snapshot of the edit form as it opened, for the close guard.
  const [editBaseline, setEditBaseline] = useState('')

  const openEdit = useCallback((row: PurchaseReturn) => {
    const d = row.date ? new Date(row.date) : null
    const next = {
      number: row.number ?? '',
      supplier: row.supplier ?? '',
      date: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '',
    }
    setEditTarget(row)
    setEditError('')
    setEditForm(next)
    setEditBaseline(JSON.stringify(next))
    setViewReturn(null)
  }, [setEditTarget, setEditForm, setViewReturn])

  const submitEdit = async () => {
    if (!editTarget) return
    if (!editForm.number.trim()) {
      setEditError('Return number is required')
      return
    }
    setEditSaving(true)
    setEditError('')
    try {
      await dbApi.update('purchase-returns', editTarget.id, {
        number: editForm.number.trim(),
        supplier: editForm.supplier.trim(),
        ...(editForm.date ? { date: new Date(`${editForm.date}T00:00:00`).toISOString() } : {}),
      })
      toast.success('Purchase return updated')
      setEditTarget(null)
      load()
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setEditSaving(false)
    }
  }

  const columns = useMemo<ColumnDef<PurchaseReturn>[]>(
    () => [
      {
        accessorKey: 'number',
        header: 'Return Number',
        meta: { headerClassName: 'min-w-[160px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-warning-50 text-warning-700">
              <Undo2 className="h-4 w-4" />
            </div>
            <div>
              <p className="font-medium text-foreground">{row.original.number}</p>
              <p className="text-[11px] text-muted-foreground">{formatDate(row.original.date)}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'supplier',
        header: 'Supplier',
        cell: ({ row }) => <span className="font-medium text-foreground">{row.original.supplier}</span>,
      },
      {
        accessorKey: 'items',
        header: 'Items',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.items}</span>,
      },
      {
        accessorKey: 'weight',
        header: 'Weight',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatWeight(row.original.weight)}</span>,
      },
      {
        accessorKey: 'amount',
        header: 'Amount',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.amount)}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const s = statusBadge[row.original.status] ?? { label: row.original.status ?? '—', variant: 'muted' as const }
          return <Badge variant={s.variant} dot>{s.label}</Badge>
        },
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const, headerClassName: 'w-24' },
        cell: ({ row }) => (          <div className="flex items-center justify-end gap-0.5">
            <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.original.number}`} onClick={() => openEdit(row.original)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              </TooltipTrigger>
              <TooltipContent>Edit return header</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => setViewReturn(row.original)}>
                <Eye className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View return details</TooltipContent>
              </Tooltip>
              {row.original.status === 'pending' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => setReturnStatus(row.original, 'approved')}>
                      <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Approve</TooltipContent>
                </Tooltip>
              ) : null}
              {row.original.status === 'approved' || row.original.status === 'pending' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => setReturnStatus(row.original, 'received')}>
                      <PackageMinus className="h-3.5 w-3.5 text-info-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Receive — takes stock out</TooltipContent>
                </Tooltip>
              ) : null}
              {row.original.status === 'received' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => setReturnStatus(row.original, 'approved')}>
                      <RefreshCw className="h-3.5 w-3.5 text-warning-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Undo receipt — puts stock back</TooltipContent>
                </Tooltip>
              ) : null}
              {row.original.status === 'pending' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => setReturnStatus(row.original, 'rejected')}>
                      <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reject</TooltipContent>
                </Tooltip>
              ) : null}
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [setReturnStatus, openEdit],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Purchase Returns"
        subtitle="Silver returned to suppliers due to defects, short-weight or rejected lots."
        actions={
          <Button size="sm" onClick={openDialog}>
            <Plus className="h-4 w-4" /> Record Return
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MiniCard icon={Undo2} label="Total Returns" value={String(returns.length)} sub="All time" tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
        <MiniCard icon={Weight} label="Returned Weight" value={formatWeight(totalWeight)} sub="Gross weight" tint="bg-info-50 text-info-700" />
        <MiniCard icon={Undo2} label="Pending" value={String(returns.filter((r) => r.status === 'pending').length)} sub="Awaiting decision" tint="bg-warning-50 text-warning-700" />
        <MiniCard icon={CheckCircle2} label="Received Back" value={String(returns.filter((r) => r.status === 'received').length)} sub="Out of stock" tint="bg-success-50 text-success-700" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search return, supplier..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[
                { value: '', label: 'All Status' },
                { value: 'pending', label: 'Pending' },
                { value: 'approved', label: 'Approved' },
                { value: 'received', label: 'Received' },
                { value: 'rejected', label: 'Rejected' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
              value={statusFilter}
              onValueChange={setStatusFilter}
              className="w-[140px]"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {returns.length} returns
            </div>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No purchase returns found"
            onRowClick={setViewReturn}
          />
        </CardContent>
      </Card>

      <AppDialog
        open={viewReturn !== null}
        onOpenChange={(open) => { if (!open) setViewReturn(null) }}
        size="xl"
        title={`Return ${viewReturn?.number ?? ''}`}
        description={viewReturn ? formatDate(viewReturn.date) : ''}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewReturn(null)}>Close</Button>
            <Button variant="outline" onClick={() => viewReturn && openEdit(viewReturn)}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          </DialogFooter>
        }
      >
          {viewReturn && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span className="font-medium">{viewReturn.supplier}</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={statusBadge[viewReturn.status]?.variant ?? 'muted'} dot>{statusBadge[viewReturn.status]?.label ?? viewReturn.status}</Badge>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">Weight</span><span>{formatWeight(viewReturn.weight)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-semibold">{formatCurrency(viewReturn.amount)}</span></div>
                {viewReturn.invoiceId ? (
                  <div className="col-span-2 flex justify-between">
                    <span className="text-muted-foreground">Against invoice</span>
                    <span>{invoices.find((inv) => inv.id === viewReturn.invoiceId)?.number ?? viewReturn.invoiceId}</span>
                  </div>
                ) : null}
              </div>

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
                    {(viewReturn.lines ?? []).map((l, i) => (
                      <tr key={`${l.sku}-${i}`} className="border-b border-border/40 last:border-0">
                        <td className="px-3 py-2">
                          {l.product || '—'}
                          {isPieceRateShaped(l.weight, l.rate, l.amount) ? (
                            // No grams on a piece-rate line — say the ₹/pc out loud.
                            <span className="block text-[11px] text-muted-foreground">
                              ₹{unitPrice(l.amount, l.qty).toFixed(2)}/pc
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{l.sku || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{l.qty}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{l.weight > 0 ? formatWeight(l.weight) : '—'}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(l.amount)}</td>
                      </tr>
                    ))}
                    {(viewReturn.lines ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                          No line items recorded on this return.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              {viewReturn.status === 'pending' || viewReturn.status === 'approved' ? (
                <p className="text-xs text-muted-foreground">
                  Stock only moves once this return is marked <strong>Received</strong>.
                </p>
              ) : null}
            </div>
          )}
      </AppDialog>

      <AppDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        size="lg"
        isDirty={formOpen && JSON.stringify({ header, lines }) !== formBaseline}
        title="Record Purchase Return"
        description="Line items say what is going back to the supplier. Nothing leaves stock until the return is received."
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Record return
            </Button>
          </DialogFooter>
        }
      >

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Return number">
                <Input value={header.number} onChange={(e) => setHeader((h) => ({ ...h, number: e.target.value }))} />
              </Field>
              <Field label="Supplier">
                <Select
                  options={[
                    { value: '', label: 'Select supplier…' },
                    ...suppliers.map((s) => ({ value: s.name, label: s.name })),
                  ]}
                  value={header.supplier}
                  onValueChange={(v) => setHeader((h) => ({ ...h, supplier: v }))}
                />
              </Field>
              <Field label="Against purchase invoice (optional)">
                <Select
                  options={[
                    { value: '', label: 'Not linked to an invoice' },
                    ...invoices.map((inv) => ({
                      value: inv.id,
                      label: `${inv.number} · ${inv.supplier}`,
                    })),
                  ]}
                  value={header.invoiceId}
                  onValueChange={(v) =>
                    setHeader((h) => ({
                      ...h,
                      invoiceId: v,
                      // Picking the receipt fills the supplier it was bought
                      // from, so the two halves cannot disagree.
                      supplier: v ? (invoices.find((inv) => inv.id === v)?.supplier ?? h.supplier) : h.supplier,
                    }))
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  A linked return takes the goods back out of the store that received them. Without one it deducts
                  the main store.
                </p>
              </Field>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Line items</p>
                <Button variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
                  <Plus className="h-3.5 w-3.5" /> Add line
                </Button>
              </div>
              <div className="overflow-x-auto rounded-md border border-border/60">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="min-w-[190px] px-2 py-2 font-medium">Product / SKU</th>
                      <th className="w-20 px-2 py-2 text-right font-medium">Qty</th>
                      <th className="w-28 px-2 py-2 text-right font-medium">Weight (gm)</th>
                      <th className="w-28 px-2 py-2 text-right font-medium">Rate / gm</th>
                      <th className="w-24 px-2 py-2 text-right font-medium">Amount</th>
                      <th className="w-10 px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => {
                      const pieceRate = purchaseLinePricing(line, sellables) === 'piece_rate'
                      return (
                      <tr key={index} className="border-b border-border/40 last:border-0">
                        <td className="px-2 py-1.5">
                          <SearchableSelect
                            options={productOptions}
                            value={line.sku === '' ? (line.product ? CUSTOM_SKU : '') : line.sku}
                            onValueChange={(v) => pickProduct(index, v)}
                            placeholder="Select a product…"
                            searchPlaceholder="Search name, SKU or variant…"
                            emptyText="No matching product or variant"
                            className="h-8 text-xs"
                            compact
                          />
                          <Input
                            value={line.product}
                            onChange={(e) => setLine(index, { product: e.target.value })}
                            placeholder="Item name / SKU"
                            className="mt-1 h-7 text-xs"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input type="number" min="1" value={line.qty} onChange={(e) => setLine(index, { qty: e.target.value })} className="h-8 text-right text-xs" />
                        </td>
                        {pieceRate ? (
                          // A piece-rate item has no grams: one wide cell carries
                          // the ₹/pc price instead of a weight × rate pair.
                          <td className="px-2 py-1.5" colSpan={2}>
                            <div className="flex items-center justify-end gap-1.5">
                              <span className="text-[11px] text-muted-foreground">Price</span>
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={line.price}
                                onChange={(e) => setLine(index, { price: e.target.value })}
                                placeholder="0.00"
                                aria-label="Price per piece"
                                className="h-8 w-24 text-right text-xs"
                              />
                              <span className="text-[11px] text-muted-foreground">₹/pc</span>
                            </div>
                          </td>
                        ) : (
                          <>
                            <td className="px-2 py-1.5">
                              <Input type="number" min="0" step="0.001" value={line.weight} onChange={(e) => setLine(index, { weight: e.target.value })} className="h-8 text-right text-xs" />
                            </td>
                            <td className="px-2 py-1.5">
                              <Input type="number" min="0" step="0.01" value={line.rate} onChange={(e) => setLine(index, { rate: e.target.value })} className="h-8 text-right text-xs" />
                            </td>
                          </>
                        )}
                        <td className="px-2 py-1.5 text-right tabular-nums text-xs">{formatCurrency(lineAmount(line, sellables))}</td>
                        <td className="px-2 py-1.5 text-right">
                          <Button variant="ghost" size="icon-sm" onClick={() => removeLine(index)} aria-label="Remove line">
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1.5 text-right text-xs text-muted-foreground">
                {totals.count} line(s) · {formatWeight(totals.weight)} · {formatCurrency(totals.amount)}
              </p>
            </div>

            <label className="flex items-start gap-2 rounded-md border border-border/60 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-primary"
                checked={header.receiveNow}
                onChange={(e) => setHeader((h) => ({ ...h, receiveNow: e.target.checked }))}
              />
              <span>
                <span className="font-medium">Receive it now</span>
                <span className="block text-[11px] text-muted-foreground">
                  Takes the returned quantity straight out of stock. Leave unticked to record it as pending.
                </span>
              </span>
            </label>

            {formError ? <p className="text-sm text-red-600 dark:text-red-400">{formError}</p> : null}
          </div>
      </AppDialog>

      <AppDialog
        open={editTarget !== null}
        onOpenChange={(open) => { if (!open) setEditTarget(null) }}
        size="sm"
        isDirty={editTarget !== null && JSON.stringify(editForm) !== editBaseline}
        title={`Edit Return ${editTarget?.number ?? ''}`}
        description="Correct the return number, supplier or date. Line items stay as recorded — receive/undo controls the stock."
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={editSaving}>Cancel</Button>
            <Button onClick={() => void submitEdit()} disabled={editSaving}>
              {editSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save changes
            </Button>
          </DialogFooter>
        }
      >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Return number">
                <Input value={editForm.number} onChange={(e) => setEditForm((f) => ({ ...f, number: e.target.value }))} />
              </Field>
              <Field label="Supplier">
                <Select
                  options={[
                    { value: '', label: 'Select supplier…' },
                    ...suppliers.map((s) => ({ value: s.name, label: s.name })),
                    ...(editForm.supplier && !suppliers.some((s) => s.name === editForm.supplier)
                      ? [{ value: editForm.supplier, label: editForm.supplier }]
                      : []),
                  ]}
                  value={editForm.supplier}
                  onValueChange={(v) => setEditForm((f) => ({ ...f, supplier: v }))}
                />
              </Field>
            </div>
            <Field label="Date">
              <Input type="date" value={editForm.date} onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))} />
            </Field>
            {editError ? <p className="text-sm text-red-600 dark:text-red-400">{editError}</p> : null}
          </div>
      </AppDialog>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
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