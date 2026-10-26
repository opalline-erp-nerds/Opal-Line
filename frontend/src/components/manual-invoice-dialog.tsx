import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from '@/components/ui/confirm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { AppDialog } from '@/components/ui/app-dialog'
import { DialogFooter } from '@/components/ui/dialog'
import { CustomerPicker, type CustomerHit } from '@/components/customer-picker'
import { dbApi } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { useSilverRate } from '@/lib/silver-rate-context'
import { lineAmount, invoiceTotalsPreview } from '@/lib/invoicePricing'
import type { Invoice, Product } from '@/types'

/** Sentinel: the line's product is typed by hand, not picked from the catalogue. */
const CUSTOM_SKU = '__custom__'

/** One editable line in the manual-invoice form. */
interface DraftLine {
  product: string
  sku: string
  qty: string
  /** Per-PIECE net weight in grams (from the catalogue). */
  netWeight: string
  /** Making charge PER GRAM (from the catalogue, editable). */
  makingCharge: string
}

function emptyLine(): DraftLine {
  return { product: '', sku: '', qty: '1', netWeight: '', makingCharge: '' }
}

/** Total billable weight for a line = per-piece net weight × qty. */
function lineTotalWeight(line: DraftLine): number {
  const net = Number(line.netWeight) || 0
  const qty = Math.max(1, Math.floor(Number(line.qty) || 1))
  return net * qty
}

interface DraftForm {
  customer: string
  customerEmail: string
  customerPhone: string
  buyerGstin: string
  paymentMethod: string
  paymentStatus: string
  status: string
  gst: string
  discount: string
}

function emptyForm(): DraftForm {
  return {
    customer: '', customerEmail: '', customerPhone: '', buyerGstin: '',
    paymentMethod: 'Cash', paymentStatus: 'pending', status: 'issued',
    gst: '3', discount: '0',
  }
}

export interface ManualInvoiceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-fill the buyer, e.g. when billing from a specific order. */
  initialCustomer?: string
  initialCustomerPhone?: string
  /** Called with the row the server returned, after it has been created. */
  onCreated?: (invoice: Invoice) => void
}

/**
 * Bill a walk-in or phone sale straight to an invoice — no sales order needed.
 *
 * The silver rate comes from Silver Rate Management (authoritative, read-only)
 * and every total is computed with the SAME per-gram maths the server uses
 * (`lib/invoicePricing` mirrors `normalizeInvoiceItems`), so the preview equals
 * what gets stored. Each line carrying a SKU deducts stock; hand-typed lines
 * leave stock alone. The server mints the invoice number.
 *
 * Shared by the Sales Invoices "New Invoice" button and the Sales Orders page.
 */
