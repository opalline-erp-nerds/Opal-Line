import { toast, promptDialog } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@/lib/table'
import { AlertTriangle, Coins, Download, FileText, MoreHorizontal, Pencil, Plus, RefreshCcw, Search, UserPlus, Users, Mail, Phone, ShoppingBag, CircleDollarSign } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { AppDialog } from '@/components/ui/app-dialog'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { DialogFooter } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { backupApi, dbApi, shopifyApi } from '@/lib/api'
import { exportTable } from '@/lib/export'
import type { Customer, Invoice, SalesOrder } from '@/types'
import { formatCurrency, formatDate, formatNumber } from '@/lib/format'
import { initials } from '@/lib/utils'

export default function CustomersPage() {
  const navigate = useNavigate()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [importing, setImporting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [piiGap, setPiiGap] = useState(0)
  const [duplicateEmails, setDuplicateEmails] = useState<Array<{ email: string; cnt: number; customers: string }>>([])
  const [exportLink, setExportLink] = useState<string | null>(null)
  const csvInputRef = useRef<HTMLInputElement>(null)

  const refreshPiiGap = useCallback(() => {
    shopifyApi.piiGap().then((r) => setPiiGap(r.missing)).catch(() => {})
    // Advisory only: shared inboxes are warned about, never merged.
    dbApi.getCustomerDuplicateEmails().then((r) => setDuplicateEmails(r.data)).catch(() => setDuplicateEmails([]))
  }, [])
  const [showAdd, setShowAdd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addName, setAddName] = useState('')
  const [addEmail, setAddEmail] = useState('')
  const [addPhone, setAddPhone] = useState('')
  const [addCity, setAddCity] = useState('')
  const [viewCustomer, setViewCustomer] = useState<Customer | null>(null)
  const [customerOrders, setCustomerOrders] = useState<SalesOrder[]>([])
  const [customerInvoices, setCustomerInvoices] = useState<Invoice[]>([])
  const [loyaltyBalance, setLoyaltyBalance] = useState<number | null>(null)
  const [loyaltyEntries, setLoyaltyEntries] = useState<Array<{ id: string; type: string; points: string; balanceAfter: string | null; note: string | null; invoiceNumber: string | null; date: string }>>([])
  const [adjustingPoints, setAdjustingPoints] = useState(false)

  // Load the customer's recent orders + invoice statement whenever the detail dialog opens
  useEffect(() => {
    if (!viewCustomer) {
      // Defer the reset out of the effect body (react/set-state-in-effect).
      queueMicrotask(() => {
        setCustomerOrders([])
        setCustomerInvoices([])
        setLoyaltyBalance(null)
        setLoyaltyEntries([])
      })
      return
    }
    let cancelled = false
    dbApi.loyaltyBalance(viewCustomer.name)
      .then((r) => { if (!cancelled) setLoyaltyBalance(r.found ? (r.balance ?? 0) : null) })
      .catch(() => undefined)
    dbApi.loyaltyHistory(viewCustomer.name)
      .then((r) => { if (!cancelled) setLoyaltyEntries(r.entries ?? []) })
      .catch(() => undefined)
    dbApi.getSalesOrders()
      .then((orders) => {
        if (cancelled) return
        setCustomerOrders(
          orders
            .filter((o) => o.customer === viewCustomer.name)
            .sort((a, b) => String(b.date).localeCompare(String(a.date)))
            .slice(0, 5),
        )
      })
      .catch(() => undefined)
    dbApi
      .getInvoices()
      .then((invoices) => {
        if (cancelled) return
        setCustomerInvoices(
          invoices
            .filter((inv) => inv.customer === viewCustomer.name)
            .sort((a, b) => String(b.date).localeCompare(String(a.date))),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [viewCustomer])

  useEffect(() => {
    dbApi.getCustomers().then((d) => {
      setCustomers(d)
      setLoading(false)
    }).catch(() => setLoading(false))
    refreshPiiGap()
  }, [refreshPiiGap])

  const toggleStatus = async (c: Customer) => {
    const next = c.status === 'inactive' ? 'active' : 'inactive'
    try {
      await dbApi.update('customers', c.id, { status: next })
      setCustomers((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: next } : x)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    }
  }

  // Edit a customer's contact details. Name is the join key used across
  // orders/invoices, so it stays required here.
  const [editTarget, setEditTarget] = useState<Customer | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', email: '', phone: '', city: '', province: '', status: 'active' as 'active' | 'inactive' })
  // Snapshot of the edit form as it opened, for the unsaved-changes close guard.
  const [editBaseline, setEditBaseline] = useState('')

  const openEdit = (c: Customer) => {
    const next = {
      name: c.name ?? '',
      email: c.email ?? '',
      phone: c.phone ?? '',
      city: c.city ?? '',
      province: c.province ?? '',
      status: (c.status === 'inactive' ? 'inactive' : 'active') as 'active' | 'inactive',
    }
    setEditTarget(c)
    setEditForm(next)
    setEditBaseline(JSON.stringify(next))
  }

  const submitEdit = async () => {
    if (!editTarget) return
    if (!editForm.name.trim()) { toast.error('Name is required'); return }
    setEditSaving(true)
    try {
      const patch = {
        name: editForm.name.trim(),
        email: editForm.email.trim(),
        phone: editForm.phone.trim(),
        city: editForm.city.trim(),
        province: editForm.province.trim(),
        status: editForm.status,
      }
      await dbApi.update('customers', editTarget.id, patch)
      setCustomers((prev) => prev.map((x) => (x.id === editTarget.id ? { ...x, ...patch } : x)))
      toast.success('Customer updated')
      setEditTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setEditSaving(false)
    }
  }

  // Shared by the row menu and the detail dialog: prompt for a delta and
  // refresh the balance/history shown in the open detail view.
  const adjustLoyalty = async (c: Customer) => {
    const raw = await promptDialog({ title: `Adjust points for ${c.name}`, description: 'Use a negative number to deduct points.', defaultValue: '50', inputType: 'number', confirmLabel: 'Apply' })
    if (raw === null) return
    const pts = Number(raw)
    if (!Number.isFinite(pts) || pts === 0) { toast.error('Enter a non-zero number'); return }
    setAdjustingPoints(true)
    try {
      await dbApi.loyaltyAdjust(c.name, Math.round(pts), 'Manual adjustment')
      const [b, h] = await Promise.all([dbApi.loyaltyBalance(c.name), dbApi.loyaltyHistory(c.name)])
      setLoyaltyBalance(b.found ? (b.balance ?? 0) : null)
      setLoyaltyEntries(h.entries ?? [])
      toast.success(`Loyalty balance updated for ${c.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Adjust failed')
    } finally {
      setAdjustingPoints(false)
    }
  }

  // Bulk selection
  const [selected, setSelected] = useState<Customer[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const bulkStatus = async (status: 'active' | 'inactive') => {
    setBulkBusy(true)
    try {
      await Promise.all(selected.map((c) => dbApi.update('customers', c.id, { status })))
      const ids = new Set(selected.map((c) => c.id))
      setCustomers((prev) => prev.map((x) => (ids.has(x.id) ? { ...x, status } : x)))
      setSelected([])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk update failed')
    } finally {
      setBulkBusy(false)
    }
  }
  const bulkExport = () => exportTable('customers-selected.csv', columns, selected)

  const importFromShopify = async () => {
    setImporting(true)
    try {
      const res = await shopifyApi.sync(['customers'])
      toast.success(`Imported ${res.results.customers?.count ?? 0} customers from Shopify`)
      await dbApi.getCustomers().then(setCustomers)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  // Full PII sync: open Shopify's customers page so the user can click Export
  // there; Shopify emails the export to the order mailbox. The backend ingests
  // .csv attachments directly; when the email only carries a download link
  // (current Shopify templates), the link is surfaced so the user can download
  // the file in their logged-in Shopify session and import it with the picker.
  const syncCustomers = async (checkOnly: boolean) => {
    setSyncing(true)
    try {
      if (!checkOnly) {
        try {
          const { url } = await shopifyApi.customersExportUrl()
          window.open(url, '_blank', 'noopener')
          toast.info('Shopify opened — click Export customers there, then click "Check for the CSV" here in a minute.')
        } catch {
          toast.info('Export customers from Shopify Admin → Customers, then click "Check for the CSV".')
        }
        setSyncing(false)
        return
      }
      const res = await shopifyApi.pollCustomerExport()
      if (res.attachmentsFound > 0) {
        toast.success(`Customer CSV imported — ${res.updated} customers updated, ${res.imported} added${res.errors.length ? `, ${res.errors.length} skipped` : ''}`)
        await dbApi.getCustomers().then(setCustomers)
        refreshPiiGap()
      } else if (res.downloadUrl) {
        setExportLink(res.downloadUrl)
        window.open(res.downloadUrl, '_blank', 'noopener')
        toast.info('Export found — the download opened in your Shopify session. Save customers_export.csv, then use "Import the CSV file".')
      } else if (res.errors.length > 0) {
        toast.error(res.errors[0])
      } else {
        toast.info('No customer export email found yet — click Export customers in the Shopify tab, wait for the email, then try again.')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  // Import a downloaded customers_export.csv: Shopify's export emails now carry
  // a download link instead of an attachment, so the user saves the file from
  // their logged-in Shopify session and picks it here.
  const importExportFile = async (file: File) => {
    setSyncing(true)
    try {
      const csv = await file.text()
      const parsed = await backupApi.parseCSV(csv)
      if (!parsed.ok || parsed.count === 0) {
        toast.error(parsed.count === 0 ? 'No rows found in the CSV' : 'Could not parse the CSV')
        return
      }
      const res = await backupApi.importCustomersCSV(parsed.rows)
      toast.success(`Customer CSV imported — ${res.updated} customers updated, ${res.imported} added${res.errors.length ? `, ${res.errors.length} skipped` : ''}`)
      await dbApi.getCustomers().then(setCustomers)
      refreshPiiGap()
      setExportLink(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setSyncing(false)
    }
  }

  const saveCustomer = async (e: FormEvent) => {
    e.preventDefault()
    if (!addName.trim()) return
    setSaving(true)
    try {
      const created = await dbApi.create<Customer>('customers', {
        name: addName.trim(),
        email: addEmail.trim(),
        phone: addPhone.trim(),
        city: addCity.trim(),
        status: 'active',
        orders: 0,
        totalSpent: 0,
        joined: new Date().toISOString(),
      })
      setCustomers((prev) => [created, ...prev])
      setShowAdd(false)
      setAddName('')
      setAddEmail('')
      setAddPhone('')
      setAddCity('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create customer')
    } finally {
      setSaving(false)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return customers.filter(
      (c) => !q || c.name.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q) || (c.phone ?? '').toLowerCase().includes(q),
    )
  }, [customers, query])

  const totalSpend = customers.reduce((a, c) => a + c.totalSpent, 0)

  const columns = useMemo<ColumnDef<Customer>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Customer',
        meta: { headerClassName: 'min-w-[200px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary-100 text-primary-700">{initials(row.original.name)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium text-foreground">{row.original.name}</p>
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Mail className="h-2.5 w-2.5" /> {row.original.email}
              </p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'phone',
        header: 'Phone',
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.phone}</span>,
      },
      { accessorKey: 'city', header: 'City', cell: ({ row }) => <span>{row.original.city || row.original.province || '—'}</span> },
      {
        accessorKey: 'orders',
        header: 'Orders',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.orders)}</span>,
      },
      {
        accessorKey: 'totalSpent',
        header: 'Total Spent',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.totalSpent)}</span>,
      },
      {
        accessorKey: 'joined',
        header: 'Customer Since',
        cell: ({ row }) => <span className="text-muted-foreground">{formatDate(row.original.joined)}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => <Badge variant={row.original.status === 'active' ? 'success' : 'muted'} dot>{row.original.status}</Badge>,
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const },
        cell: ({ row }) => {
          const c = row.original
          return (
            <TooltipProvider delayDuration={200}>
            <div className="flex items-center justify-end gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => (window.location.href = `tel:${encodeURI(c.phone ?? '')}`)}>
                  <Phone className="h-3.5 w-3.5" />
                </Button>
                </TooltipTrigger>
                <TooltipContent>Call</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => (window.location.href = `mailto:${encodeURI(c.email ?? '')}`)}>
                  <Mail className="h-3.5 w-3.5" />
                </Button>
                </TooltipTrigger>
                <TooltipContent>Email</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Customer 360 for ${c.name}`} onClick={() => navigate(`/sales/customers/${encodeURIComponent(c.name)}`)}>
                  <FileText className="h-3.5 w-3.5" />
                </Button>
                </TooltipTrigger>
                <TooltipContent>Customer 360</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">More actions</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => openEdit(c)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit customer
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void adjustLoyalty(c)}>
                    <Coins className="h-3.5 w-3.5" /> Adjust loyalty points
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => toggleStatus(c)}>
                    {c.status === 'inactive' ? 'Activate' : 'Deactivate'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            </TooltipProvider>
          )
        },
      },
    ],
    [navigate],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Customers"
        subtitle="Ecommerce customers who purchased through the Opal Line Shopify store."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => exportTable('customers.csv', columns, filtered)}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button variant="outline" size="sm" onClick={() => syncCustomers(false)} disabled={syncing}>
              <RefreshCcw className="h-3.5 w-3.5" /> Sync Customers
            </Button>
            <Button variant="ghost" size="sm" onClick={() => syncCustomers(true)} disabled={syncing}>
              {syncing ? 'Checking...' : 'Check for the CSV'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => csvInputRef.current?.click()} disabled={syncing}>
              Import the CSV file
            </Button>
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importExportFile(f)
                e.target.value = ''
              }}
            />
            <Button variant="outline" size="sm" onClick={importFromShopify} disabled={importing}>
              <UserPlus className="h-3.5 w-3.5" /> {importing ? 'Importing...' : 'Import from Shopify'}
            </Button>
            <Button size="sm" onClick={() => { setAddName(''); setAddEmail(''); setAddPhone(''); setAddCity(''); setShowAdd(true) }}>
              <Plus className="h-4 w-4" /> Add Customer
            </Button>
          </>
        }
      />

      {piiGap > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning-200 bg-warning-50 px-4 py-2.5 text-sm text-warning-800 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <b>{piiGap}</b> customer{piiGap === 1 ? '' : 's'} still missing contact details (redacted by Shopify). Use <b>Sync Customers</b> to fill them.
          </span>
          {exportLink ? (
            <a href={exportLink} target="_blank" rel="noreferrer" className="ml-auto underline font-medium">
              Open the export download page
            </a>
          ) : null}
        </div>
      ) : null}

      {duplicateEmails.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-info-200 bg-info-50 px-4 py-2.5 text-sm text-info-800 dark:border-info-500/30 dark:bg-info-500/10 dark:text-info-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <b>{duplicateEmails.length}</b> email address{duplicateEmails.length === 1 ? '' : 'es'} shared by multiple customers ({duplicateEmails.map((d) => d.email).join(', ')}). These may be separate people sharing an inbox — review before emailing.
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile icon={Users} label="Total Customers" value={String(customers.length)} sub={`${customers.filter((c) => c.status === 'active').length} active`} tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
        <SummaryTile icon={Mail} label="Email Subscribers" value={String(customers.filter((c) => c.email).length)} sub="With email on file" tint="bg-info-50 text-info-700" />
        <SummaryTile icon={ShoppingBag} label="Repeat Customers" value={String(customers.filter((c) => (c.orders ?? 0) >= 2).length)} sub="More than 1 order" tint="bg-success-50 text-success-700" />
        <SummaryTile icon={CircleDollarSign} label="Lifetime Value" value={formatCurrency(totalSpend)} sub="All customers" tint="bg-warning-50 text-warning-700" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search name, email, phone..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {customers.length} customers
            </div>
          </div>

          {selected.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
              <span className="text-xs font-medium">{selected.length} selected</span>
              <Button size="sm" variant="outline" onClick={() => bulkStatus('active')} disabled={bulkBusy}>Mark Active</Button>
              <Button size="sm" variant="outline" onClick={() => bulkStatus('inactive')} disabled={bulkBusy}>Mark Inactive</Button>
              <Button size="sm" variant="outline" onClick={bulkExport}>
                <Download className="h-3.5 w-3.5" /> Export Selected
              </Button>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected([])}>Clear</Button>
            </div>
          )}
          <DataTable
            onRowClick={setViewCustomer}
            onSelectionChange={setSelected}
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No customers found"
          />
        </CardContent>
      </Card>

      <AppDialog
        open={viewCustomer !== null}
        onOpenChange={(open) => { if (!open) setViewCustomer(null) }}
        size="md"
        titleAdornment={
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-primary-100 text-primary-700">{initials(viewCustomer?.name ?? '')}</AvatarFallback>
          </Avatar>
        }
        title={viewCustomer?.name ?? 'Customer'}
        description="Customer details and activity"
        footer={
          <DialogFooter>
            {viewCustomer?.phone ? (
              <Button variant="outline" onClick={() => (window.location.href = `tel:${encodeURI(viewCustomer.phone)}`)}>
                <Phone className="h-4 w-4" /> Call
              </Button>
            ) : null}
            {viewCustomer?.email ? (
              <Button variant="outline" onClick={() => (window.location.href = `mailto:${encodeURI(viewCustomer.email)}`)}>
                <Mail className="h-4 w-4" /> Email
              </Button>
            ) : null}
            <Button onClick={() => { setViewCustomer(null); navigate('/sales/invoices') }}>
              <ShoppingBag className="h-4 w-4" /> Order History
            </Button>
          </DialogFooter>
        }
      >
          {viewCustomer ? (
            <>
            <div className="space-y-0.5 text-sm">
              <DetailRow label="Email" value={viewCustomer.email || '—'} />
              <DetailRow label="Phone" value={viewCustomer.phone || '—'} />
              <DetailRow label="City" value={[viewCustomer.city, viewCustomer.province].filter(Boolean).join(', ') || '—'} />
              <DetailRow label="Total Orders" value={formatNumber(viewCustomer.orders)} />
              <DetailRow label="Total Spent" value={formatCurrency(viewCustomer.totalSpent)} />
              <DetailRow label="Customer Since" value={formatDate(viewCustomer.joined)} />
              <DetailRow
                label="Status"
                value={viewCustomer.status === 'active' ? 'Active' : 'Inactive'}
              />
              {viewCustomer.shopifyId ? <DetailRow label="Shopify ID" value={viewCustomer.shopifyId} /> : null}
              {viewCustomer.emailVerified != null && viewCustomer.email ? (
                <DetailRow label="Email Verified" value={viewCustomer.emailVerified ? 'Yes' : 'No'} />
              ) : null}
            </div>
            <div className="mt-3 border-t border-border/60 pt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent Orders</p>
              {customerOrders.length === 0 ? (
                <p className="py-1 text-sm text-muted-foreground">No orders found for this customer.</p>
              ) : (
                <div className="space-y-1.5">
                  {customerOrders.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => { setViewCustomer(null); navigate('/sales/orders') }}
                      className="flex w-full items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-left text-sm hover:bg-muted/60"
                    >
                      <span className="shrink-0 font-medium text-foreground">{o.shopifyId || o.internalId}</span>
                      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{formatDate(o.date)}</span>
                        <Badge variant={o.payment === 'paid' ? 'success' : 'muted'} dot>{o.payment}</Badge>
                        <span className="shrink-0 tabular-nums font-medium text-foreground">{formatCurrency(o.value)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-3 border-t border-border/60 pt-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Loyalty Points</p>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={adjustingPoints}
                    onClick={() => void adjustLoyalty(viewCustomer)}
                  >
                    Adjust
                  </Button>
                </div>
              </div>
              <div className={`rounded-md border px-2 py-1.5 text-center ${loyaltyBalance && loyaltyBalance > 0 ? 'border-violet-500/40 bg-violet-500/10' : 'border-border/60 bg-muted/30'}`}>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Available Balance</p>
                <p className="text-lg font-semibold tabular-nums text-foreground">
                  {loyaltyBalance === null ? '—' : `${loyaltyBalance.toLocaleString('en-IN')} pts`}
                </p>
                <p className="text-[10px] text-muted-foreground">1 point = ₹1 · earned ₹1 per ₹100 spent</p>
              </div>
              {loyaltyEntries.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {loyaltyEntries.slice(0, 4).map((e) => (
                    <div key={e.id} className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-sm">
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {e.invoiceNumber ? `${e.invoiceNumber} — ` : ''}{e.note || e.type}
                      </span>
                      <span className={`shrink-0 text-xs font-semibold tabular-nums ${Number(e.points) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {Number(e.points) >= 0 ? '+' : ''}{Number(e.points)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="mt-3 border-t border-border/60 pt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Statement</p>
              {(() => {
                const totalInvoiced = customerInvoices.reduce((a, inv) => a + (inv.grandTotal ?? 0), 0)
                const totalPaid = customerInvoices
                  .filter((inv) => inv.paymentStatus === 'paid')
                  .reduce((a, inv) => a + (inv.grandTotal ?? 0), 0)
                const outstanding = customerInvoices
                  .filter((inv) => inv.paymentStatus !== 'paid' && inv.status !== 'cancelled' && inv.status !== 'refunded')
                  .reduce((a, inv) => a + (inv.grandTotal ?? 0), 0)
                return (
                  <div>
                    <div className="mb-2 grid grid-cols-3 gap-2">
                      <div className="rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-center">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Invoiced</p>
                        <p className="text-sm font-semibold tabular-nums text-foreground">{formatCurrency(totalInvoiced)}</p>
                      </div>
                      <div className="rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-center">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Paid</p>
                        <p className="text-sm font-semibold tabular-nums text-emerald-600">{formatCurrency(totalPaid)}</p>
                      </div>
                      <div className={`rounded-md border px-2 py-1.5 text-center ${outstanding > 0 ? 'border-amber-500/40 bg-amber-500/10' : 'border-border/60 bg-muted/30'}`}>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Outstanding</p>
                        <p className={`text-sm font-semibold tabular-nums ${outstanding > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>{formatCurrency(outstanding)}</p>
                      </div>
                    </div>
                    {customerInvoices.length === 0 ? (
                      <p className="py-1 text-sm text-muted-foreground">No invoices on record.</p>
                    ) : (
                      <div className="space-y-1">
                        {customerInvoices.slice(0, 6).map((inv) => (
                          <button
                            key={inv.id}
                            type="button"
                            onClick={() => { setViewCustomer(null); navigate(`/sales/invoices?highlight=${encodeURIComponent(inv.number)}`) }}
                            className="flex w-full items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-left text-sm hover:bg-muted/60"
                          >
                            <span className="shrink-0 font-medium text-foreground">{inv.number}</span>
                            <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                              <span className="truncate">{formatDate(inv.date)}</span>
                              <Badge variant={inv.paymentStatus === 'paid' ? 'success' : inv.paymentStatus === 'pending' ? 'warning' : 'muted'} dot>{inv.paymentStatus}</Badge>
                              <span className="shrink-0 tabular-nums font-medium text-foreground">{formatCurrency(inv.grandTotal)}</span>
                            </span>
                          </button>
                        ))}
                        {customerInvoices.length > 6 ? (
                          <p className="pt-0.5 text-right text-[11px] text-muted-foreground">+{customerInvoices.length - 6} more invoices</p>
                        ) : null}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
            </>
          ) : null}
      </AppDialog>

      <AppDialog
        open={showAdd}
        onOpenChange={setShowAdd}
        size="sm"
        isDirty={showAdd && Boolean(addName || addEmail || addPhone || addCity)}
        title="Add Customer"
        description="Create a new customer record."
        footer={
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit" form="add-customer-form" disabled={saving || !addName.trim()}>{saving ? 'Saving...' : 'Save Customer'}</Button>
          </DialogFooter>
        }
      >
        <form id="add-customer-form" onSubmit={saveCustomer} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cust-name">Name</Label>
            <Input id="cust-name" value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="Full name" required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cust-email">Email</Label>
              <Input id="cust-email" type="email" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="name@example.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cust-phone">Phone</Label>
              <Input id="cust-phone" value={addPhone} onChange={(e) => setAddPhone(e.target.value)} placeholder="+91..." />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cust-city">City</Label>
            <Input id="cust-city" value={addCity} onChange={(e) => setAddCity(e.target.value)} placeholder="City" />
          </div>
        </form>
      </AppDialog>

      <AppDialog
        open={editTarget !== null}
        onOpenChange={(open) => { if (!open) setEditTarget(null) }}
        size="sm"
        isDirty={editTarget !== null && JSON.stringify(editForm) !== editBaseline}
        title="Edit Customer"
        description="Update contact details and status."
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={editSaving}>Cancel</Button>
            <Button onClick={() => void submitEdit()} disabled={editSaving || !editForm.name.trim()}>
              {editSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-cust-name">Name</Label>
            <Input id="edit-cust-name" value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} placeholder="Full name" required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-cust-email">Email</Label>
              <Input id="edit-cust-email" type="email" value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} placeholder="name@example.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-cust-phone">Phone</Label>
              <Input id="edit-cust-phone" value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+91..." />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-cust-city">City</Label>
              <Input id="edit-cust-city" value={editForm.city} onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value }))} placeholder="City" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-cust-province">State / Province</Label>
              <Input id="edit-cust-province" value={editForm.province} onChange={(e) => setEditForm((f) => ({ ...f, province: e.target.value }))} placeholder="State" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select
              options={[
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
              ]}
              value={editForm.status}
              onValueChange={(v) => setEditForm((f) => ({ ...f, status: v === 'inactive' ? 'inactive' : 'active' }))}
            />
          </div>
        </div>
      </AppDialog>
    </div>
  )
}

function SummaryTile({ icon: Icon, label, value, sub, tint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; tint: string }) {
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  )
}
