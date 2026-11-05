import { confirmDialog, toast } from '@/components/ui/confirm'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  Download,
  ExternalLink,
  FileText,
  Mail,
  MessageCircle,
  Pencil,
  Printer,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  Undo2,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { InvoiceReturnDialog } from '@/components/invoice-return-dialog'
import { PrintTemplatePicker } from '@/components/print-template-picker'
import { printDocument, mergePrintConfig, invoicePrintDoc } from '@/lib/printTemplate'
import { printTemplatesApi } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { dbApi } from '@/lib/api'
import type { AppSettings, EInvoiceStatus, Invoice } from '@/types'
import { formatCurrency, formatDateTime } from '@/lib/format'

export default function InvoiceDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [printConfig, setPrintConfig] = useState<unknown>(null)
  // SKU → product photo for printed line-item thumbnails. Any stored image is
  // fine for printing (the CDN-skip policy only applies to pushing to Shopify).
  const productImageBySku = useRef(new Map<string, string>())
  const [loading, setLoading] = useState(true)
  const [refunding, setRefunding] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [waSending, setWaSending] = useState(false)
  const [emailSending, setEmailSending] = useState(false)
  // Auto UPI QR for printables (from Settings UPI ID); null = hidden.
  const [upiQr, setUpiQr] = useState<string | null>(null)
  const [einvoice, setEinvoice] = useState<EInvoiceStatus | null>(null)
  const [irnBusy, setIrnBusy] = useState(false)
  // Return-dialog state must live above the early returns (Rules of Hooks).
  // The dialog itself is the shared component: it loads per-line sold /
  // previously returned / remaining quantities and submits an idempotent
  // request so a retry can never restock twice.
  const [returnOpen, setReturnOpen] = useState(false)
  const returnProcessed = (opts: { returnStatus: Invoice['status'] | null; fullyReturned: boolean }) => {
    const next = opts.returnStatus
    if (next !== 'partially_returned' && next !== 'fully_returned') return
    setInvoice((inv) => (inv ? { ...inv, status: next } : inv))
  }
  useEffect(() => {
    // Defer out of the effect body: setLoading fires synchronously
    // (react/set-state-in-effect).
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setLoading(true)
      // Drop per-invoice carry-over (IRN card, UPI QR, return dialog) so
      // nothing from the previously viewed invoice can leak into this one.
      setEinvoice(null)
      setUpiQr(null)
      setReturnOpen(false)
      dbApi.getInvoiceById(id ?? '').then((inv) => {
        // A slower response for a previously opened invoice must never
        // overwrite the record currently on screen.
        if (cancelled) return
        setInvoice(inv ?? null)
        setLoading(false)
      }).catch(() => { if (!cancelled) setLoading(false) })
      dbApi.getSettings().then((s) => { if (!cancelled) setSettings(s ?? null) }).catch(() => {})
      dbApi.getProducts()
        .then((ps) => {
          if (cancelled) return
          const m = new Map<string, string>()
          for (const p of ps) {
            const src = p.image?.trim()
            if (src) m.set(p.sku, src)
          }
          productImageBySku.current = m
        })
        .catch(() => {})
      printTemplatesApi.getDefault('invoice').then((r) => { if (!cancelled) setPrintConfig(r.config) }).catch(() => {})
    })
    return () => { cancelled = true }
  }, [id])

  // Fetch the UPI QR once the invoice total is known; silently absent when
  // no UPI ID is configured in Settings.
  useEffect(() => {
    if (!invoice?.grandTotal) return
    let cancelled = false
    printTemplatesApi
      .getUpiQr(invoice.grandTotal)
      .then((r) => { if (!cancelled && r.enabled && r.dataUrl) setUpiQr(r.dataUrl) })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [invoice?.grandTotal])

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[1300px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-10 w-80" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Skeleton className="h-72 rounded-lg lg:col-span-2" />
          <Skeleton className="h-72 rounded-lg" />
        </div>
      </div>
    )
  }

  if (!invoice) {
    return <div className="px-6 py-6 text-sm text-muted-foreground">Invoice not found.</div>
  }

  const printInvoice = (arg?: unknown) => {
    // Support both: printInvoice({ mode: 'pdf' }) from buttons
    // and printInvoice(config, name) from PrintTemplatePicker
    const options = (typeof arg === 'object' && arg !== null && ('mode' in arg || 'configOverride' in arg))
      ? (arg as { configOverride?: unknown; mode?: 'silent' | 'dialog' | 'pdf' })
      : { configOverride: arg }
    // The print doc is a straight mapping of the PERSISTED invoice (Settings
    // GSTIN/address/phone win over values stamped on the row) — same saved
    // values the screen shows, no recalculation.
    const doc = invoicePrintDoc(invoice, {
      imagesBySku: productImageBySku.current,
      business: {
        businessName: settings?.businessName || invoice.businessName,
        businessGstin: settings?.gstin || invoice.businessGstin || null,
        businessAddress: settings?.address || invoice.businessAddress || null,
        businessPhone: settings?.phone || invoice.businessPhone || null,
        businessEmail: settings?.email || invoice.businessEmail || null,
      },
    })
    // An explicit config comes from the saved-template picker; otherwise the
    // saved default (or stock layout) applies.
    const merged = mergePrintConfig(options.configOverride ?? printConfig)
    // Prefer a manually-uploaded QR design; otherwise use the auto UPI QR.
    const withQr = merged.qrDataUrl ? merged : { ...merged, showQr: upiQr !== null, qrDataUrl: upiQr, qrCaption: 'Scan to pay via UPI' }
    printDocument(doc, withQr, {
      docType: 'invoice',
      tagline: '92.5 Sterling Silver Jewellery',
      showImages: true,
    }, options.mode)
  }

  const emailInvoice = async () => {
    setEmailSending(true)
    try {
      const result = await dbApi.emailInvoice(invoice.id, invoice.customerEmail || undefined)
      if (result.ok) {
        toast.success(`Invoice ${invoice.number} emailed to ${result.to}`)
      } else {
        toast.error(result.error || 'Email send failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Email send failed')
    } finally {
      setEmailSending(false)
    }
  }

  const sendWhatsAppInvoice = async () => {
    setWaSending(true)
    try {
      const result = await dbApi.sendInvoiceWhatsApp(invoice.id)
      if (result.ok) {
        toast.success(`Invoice ${invoice.number} sent to ${result.to} on WhatsApp`)
      } else {
        toast.error(result.error || 'WhatsApp send failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'WhatsApp send failed')
    } finally {
      setWaSending(false)
    }
  }

  const refundInvoice = async () => {
    if (!(await confirmDialog({ title: `Mark invoice ${invoice.number} as refunded? This cannot be undone.` }))) return
    setRefunding(true)
    try {
      await dbApi.update('invoices', invoice.id, { status: 'refunded', paymentStatus: 'refunded' })
      setInvoice({ ...invoice, status: 'refunded', paymentStatus: 'refunded' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refund failed')
    } finally {
      setRefunding(false)
    }
  }

  // Edit reuses the invoices list page's edit dialog via router state.
  const editInvoice = () => {
    if (!invoice) return
    navigate('/sales/invoices', { state: { editInvoiceId: invoice.id } })
  }

  // Permanent delete: the backend reverses the invoice's stock in the same
  // transaction and the loyalty points it earned right after — same contract
  // as the delete on the invoices list page.
  const deleteInvoice = async () => {
    if (!invoice) return
    if (!(await confirmDialog({
      title: `Delete invoice ${invoice.number}?`,
      description: 'This permanently removes the invoice. The stock it sold comes back into inventory and the loyalty points it earned are reversed.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return
    setDeleting(true)
    try {
      await dbApi.remove('invoices', invoice.id)
      toast.success(`Invoice ${invoice.number} deleted — stock and loyalty points reversed`)
      navigate('/sales/invoices')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
      setDeleting(false)
    }
  }

  // Returns: choose quantities per line item → per-line credit note + restock
  const openReturnDialog = () => {
    setReturnOpen(true)
  }

  const customerInitial = invoice.customer.split(' ').map((n) => n[0]).join('').slice(0, 2)

  return (
    <div className="mx-auto w-full max-w-[1300px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/sales/invoices" className="flex items-center gap-1 hover:text-primary-700">
          <ArrowLeft className="h-3 w-3" /> Sales Invoices
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">{invoice.number}</span>
      </div>

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300 ring-1 ring-primary-100">
              <FileText className="h-5 w-5" />
            </div>
            <span>Sales Invoice</span>
            <span className="font-mono text-lg font-semibold text-primary-700">{invoice.number}</span>
            {invoice.status === 'refunded' ? (
              <Badge variant="muted" dot>REFUNDED</Badge>
            ) : invoice.status === 'fully_returned' ? (
              <Badge variant="muted" dot>FULLY RETURNED</Badge>
            ) : invoice.status === 'partially_returned' ? (
              <Badge variant="warning" dot>PARTIALLY RETURNED</Badge>
            ) : (
              <Badge variant="success" dot>PAID</Badge>
            )}
          </span>
        }
        subtitle={`${invoice.shopifyOrder ? `Shopify Order ${invoice.shopifyOrder}` : 'Manual / Booking invoice'} · ${formatDateTime(invoice.date)}`}
        actions={
          <>
            <PrintTemplatePicker docType="invoice" onSelect={(config) => printInvoice(config)} />
            <Button variant="outline" size="sm" onClick={() => printInvoice()}><Printer className="h-3.5 w-3.5" /> Print</Button>
            <Button variant="outline" size="sm" onClick={() => printInvoice({ mode: 'pdf' })}><Download className="h-3.5 w-3.5" /> Save as PDF</Button>
            <Button variant="outline" size="sm" onClick={emailInvoice} disabled={emailSending}><Mail className="h-3.5 w-3.5" /> {emailSending ? 'Sending…' : 'Email'}</Button>
            {invoice.customerPhone ? (
              <Button variant="outline" size="sm" onClick={sendWhatsAppInvoice} disabled={waSending}><MessageCircle className="h-3.5 w-3.5" /> {waSending ? 'Sending…' : 'Send WhatsApp'}</Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={openReturnDialog} disabled={invoice.status === 'refunded' || invoice.status === 'cancelled' || invoice.status === 'fully_returned'}>
              <Undo2 className="h-3.5 w-3.5" /> Return Items
            </Button>
            <Button variant="soft-danger" size="sm" onClick={refundInvoice} disabled={refunding || invoice.status === 'refunded'}><Undo2 className="h-3.5 w-3.5" /> Refund</Button>
            <Button variant="outline" size="sm" onClick={editInvoice}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
            <Button variant="soft-danger" size="sm" onClick={() => void deleteInvoice()} disabled={deleting}><Trash2 className="h-3.5 w-3.5" /> {deleting ? 'Deleting…' : 'Delete'}</Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-sm">Invoice Items</CardTitle>
                <CardDescription>{invoice.items.length} line items · 92.5% Sterling Silver</CardDescription>
              </div>
              <Badge variant="success">
                <CircleCheck className="h-3 w-3" /> Ecommerce Sale
              </Badge>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Weight</TableHead>
                    <TableHead className="text-right">Silver Rate</TableHead>
                    <TableHead className="text-right">Making</TableHead>
                    <TableHead className="text-right">Tax</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoice.items.map((item, i) => {
                    const lineMakingValue = item.weight * item.makingCharge
                    return (
                      <TableRow key={i}>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
                              <FileText className="h-3.5 w-3.5" />
                            </div>
                            <div>
                              <p className="font-medium text-foreground">{item.product}</p>
                              <p className="text-[10.5px] text-muted-foreground">{item.sku}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{item.qty}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{item.weight.toFixed(2)} gm</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{item.silverRate > 0 ? `₹${item.silverRate.toFixed(2)}/g` : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{item.makingCharge > 0 ? `${formatCurrency(item.makingCharge)}/g = ${formatCurrency(lineMakingValue)}` : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{item.tax > 0 ? formatCurrency(item.tax) : '—'}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-foreground">{formatCurrency(item.amount)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              <div className="flex justify-end gap-4 border-t bg-muted/30 px-5 py-3 text-xs text-muted-foreground">
                <span>{invoice.items.reduce((a, i) => a + i.qty, 0)} items</span>
                <span>{invoice.items.reduce((a, i) => a + i.weight, 0).toFixed(2)} gm</span>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Billed To</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-600 text-sm font-semibold text-white">
                    {customerInitial}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{invoice.customer}</p>
                    <p className="text-xs text-muted-foreground">{invoice.customerEmail}</p>
                    {invoice.customerPhone ? <p className="text-xs text-muted-foreground">{invoice.customerPhone}</p> : null}
                  </div>
                </div>
                {invoice.customerAddress || invoice.customerCity || invoice.customerState || invoice.customerPincode ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {invoice.customerAddress ? <p>{invoice.customerAddress}</p> : null}
                    {[invoice.customerCity, invoice.customerState, invoice.customerPincode].filter(Boolean).length > 0 ? (
                      <p>{[invoice.customerCity, invoice.customerState, invoice.customerPincode].filter(Boolean).join(', ')}</p>
                    ) : null}
                  </div>
                ) : null}
                <Separator className="my-4" />
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Shopify Order</span>
                    <span className="font-mono font-medium text-foreground">{invoice.shopifyOrder || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Payment Method</span>
                    <span className="font-medium text-foreground">{invoice.paymentMethod}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Invoice Date</span>
                    <span className="font-medium text-foreground">{formatDateTime(invoice.date)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Amount Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <SummaryRow label="Silver Value" value={invoice.silverValue > 0 ? formatCurrency(invoice.silverValue) : '—'} />
                <SummaryRow label="Making Charge" value={invoice.makingCharge > 0 ? formatCurrency(invoice.makingCharge) : '—'} />
                <SummaryRow label="Subtotal" value={formatCurrency(invoice.subtotal)} />
                <SummaryRow label={`GST @ ${invoice.gst}%`} value={formatCurrency(invoice.gstAmount)} />
                <SummaryRow label="Discount" value={`- ${formatCurrency(invoice.discount)}`} />
                <Separator />
                <div className="flex items-center justify-between pt-1">
                  <span className="text-sm font-semibold text-foreground">Grand Total</span>
                  <span className="text-xl font-bold text-primary-700">{formatCurrency(invoice.grandTotal)}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="space-y-4">
          <EInvoiceCard
            status={einvoice}
            busy={irnBusy}
            onLoad={(id) =>
              dbApi
                .getEInvoiceStatus(id)
                .then(setEinvoice)
                .catch(() => setEinvoice(null))
            }
            onGenerate={async () => {
              setIrnBusy(true)
              try {
                const r = await dbApi.generateEInvoice(invoice.id)
                setEinvoice((s) => ({
                  mode: s?.mode ?? 'manual',
                  provider: r.provider,
                  gatewayConfigured: s?.gatewayConfigured ?? false,
                  status: 'generated',
                  irn: r.irn,
                  irnDate: r.irnDate,
                  qrCode: r.qrCode,
                }))
                toast.success(`IRN generated via ${r.provider}`)
                setInvoice({ ...invoice, irn: r.irn, irnDate: r.irnDate, qrCode: r.qrCode })
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'IRN generation failed')
              } finally {
                setIrnBusy(false)
              }
            }}
            onCancel={async () => {
              setIrnBusy(true)
              try {
                await dbApi.cancelEInvoice(invoice.id, 'Cancelled by seller')
                toast.success('IRN cancelled')
                setEinvoice((s) => (s ? { ...s, status: 'pending', irn: s.irn } : s))
                setInvoice({ ...invoice, status: 'cancelled' })
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'IRN cancellation failed')
              } finally {
                setIrnBusy(false)
              }
            }}
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Payment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3 rounded-lg border border-success-100 bg-success-50/60 p-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-success-700 text-white">
                  <CircleCheck className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-success-700">Paid via Razorpay</p>
                  <p className="text-[11px] text-success-700/80">Settled · reconciled with bank</p>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Payment ID</span>
                  <span className="font-mono text-xs font-medium text-foreground">{invoice.paymentId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Amount</span>
                  <span className="font-semibold tabular-nums text-foreground">{formatCurrency(invoice.grandTotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Gateway</span>
                  <span className="font-medium text-foreground">Razorpay</span>
                </div>
              </div>
              <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => window.open('https://dashboard.razorpay.com/app/payments', '_blank', 'noopener')}>
                <ExternalLink className="h-3.5 w-3.5" /> View on Razorpay
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Order Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Shopify Order</span>
                <Link to="/sales/orders" className="flex items-center gap-1 font-mono font-medium text-primary-700 hover:underline">
                  {invoice.shopifyOrder || 'No linked order'} <ShoppingBag className="h-3 w-3" />
                </Link>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Fulfillment</span>
                <span className="font-medium text-foreground">{invoice.paymentStatus ?? 'Pending'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">GST</span>
                <span className="font-medium text-foreground">{invoice.gst}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">GST Type</span>
                <span className="font-medium text-foreground">Intra-state</span>
              </div>
              <Separator className="my-2" />
              <div className="flex items-start gap-2 rounded-md bg-muted/60 p-2.5 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-700" />
                {invoice.shopifyOrder
                  ? `Invoice generated automatically from Shopify order #${invoice.shopifyOrder.slice(1)}.`
                  : 'Invoice generated from a booking or manual order.'}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <InvoiceReturnDialog
        invoice={invoice}
        open={returnOpen}
        onOpenChange={setReturnOpen}
        onProcessed={returnProcessed}
      />
    </div>
  )
}

/**
 * E-invoicing panel: shows the IRN once generated, or the action to generate
 * one when the shop has e-invoicing switched on.
 */
function EInvoiceCard({
  status,
  busy,
  onLoad,
  onGenerate,
  onCancel,
}: {
  status: EInvoiceStatus | null
  busy: boolean
  onLoad: (invoiceId: string) => void
  onGenerate: () => void
  onCancel: () => void
}) {
  const { invoiceId } = useParams()
  useEffect(() => {
    if (invoiceId) onLoad(invoiceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId])

  // Nothing to show while e-invoicing is off — don't clutter every invoice.
  if (!status || status.mode === 'off') return null

  const generated = status.status === 'generated' && Boolean(status.irn)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" /> E-Invoice (GST)
        </CardTitle>
        <CardDescription>
          {status.mode === 'automatic'
            ? 'IRNs are generated automatically when an invoice is issued.'
            : 'Generate the IRN for this invoice when it is issued.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {generated && status.irn ? (
          <>
            <div className="rounded-lg border border-success-100 bg-success-50/60 p-3">
              <p className="text-sm font-semibold text-success-700">IRN generated</p>
              <p className="mt-1 break-all font-mono text-[11px] text-success-800">{status.irn}</p>
              {status.irnDate ? (
                <p className="mt-1 text-[11px] text-success-700/80">Issued {formatDateTime(status.irnDate)}</p>
              ) : null}
            </div>
            {status.qrCode ? (
              <div className="rounded-lg border p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Signed QR payload</p>
                <p className="mt-1 break-all font-mono text-[10.5px] text-muted-foreground">{status.qrCode}</p>
              </div>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5"
              disabled={busy}
              onClick={async () => {
                const ok = await confirmDialog({
                  title: 'Cancel this IRN?',
                  description: 'Cancelling an IRN at the GST portal cannot be undone, and the invoice will be marked cancelled.',
                  confirmLabel: 'Cancel IRN',
                  danger: true,
                })
                if (ok) onCancel()
              }}
            >
              {busy ? 'Cancelling…' : 'Cancel IRN'}
            </Button>
          </>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">
              No IRN on this invoice yet.
              {!status.gatewayConfigured ? ' It will be produced locally until a live GST gateway is connected.' : ''}
            </p>
            <Button size="sm" className="w-full gap-1.5" disabled={busy} onClick={onGenerate}>
              {busy ? 'Generating…' : 'Generate IRN'}
            </Button>
          </>
        )}
        <p className="text-[11px] text-muted-foreground">Provider: {status.provider}</p>
      </CardContent>
    </Card>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  )
}
