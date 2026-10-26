import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import {
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Send,
  ShoppingBag,
  Trash2,
  Wallet,
  XCircle,
  Mail,
  MessageCircle,
  Pencil,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AppDialog } from '@/components/ui/app-dialog'
import { DialogFooter } from '@/components/ui/dialog'
import { dbApi, backupApi, formatApiError } from '@/lib/api'
import { SalesFollowUpsCard } from '@/components/sales-follow-ups-card'
import type { AppSettings, Quotation } from '@/types'
import { formatCurrency, formatDate } from '@/lib/format'
import { printDocument, mergePrintConfig } from '@/lib/printTemplate'

// SKU → product photo for printed line-item thumbnails. Any stored image is
// fine for printing (the CDN-skip policy only applies to pushing to Shopify).
let quoteProductImages: Map<string, string> | null = null
async function loadQuoteProductImages(): Promise<Map<string, string>> {
  if (quoteProductImages) return quoteProductImages
  const m = new Map<string, string>()
  try {
    const ps = await dbApi.getProducts()
    for (const p of ps) {
      const src = p.image?.trim()
      if (src) m.set(p.sku, src)
    }
  } catch {
    // printing simply falls back to no thumbnails
  }
  quoteProductImages = m
  return m
}
import { printTemplatesApi } from '@/lib/api'
import { PrintTemplatePicker } from '@/components/print-template-picker'

