import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Building, Landmark, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { todayIST } from '@/lib/format'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { dbApi } from '@/lib/api'
import type { BankAccount, LedgerEntry } from '@/types'
import { formatCurrency } from '@/lib/format'

export default function BankAccountsPage() {
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [ledger, setLedger] = useState<LedgerEntry[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<BankAccount | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', bank: '', accountNumber: '', balance: '', ifsc: '' })
  // Snapshot of the form as it opened, for the unsaved-changes close guard.
  const [baseline, setBaseline] = useState('')

  const load = useCallback(() => {
    Promise.all([dbApi.getBankAccounts(), dbApi.getLedgerEntries()]).then(([acc, led]) => {
      setAccounts(acc)
      setLedger(led)
    }).catch(() => {})
  }, [])

  useEffect(load, [load])

  const openDialog = (account?: BankAccount) => {
    let next
    if (account) {
      setEditing(account)
      next = { name: account.name, bank: account.bank, accountNumber: account.accountNumber || '', balance: String(account.balance), ifsc: account.ifsc || '' }
    } else {
      setEditing(null)
      next = { name: '', bank: '', accountNumber: '', balance: '', ifsc: '' }
    }
    setForm(next)
    setBaseline(JSON.stringify(next))
    setError('')
    setDialogOpen(true)
  }

  const submit = async () => {
    if (!form.name.trim() || !form.bank.trim()) {
      setError('Account name and bank are required')
      return
    }
    setSaving(true)
    setError('')
    try {
      const payload = {
        name: form.name.trim(),
        bank: form.bank.trim(),
        accountNumber: form.accountNumber.trim() || '•••• 0000',
        balance: parseFloat(form.balance || '0'),
        ifsc: form.ifsc.trim() || 'HDFC0000000',
      }
      if (editing) {
        await dbApi.update('bank-accounts', editing.id, payload)
      } else {
        await dbApi.create('bank-accounts', payload)
      }
      setDialogOpen(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : editing ? 'Failed to update account' : 'Failed to add account')
    } finally {
      setSaving(false)
    }
  }

  const totalBalance = accounts.reduce((a, b) => a + b.balance, 0)
  const monthKey = todayIST().slice(0, 7)
  const monthEntries = ledger.filter((l) => String(l.date ?? '').startsWith(monthKey))
  const monthInflows = monthEntries.reduce((a, l) => a + l.credit, 0)
  const monthOutflows = monthEntries.reduce((a, l) => a + l.debit, 0)

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Bank Accounts"
        subtitle="Bank and settlement accounts used for business transactions and reconciliation."
        actions={
          <Button size="sm" onClick={() => openDialog()}>
            <Plus className="h-4 w-4" /> Add Account
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniCard icon={Landmark} label="Total Balance" value={formatCurrency(totalBalance)} sub="Across all accounts" tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
        <MiniCard icon={Building} label="Accounts" value={String(accounts.length)} sub="Active accounts" tint="bg-info-50 text-info-700" />
        <MiniCard icon={ArrowUpRight} label="Ledger In (Month)" value={formatCurrency(monthInflows)} sub="Credits this month" tint="bg-success-50 text-success-700" />
        <MiniCard icon={ArrowDownRight} label="Ledger Out (Month)" value={formatCurrency(monthOutflows)} sub="Debits this month" tint="bg-warning-50 text-warning-700" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {accounts.map((account) => (
          <Card key={account.id} className="p-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
                  <Landmark className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold text-foreground">{account.name}</p>
                  <p className="text-[11px] text-muted-foreground">{account.bank}</p>
                </div>
              </div>
<TooltipProvider delayDuration={200}>
                  <div className="flex items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-sm" onClick={() => openDialog(account)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Edit account</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-sm" onClick={async () => {
                          if (!(await confirmDialog({ title: `Delete bank account "${account.name}"?`, danger: true, confirmLabel: 'Delete' }))) return
                          try {
                            await dbApi.remove('bank-accounts', account.id)
                            load()
                            toast.undoable('Bank account deleted', async () => {
                              try {
                                const { id: _omit, ...rest } = account
                                await dbApi.create('bank-accounts', rest)
                                load()
                                toast.success('Delete undone — account restored')
                              } catch {
                                toast.error('Could not restore account')
                              }
                            })
                          } catch {
                            toast.error('Failed to delete account')
                          }
                        }}>
                          <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete account</TooltipContent>
                    </Tooltip>
                  </div>
                </TooltipProvider>
            </div>

            <div className="mt-5">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Available Balance</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(account.balance)}</p>
            </div>

              <div className="mt-4 flex items-center gap-2">
              <Badge variant="info" dot>Verified</Badge>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">{account.ifsc}</span>
            </div>

            <div className="mt-4 space-y-1.5 border-t pt-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Account Number</span>
                <span className="font-mono text-foreground">{account.accountNumber}</span>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <AppDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        size="sm"
        isDirty={dialogOpen && JSON.stringify(form) !== baseline}
        title={editing ? 'Edit Bank Account' : 'Add Bank Account'}
        description={editing ? 'Update the bank or settlement account details.' : 'Register a bank or settlement account for reconciliation.'}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {editing ? 'Save Changes' : 'Add Account'}
            </Button>
          </DialogFooter>
        }
      >
          <div className="grid gap-4">
            <Field label="Account Name">
              <Input
                placeholder="e.g. HDFC Current"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Bank">
                <Input
                  placeholder="e.g. HDFC Bank"
                  value={form.bank}
                  onChange={(e) => setForm((f) => ({ ...f, bank: e.target.value }))}
                />
              </Field>
              <Field label="Balance (₹)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={form.balance}
                  onChange={(e) => setForm((f) => ({ ...f, balance: e.target.value }))}
                />
              </Field>
            </div>
            <Field label="Account Number">
              <Input
                placeholder="e.g. 5010 0234 5678"
                value={form.accountNumber}
                onChange={(e) => setForm((f) => ({ ...f, accountNumber: e.target.value }))}
              />
            </Field>
            <Field label="IFSC Code">
              <Input
                placeholder="e.g. HDFC0001234"
                value={form.ifsc}
                onChange={(e) => setForm((f) => ({ ...f, ifsc: e.target.value }))}
              />
            </Field>
            {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
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
