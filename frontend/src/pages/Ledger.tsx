import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import { ArrowDownRight, ArrowUpRight, Download, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DataTable } from '@/components/ui/data-table'
import { dbApi } from '@/lib/api'
import { exportTable } from '@/lib/export'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import type { LedgerEntry } from '@/types'
import { formatCurrency, formatDate, todayIST } from '@/lib/format'
import { Search } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export default function LedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LedgerEntry | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ date: '', description: '', ref: '', debit: '', credit: '' })

  const load = useCallback(() => {
    setLoading(true)
    dbApi.getLedgerEntries().then((d) => {
      setEntries(d)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter(
      (e) =>
        !q ||
        (e.description ?? '').toLowerCase().includes(q) ||
        (e.ref ?? '').toLowerCase().includes(q),
    )
  }, [entries, query])

  const totalDebit = entries.reduce((a, e) => a + e.debit, 0)
  const totalCredit = entries.reduce((a, e) => a + e.credit, 0)
  const net = totalCredit - totalDebit

  const openDialog = (entry?: LedgerEntry) => {
    if (entry) {
      setEditing(entry)
      setForm({
        date: entry.date.slice(0, 10),
        description: entry.description || '',
        ref: entry.ref || '',
        debit: String(entry.debit),
        credit: String(entry.credit),
      })
    } else {
      setEditing(null)
      setForm({ date: todayIST(), description: '', ref: '', debit: '', credit: '' })
    }
    setError('')
    setDialogOpen(true)
  }

  const submit = async () => {
    if (!form.description.trim()) {
      setError('Description is required')
      return
    }
    const debit = parseFloat(form.debit || '0')
    const credit = parseFloat(form.credit || '0')
    if (debit <= 0 && credit <= 0) {
      setError('Either debit or credit amount is required')
      return
    }
    setSaving(true)
    setError('')
    try {
      const payload = {
        date: form.date,
        description: form.description.trim(),
        ref: form.ref.trim() || null,
        debit,
        credit,
      }
      if (editing) {
        await dbApi.update('ledger', editing.id, payload)
      } else {
        await dbApi.create('ledger', payload)
      }
      setDialogOpen(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : editing ? 'Failed to update entry' : 'Failed to add entry')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = useCallback(async (id: string) => {
    if (!(await confirmDialog({ title: 'Delete this ledger entry?', danger: true, confirmLabel: 'Delete' }))) return
    const snapshot = entries.find((e) => e.id === id)
    try {
      await dbApi.remove('ledger', id)
      load()
      if (snapshot) {
        toast.undoable('Ledger entry deleted', async () => {
          try {
            const { id: _omit, ...rest } = snapshot
            await dbApi.create('ledger', rest)
            load()
            toast.success('Delete undone — entry restored')
          } catch {
            toast.error('Could not restore entry')
          }
        })
      }
    } catch {
      toast.error('Failed to delete entry')
    }
  }, [entries, load])

  const columns = useMemo<ColumnDef<LedgerEntry>[]>(
    () => [
      {
        accessorKey: 'date',
        header: 'Date',
        cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{formatDate(row.original.date)}</span>,
      },
      {
        accessorKey: 'description',
        header: 'Particulars',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.description}</p>
            {row.original.ref && <p className="text-[11px] text-muted-foreground">Ref: {row.original.ref}</p>}
          </div>
        ),
      },
      {
        accessorKey: 'debit',
        header: 'Debit',
        cell: ({ row }) => <span className="text-red-600 dark:text-red-400 font-mono tabular-nums flex items-center gap-1"><ArrowUpRight className="h-3 w-3" /> {formatCurrency(row.original.debit)}</span>,
      },
      {
        accessorKey: 'credit',
        header: 'Credit',
        cell: ({ row }) => <span className="text-green-600 dark:text-green-400 font-mono tabular-nums flex items-center gap-1"><ArrowDownRight className="h-3 w-3" /> {formatCurrency(row.original.credit)}</span>,
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
                  <Button variant="ghost" size="icon-sm" onClick={() => openDialog(row.original)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit entry</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => handleDelete(row.original.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete entry</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [handleDelete]
  )

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="General Ledger"
        subtitle="All debit and credit entries across accounts."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => exportTable('ledger-entries', columns.filter(c => 'accessorKey' in c && typeof c.accessorKey === 'string'), filtered)}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            <Button size="sm" onClick={() => openDialog()}>
              <Plus className="h-4 w-4" /> Add Entry
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Total Debit</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-red-600 dark:text-red-400 flex items-center gap-1"><ArrowUpRight className="h-5 w-5" /> {formatCurrency(totalDebit)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Total Credit</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-green-600 dark:text-green-400 flex items-center gap-1"><ArrowDownRight className="h-5 w-5" /> {formatCurrency(totalCredit)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Entries</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{entries.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">Net Position</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{net >= 0 ? (
              <span className="text-green-600 dark:text-green-400 flex items-center gap-1"><ArrowDownRight className="h-5 w-5" /> {formatCurrency(net)}</span>
            ) : (
              <span className="text-red-600 dark:text-red-400 flex items-center gap-1"><ArrowUpRight className="h-5 w-5" /> {formatCurrency(-net)}</span>
            )}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search description or reference..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {loading ? (
            <div className="flex h-60 items-center justify-center text-muted-foreground">Loading ledger entries...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No ledger entries found</div>
          ) : (
            <DataTable columns={columns} data={filtered} />
          )}
        </CardContent>
      </Card>

      <AppDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        size="md"
        isDirty={dialogOpen && Boolean(form.date || form.description || form.ref || form.debit || form.credit)}
        title={editing ? 'Edit Ledger Entry' : 'Add Ledger Entry'}
        description={editing ? 'Update the ledger entry details.' : 'Record a new debit or credit entry.'}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        }
      >
          {error && <div className="mb-4 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 rounded-lg">{error}</div>}
          <div className="grid gap-4 py-4">
            <div>
              <Label htmlFor="date">Date</Label>
              <Input id="date" type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} required />
            </div>
            <div>
              <Label htmlFor="description">Description</Label>
              <Input id="description" placeholder="e.g. Payment to supplier, Sale invoice, Bank charge" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} required />
            </div>
            <div>
              <Label htmlFor="ref">Reference (optional)</Label>
              <Input id="ref" placeholder="e.g. INV-001, PAY-002, BC-003" value={form.ref} onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="debit">Debit (₹)</Label>
                <Input id="debit" type="number" min="0" step="0.01" placeholder="0.00" value={form.debit} onChange={(e) => setForm((f) => ({ ...f, debit: e.target.value }))} />
              </div>
              <div>
                <Label htmlFor="credit">Credit (₹)</Label>
                <Input id="credit" type="number" min="0" step="0.01" placeholder="0.00" value={form.credit} onChange={(e) => setForm((f) => ({ ...f, credit: e.target.value }))} />
              </div>
            </div>
          </div>
      </AppDialog>
    </div>
  )
}