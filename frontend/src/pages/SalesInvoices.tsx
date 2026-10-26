import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@/lib/table'
import { Copy, Download, Eye, FileText, Loader2, MessageCircle, MoreHorizontal, Pencil, Plus, Printer, RefreshCw, Search, Trash2, Undo2, X } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTable } from '@/components/ui/data-table'
import { printCurrentPage } from '@/lib/printTemplate'
import { AppDialog } from '@/components/ui/app-dialog'
import { DialogFooter } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { dbApi } from '@/lib/api'
import { ManualInvoiceDialog } from '@/components/manual-invoice-dialog'
import { exportTable } from '@/lib/export'
import type { Invoice, InvoiceItem } from '@/types'
import { formatCurrency, formatDate } from '@/lib/format'

const paymentBadge: Record<Invoice['paymentStatus'], { label: string; variant: 'success' | 'warning' | 'danger' | 'muted' }> = {
  paid: { label: 'Paid', variant: 'success' },
  partial: { label: 'Partial', variant: 'warning' },
  pending: { label: 'Pending', variant: 'warning' },
  failed: { label: 'Failed', variant: 'danger' },
  refunded: { label: 'Refunded', variant: 'muted' },
}

const statusBadge: Record<Invoice['status'], { label: string; variant: 'success' | 'warning' | 'danger' | 'muted' | 'info' }> = {
  paid: { label: 'Paid', variant: 'success' },
  draft: { label: 'Draft', variant: 'muted' },
  issued: { label: 'Issued', variant: 'info' },
  overdue: { label: 'Overdue', variant: 'danger' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
  refunded: { label: 'Refunded', variant: 'warning' },
}

export default function SalesInvoicesPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [reinvoiceId, setReinvoiceId] = useState<string | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [paymentFilter, setPaymentFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [viewInvoice, setViewInvoice] = useState<Invoice | null>(null)
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([])
  const [customers, setCustomers] = useState<Array<{ name: string; phone?: string | null }>>([])

  // Header-field edit state (customer, payment, dates, discount, GST).
  // Line items are intentionally not editable here — the backend PATCH keeps
  // totals in sync when discount/GST change without touching stock.
  const [editTarget, setEditTarget] = useState<Invoice | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [editForm, setEditForm] = useState({
    customer: '', customerEmail: '', customerPhone: '', customerAddress: '',
    customerCity: '', customerState: '', customerPincode: '', buyerGstin: '',
    date: '', dueDate: '', paymentMethod: '', paymentStatus: 'pending', status: 'issued',
    discount: '0', gst: '3',
  })
  // Snapshot of the edit form as it opened, for the unsaved-changes close guard.
  const [editBaseline, setEditBaseline] = useState('')

  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Manual invoice creation — a walk-in / phone sale billed straight to an
  // invoice, no sales order involved. The dialog owns its own draft state; this
  // page only tracks whether it is open and what it produced.
  const [createOpen, setCreateOpen] = useState(false)

  // Permanent delete: the backend reverses the invoice's stock in the same
  // transaction, and the loyalty points it earned are reversed right after.
  const deleteInvoice = async (inv: Invoice) => {
    if (!(await confirmDialog({
      title: `Delete invoice ${inv.number}?`,
      description: 'This permanently removes the invoice. The stock it sold comes back into inventory and the loyalty points it earned are reversed.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return
    setDeletingId(inv.id)
    try {
      await dbApi.remove('invoices', inv.id)
      setInvoices((prev) => prev.filter((x) => x.id !== inv.id))
      setViewInvoice((v) => (v?.id === inv.id ? null : v))
      toast.success(`Invoice ${inv.number} deleted — stock and loyalty points reversed`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  const openEdit = useCallback((inv: Invoice) => {
    const toDateInput = (v?: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : '')
    const next = {
      customer: inv.customer ?? '',
      customerEmail: inv.customerEmail ?? '',
      customerPhone: inv.customerPhone ?? '',
      customerAddress: inv.customerAddress ?? '',
      customerCity: inv.customerCity ?? '',
      customerState: inv.customerState ?? '',
      customerPincode: inv.customerPincode ?? '',
      buyerGstin: inv.buyerGstin ?? '',
      date: toDateInput(inv.date),
      dueDate: toDateInput(inv.dueDate),
      paymentMethod: inv.paymentMethod ?? '',
      paymentStatus: inv.paymentStatus,
      status: inv.status,
      discount: String(inv.discount ?? 0),
      gst: String(inv.gst ?? 3),
    }
    setEditTarget(inv)
    setEditError('')
    setEditForm(next)
    setEditBaseline(JSON.stringify(next))
    setViewInvoice(null)
  }, [])

  // The invoice detail page links here with { state: { editInvoiceId } } so
  // its Edit button can reuse this page's edit dialog.
  useEffect(() => {
    // Defer the setState out of the effect body (react/set-state-in-effect)
    // — same queueMicrotask pattern the other pages use. The router state is
    // cleared after it is consumed so a later invoices reload (e.g. right
    // after saving) cannot pop the edit dialog back open.
    const editId = (location.state as { editInvoiceId?: string } | null)?.editInvoiceId
    if (!editId) return
    queueMicrotask(() => {
      const inv = invoices.find((x) => x.id === editId)
      if (inv) {
        openEdit(inv)
        navigate(location.pathname, { replace: true, state: null })
      }
    })
  }, [location.state, location.pathname, invoices, openEdit, navigate])

  const submitEdit = async () => {
    if (!editTarget) return
    if (!editForm.customer.trim()) { setEditError('Customer name is required'); return }
    setEditSaving(true)
    setEditError('')
    try {
      const patch: Record<string, unknown> = {
        customer: editForm.customer.trim(),
        customerEmail: editForm.customerEmail.trim() || null,
        customerPhone: editForm.customerPhone.trim() || null,
        customerAddress: editForm.customerAddress.trim() || null,
        customerCity: editForm.customerCity.trim() || null,
        customerState: editForm.customerState.trim() || null,
        customerPincode: editForm.customerPincode.trim() || null,
        buyerGstin: editForm.buyerGstin.trim() || null,
        paymentMethod: editForm.paymentMethod.trim() || null,
        paymentStatus: editForm.paymentStatus,
        status: editForm.status,
        discount: parseFloat(editForm.discount) || 0,
        gst: parseFloat(editForm.gst) || 0,
      }
      if (editForm.date) patch.date = new Date(`${editForm.date}T00:00:00`).toISOString()
      if (editForm.dueDate) patch.dueDate = new Date(`${editForm.dueDate}T00:00:00`).toISOString()
      const updated = await dbApi.update<Invoice>('invoices', editTarget.id, patch)
      setInvoices((prev) => prev.map((x) => (x.id === editTarget.id ? { ...x, ...updated } : x)))
      toast.success(`Invoice ${editTarget.number} updated`)
      setEditTarget(null)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update invoice')
    } finally {
      setEditSaving(false)
    }
  }

  const setInvoiceStatus = async (inv: Invoice, status: Invoice['status']) => {
    if (!(await confirmDialog({ title: `Mark invoice ${inv.number} as ${status}?` }))) return
    try {
      const patch: Record<string, unknown> = { status }
      if (status === 'refunded') patch.paymentStatus = 'refunded'
      await dbApi.update('invoices', inv.id, patch)
      setInvoices((prev) => prev.map((x) => (x.id === inv.id ? { ...x, ...patch } : x)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    }
  }

  // Cancel the invoice and immediately raise a fresh one from the same order.
  // Cancel restores the sold stock and reverses the loyalty points, so the
  // reissued invoice deducts stock again — no double-count either way.
  const reinvoice = useCallback(async (inv: Invoice) => {
    if (!(await confirmDialog({
      title: `Cancel and reissue ${inv.number}?`,
      description: 'The current invoice is cancelled, its stock and loyalty points are reversed, and a fresh invoice is raised from the same order line items.',
      confirmLabel: 'Cancel & reissue',
    }))) return
    setReinvoiceId(inv.id)
    try {
      const r = await dbApi.reinvoiceOrder(inv.number)
      setInvoices((prev) => prev.filter((x) => x.id !== inv.id))
      toast.success(`Invoice ${r.cancelled} cancelled and reissued as ${r.invoiceNumber}`)
      // Pull the fresh invoice in so it shows immediately.
      dbApi.getInvoices().then(setInvoices).catch(() => undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reissue failed')
    } finally {
      setReinvoiceId(null)
    }
  }, [])

  useEffect(() => {
    dbApi.getInvoices().then((d) => {
      setInvoices(d)
      setLoading(false)
    }).catch(() => setLoading(false))
    dbApi.getCustomers().then((d) => setCustomers(d)).catch(() => undefined)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return invoices.filter((i) => {
      const matchQ =
        !q ||
        i.number.toLowerCase().includes(q) ||
        (i.shopifyOrder ?? '').toLowerCase().includes(q) ||
        i.customer.toLowerCase().includes(q)
      const matchPay = !paymentFilter || i.paymentStatus === paymentFilter
      const matchStatus = !statusFilter || i.status === statusFilter
      return matchQ && matchPay && matchStatus
    })
  }, [invoices, query, paymentFilter, statusFilter])

  const duplicateInvoice = async (inv: Invoice) => {
    if (!(await confirmDialog({ title: `Create a draft copy of ${inv.number}?`, description: "The draft gets a new number, today's date, and pending payment.", confirmLabel: 'Duplicate' }))) return
    setDuplicatingId(inv.id)
    try {
      const created = await dbApi.duplicateInvoice(inv.id)
      setInvoices((prev) => [created as unknown as Invoice, ...prev])
      setViewInvoice(created as unknown as Invoice)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Duplicate failed')
    } finally {
      setDuplicatingId(null)
    }
  }

  // Stable DataTable row handlers: inline lambdas would change identity every
  // render and defeat the table memo, re-rendering all rows on each keystroke
  // in the view dialog (felt as input lag).
  // The ref remembers which invoice the dialog is showing so a slower item
  // fetch for a previously opened invoice can never overwrite it.
  const openInvoiceIdRef = useRef<string | null>(null)
  const openInvoice = useCallback((inv: Invoice) => {
    openInvoiceIdRef.current = inv.id
    setViewInvoice(inv)
    setInvoiceItems(inv.items ?? [])
    if (!inv.items?.length) {
      dbApi.getInvoiceById(inv.id).then((full) => {
        if (openInvoiceIdRef.current === inv.id) setInvoiceItems(full?.items ?? [])
      }).catch(() => {})
    }
  }, [])

  const openInvoicePage = useCallback((inv: Invoice) => navigate(`/sales/invoices/${inv.id}`), [navigate])

  const columns = useMemo<ColumnDef<Invoice>[]>(
    () => [
      {
        accessorKey: 'number',
        header: 'Invoice',
        meta: { headerClassName: 'min-w-[150px]' },
        cell: ({ row }) => (
          <Link to={`/sales/invoices/${row.original.id}`} className="group">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
                <FileText className="h-4 w-4" />
              </div>
              <div>
                <p className="font-medium text-foreground group-hover:text-primary-700">{row.original.number}</p>
                <p className="text-[11px] text-muted-foreground">{formatDate(row.original.date)}</p>
              </div>
            </div>
          </Link>
        ),
      },
      {
        accessorKey: 'shopifyOrder',
        header: 'Shopify Order',
        cell: ({ row }) => <span className="font-mono text-[12.5px] text-muted-foreground">{row.original.shopifyOrder}</span>,
      },
      {
        accessorKey: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-foreground">{row.original.customer}</p>
            <p className="text-[11px] text-muted-foreground">{row.original.customerEmail}</p>
            {row.original.customerPhone ? <p className="text-[11px] text-muted-foreground">{row.original.customerPhone}</p> : null}
          </div>
        ),
      },
      {
        accessorKey: 'grandTotal',
        header: 'Amount',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.grandTotal)}</span>,
      },
      {
        id: 'payment',
        header: 'Payment',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const p = paymentBadge[row.original.paymentStatus] ?? { label: String(row.original.paymentStatus ?? 'Unknown'), variant: 'muted' as const }
          return <Badge variant={p.variant} dot>{p.label}</Badge>
        },
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const s = statusBadge[row.original.status] ?? { label: String(row.original.status ?? 'Unknown'), variant: 'muted' as const }
          return <Badge variant={s.variant}>{s.label}</Badge>
        },
      },
      {
        accessorKey: 'paymentMethod',
        header: 'Method',
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.paymentMethod}</span>,
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => setViewInvoice(row.original)}>
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>View</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/sales/invoices/${row.original.id}`)}>
                <Printer className="h-3.5 w-3.5" />
              </Button>
              </TooltipTrigger>
              <TooltipContent>Print</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Edit invoice ${row.original.number}`} onClick={() => openEdit(row.original)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              </TooltipTrigger>
              <TooltipContent>Edit invoice</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={duplicatingId === row.original.id}
                onClick={() => duplicateInvoice(row.original)}
              >
                {duplicatingId === row.original.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
              </TooltipTrigger>
              <TooltipContent>Duplicate as draft</TooltipContent>
            </Tooltip>
            <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${row.original.number}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>              <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-muted-foreground">More actions</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => openEdit(row.original)}><Pencil className="h-3.5 w-3.5" /> Edit invoice</DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(`/sales/invoices/${row.original.id}`)}><Download className="h-3.5 w-3.5" /> Download PDF</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setInvoiceStatus(row.original, 'refunded')}><Undo2 className="h-3.5 w-3.5" /> Refund</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setInvoiceStatus(row.original, 'cancelled')}><X className="h-3.5 w-3.5" /> Cancel</DropdownMenuItem>
              <DropdownMenuItem
                disabled={reinvoiceId === row.original.id}
                onClick={() => void reinvoice(row.original)}
              >
                {reinvoiceId === row.original.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Cancel & reissue
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-red-600 dark:text-red-400 focus:text-red-600 dark:text-red-400"
                disabled={deletingId === row.original.id}
                onClick={() => void deleteInvoice(row.original)}
              >
                {deletingId === row.original.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete invoice
              </DropdownMenuItem>
            </DropdownMenuContent>
            </DropdownMenu>
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [navigate, duplicatingId, openEdit, deletingId, reinvoiceId, reinvoice],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-4 sm:space-y-5 sm:py-6 lg:px-6">
      <PageHeader
        title="Sales Invoices"
        subtitle="Invoices generated from Shopify orders, reconciled with Razorpay payments."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => exportTable('sales-invoices.csv', columns, filtered)}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> <span className="hidden sm:inline">New Invoice</span><span className="sm:hidden">New</span>
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="space-y-4 p-3 sm:p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-0 flex-1 sm:min-w-[240px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search invoice, order, customer..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Select
                options={[
                  { value: '', label: 'All Payment' },
                  { value: 'paid', label: 'Paid' },
                  { value: 'partial', label: 'Partial' },
                  { value: 'pending', label: 'Pending' },
                  { value: 'failed', label: 'Failed' },
                  { value: 'refunded', label: 'Refunded' },
                ]}
                value={paymentFilter}
                onValueChange={setPaymentFilter}
                className="w-[calc(50%-4px)] sm:w-[140px]"
              />
              <Select
                options={[
                  { value: '', label: 'All Status' },
                  { value: 'paid', label: 'Paid' },
                  { value: 'issued', label: 'Issued' },
                  { value: 'overdue', label: 'Overdue' },
                  { value: 'cancelled', label: 'Cancelled' },
                ]}
                value={statusFilter}
                onValueChange={setStatusFilter}
                className="w-[calc(50%-4px)] sm:w-[140px]"
              />
            </div>
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {invoices.length} invoices
            </div>
          </div>

          <DataTable
            onRowDoubleClick={openInvoicePage}
            onRowClick={openInvoice}
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No invoices match your filters"
          />
        </CardContent>
      </Card>

      <AppDialog
        open={viewInvoice !== null}
        onOpenChange={(open) => { if (!open) setViewInvoice(null) }}
        size="xl"
        className="print-dialog"
        footerClassName="no-print"
        title={viewInvoice?.number}
        description={viewInvoice ? `Linked order ${viewInvoice.shopifyOrder || '—'} · ${formatDate(viewInvoice.date ?? '')}` : ''}
        footer={
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setViewInvoice(null)}>Close</Button>
            <Button variant="outline" onClick={() => void printCurrentPage()}>
              <Printer className="h-4 w-4" /> Print / PDF
            </Button>
            {(() => {
              const inv = viewInvoice
              if (!inv) return null
              const phone = inv.customerPhone || customers.find((c) => c.name === inv.customer)?.phone || ''
              if (!phone) return null
              return (
                <Button
                  variant="outline"
                  onClick={() => {
                    const digits = phone.replace(/\D/g, '')
                    const withCc = digits.length === 10 ? '91' + digits : digits
                    const text = encodeURIComponent(
                      `Invoice ${inv.number}\nCustomer: ${inv.customer}\nAmount: ₹${inv.grandTotal.toLocaleString('en-IN')}\nStatus: ${inv.paymentStatus}\n\n— Opal Line`,
                    )
                    window.open(`https://wa.me/${withCc}?text=${text}`, '_blank')
                  }}
                >
                  <MessageCircle className="h-4 w-4" /> WhatsApp
                </Button>
              )
            })()}
            <Button asChild className="ml-auto">
              <Link to={`/sales/invoices/${viewInvoice?.id ?? ''}`}>
                <Eye className="h-4 w-4" /> Open Full Page
              </Link>
            </Button>
          </DialogFooter>
        }
      >
          {viewInvoice ? (
            <div className="space-y-0.5 text-sm">
              <DetailRow label="Customer" value={viewInvoice.customer || '—'} />
              {viewInvoice.customerEmail ? <DetailRow label="Email" value={viewInvoice.customerEmail} /> : null}
              {viewInvoice.customerPhone ? <DetailRow label="Phone" value={viewInvoice.customerPhone} /> : null}
              {viewInvoice.customerAddress ? <DetailRow label="Address" value={viewInvoice.customerAddress} /> : null}
              {[viewInvoice.customerCity, viewInvoice.customerState, viewInvoice.customerPincode].some(Boolean) ? (
                <DetailRow label="City / State / PIN" value={[viewInvoice.customerCity, viewInvoice.customerState, viewInvoice.customerPincode].filter(Boolean).join(', ')} />
              ) : null}
              {viewInvoice.customerGstin ? <DetailRow label="GSTIN" value={viewInvoice.customerGstin} /> : null}
              <DetailRow label="Subtotal" value={formatCurrency(viewInvoice.subtotal)} />
              {viewInvoice.discount > 0 ? <DetailRow label="Discount" value={`− ${formatCurrency(viewInvoice.discount)}`} /> : null}
              <DetailRow label={`GST (${viewInvoice.gst ?? 0}%)`} value={formatCurrency(viewInvoice.gstAmount)} />
              <DetailRow label="Grand Total" value={formatCurrency(viewInvoice.grandTotal)} />
              <DetailRow label="Payment Method" value={viewInvoice.paymentMethod || '—'} />
              <DetailRow label="Payment Status" value={paymentBadge[viewInvoice.paymentStatus]?.label ?? viewInvoice.paymentStatus} />
              <DetailRow label="Invoice Status" value={statusBadge[viewInvoice.status]?.label ?? viewInvoice.status} />
              {invoiceItems.length > 0 ? (
                <div className="border-b border-border/60 py-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-muted-foreground">Items</span>
                    <span className="text-[11px] text-muted-foreground">{invoiceItems.length} product(s)</span>
                  </div>
                  <div className="space-y-1">
                    {invoiceItems.map((li, i) => (
                      <div key={i} className="flex items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium text-foreground">{li.product}</span>
                          {li.sku ? <span className="ml-1.5 font-mono text-muted-foreground">{li.sku}</span> : null}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{li.qty} × {formatCurrency(li.amount / (li.qty || 1))}</span>
                        <span className="shrink-0 tabular-nums font-medium text-foreground">{formatCurrency(li.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
      </AppDialog>

      <AppDialog
        open={editTarget !== null}
        onOpenChange={(open) => { if (!open) setEditTarget(null) }}
        size="lg"
        isDirty={editTarget !== null && JSON.stringify(editForm) !== editBaseline}
        title={`Edit ${editTarget?.number ?? ''}`}
        description="Update invoice header details. Totals recalculate when discount or GST changes."
        footer={
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={editSaving}>Cancel</Button>
            <Button onClick={() => void submitEdit()} disabled={editSaving}>
              {editSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save changes
            </Button>
          </DialogFooter>
        }
      >
        <div className="space-y-3 text-sm">
          {editError ? (
            <div className="rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">{editError}</div>
          ) : null}
          <Field label="Customer *">
            <Input value={editForm.customer} onChange={(e) => setEditForm((f) => ({ ...f, customer: e.target.value }))} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Email"><Input type="email" value={editForm.customerEmail} onChange={(e) => setEditForm((f) => ({ ...f, customerEmail: e.target.value }))} /></Field>
            <Field label="Phone"><Input value={editForm.customerPhone} onChange={(e) => setEditForm((f) => ({ ...f, customerPhone: e.target.value }))} /></Field>
            <Field label="City"><Input value={editForm.customerCity} onChange={(e) => setEditForm((f) => ({ ...f, customerCity: e.target.value }))} /></Field>
            <Field label="State"><Input value={editForm.customerState} onChange={(e) => setEditForm((f) => ({ ...f, customerState: e.target.value }))} /></Field>
            <Field label="PIN code"><Input value={editForm.customerPincode} onChange={(e) => setEditForm((f) => ({ ...f, customerPincode: e.target.value }))} /></Field>
            <Field label="Buyer GSTIN"><Input value={editForm.buyerGstin} onChange={(e) => setEditForm((f) => ({ ...f, buyerGstin: e.target.value }))} placeholder="e.g. 27AAAAA0000A1Z5" /></Field>
          </div>
          <Field label="Address"><Input value={editForm.customerAddress} onChange={(e) => setEditForm((f) => ({ ...f, customerAddress: e.target.value }))} /></Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Invoice date"><Input type="date" value={editForm.date} onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))} /></Field>
            <Field label="Due date"><Input type="date" value={editForm.dueDate} onChange={(e) => setEditForm((f) => ({ ...f, dueDate: e.target.value }))} /></Field>
            <Field label="Invoice status">
              <Select
                options={[
                  { value: 'issued', label: 'Issued' },
                  { value: 'paid', label: 'Paid' },
                  { value: 'overdue', label: 'Overdue' },
                  { value: 'draft', label: 'Draft' },
                  { value: 'cancelled', label: 'Cancelled' },
                  { value: 'refunded', label: 'Refunded' },
                ]}
                value={editForm.status}
                onValueChange={(v) => setEditForm((f) => ({ ...f, status: v }))}
              />
            </Field>
            <Field label="Payment status">
              <Select
                options={[
                  { value: 'pending', label: 'Pending' },
                  { value: 'partial', label: 'Partial' },
                  { value: 'paid', label: 'Paid' },
                  { value: 'failed', label: 'Failed' },
                  { value: 'refunded', label: 'Refunded' },
                ]}
                value={editForm.paymentStatus}
                onValueChange={(v) => setEditForm((f) => ({ ...f, paymentStatus: v }))}
              />
            </Field>
            <Field label="Payment method"><Input value={editForm.paymentMethod} onChange={(e) => setEditForm((f) => ({ ...f, paymentMethod: e.target.value }))} placeholder="Cash / UPI / Card" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Discount (₹)"><Input type="number" min={0} value={editForm.discount} onChange={(e) => setEditForm((f) => ({ ...f, discount: e.target.value }))} /></Field>
              <Field label="GST (%)"><Input type="number" min={0} step="0.01" value={editForm.gst} onChange={(e) => setEditForm((f) => ({ ...f, gst: e.target.value }))} /></Field>
            </div>
          </div>
        </div>
      </AppDialog>

      <ManualInvoiceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(inv) => {
          setInvoices((prev) => [inv, ...prev])
          setViewInvoice(inv)
        }}
      />
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  )
}