export function ManualInvoiceDialog({
  open,
  onOpenChange,
  initialCustomer,
  initialCustomerPhone,
  onCreated,
}: ManualInvoiceDialogProps) {
  const { rate: silverRate } = useSilverRate()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [productQuery, setProductQuery] = useState('')
  const [productHits, setProductHits] = useState<Product[]>([])
  // Tracks the query whose results are in productHits, so the spinner is
  // derived (not set synchronously in the search effect).
  const [resolvedProductQuery, setResolvedProductQuery] = useState('')
  const [form, setForm] = useState<DraftForm>(emptyForm)
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()])
  const productToken = useRef(0)

  // Managed rate per gram; 0 until the provider loads (blocks submit below).
  const ratePerGram = silverRate?.rate ?? 0

  // Reset the form each time the dialog opens so a stale draft (or the previous
  // order's pre-fill) never leaks into the next invoice.
  useEffect(() => {
    if (!open) return
    // Defer the setState out of the effect body (react/set-state-in-effect).
    queueMicrotask(() => {
      setError('')
      setProductQuery('')
      setProductHits([])
      setForm({ ...emptyForm(), customer: initialCustomer ?? '', customerPhone: initialCustomerPhone ?? '' })
      setLines([emptyLine()])
    })
  }, [open, initialCustomer, initialCustomerPhone])

  // Seed the product search with the full catalogue on first open so the
  // dropdown is browsable before the user types.
  useEffect(() => {
    if (!open || products.length > 0) return
    dbApi.getProducts().then((all) => {
      setProducts(all)
      setProductHits(all.slice(0, 20))
    }).catch(() => setProducts([]))
  }, [open, products.length])

  // Debounced product search (name / SKU) with a stale-guard.
  useEffect(() => {
    if (!open) return
    const q = productQuery.trim()
    if (q === '') {
      // Defer the reset out of the effect body (react/set-state-in-effect).
      queueMicrotask(() => {
        setProductHits(products.slice(0, 20))
        setResolvedProductQuery('')
      })
      return
    }
    const lower = q.toLowerCase()
    // Filter the already-loaded catalogue first; only reach out when the local
    // list doesn't obviously contain the term (keeps keystrokes snappy).
    const local = products.filter(
      (p) =>
        p.name.toLowerCase().includes(lower) ||
        p.sku.toLowerCase().includes(lower),
    )
    if (local.length > 0) {
      // Defer out of the effect body (react/set-state-in-effect).
      queueMicrotask(() => {
        setProductHits(local.slice(0, 20))
        setResolvedProductQuery(q)
      })
      return
    }
    const t = window.setTimeout(() => {
      const token = ++productToken.current
      dbApi.searchProducts(q).then((rows) => {
        if (token !== productToken.current) return // stale — a newer query won
        setProductHits(rows)
        setResolvedProductQuery(q)
      }).catch(() => {
        if (token !== productToken.current) return
        setProductHits([])
        setResolvedProductQuery(q)
      })
    }, 250)
    return () => window.clearTimeout(t)
  }, [productQuery, open, products])

  // Derived: a non-empty query is "searching" until its results have landed.
  const searchingProducts = productQuery.trim() !== '' && productQuery.trim() !== resolvedProductQuery

  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  const removeLine = (index: number) =>
    setLines((prev) => (prev.length === 1 ? [emptyLine()] : prev.filter((_, i) => i !== index)))

  // Picking a catalogue product prefills name, per-piece net weight and the
  // per-gram making charge — the two numbers that drive the price.
  const pickProduct = (index: number, sku: string) => {
    if (sku === CUSTOM_SKU) {
      setLine(index, { sku: '', product: '' })
      return
    }
    const p = products.find((x) => x.sku === sku) ?? productHits.find((x) => x.sku === sku)
    if (!p) return
    setLine(index, {
      sku: p.sku,
      product: p.name,
      netWeight: p.netWeight != null ? String(p.netWeight) : '',
      makingCharge: p.makingCharge != null ? String(p.makingCharge) : '',
    })
  }

  // Customer autofetch: picking an existing customer fills their contact block.
  const onCustomerPicked = (hit: CustomerHit) => {
    setForm((f) => ({
      ...f,
      customer: hit.name ?? '',
      customerPhone: hit.phone ?? '',
      customerEmail: hit.email ?? '',
    }))
  }

  const totals = useMemo(() => {
    const priced = lines
      .filter((l) => l.sku.trim() !== '' || l.product.trim() !== '')
      .map((l) => ({
        weight: lineTotalWeight(l),
        silverRatePerGram: ratePerGram,
        makingChargePerGram: Number(l.makingCharge) || 0,
      }))
    return invoiceTotalsPreview(priced, Number(form.gst) || 0, Number(form.discount) || 0)
  }, [lines, form.gst, form.discount, ratePerGram])

  const submit = async () => {
    const customer = form.customer.trim()
    if (!customer) { setError('Customer name is required'); return }
    const usable = lines.filter((l) => l.sku.trim() !== '' || l.product.trim() !== '')
    if (usable.length === 0) { setError('Add at least one line item'); return }
    if (!(ratePerGram > 0)) { setError('Silver rate is not loaded yet — set it in Silver Rate Management.'); return }
    setSaving(true)
    setError('')
    try {
      const payload = {
        customer,
        customerEmail: form.customerEmail.trim() || null,
        customerPhone: form.customerPhone.trim() || null,
        buyerGstin: form.buyerGstin.trim() || null,
        paymentMethod: form.paymentMethod.trim() || null,
        paymentStatus: form.paymentStatus,
        status: form.status,
        gst: Number(form.gst) || 0,
        discount: Number(form.discount) || 0,
        date: new Date().toISOString(),
        items: usable.map((l) => {
          const weight = lineTotalWeight(l)
          const making = Number(l.makingCharge) || 0
          return {
            product: l.product.trim(),
            sku: l.sku.trim(),
            qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
            weight,
            // The server overwrites the rate with the managed value; sending it
            // keeps the payload self-describing for logs and for the preview
            // matching the stored row.
            silverRate: ratePerGram,
            makingCharge: making,
            amount: lineAmount({ weight, silverRatePerGram: ratePerGram, makingChargePerGram: making }),
          }
        }),
      }
      // No number in the payload — the server mints the next invoice number.
      const created = await dbApi.create<Invoice>('invoices', payload)
      toast.success(`Invoice ${created.number} created`)
      onOpenChange(false)
      onCreated?.(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invoice')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => { if (!next) onOpenChange(false) }}
      size="xl"
      title="New Sales Invoice"
      description="Bill a walk-in or phone sale directly — no sales order needed. The invoice number is minted automatically; each line with a SKU deducts stock."
      footer={
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Create invoice
          </Button>
        </DialogFooter>
      }
    >
      <div className="space-y-4 text-sm">
        {error ? (
          <div className="rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">{error}</div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Customer *">
            <CustomerPicker
              onPick={onCustomerPicked}
              onNameChange={(name) => setForm((f) => ({ ...f, customer: name }))}
              disabled={saving}
            />
          </Field>
          <Field label="Phone">
            <Input value={form.customerPhone} onChange={(e) => setForm((f) => ({ ...f, customerPhone: e.target.value }))} />
          </Field>
          <Field label="Email"><Input type="email" value={form.customerEmail} onChange={(e) => setForm((f) => ({ ...f, customerEmail: e.target.value }))} /></Field>
          <Field label="Buyer GSTIN (optional)"><Input value={form.buyerGstin} onChange={(e) => setForm((f) => ({ ...f, buyerGstin: e.target.value.toUpperCase() }))} placeholder="e.g. 27AAAAA0000A1Z5" maxLength={15} /></Field>
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
                  <th className="min-w-[210px] px-3 py-2 font-medium">Product / SKU</th>
                  <th className="w-20 px-2 py-2 text-right font-medium">Qty</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Net wt / pc</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Rate / gm</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Making / gm</th>
                  <th className="w-24 px-2 py-2 text-right font-medium">Amount</th>
                  <th className="w-10 px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const weight = lineTotalWeight(line)
                  const preview = lineAmount({
                    weight,
                    silverRatePerGram: ratePerGram,
                    makingChargePerGram: Number(line.makingCharge) || 0,
                  })
                  return (
                    <tr key={index} className="border-b border-border/40 last:border-0">
                      <td className="px-2 py-1.5">
                        <Input
                          value={line.sku ? `${line.product} (${line.sku})` : line.product}
                          onChange={(e) => {
                            const v = e.target.value
                            // Typing clears the picked SKU (back to a hand line)
                            // and re-runs the product search.
                            setLine(index, { product: v, sku: '', netWeight: '', makingCharge: '' })
                            setProductQuery(v)
                          }}
                          placeholder="Search name or SKU…"
                          className="h-8 text-xs"
                          aria-label="Search products"
                        />
                        {productQuery.trim() !== '' && (productHits.length > 0 || searchingProducts) ? (
                          <div className="mt-1 max-h-32 overflow-auto rounded-md border border-border/60 bg-card p-1">
                            {searchingProducts && productHits.length === 0 ? (
                              <p className="flex items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground">
                                <Loader2 className="h-3 w-3 animate-spin" /> Searching…
                              </p>
                            ) : (
                              productHits.map((p) => (
                                <button
                                  key={p.sku}
                                  type="button"
                                  onClick={() => {
                                    pickProduct(index, p.sku)
                                    setProductQuery('')
                                  }}
                                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors hover:bg-muted"
                                >
                                  <span className="truncate">{p.name}</span>
                                  <span className="shrink-0 text-muted-foreground">{p.sku}</span>
                                </button>
                              ))
                            )}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input type="number" min="1" value={line.qty} onChange={(e) => setLine(index, { qty: e.target.value })} className="h-8 text-right text-xs" />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input type="number" min="0" step="0.001" value={line.netWeight} onChange={(e) => setLine(index, { netWeight: e.target.value })} className="h-8 text-right text-xs" />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-xs text-muted-foreground">
                        {ratePerGram > 0 ? ratePerGram.toFixed(2) : '—'}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input type="number" min="0" step="0.01" value={line.makingCharge} onChange={(e) => setLine(index, { makingCharge: e.target.value })} className="h-8 text-right text-xs" />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-xs" title={weight > 0 ? `${weight.toFixed(3)} gm × (₹${ratePerGram.toFixed(2)} + making)` : undefined}>
                        {formatCurrency(preview)}
                      </td>
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
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Rate / gm is locked to the managed silver rate. Amount = total weight (net wt × qty) × (rate + making per gm).
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid grid-cols-2 gap-3">
            <Field label="GST (%)">
              <Input type="number" min="0" step="0.01" value={form.gst} onChange={(e) => setForm((f) => ({ ...f, gst: e.target.value }))} />
            </Field>
            <Field label="Discount (₹)">
              <Input type="number" min="0" step="0.01" value={form.discount} onChange={(e) => setForm((f) => ({ ...f, discount: e.target.value }))} />
            </Field>
            <Field label="Payment method">
              <Input value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))} placeholder="Cash / UPI / Card" />
            </Field>
            <Field label="Payment status">
              <Select
                options={[
                  { value: 'pending', label: 'Pending' },
                  { value: 'partial', label: 'Partial' },
                  { value: 'paid', label: 'Paid' },
                ]}
                value={form.paymentStatus}
                onValueChange={(v) => setForm((f) => ({ ...f, paymentStatus: v }))}
              />
            </Field>
            <Field label="Invoice status">
              <Select
                options={[
                  { value: 'issued', label: 'Issued' },
                  { value: 'draft', label: 'Draft' },
                  { value: 'paid', label: 'Paid' },
                ]}
                value={form.status}
                onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}
              />
            </Field>
          </div>
          <div className="space-y-1 self-start rounded-md border border-border/60 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{formatCurrency(totals.subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">GST ({totals.gstRate}%)</span><span className="tabular-nums">{formatCurrency(totals.gstAmount)}</span></div>
            {totals.discount > 0 ? (
              <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="tabular-nums">− {formatCurrency(totals.discount)}</span></div>
            ) : null}
            <div className="flex justify-between border-t border-border/60 pt-1 font-semibold"><span>Grand total</span><span className="tabular-nums">{formatCurrency(totals.grandTotal)}</span></div>
          </div>
        </div>
      </div>
    </AppDialog>
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
