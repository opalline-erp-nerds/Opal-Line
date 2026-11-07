import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import {
  Ban,
  Download,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Trash2,
  Wallet,
  Weight,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi } from '@/lib/api'
import { exportTable } from '@/lib/export'
import type { InventoryLocation, Product, PurchaseInvoice, PurchaseInvoiceDetail, Supplier } from '@/types'
import { formatCurrency, formatDate, formatNumber, formatWeight, todayIST } from '@/lib/format'

const statusBadge: Record<string, { label: string; variant: 'success' | 'warning' | 'info' | 'muted' }> = {
  paid: { label: 'Paid', variant: 'success' },
  partial: { label: 'Partial', variant: 'info' },
  pending: { label: 'Pending', variant: 'warning' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
}

/** GST state codes live in the first two digits of a GSTIN. */
const STATE_BY_CODE: Record<string, string> = {
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '19': 'West Bengal',
  '24': 'Gujarat', '27': 'Maharashtra', '29': 'Karnataka', '33': 'Tamil Nadu', '32': 'Kerala',
  '23': 'Madhya Pradesh', '22': 'Chhattisgarh', '21': 'Odisha', '20': 'Jharkhand', '36': 'Telangana',
  '37': 'Andhra Pradesh', '05': 'Uttarakhand', '03': 'Punjab', '10': 'Bihar', '34': 'Puducherry',
}

function stateFromGstin(gstin: string): string {
  return STATE_BY_CODE[gstin.slice(0, 2)] ?? ''
}

/** One editable line in the purchase form. */
interface DraftLine {
  product: string
  sku: string
  qty: string
  weight: string
  rate: string
  tax: string
}

function emptyLine(): DraftLine {
  return { product: '', sku: '', qty: '1', weight: '', rate: '', tax: '0' }
}

/** A "custom" option lets a line be typed in when the SKU is not in the catalog. */
const CUSTOM_SKU = '__custom__'

function lineCost(line: DraftLine): number {
  const weight = Number(line.weight) || 0
  const rate = Number(line.rate) || 0
  return Math.round(weight * rate * 100) / 100
}

export default function PurchaseInvoicesPage() {
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [businessGstin, setBusinessGstin] = useState('')
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [viewInvoice, setViewInvoice] = useState<PurchaseInvoiceDetail | null>(null)
  const [viewLoading, setViewLoading] = useState(false)

  // Create / edit form
  const [formOpen, setFormOpen] = useState(false)
  // Which shop this document belongs to. Stock movements follow it, so picking
  // the wrong one puts the goods on the wrong shelf.
  const [locations, setLocations] = useState<InventoryLocation[]>([])
  const [locationId, setLocationId] = useState('')

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      dbApi.getInventoryLocations()
        .then((locs) => {
          if (cancelled || !locs.length) return
          setLocations(locs)
          setLocationId((prev) => prev || locs[0].id)
        })
        .catch(() => undefined)
    })
    return () => { cancelled = true }
  }, [])

  const [editing, setEditing] = useState<PurchaseInvoiceDetail | null>(null)
  const [saving, setSaving] = useState(false)
  const [recreatingId, setRecreatingId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [header, setHeader] = useState({ number: '', supplier: '', date: todayIST(), supplierGstin: '', tcsRate: '0' })
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()])
  // Snapshot of the create/edit form as it opened, for the close guard.
  const [formBaseline, setFormBaseline] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    dbApi.getPurchaseInvoices()
      .then(setInvoices)
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
    // The business GSTIN decides CGST/SGST vs IGST, so the form needs it to
    // tell the user which split is actually being charged.
    dbApi.getSettings().then((s) => setBusinessGstin(s?.gstin ?? '')).catch(() => setBusinessGstin(''))
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return invoices.filter((i) => {
      const matchQ = !q || i.number.toLowerCase().includes(q) || i.supplier.toLowerCase().includes(q)
      const matchStatus = !statusFilter || i.status === statusFilter
      return matchQ && matchStatus
    })
  }, [invoices, query, statusFilter])

  const outstanding = invoices
    .filter((i) => i.status !== 'paid' && i.status !== 'cancelled')
    .reduce((a, i) => a + (i.balance ?? i.total), 0)
  const totalWeight = invoices.reduce((a, i) => a + i.weight, 0)

  const openView = useCallback(async (id: string) => {
    setViewLoading(true)
    try {
      setViewInvoice(await dbApi.getPurchaseInvoiceWithItems(id))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the invoice')
    } finally {
      setViewLoading(false)
    }
  }, [])

  // Stable row handler: an inline lambda here would change identity every
  // render and defeat the DataTable memo (re-rendering the whole table on
  // every keystroke in the create/edit dialog).
  const openViewById = useCallback((i: PurchaseInvoice) => { void openView(i.id) }, [openView])

  const openCreate = () => {
    const nextHeader = { number: `PI-${new Date().getFullYear()}-${String(invoices.length + 1).padStart(4, '0')}`, supplier: '', date: todayIST(), supplierGstin: '', tcsRate: '0' }
    const nextLines = [emptyLine()]
    setEditing(null)
    setHeader(nextHeader)
    setLines(nextLines)
    setFormBaseline(JSON.stringify({ header: nextHeader, lines: nextLines }))
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = useCallback(async (invoice: PurchaseInvoice) => {
    try {
      const detail = await dbApi.getPurchaseInvoiceWithItems(invoice.id)
      const nextHeader = {
        number: detail.number,
        supplier: detail.supplier ?? '',
        date: (detail.date ?? '').slice(0, 10) || todayIST(),
        supplierGstin: detail.supplierGstin ?? '',
        tcsRate: String(detail.tcsRate ?? 0),
      }
      const nextLines =
        detail.lines.length > 0
          ? detail.lines.map((it) => ({
              product: it.product,
              sku: it.sku,
              qty: String(it.qty),
              weight: String(it.weight),
              rate: String(it.rate),
              tax: String(it.tax),
            }))
          : [emptyLine()]
      setEditing(detail)
      setHeader(nextHeader)
      setLines(nextLines)
      setFormBaseline(JSON.stringify({ header: nextHeader, lines: nextLines }))
      setFormError('')
      setFormOpen(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the invoice')
    }
  }, [])

  const pickProduct = (index: number, sku: string) => {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== index) return l
        if (sku === CUSTOM_SKU) return { ...l, sku: '' }
        const p = products.find((x) => x.sku === sku)
        return { ...l, sku, product: p?.name ?? l.product, weight: p ? String(p.netWeight ?? '') : l.weight }
      }),
    )
  }

  const setLine = (index: number, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  const removeLine = (index: number) => {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))
  }

  // Live totals + GST split preview, mirroring what the server computes.
  const totals = useMemo(() => {
    const cost = lines.reduce((a, l) => a + lineCost(l), 0)
    const tax = lines.reduce((a, l) => a + (Number(l.tax) || 0), 0)
    const weight = lines.reduce((a, l) => a + (Number(l.weight) || 0), 0)
    const roundedCost = Math.round(cost * 100) / 100
    const roundedTax = Math.round(tax * 100) / 100
    const tcsRate = Number(header.tcsRate) || 0
    const tcs = tcsRate > 0 ? Math.round((roundedCost * tcsRate) / 100 * 100) / 100 : 0
    return {
      cost: roundedCost,
      tax: roundedTax,
      weight: Math.round(weight * 100) / 100,
      total: Math.round((roundedCost + roundedTax) * 100) / 100,
      tcs,
      cgst: Math.round((roundedTax / 2) * 100) / 100,
      sgst: Math.round((roundedTax / 2) * 100) / 100,
      igst: roundedTax,
    }
  }, [lines, header.tcsRate])

  const supplierState = stateFromGstin(header.supplierGstin.trim())
  const businessState = stateFromGstin(businessGstin)
  /** What the server will actually charge, so the form can say so plainly. */
  const splitNote = !businessGstin
    ? 'No business GSTIN in Settings — every purchase is treated as intra-state (CGST + SGST).'
    : !supplierState
      ? 'No supplier GSTIN — treated as intra-state (CGST + SGST).'
      : businessState.toLowerCase() === supplierState.toLowerCase()
        ? `${supplierState} = your state — CGST + SGST`
        : `${supplierState} vs your ${businessState} — IGST`
  const knownSkus = useMemo(() => products.map((p) => p.sku), [products])

  const submit = async () => {
    if (!header.number.trim()) {
      setFormError('Supplier invoice number is required')
      return
    }
    if (!header.supplier.trim()) {
      setFormError('Select a supplier')
      return
    }
    const usable = lines.filter((l) => l.sku.trim() !== '' || l.product.trim() !== '')
    if (usable.length === 0) {
      setFormError('Add at least one line item — that is what puts stock in')
      return
    }
    setSaving(true)
    setFormError('')
    const payload = {
      number: header.number.trim(),
      supplier: header.supplier.trim(),
      date: header.date,
      supplierGstin: header.supplierGstin.trim() || null,
      tcsRate: Number(header.tcsRate) || 0,
      // Goods may be delivered to a branch rather than the main store.
      locationId: locationId || undefined,
      items: usable.map((l) => ({
        product: l.product.trim(),
        sku: l.sku.trim(),
        qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
        weight: Number(l.weight) || 0,
        rate: Number(l.rate) || 0,
        tax: Number(l.tax) || 0,
      })),
    }
    try {
      if (editing) {
        const res = await dbApi.updatePurchaseInvoice(editing.id, payload)
        toast.success(`${payload.number} updated — ${res.stockedSkus} SKU(s) restocked`)
      } else {
        const res = await dbApi.createPurchaseInvoice(payload)
        toast.success(`${payload.number} recorded — stock added for ${res.stockedSkus} SKU(s)`)
      }
      setFormOpen(false)
      load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save the purchase invoice')
    } finally {
      setSaving(false)
    }
  }

  const cancelInvoice = async (invoice: { id: string; number: string }) => {
    if (
      !(await confirmDialog({
        title: `Cancel ${invoice.number}?`,
        description: 'The stock it added is taken back and the invoice stops counting towards supplier dues.',
        confirmLabel: 'Cancel invoice',
      }))
    ) {
      return
    }
    try {
      await dbApi.updatePurchaseInvoice(invoice.id, { status: 'cancelled' })
      toast.success(`${invoice.number} cancelled and stock reversed`)
      setViewInvoice(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel the invoice')
    }
  }

  const deleteInvoice = async (invoice: PurchaseInvoice) => {
    if (
      !(await confirmDialog({
        title: `Permanently delete ${invoice.number}?`,
        description:
          'This removes the invoice for good and takes its stock back out. Cancelling instead keeps the record and just reverses the stock.',
        confirmLabel: 'Delete permanently',
      }))
    ) {
      return
    }
    try {
      await dbApi.deletePurchaseInvoice(invoice.id)
      toast.success(`${invoice.number} deleted`)
      setViewInvoice(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the invoice')
    }
  }

  // Cancel the invoice (reverses its stock) and raise a fresh copy with the
  // same lines under a new supplier invoice number.
  const recreateInvoice = async (invoice: PurchaseInvoice) => {
    if (
      !(await confirmDialog({
        title: `Cancel and recreate ${invoice.number}?`,
        description:
          'The current invoice is cancelled and its stock is taken back, then a fresh invoice with the same lines is raised under a new number. Record payments against the new invoice.',
        confirmLabel: 'Cancel & recreate',
      }))
    ) {
      return
    }
    setRecreatingId(invoice.id)
    try {
      const r = await dbApi.recreatePurchaseInvoice(invoice.id)
      toast.success(`${r.cancelled} cancelled and recreated as ${r.invoice}`)
      setViewInvoice(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not recreate the invoice')
    } finally {
      setRecreatingId(null)
    }
  }

  const columns = useMemo<ColumnDef<PurchaseInvoice>[]>(
    () => [
      {
        accessorKey: 'number',
        header: 'Purchase Invoice',
        meta: { headerClassName: 'min-w-[160px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <Receipt className="h-4 w-4" />
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
        accessorKey: 'weight',
        header: 'Weight',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatWeight(row.original.weight)}</span>,
      },
      {
        accessorKey: 'rate',
        header: 'Rate / gm',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">₹{row.original.rate.toFixed(1)}</span>,
      },
      {
        accessorKey: 'tax',
        header: 'GST',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {formatCurrency(row.original.tax)}
            {row.original.igst ? <span className="ml-1 text-[10px] text-info-700">IGST</span> : null}
            {row.original.cgst ? <span className="ml-1 text-[10px] text-info-700">CGST+SGST</span> : null}
          </span>
        ),
      },
      {
        accessorKey: 'total',
        header: 'Total',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.total)}</span>,
      },
      {
        id: 'balance',
        header: 'Balance',
        meta: { align: 'right' as const },
        cell: ({ row }) => {
          const balance = row.original.balance ?? row.original.total
          const paid = row.original.paidAmount ?? 0
          if (paid <= 0) return <span className="tabular-nums text-muted-foreground">—</span>
          return <span className="tabular-nums font-medium text-red-600 dark:text-red-400">{formatCurrency(balance)}</span>
        },
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
        meta: { align: 'right' as const, headerClassName: 'w-20' },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => openView(row.original.id)}>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View invoice details</TooltipContent>
              </Tooltip>
              {row.original.status !== 'cancelled' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(row.original)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit lines / supplier GSTIN</TooltipContent>
                </Tooltip>
              ) : null}
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [openEdit, openView],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Purchase Invoices"
        subtitle="Supplier invoices for raw silver received against purchase orders — each line lands in stock."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => exportTable('purchase-invoices.csv', columns, filtered)}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4" /> Record Purchase
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MiniCard icon={Receipt} label="Total Invoices" value={formatNumber(invoices.length)} sub="All time" tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
        <MiniCard icon={Wallet} label="Total Value" value={formatCurrency(invoices.reduce((a, i) => a + i.total, 0))} sub="Including GST" tint="bg-info-50 text-info-700" />
        <MiniCard icon={Wallet} label="Outstanding" value={formatCurrency(outstanding)} sub="Not yet paid" tint="bg-warning-50 text-warning-700" />
        <MiniCard icon={Weight} label="Silver Received" value={formatWeight(totalWeight)} sub="Gross weight" tint="bg-success-50 text-success-700" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search invoice, supplier..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[
                { value: '', label: 'All Status' },
                { value: 'paid', label: 'Paid' },
                { value: 'partial', label: 'Partial' },
                { value: 'pending', label: 'Pending' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
              value={statusFilter}
              onValueChange={setStatusFilter}
              className="w-[140px]"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {invoices.length} invoices
            </div>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No purchase invoices found"
            onRowClick={openViewById}
          />
        </CardContent>
      </Card>

      {/* View detail */}
      <AppDialog
        open={viewInvoice !== null}
        onOpenChange={(open) => { if (!open) setViewInvoice(null) }}
        size="xl"
        title={`Purchase Invoice ${viewInvoice?.number ?? ''}`}
        description={
          <>
            {viewInvoice ? formatDate(viewInvoice.date) : ''}
            {viewLoading ? ' · loading…' : ''}
          </>
        }
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewInvoice(null)}>Close</Button>
            {viewInvoice && viewInvoice.status !== 'cancelled' ? (
              <Button
                variant="outline"
                onClick={() => {
                  const inv = viewInvoice
                  setViewInvoice(null)
                  if (inv) void openEdit(inv)
                }}
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            ) : null}
            {viewInvoice && viewInvoice.status !== 'cancelled' ? (
              <Button variant="outline" onClick={() => cancelInvoice(viewInvoice)}>
                <Ban className="h-3.5 w-3.5" /> Cancel Invoice
              </Button>
            ) : null}
            {viewInvoice && viewInvoice.status !== 'cancelled' ? (
              <Button
                variant="outline"
                onClick={() => void recreateInvoice(viewInvoice)}
                disabled={recreatingId === viewInvoice.id}
              >
                {recreatingId === viewInvoice.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}{' '}
                Cancel & Recreate
              </Button>
            ) : null}
            {viewInvoice ? (
              <Button variant="outline" onClick={() => deleteInvoice(viewInvoice)} className="text-red-600 dark:text-red-400">
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            ) : null}
          </DialogFooter>
        }
      >
          {viewInvoice ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span className="font-medium">{viewInvoice.supplier}</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={statusBadge[viewInvoice.status]?.variant ?? 'muted'} dot>{statusBadge[viewInvoice.status]?.label ?? viewInvoice.status}</Badge>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">Supplier GSTIN</span><span className="font-mono text-xs">{viewInvoice.supplierGstin || '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Weight</span><span>{formatWeight(viewInvoice.weight)}</span></div>
              </div>

              <div className="overflow-hidden rounded-md border border-border/60">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Item</th>
                      <th className="px-3 py-2 font-medium">SKU</th>
                      <th className="px-3 py-2 text-right font-medium">Qty</th>
                      <th className="px-3 py-2 text-right font-medium">Weight</th>
                      <th className="px-3 py-2 text-right font-medium">Rate</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewInvoice.lines.map((it, idx) => (
                      <tr key={`${it.sku}-${idx}`} className="border-b border-border/40 last:border-0">
                        <td className="px-3 py-2">{it.product || '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{it.sku || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{it.qty}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatWeight(it.weight)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">₹{it.rate.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(it.amount)}</td>
                      </tr>
                    ))}
                    {viewInvoice.lines.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                          No line items on this invoice.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Cost</span><span className="tabular-nums">{formatCurrency(viewInvoice.cost, { decimals: true })}</span></div>
                {viewInvoice.igst > 0 ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">IGST (inter-state)</span><span className="tabular-nums">{formatCurrency(viewInvoice.igst, { decimals: true })}</span></div>
                ) : (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">CGST + SGST (intra-state)</span>
                    <span className="tabular-nums">{formatCurrency(viewInvoice.cgst, { decimals: true })} + {formatCurrency(viewInvoice.sgst, { decimals: true })}</span>
                  </div>
                )}
                {viewInvoice.tcsRate > 0 ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">TCS @ {viewInvoice.tcsRate}%</span><span className="tabular-nums">{formatCurrency(viewInvoice.tcsAmount, { decimals: true })}</span></div>
                ) : null}
                <div className="flex justify-between border-t pt-2 font-semibold"><span>Total</span><span>{formatCurrency(viewInvoice.total, { decimals: true })}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Paid</span><span className="tabular-nums">{formatCurrency(viewInvoice.paidAmount, { decimals: true })}</span></div>
                <div className="flex justify-between font-medium"><span>Balance</span><span className="tabular-nums text-red-600 dark:text-red-400">{formatCurrency(viewInvoice.balance, { decimals: true })}</span></div>
              </div>
            </div>
          ) : null}
      </AppDialog>

      {/* Create / edit */}
      <AppDialog
        open={formOpen}
        onOpenChange={(open) => { if (!open) setFormOpen(false) }}
        size="lg"
        isDirty={formOpen && JSON.stringify({ header, lines }) !== formBaseline}
        title={editing ? `Edit ${editing.number}` : 'Record Purchase'}
        description={
          editing
            ? 'Changing the lines restocks the difference. Cancelling an invoice takes its stock back out.'
            : 'Every line adds its quantity to stock. Input GST is split from the supplier GSTIN.'
        }
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editing ? 'Save changes' : 'Record purchase'}
            </Button>
          </DialogFooter>
        }
      >

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Supplier invoice number">
                <Input
                  value={header.number}
                  onChange={(e) => setHeader((h) => ({ ...h, number: e.target.value }))}
                  placeholder="PI-2026-0001"
                />
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
              <Field label="Date">
                <Input
                  type="date"
                  value={header.date}
                  onChange={(e) => setHeader((h) => ({ ...h, date: e.target.value }))}
                />
              </Field>
              <Field label="Receive at" hint="Goods can be delivered to a branch instead of the main store.">
                <Select
                  options={locations.map((l) => ({ value: l.id, label: l.name }))}
                  value={locationId}
                  onValueChange={setLocationId}
                  placeholder="Select location"
                />
              </Field>
              <Field label="Supplier GSTIN (optional)">
                <Input
                  value={header.supplierGstin}
                  onChange={(e) => setHeader((h) => ({ ...h, supplierGstin: e.target.value.toUpperCase() }))}
                  placeholder="27AAAAA0000A1Z5"
                  maxLength={15}
                />
                <p className="text-[11px] text-muted-foreground">{splitNote}</p>
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
                      <th className="min-w-[190px] px-3 py-2 font-medium">Product / SKU</th>
                      <th className="w-20 px-2 py-2 text-right font-medium">Qty</th>
                      <th className="w-28 px-2 py-2 text-right font-medium">Weight (gm)</th>
                      <th className="w-28 px-2 py-2 text-right font-medium">Rate / gm</th>
                      <th className="w-28 px-2 py-2 text-right font-medium">GST (₹)</th>
                      <th className="w-24 px-2 py-2 text-right font-medium">Amount</th>
                      <th className="w-10 px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => (
                      <tr key={index} className="border-b border-border/40 last:border-0">
                        <td className="px-2 py-1.5">
                          <Select
                            options={[
                              { value: '', label: 'Select a product…' },
                              ...knownSkus.map((sku) => {
                                const p = products.find((x) => x.sku === sku)
                                return { value: sku, label: `${p?.name ?? sku} (${sku})` }
                              }),
                              { value: CUSTOM_SKU, label: 'Other / type manually' },
                            ]}
                            value={line.sku === '' ? (line.product ? CUSTOM_SKU : '') : line.sku}
                            onValueChange={(v) => pickProduct(index, v)}
                            className="h-8 text-xs"
                          />
                          <Input
                            value={line.product}
                            onChange={(e) => setLine(index, { product: e.target.value })}
                            placeholder="Item name / SKU"
                            className="mt-1 h-7 text-xs"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            type="number"
                            min="1"
                            value={line.qty}
                            onChange={(e) => setLine(index, { qty: e.target.value })}
                            className="h-8 text-right text-xs"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            type="number"
                            min="0"
                            step="0.001"
                            value={line.weight}
                            onChange={(e) => setLine(index, { weight: e.target.value })}
                            className="h-8 text-right text-xs"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.rate}
                            onChange={(e) => setLine(index, { rate: e.target.value })}
                            className="h-8 text-right text-xs"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.tax}
                            onChange={(e) => setLine(index, { tax: e.target.value })}
                            className="h-8 text-right text-xs"
                          />
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-xs">
                          {formatCurrency(lineCost(line) + (Number(line.tax) || 0))}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <Button variant="ghost" size="icon-sm" onClick={() => removeLine(index)} aria-label="Remove line">
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="TCS rate % (194Q bullion, 0 = none)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={header.tcsRate}
                  onChange={(e) => setHeader((h) => ({ ...h, tcsRate: e.target.value }))}
                />
              </Field>
              <div className="space-y-1 rounded-md border border-border/60 p-3 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Weight</span><span className="tabular-nums">{formatWeight(totals.weight)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Cost</span><span className="tabular-nums">{formatCurrency(totals.cost, { decimals: true })}</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">GST</span>
                  <span className="tabular-nums">
                    {splitNote.endsWith('IGST')
                      ? `IGST ${totals.igst.toFixed(2)}`
                      : `CGST ${totals.cgst.toFixed(2)} + SGST ${totals.sgst.toFixed(2)}`}
                  </span>
                </div>
                {totals.tcs > 0 ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">TCS</span><span className="tabular-nums">{formatCurrency(totals.tcs, { decimals: true })}</span></div>
                ) : null}
                <div className="flex justify-between border-t pt-1 font-semibold"><span>Total</span><span className="tabular-nums">{formatCurrency(totals.total, { decimals: true })}</span></div>
              </div>
            </div>

            {formError ? <p className="text-sm text-red-600 dark:text-red-400">{formError}</p> : null}
          </div>
      </AppDialog>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
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