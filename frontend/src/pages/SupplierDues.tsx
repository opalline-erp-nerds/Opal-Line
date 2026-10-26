import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Building2, FileText, History, IndianRupee, Mail, RefreshCw, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { dbApi } from '@/lib/api'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'
import type { SupplierDue, SupplierDuesDetail, SupplierDuesResponse } from '@/types'

function ageDays(dateStr: string | null): number {
  if (!dateStr) return 0
  return Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000))
}

/** Worst bucket the supplier sits in — drives the badge. */
function ageBucket(due: SupplierDue): { label: string; variant: 'success' | 'warning' | 'danger' } {
  if (due.d60plus > 0) return { label: '60d+', variant: 'danger' }
  if (due.d31_60 > 0) return { label: '31–60d', variant: 'danger' }
  if (due.d1_30 > 0) return { label: '1–30d', variant: 'warning' }
  return { label: 'Not due', variant: 'success' }
}

export default function SupplierDuesPage() {
  const [data, setData] = useState<SupplierDuesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [sending, setSending] = useState(false)

  // Payment dialog
  const [payFor, setPayFor] = useState<SupplierDue | null>(null)
  const [detail, setDetail] = useState<SupplierDuesDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('bank-transfer')
  const [payNote, setPayNote] = useState('')
  const [paySaving, setPaySaving] = useState(false)

  // Read-only supplier detail
  const [viewFor, setViewFor] = useState<SupplierDue | null>(null)
  const [viewDetail, setViewDetail] = useState<SupplierDuesDetail | null>(null)
  const [viewLoading, setViewLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    dbApi.getSupplierDues()
      .then(setData)
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!data) return []
    return data.dues.filter((d) => !q || d.supplier.toLowerCase().includes(q))
  }, [data, query])

  const selectedBalance = useMemo(() => {
    if (!detail) return 0
    return detail.invoices
      .filter((i) => selected.includes(i.id))
      .reduce((a, i) => a + i.balance, 0)
  }, [detail, selected])

  const loadDetail = useCallback(async (supplier: string) => {
    setDetailLoading(true)
    try {
      return await dbApi.getSupplierDuesDetail(supplier)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load supplier invoices')
      return null
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const openPayDialog = async (due: SupplierDue) => {
    setPayFor(due)
    setPayAmount(String(due.balance))
    setPayMethod('bank-transfer')
    setPayNote('')
    setSelected([])
    const res = await loadDetail(due.supplier)
    setDetail(res)
    // Default to settling the oldest invoices, oldest first.
    if (res) setSelected(res.invoices.map((i) => i.id))
  }

  const toggleInvoice = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const submitPayment = async () => {
    if (!payFor) return
    const amount = Number(payAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid amount')
      return
    }
    if (selected.length === 0) {
      toast.error('Select at least one invoice to settle')
      return
    }
    if (amount > selectedBalance + 0.01) {
      toast.error(`Selected invoices only owe ${formatCurrency(selectedBalance, { decimals: true })}`)
      return
    }
    setPaySaving(true)
    try {
      const res = await dbApi.recordSupplierPayment({
        supplier: payFor.supplier,
        amount,
        method: payMethod,
        note: payNote.trim() || undefined,
        allocate: selected,
      })
      const settled = res.settled.length > 0 ? ` — settled ${res.settled.join(', ')}` : ''
      toast.success(`Payment ${res.ref} recorded${settled}. Outstanding ${formatCurrency(res.outstanding)}`)
      setPayFor(null)
      setDetail(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Payment failed')
    } finally {
      setPaySaving(false)
    }
  }

  const openView = async (due: SupplierDue) => {
    setViewFor(due)
    setViewDetail(null)
    setViewLoading(true)
    try {
      setViewDetail(await dbApi.getSupplierDuesDetail(due.supplier))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load supplier invoices')
    } finally {
      setViewLoading(false)
    }
  }

  const sendSummary = async () => {
    if (
      !(await confirmDialog({
        title: 'Email the supplier payables summary?',
        description: 'Sends the outstanding balance per supplier to the notification email address.',
        confirmLabel: 'Send summary',
      }))
    ) {
      return
    }
    setSending(true)
    try {
      const res = await dbApi.sendSupplierDuesSummary()
      if (res.message) toast.info(res.message)
      else toast.success(`Summary emailed to ${res.to} (${res.sent} supplier${res.sent === 1 ? '' : 's'})`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the summary')
    } finally {
      setSending(false)
    }
  }

  const aging = data?.aging

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Supplier Dues"
        subtitle="Outstanding purchase invoices — pay suppliers and track how overdue each balance is."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={sendSummary} disabled={sending || !data || data.dues.length === 0}>
              <Mail className="h-3.5 w-3.5" /> Send Summary
            </Button>
          </>
        }
      />

      {loading && !data ? (
        <Card className="flex h-48 items-center justify-center text-sm text-muted-foreground">Loading supplier dues...</Card>
      ) : !data || data.dues.length === 0 ? (
        <Card className="flex h-48 flex-col items-center justify-center gap-2 text-center">
          <Wallet className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">All clear</p>
          <p className="text-xs text-muted-foreground">No outstanding purchase invoices.</p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Outstanding</p>
              <p className="text-xl font-bold tabular-nums text-red-600 dark:text-red-400">{formatCurrency(data.total)}</p>
              <p className="text-[11px] text-muted-foreground">{data.supplierCount} supplier{data.supplierCount === 1 ? '' : 's'}</p>
            </Card>
            <Card className="p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">1–30 days overdue</p>
              <p className="text-xl font-bold tabular-nums text-warning-600 dark:text-warning-400">{formatCurrency(aging?.d1_30 ?? 0)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">31–60 days overdue</p>
              <p className="text-xl font-bold tabular-nums text-orange-600 dark:text-orange-400">{formatCurrency(aging?.d31_60 ?? 0)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">60+ days overdue</p>
              <p className="text-xl font-bold tabular-nums text-red-600 dark:text-red-400">{formatCurrency(aging?.d60plus ?? 0)}</p>
              <p className="text-[11px] text-muted-foreground">
                Oldest {Math.max(0, ...data.dues.map((d) => ageDays(d.oldestDate)))} days
              </p>
            </Card>
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="border-b border-border/60 p-4">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search supplier name…"
                  className="max-w-sm"
                />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Supplier</th>
                      <th className="px-4 py-3 text-right font-medium">Invoices</th>
                      <th className="px-4 py-3 text-right font-medium">Total</th>
                      <th className="px-4 py-3 text-right font-medium">Paid</th>
                      <th className="px-4 py-3 font-medium">Aging</th>
                      <th className="px-4 py-3 text-right font-medium">Outstanding</th>
                      <th className="px-4 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((d) => {
                      const bucket = ageBucket(d)
                      return (
                        <tr key={d.supplier} className="border-b border-border/40 last:border-0">
                          <td className="px-4 py-3 font-medium text-foreground">{d.supplier}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{d.invoiceCount}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{formatCurrency(d.total)}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                            {d.paid > 0 ? formatCurrency(d.paid) : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={bucket.variant} dot>{bucket.label}</Badge>
                          </td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums text-red-600 dark:text-red-400">
                            {formatCurrency(d.balance)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-1.5">
                              <Button variant="ghost" size="sm" onClick={() => openView(d)}>
                                <History className="h-3.5 w-3.5" /> Ledger
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => openPayDialog(d)}>
                                <IndianRupee className="h-3.5 w-3.5" /> Pay
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">No suppliers match.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Record payment — pick which invoices this settles */}
      <AppDialog
        open={payFor !== null}
        onOpenChange={(open) => { if (!open) { setPayFor(null); setDetail(null) } }}
        size="xl"
        isDirty={payFor !== null && Boolean(payAmount || payNote || selected.length)}
        title={`Pay Supplier — ${payFor?.supplier ?? ''}`}
        description={`Outstanding ${formatCurrency(payFor?.balance ?? 0)} across ${payFor?.invoiceCount ?? 0} purchase invoice(s). Tick the invoices this payment settles.`}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPayFor(null); setDetail(null) }}>Cancel</Button>
            <Button onClick={submitPayment} disabled={paySaving || !payAmount || selected.length === 0}>
              {paySaving ? 'Saving…' : 'Record Payment'}
            </Button>
          </DialogFooter>
        }
      >
          <div className="space-y-4">
            <div className="max-h-56 overflow-y-auto rounded-md border border-border/60">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="w-10 px-3 py-2"></th>
                    <th className="px-3 py-2 font-medium">Invoice</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Age</th>
                    <th className="px-3 py-2 text-right font-medium">Paid</th>
                    <th className="px-3 py-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail?.invoices ?? []).map((inv) => (
                    <tr key={inv.id} className="border-b border-border/40 last:border-0">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 cursor-pointer accent-primary"
                          checked={selected.includes(inv.id)}
                          onChange={() => toggleInvoice(inv.id)}
                          aria-label={`Select ${inv.number}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{inv.number}</td>
                      <td className="px-3 py-2 text-muted-foreground">{formatDate(inv.date)}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{inv.ageDays}d</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatCurrency(inv.paidAmount)}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(inv.balance)}</td>
                    </tr>
                  ))}
                  {detail && detail.invoices.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                        Nothing outstanding for this supplier.
                      </td>
                    </tr>
                  ) : null}
                  {detailLoading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">Loading invoices…</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pay-amount">Amount (₹)</Label>
                <Input
                  id="pay-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  Selected invoices owe {formatCurrency(selectedBalance, { decimals: true })}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Method</Label>
                <Select
                  options={[
                    { value: 'bank-transfer', label: 'Bank Transfer' },
                    { value: 'upi', label: 'UPI' },
                    { value: 'cash', label: 'Cash' },
                    { value: 'cheque', label: 'Cheque' },
                  ]}
                  value={payMethod}
                  onValueChange={setPayMethod}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="pay-note">Note (optional)</Label>
                <Input
                  id="pay-note"
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                  placeholder="UTR / reference"
                />
              </div>
            </div>
          </div>
      </AppDialog>

      {/* Supplier ledger: open invoices + payment history */}
      <AppDialog
        open={viewFor !== null}
        onOpenChange={(open) => { if (!open) { setViewFor(null); setViewDetail(null) } }}
        size="xl"
        title={`Supplier Ledger — ${viewFor?.supplier ?? ''}`}
        description={viewDetail
          ? `Outstanding ${formatCurrency(viewDetail.outstanding)} · ${viewDetail.payments.length} payment(s) recorded`
          : 'Loading payment history…'}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => { setViewFor(null); setViewDetail(null) }}>Close</Button>
          </DialogFooter>
        }
      >
          <div className="space-y-4">
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <FileText className="h-3.5 w-3.5" /> Open invoices
              </p>
              <div className="overflow-hidden rounded-md border border-border/60">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Invoice</th>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 text-right font-medium">Total</th>
                      <th className="px-3 py-2 text-right font-medium">Paid</th>
                      <th className="px-3 py-2 text-right font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(viewDetail?.invoices ?? []).map((inv) => (
                      <tr key={inv.id} className="border-b border-border/40 last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{inv.number}</td>
                        <td className="px-3 py-2 text-muted-foreground">{formatDate(inv.date)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(inv.total)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatCurrency(inv.paidAmount)}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums text-red-600 dark:text-red-400">
                          {formatCurrency(inv.balance)}
                        </td>
                      </tr>
                    ))}
                    {viewDetail && viewDetail.invoices.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                          Nothing outstanding.
                        </td>
                      </tr>
                    ) : null}
                    {viewLoading ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" /> Payments made
              </p>
              <div className="space-y-2">
                {(viewDetail?.payments ?? []).map((p) => (
                  <div key={p.id} className="rounded-md border border-border/60 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-mono text-xs font-medium">{p.ref}</span>
                      <span className="text-sm font-semibold tabular-nums">{formatCurrency(p.amount, { decimals: true })}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {formatDateTime(p.date)} · {p.method}
                      {p.note ? ` · ${p.note}` : ''}
                    </p>
                    {p.allocations.length > 0 ? (
                      <ul className="mt-1.5 space-y-0.5">
                        {p.allocations.map((a) => (
                          <li key={`${p.id}-${a.invoiceId}`} className="flex justify-between text-[11px] text-muted-foreground">
                            <span className="font-mono">{a.invoiceNumber}</span>
                            <span className="tabular-nums">{formatCurrency(a.amount, { decimals: true })}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
                {viewDetail && viewDetail.payments.length === 0 && !viewLoading ? (
                  <p className="rounded-md border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
                    No payments recorded yet.
                  </p>
                ) : null}
              </div>
            </div>
          </div>
      </AppDialog>
    </div>
  )
}