const statusBadge: Record<string, { label: string; variant: 'success' | 'warning' | 'info' | 'muted' }> = {
  draft: { label: 'Draft', variant: 'info' },
  sent: { label: 'Sent', variant: 'warning' },
  approved: { label: 'Approved', variant: 'success' },
  converted: { label: 'Converted', variant: 'success' },
  expired: { label: 'Expired', variant: 'muted' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
}

/** Statuses that can no longer be converted into an invoice or order. */
const isClosed = (status: string) => status === 'converted' || status === 'cancelled' || status === 'expired'

/** Statuses where the lifecycle actions still apply. */
const isLive = (status: string) => !isClosed(status)

/** Order the status filter follows the lifecycle. */
const statusOptions: Array<Quotation['status']> = ['draft', 'sent', 'approved', 'converted', 'expired', 'cancelled']

interface ItemForm {
  product: string
  sku: string
  qty: string
  weight: string
  silverRate: string
  makingCharge: string
}

const emptyItem: ItemForm = { product: '', sku: '', qty: '1', weight: '', silverRate: '', makingCharge: '' }

export default function QuotationsPage() {
  const [quotes, setQuotes] = useState<Quotation[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ customer: '', phone: '', email: '', city: '', notes: '', gst: '3', discount: '0', validUntil: '' })
  const [items, setItems] = useState<ItemForm[]>([{ ...emptyItem }])
  // Snapshot of the quotation form as it opened, for the unsaved-changes close guard.
  const [baseline, setBaseline] = useState('')
  const snapshotForm = () => JSON.stringify({ form, items })
  const [viewQuote, setViewQuote] = useState<Quotation | null>(null)
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [printConfig, setPrintConfig] = useState<unknown>(null)

  useEffect(() => {
    dbApi.getSettings().then((s) => setSettings(s ?? null)).catch(() => {})
    printTemplatesApi.getDefault('quotation').then((r) => setPrintConfig(r.config)).catch(() => {})
  }, [])

  const printQuotation = async (q: Quotation, configOverride?: unknown) => {
    const items = q.items ?? []
    const validity = q.validUntil ? formatDate(q.validUntil) : '15 days from quotation date'
    const imageBySku = await loadQuoteProductImages()
    printDocument(
      {
        number: q.number,
        customer: q.customer,
        customerPhone: q.customerPhone,
        customerEmail: q.customerEmail,
        customerAddress: q.customerAddress,
        customerCity: q.customerCity,
        customerState: q.customerState,
        customerPincode: q.customerPincode,
        businessName: settings?.businessName || undefined,
        businessGstin: settings?.gstin || null,
        businessAddress: settings?.address || null,
        businessPhone: settings?.phone || null,
        businessEmail: settings?.email || null,
        gst: q.gst,
        gstAmount: q.gstAmount,
        discount: q.discount,
        subtotal: q.subtotal,
        grandTotal: q.grandTotal,
        date: q.date,
        items: items.map((i) => ({
          product: i.product,
          sku: i.sku,
          qty: i.qty,
          weight: i.weight,
          silverRate: i.silverRate,
          makingCharge: i.makingCharge,
          amount: i.amount,
          image: imageBySku.get(i.sku),
        })),
      },
      // An explicit config comes from the saved-template picker; otherwise the
      // saved default (or stock layout) applies.
      mergePrintConfig(configOverride ?? printConfig),
      {
        docType: 'quotation',
        tagline: '92.5 Sterling Silver Jewellery',
        showImages: true,
        extraBox: { label: 'Valid Until', value: validity },
        notes: q.notes ?? undefined,
        billToLabel: 'Prepared For',
        totalLabel: 'QUOTED TOTAL',
        terms: `Prices are based on the prevailing silver rate on the quotation date and are valid until ${validity}. Actual invoice value may vary with the silver rate on the date of billing. Making charges as stated; GST extra as applicable. This quotation is not a tax invoice.`,
      },
    )
  }

  const load = useCallback(() => {
    setLoading(true)
    dbApi.getQuotations().then((d) => {
      setQuotes(d)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return quotes.filter((r) => {
      const matchQ = !q || r.number.toLowerCase().includes(q) || (r.customer ?? '').toLowerCase().includes(q)
      const matchStatus = !statusFilter || r.status === statusFilter
      return matchQ && matchStatus
    })
  }, [quotes, query, statusFilter])

  const itemAmount = (it: ItemForm) => {
    const weight = parseFloat(it.weight) || 0
    const rate = parseFloat(it.silverRate) || 0
    const making = parseFloat(it.makingCharge) || 0
    if (weight > 0 && rate > 0) return Math.round((weight * rate + making) * 100) / 100
    return 0
  }

  const itemsTotal = items.reduce((a, it) => a + itemAmount(it), 0)
  const gstRate = parseFloat(form.gst) || 0
  const discount = parseFloat(form.discount) || 0
  const gstAmount = Math.round(((itemsTotal * gstRate) / 100) * 100) / 100
  const grandTotal = Math.round((itemsTotal + gstAmount - discount) * 100) / 100

  const openDialog = () => {
    const nextForm = { customer: '', phone: '', email: '', city: '', notes: '', gst: '3', discount: '0', validUntil: '' }
    const nextItems = [{ ...emptyItem }]
    setEditingId(null)
    setForm(nextForm)
    setItems(nextItems)
    setBaseline(JSON.stringify({ form: nextForm, items: nextItems }))
    setError('')
    setDialogOpen(true)
  }

  // Reopen the same dialog prefilled to edit an existing quotation. Closed
  // quotes (converted/cancelled/expired) are read-only downstream.
  const openEdit = (q: Quotation) => {
    const nextForm = {
      customer: q.customer ?? '',
      phone: q.customerPhone ?? '',
      email: q.customerEmail ?? '',
      city: q.customerCity ?? '',
      notes: q.notes ?? '',
      gst: String(q.gst ?? 3),
      discount: String(q.discount ?? 0),
      // Date input wants yyyy-mm-dd; keep the date part of the stored instant.
      validUntil: q.validUntil ? q.validUntil.slice(0, 10) : '',
    }
    const existingItems = q.items ?? []
    const nextItems =
      existingItems.length > 0
        ? existingItems.map((it) => ({
            product: it.product ?? '',
            sku: it.sku ?? '',
            qty: String(it.qty ?? 1),
            weight: it.weight ? String(it.weight) : '',
            silverRate: it.silverRate ? String(it.silverRate) : '',
            makingCharge: it.makingCharge ? String(it.makingCharge) : '',
          }))
        : [{ ...emptyItem }]
    setEditingId(q.id)
    setForm(nextForm)
    setItems(nextItems)
    setBaseline(JSON.stringify({ form: nextForm, items: nextItems }))
    setError('')
    setViewQuote(null)
    setDialogOpen(true)
  }

  const setItem = (idx: number, patch: Partial<ItemForm>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }

  const submit = async () => {
    const validItems = items.filter((it) => it.product.trim() || it.sku.trim())
    if (!form.customer.trim()) { setError('Customer name is required'); return }
    if (validItems.length === 0) { setError('Add at least one product line'); return }
    setSaving(true)
    setError('')
    const payload = {
      customer: form.customer.trim(),
      customerPhone: form.phone.trim() || null,
      customerEmail: form.email.trim() || null,
      customerCity: form.city.trim() || null,
      notes: form.notes.trim() || null,
      validUntil: form.validUntil || null,
      gst: gstRate,
      discount,
      items: validItems.map((it) => ({
        product: it.product.trim(),
        sku: it.sku.trim(),
        qty: Math.max(1, parseInt(it.qty, 10) || 1),
        weight: parseFloat(it.weight) || 0,
        silverRate: parseFloat(it.silverRate) || 0,
        makingCharge: parseFloat(it.makingCharge) || 0,
      })),
    }
    try {
      if (editingId) {
        await dbApi.updateQuotation(editingId, payload)
        toast.success('Quotation updated')
      } else {
        await dbApi.createQuotation(payload)
      }
      setDialogOpen(false)
      load()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : editingId ? 'Failed to update quotation' : 'Failed to create quotation',
      )
    } finally {
      setSaving(false)
    }
  }

  // ─── Lifecycle actions ─────────────────────────────────────────────────────
  const changeStatus = async (q: Quotation, next: Quotation['status'], opts?: { extendDays?: number }) => {
    if (next === 'cancelled') {
      const ok = await confirmDialog({
        title: `Cancel ${q.number}?`,
        description: 'The quotation stays on record as cancelled and can no longer be converted.',
        confirmLabel: 'Cancel quotation',
        danger: true,
      })
      if (!ok) return
    }
    setConvertingId(q.id)
    try {
      // Reopening an expired quotation first needs a validity window.
      let reopenUntil: Date | null = null
      if (next === 'draft' && opts?.extendDays) {
        reopenUntil = new Date(Date.now() + opts.extendDays * 86_400_000)
        await dbApi.updateQuotation(q.id, { validUntil: reopenUntil.toISOString() })
      }
      await dbApi.setQuotationStatus(q.id, next)
      toast.success(
        next === 'draft' && reopenUntil
          ? `${q.number} reopened — valid until ${formatDate(reopenUntil.toISOString())}`
          : `${q.number} marked ${next}`,
      )
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update status')
    } finally {
      setConvertingId(null)
    }
  }

  // ─── Send to customer ─────────────────────────────────────────────────────
  const [sendingId, setSendingId] = useState<string | null>(null)

  const sendByEmail = async (q: Quotation) => {
    setSendingId(q.id)
    try {
      const r = await dbApi.emailQuotation(q.id)
      if (r.ok) {
        toast.success(`Quotation emailed to ${r.to}`)
        load()
      } else {
        toast.error(r.error ?? 'Email failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Email failed')
    } finally {
      setSendingId(null)
    }
  }

  const sendByWhatsApp = async (q: Quotation) => {
    setSendingId(q.id)
    try {
      const r = await dbApi.sendQuotationWhatsApp(q.id)
      if (r.ok) {
        toast.success(`Quotation sent on WhatsApp to ${r.to}`)
        load()
      } else {
        toast.error(r.error ?? 'WhatsApp send failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'WhatsApp send failed')
    } finally {
      setSendingId(null)
    }
  }

  const convert = useCallback(async (q: Quotation) => {
    if (!(await confirmDialog({ title: `Convert ${q.number} into a tax invoice?`, description: 'Stock will be deducted and an invoice number generated.', confirmLabel: 'Convert' }))) return
    setConvertingId(q.id)
    setMessage(null)
    try {
      const r = await dbApi.convertQuotation(q.id)
      setMessage({ ok: true, text: `${q.number} converted to invoice ${r.invoiceNumber}` })
      load()
    } catch (err) {
      setMessage({ ok: false, text: formatApiError(err, 'Conversion failed') })
    } finally {
      setConvertingId(null)
    }
  }, [load])

  // Stable DataTable row handler: an inline lambda would change identity every
  // render and defeat the table memo, re-rendering all rows on each dialog
  // keystroke (felt as input lag).
  const convertRow = useCallback((q: Quotation) => { void convert(q) }, [convert])

  const convertToOrder = async (q: Quotation) => {
    if (!(await confirmDialog({ title: `Convert ${q.number} into a sales order?`, description: 'Creates a confirmed order without stock movement — invoicing happens when the order is fulfilled.', confirmLabel: 'Convert' }))) return
    setConvertingId(q.id)
    setMessage(null)
    try {
      const r = await dbApi.convertQuotationToOrder(q.id)
      setMessage({ ok: true, text: `${q.number} converted to sales order ${r.orderNumber}` })
      load()
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Conversion failed' })
    } finally {
      setConvertingId(null)
    }
  }

  const removeQuote = async (id: string) => {
    if (!(await confirmDialog({ title: 'Delete this quotation?', danger: true, confirmLabel: 'Delete' }))) return
    const snapshot = quotes.find((r) => r.id === id)
    try {
      await dbApi.deleteQuotation(id)
      setQuotes((prev) => prev.filter((r) => r.id !== id))
      if (snapshot) {
        toast.undoable('Quotation deleted', async () => {
          try {
            await dbApi.create('quotations', snapshot as unknown as Record<string, unknown>)
            setQuotes((prev) => [snapshot, ...prev])
            toast.success('Delete undone — quotation restored')
          } catch {
            toast.error('Could not restore quotation')
          }
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const columns = useMemo<ColumnDef<Quotation>[]>(
    () => [
      {
        accessorKey: 'number',
        header: 'Quotation',
        meta: { headerClassName: 'min-w-[150px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <FileText className="h-4 w-4" />
            </div>
            <div>
              <p className="font-mono font-medium text-foreground">{row.original.number}</p>
              <p className="text-[11px] text-muted-foreground">{formatDate(row.original.date)}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'customer',
        header: 'Customer',
        cell: ({ row }) => <span className="font-medium text-foreground">{row.original.customer ?? '—'}</span>,
      },
      {
        id: 'phone',
        header: 'Phone',
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.customerPhone ?? '—'}</span>,
      },
      {
        accessorKey: 'grandTotal',
        header: 'Total',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.grandTotal)}</span>,
      },
      {
        accessorKey: 'validUntil',
        header: 'Valid Until',
        cell: ({ row }) => {
          if (!row.original.validUntil) return <span className="text-muted-foreground">—</span>
          const isExpired = new Date(row.original.validUntil).getTime() < Date.now()
          return (
            <span className={isExpired ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground'}>
              {formatDate(row.original.validUntil)}
              {isExpired && !isClosed(row.original.status) ? ' · lapsed' : ''}
            </span>
          )
        },
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const s = statusBadge[row.original.status] ?? { label: row.original.status, variant: 'muted' as const }
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
                  <Button variant="ghost" size="icon-sm" onClick={() => printQuotation(row.original)}>
                    <Printer className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Print / PDF</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => backupApi.downloadQuotationPDF(row.original.id)}>
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Download PDF</TooltipContent>
              </Tooltip>
              {isLive(row.original.status) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={sendingId === row.original.id}
                      onClick={() => sendByEmail(row.original)}
                    >
                      {sendingId === row.original.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Mail className="h-3.5 w-3.5 text-primary-600" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Email with PDF</TooltipContent>
                </Tooltip>
              )}
              {isLive(row.original.status) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={sendingId === row.original.id || !row.original.customerPhone}
                      onClick={() => sendByWhatsApp(row.original)}
                    >
                      <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {row.original.customerPhone ? 'Send on WhatsApp' : 'No phone number on this quotation'}
                  </TooltipContent>
                </Tooltip>
              )}
              {row.original.status === 'draft' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={convertingId === row.original.id}
                      onClick={() => changeStatus(row.original, 'sent')}
                    >
                      <Send className="h-3.5 w-3.5 text-primary-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Mark as sent</TooltipContent>
                </Tooltip>
              )}
              {row.original.status === 'sent' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={convertingId === row.original.id}
                      onClick={() => changeStatus(row.original, 'approved')}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Customer approved</TooltipContent>
                </Tooltip>
              )}
              {row.original.status === 'expired' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={convertingId === row.original.id}
                      onClick={() => changeStatus(row.original, 'draft', { extendDays: 15 })}
                    >
                      <RotateCcw className="h-3.5 w-3.5 text-primary-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reopen for 15 more days</TooltipContent>
                </Tooltip>
              )}
              {isLive(row.original.status) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={convertingId === row.original.id}
                      onClick={() => changeStatus(row.original, 'cancelled')}
                    >
                      <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel quotation</TooltipContent>
                </Tooltip>
              )}
              {row.original.status !== 'converted' && row.original.status !== 'cancelled' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={convertingId === row.original.id || row.original.status === 'expired'}
                      onClick={() => convert(row.original)}
                    >
                      {convertingId === row.original.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Wallet className="h-3.5 w-3.5 text-success-600" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {row.original.status === 'expired'
                      ? 'Expired — reopen to convert'
                      : 'Convert to invoice'}
                  </TooltipContent>
                </Tooltip>
              )}
              {isLive(row.original.status) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={convertingId === row.original.id}
                      onClick={() => convertToOrder(row.original)}
                    >
                      {convertingId === row.original.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <ShoppingBag className="h-3.5 w-3.5 text-info-600" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Convert to sales order</TooltipContent>
                </Tooltip>
              )}
              {row.original.convertedInvoice && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex h-8 w-8 items-center justify-center text-[10px] font-semibold text-success-700">
                      {row.original.convertedInvoice.slice(-4)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Invoice {row.original.convertedInvoice}</TooltipContent>
                </Tooltip>
              )}
              {isLive(row.original.status) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.original.number}`} onClick={() => openEdit(row.original)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit quotation</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => removeQuote(row.original.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete quotation</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [convertingId],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Quotations"
        subtitle="Pre-sale estimates for walk-in and enquiry customers — convert approved quotes into tax invoices in one click."
        actions={
          <Button size="sm" onClick={openDialog}>
            <Plus className="h-4 w-4" /> New Quotation
          </Button>
        }
      />

      {message && (
        <Card className={`border ${message.ok ? 'border-success-200 bg-success-50' : 'border-red-200 bg-red-50'}`}>
          <CardContent className="flex items-center gap-2 p-3 text-sm">
            {message.ok ? <CheckCircle2 className="h-4 w-4 text-success-600" /> : <span className="text-red-600 dark:text-red-400">⚠</span>}
            <span className={`${message.ok ? 'text-success-800' : 'text-red-800'} whitespace-pre-line`}>{message.text}</span>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniCard label="Total Quotations" value={String(quotes.length)} sub="All time" />
        <MiniCard label="Open" value={String(quotes.filter((q) => q.status === 'draft' || q.status === 'sent').length)} sub="Awaiting decision" />
        <MiniCard label="Converted" value={String(quotes.filter((q) => q.status === 'converted').length)} sub="Became invoices" />
        <MiniCard label="Quoted Value" value={formatCurrency(quotes.filter((q) => q.status !== 'converted' && q.status !== 'cancelled').reduce((a, q) => a + q.grandTotal, 0))} sub="Open pipeline" />
      </div>

      <SalesFollowUpsCard />

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search quote number, customer..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[
                { value: '', label: `All Status (${quotes.length})` },
                ...statusOptions.map((st) => ({
                  value: st,
                  label: `${statusBadge[st]?.label ?? st} (${quotes.filter((r) => r.status === st).length})`,
                })),
              ]}
              value={statusFilter}
              onValueChange={setStatusFilter}
              className="w-[170px]"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {quotes.length} quotations
            </div>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No quotations found"
            onRowClick={setViewQuote}
            onRowDoubleClick={convertRow}
          />
        </CardContent>
      </Card>

      {/* Create dialog */}
      <AppDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        size="lg"
        isDirty={dialogOpen && snapshotForm() !== baseline}
        title={editingId ? 'Edit Quotation' : 'New Quotation'}
        description={editingId ? 'Update the estimate. Totals recompute automatically.' : 'Create a pre-sale estimate. Nothing is billed until you convert it.'}
        footer={
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editingId ? 'Save Changes' : 'Create Quotation'}
            </Button>
          </DialogFooter>
        }
      >
          <div className="grid gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Customer name *">
                <Input value={form.customer} onChange={(e) => setForm((f) => ({ ...f, customer: e.target.value }))} placeholder="Walk-in customer" />
              </Field>
              <Field label="Phone">
                <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+91..." />
              </Field>
              <Field label="Email">
                <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              </Field>
              <Field label="City">
                <Input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
              </Field>
            </div>

            <div className="space-y-2 border-t pt-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Line items</Label>
                <Button variant="outline" size="sm" onClick={() => setItems((prev) => [...prev, { ...emptyItem }])}>
                  <Plus className="h-3.5 w-3.5" /> Add line
                </Button>
              </div>
              {items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-2 items-end gap-2 rounded-lg border p-2.5 sm:grid-cols-6">
                  <div className="col-span-2 sm:col-span-2">
                    <Label className="text-[10px] text-muted-foreground">Product</Label>
                    <Input className="h-8 text-xs" value={it.product} onChange={(e) => setItem(idx, { product: e.target.value })} placeholder="Item name" />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">SKU</Label>
                    <Input className="h-8 text-xs" value={it.sku} onChange={(e) => setItem(idx, { sku: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Qty</Label>
                    <Input className="h-8 text-xs" type="number" min="1" value={it.qty} onChange={(e) => setItem(idx, { qty: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Weight (g)</Label>
                    <Input className="h-8 text-xs" type="number" value={it.weight} onChange={(e) => setItem(idx, { weight: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Making ₹</Label>
                    <Input className="h-8 text-xs" type="number" value={it.makingCharge} onChange={(e) => setItem(idx, { makingCharge: e.target.value })} />
                  </div>
                  <div className="col-span-2 flex items-center justify-between sm:col-span-6">
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>Silver rate ₹/g</span>
                      <Input className="h-7 w-24 text-xs" type="number" value={it.silverRate} onChange={(e) => setItem(idx, { silverRate: e.target.value })} />
                      <span className="font-semibold text-foreground">Line: {formatCurrency(itemAmount(it))}</span>
                    </div>
                    {items.length > 1 && (
                      <Button variant="ghost" size="icon-sm" onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}>
                        <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-4">
              <Field label="GST %">
                <Input type="number" value={form.gst} onChange={(e) => setForm((f) => ({ ...f, gst: e.target.value }))} />
              </Field>
              <Field label="Discount ₹">
                <Input type="number" value={form.discount} onChange={(e) => setForm((f) => ({ ...f, discount: e.target.value }))} />
              </Field>
              <Field label="Valid until">
                <Input type="date" value={form.validUntil} onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))} />
              </Field>
              <div className="rounded-lg bg-muted/50 p-2 text-right">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Grand total</p>
                <p className="text-lg font-bold tabular-nums text-foreground">{formatCurrency(grandTotal)}</p>
                <p className="text-[10px] text-muted-foreground">{formatCurrency(itemsTotal)} + {formatCurrency(gstAmount)} GST − {formatCurrency(discount)}</p>
              </div>
            </div>

            <Field label="Notes">
              <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Design details, delivery promise..." />
            </Field>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
      </AppDialog>

      {/* View dialog */}
      <AppDialog
        open={viewQuote !== null}
        onOpenChange={(open) => { if (!open) setViewQuote(null) }}
        size="xl"
        title={<>Quotation {viewQuote?.number}</>}
        description={viewQuote ? formatDate(viewQuote.date) : ''}
        footer={
          viewQuote && viewQuote.status !== 'converted' && viewQuote.status !== 'cancelled' ? (
            <div className="flex flex-wrap gap-2">
              <PrintTemplatePicker docType="quotation" onSelect={(config) => printQuotation(viewQuote, config)} />
              <Button variant="outline" className="flex-1" size="sm" onClick={() => printQuotation(viewQuote)}>
                <Printer className="h-4 w-4" /> Print / PDF
              </Button>
              <Button variant="outline" className="flex-1" size="sm" onClick={() => backupApi.downloadQuotationPDF(viewQuote.id)}>
                <Download className="h-4 w-4" /> Download PDF
              </Button>
              <Button className="flex-1" size="sm" disabled={convertingId === viewQuote.id} onClick={() => { const q = viewQuote; setViewQuote(null); void convert(q) }}>
                <Wallet className="h-4 w-4" /> Convert to Invoice
              </Button>
            </div>
          ) : undefined
        }
      >
          {viewQuote && (
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Customer</span><span className="font-medium">{viewQuote.customer ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Phone</span><span>{viewQuote.customerPhone ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Status</span><Badge variant={statusBadge[viewQuote.status]?.variant ?? 'muted'} dot>{statusBadge[viewQuote.status]?.label ?? viewQuote.status}</Badge></div>
              {viewQuote.validUntil && <div className="flex justify-between"><span className="text-muted-foreground">Valid until</span><span>{formatDate(viewQuote.validUntil)}</span></div>}
              {viewQuote.convertedInvoice && (
                <div className="flex justify-between"><span className="text-muted-foreground">Converted to</span><span className="font-mono font-medium text-success-700">{viewQuote.convertedInvoice}</span></div>
              )}
              <div className="border-t pt-2">
                <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Items</p>
                <div className="space-y-1.5">
                  {(viewQuote.items ?? []).map((it, i) => (
                    <div key={it.id ?? i} className="flex justify-between text-xs">
                      <span>{it.product || it.sku} × {it.qty}{it.weight ? ` · ${it.weight}g` : ''}</span>
                      <span className="tabular-nums">{formatCurrency(it.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-1 border-t pt-2">
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Subtotal</span><span>{formatCurrency(viewQuote.subtotal)}</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">GST ({viewQuote.gst}%)</span><span>{formatCurrency(viewQuote.gstAmount)}</span></div>
                {viewQuote.discount > 0 && <div className="flex justify-between text-xs"><span className="text-muted-foreground">Discount</span><span>−{formatCurrency(viewQuote.discount)}</span></div>}
                <div className="flex justify-between border-t pt-1.5 font-semibold"><span>Grand total</span><span>{formatCurrency(viewQuote.grandTotal)}</span></div>
              </div>
              {viewQuote.notes && <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">{viewQuote.notes}</p>}
            </div>
          )}
      </AppDialog>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function MiniCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-3 sm:p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-bold text-foreground">{value}</p>
      {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
    </Card>
  )
}
