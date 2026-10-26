import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import { Banknote, CheckCircle2, HandCoins, Loader2, Plus, RefreshCcw, RotateCcw, Trash2, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, type SelectOption } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { dbApi } from '@/lib/api'
import type { Payment } from '@/types'
import { formatCurrency, formatDateTime } from '@/lib/format'
import { Search } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'

const statusBadge: Record<Payment['status'], { label: string; variant: 'success' | 'warning' | 'danger' | 'muted' }> = {
  settled: { label: 'Settled', variant: 'success' },
  pending: { label: 'Pending', variant: 'warning' },
  failed: { label: 'Failed', variant: 'danger' },
  refunded: { label: 'Refunded', variant: 'muted' },
}

const paymentMethods: SelectOption[] = [
  { label: 'UPI', value: 'UPI' },
  { label: 'Bank Transfer', value: 'Bank Transfer' },
  { label: 'Net Banking', value: 'Net Banking' },
  { label: 'Card', value: 'Card' },
  { label: 'Cash', value: 'Cash' },
]
const gateways: SelectOption[] = [
  { label: 'Razorpay', value: 'Razorpay' },
  { label: 'COD', value: 'COD' },
  { label: 'Bank Transfer', value: 'Bank Transfer' },
  { label: 'UPI', value: 'UPI' },
  { label: 'Manual', value: 'Manual' },
]
const statusOptions: SelectOption[] = [
  { label: 'Settled', value: 'settled' },
  { label: 'Pending', value: 'pending' },
  { label: 'Failed', value: 'failed' },
  { label: 'Refunded', value: 'refunded' },
]
const reconciliationOptions: SelectOption[] = [
  { label: 'All', value: 'false' },
  { label: 'Reconciled Only', value: 'true' },
]

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [reconciledOnly, setReconciledOnly] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    // Blank default: openDialog() stamps a PAY-<timestamp> ref when it opens.
    ref: '',
    invoice: '',
    customer: '',
    amount: '',
    method: 'UPI',
    gateway: 'Manual',
    status: 'settled',
  })
  // Snapshot of the form as it opened, for the unsaved-changes close guard.
  const [baseline, setBaseline] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    dbApi.getPayments().then((d) => {
      setPayments(d)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  const setReconciled = useCallback(async (payment: Payment, reconciled: boolean) => {
    try {
      await dbApi.update('payments', payment.id, { reconciled })
      load()
    } catch {
      toast.error('Failed to update reconciliation status')
    }
  }, [load])

  const handleRefund = useCallback(async (payment: Payment) => {
    if (!(await confirmDialog({ title: `Create refund for payment ${payment.ref}?`, confirmLabel: 'Refund' }))) return
    try {
      await dbApi.create('payments', {
        ref: `REF-${payment.ref}`,
        invoice: payment.invoice,
        customer: payment.customer,
        amount: -payment.amount,
        method: payment.method,
        gateway: payment.gateway,
        status: 'refunded',
        date: new Date().toISOString(),
        reconciled: false,
      })
      load()
    } catch {
      toast.error('Failed to create refund')
    }
  }, [load])

  const handleDelete = useCallback(async (id: string) => {
    if (!(await confirmDialog({ title: 'Delete this payment record?', danger: true, confirmLabel: 'Delete' }))) return
    const snapshot = payments.find((p) => p.id === id)
    try {
      await dbApi.remove('payments', id)
      load()
      if (snapshot) {
        toast.undoable('Payment record deleted', async () => {
          try {
            const { id: _omit, ...rest } = snapshot
            await dbApi.create('payments', rest)
            load()
            toast.success('Delete undone — payment restored')
          } catch {
            toast.error('Could not restore payment')
          }
        })
      }
    } catch {
      toast.error('Failed to delete payment')
    }
  }, [payments, load])

  const openDialog = () => {
    const next = { ref: `PAY-${Date.now()}`, invoice: '', customer: '', amount: '', method: 'UPI', gateway: 'Manual', status: 'settled' }
    setForm(next)
    setBaseline(JSON.stringify(next))
    setError('')
    setDialogOpen(true)
  }

  const submit = async () => {
    if (!form.customer.trim() || !form.amount) {
      setError('Customer and amount are required')
      return
    }
    setSaving(true)
    setError('')
    try {
      await dbApi.create('payments', {
        ref: form.ref,
        invoice: form.invoice || null,
        customer: form.customer.trim(),
        amount: parseFloat(form.amount),
        method: form.method,
        gateway: form.gateway,
        status: form.status,
        date: new Date().toISOString(),
        reconciled: false,
      })
      setDialogOpen(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add payment')
    } finally {
      setSaving(false)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return payments.filter((p) => {
      const matchQ = !q || (p.ref ?? '').toLowerCase().includes(q) || (p.invoice ?? '').toLowerCase().includes(q) || p.customer.toLowerCase().includes(q)
      const matchStatus = !statusFilter || p.status === statusFilter
      const matchReconciled = !reconciledOnly || p.reconciled === true
      return matchQ && matchStatus && matchReconciled
    })
  }, [payments, query, statusFilter, reconciledOnly])

  const settledAmount = payments.filter((p) => p.status === 'settled').reduce((a, p) => a + p.amount, 0)
  const pendingAmount = payments.filter((p) => p.status === 'pending').reduce((a, p) => a + p.amount, 0)
  const refundedAmount = payments.filter((p) => p.status === 'refunded').reduce((a, p) => a + p.amount, 0)
  const reconciledCount = payments.filter((p) => p.reconciled).length

  const columns = useMemo<ColumnDef<Payment>[]>(
    () => [
      {
        accessorKey: 'ref',
        header: 'Payment Ref',
        meta: { headerClassName: 'min-w-[170px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-success-50 text-success-700">
              <Banknote className="h-4 w-4" />
            </div>
            <div>
              <p className="font-mono text-[12px] font-medium text-foreground">{row.original.ref}</p>
              <p className="text-[11px] text-muted-foreground">{formatDateTime(row.original.date)}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'invoice',
        header: 'Invoice',
        cell: ({ row }) => <span className="font-mono text-[12px] font-medium text-primary-700">{row.original.invoice || '—'}</span>,
      },
      {
        accessorKey: 'customer',
        header: 'Customer',
        cell: ({ row }) => <span className="font-medium text-foreground">{row.original.customer}</span>,
      },
      {
        accessorKey: 'amount',
        header: 'Amount',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className={`font-semibold tabular-nums ${row.original.amount < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>
            {formatCurrency(row.original.amount)}
          </span>
        ),
      },
      {
        accessorKey: 'method',
        header: 'Method',
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.method} · <span className="text-foreground">{row.original.gateway}</span>
          </span>
        ),
      },
      {
        id: 'reconciled',
        header: 'Reconciled',
        meta: { align: 'center' as const },
        cell: ({ row }) =>
          row.original.reconciled === true
            ? <Badge variant="success" dot>Reconciled</Badge>
            : <Badge variant="warning" dot>Pending</Badge>,
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
                  <Button variant="ghost" size="icon-sm" onClick={() => setReconciled(row.original, !row.original.reconciled)}>
                    {row.original.reconciled
                      ? <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                      : <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{row.original.reconciled ? 'Unreconcile' : 'Mark Reconciled'}</TooltipContent>
              </Tooltip>
              {row.original.status !== 'refunded' && row.original.amount > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => handleRefund(row.original)}>
                      <RefreshCcw className="h-3.5 w-3.5 text-warning-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Create Refund</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => handleDelete(row.original.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete payment</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [setReconciled, handleRefund, handleDelete]
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Payments"
        subtitle="Razorpay and gateway payments received against sales invoices, tracked for reconciliation."
        actions={
          <Button size="sm" onClick={openDialog}>
            <Plus className="h-4 w-4" /> Add Payment
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Total Settled</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-success-600 flex items-center gap-1"><Wallet className="h-5 w-5" /> {formatCurrency(settledAmount)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Pending</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-warning-600 flex items-center gap-1"><HandCoins className="h-5 w-5" /> {formatCurrency(pendingAmount)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Refunded</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-muted-foreground flex items-center gap-1"><RefreshCcw className="h-5 w-5" /> {formatCurrency(refundedAmount)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Reconciled</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground flex items-center gap-1"><CheckCircle2 className="h-5 w-5" /> {reconciledCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Total Payments</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{payments.length}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search ref, invoice, or customer..." value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
            </div>
            <div className="flex gap-2">
              <Select options={statusOptions} value={statusFilter} onValueChange={setStatusFilter} className="w-[180px]" />
              <Select options={reconciliationOptions} value={reconciledOnly ? 'true' : 'false'} onValueChange={(v) => setReconciledOnly(v === 'true')} className="w-[160px]" />
            </div>
          </div>

          {loading ? (
            <div className="flex h-60 items-center justify-center text-muted-foreground">Loading payments...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No payments found</div>
          ) : (
            <DataTable columns={columns} data={filtered} />
          )}
        </CardContent>
      </Card>

      <AppDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        size="sm"
        isDirty={dialogOpen && JSON.stringify(form) !== baseline}
        title="Add Payment"
        description="Record a manual payment or adjustment."
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Payment'}
            </Button>
          </DialogFooter>
        }
      >
          {error && <div className="mb-4 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 rounded-lg">{error}</div>}
          <div className="grid gap-4 py-4">
            <div>
              <Label htmlFor="ref">Payment Reference</Label>
              <Input id="ref" placeholder="e.g. PAY-1001" value={form.ref} onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="invoice">Invoice Reference (optional)</Label>
              <Input id="invoice" placeholder="e.g. INV-001" value={form.invoice} onChange={(e) => setForm((f) => ({ ...f, invoice: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="customer">Customer</Label>
              <Input id="customer" placeholder="Customer name" value={form.customer} onChange={(e) => setForm((f) => ({ ...f, customer: e.target.value }))} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="amount">Amount (₹)</Label>
                <Input id="amount" type="number" min="0" step="0.01" placeholder="0.00" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} required />
              </div>
              <div>
                <Label htmlFor="method">Method</Label>
                <Select options={paymentMethods} value={form.method} onValueChange={(v) => setForm((f) => ({ ...f, method: v }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="gateway">Gateway</Label>
                <Select options={gateways} value={form.gateway} onValueChange={(v) => setForm((f) => ({ ...f, gateway: v }))} />
              </div>
              <div>
                <Label htmlFor="status">Status</Label>
                <Select options={statusOptions} value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))} />
              </div>
            </div>
          </div>
      </AppDialog>
    </div>
  )
}