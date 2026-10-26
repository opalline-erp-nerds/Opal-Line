import { toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import { Building2, Loader2, MapPin, Package, Pencil, Plus, Search, Warehouse } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi } from '@/lib/api'
import type { InventoryLocation, LocationStockSummary, Product } from '@/types'
import { exportTable } from '@/lib/export'
import { formatCurrency, formatNumber } from '@/lib/format'

const LOCATION_TYPES = [
  { value: 'store', label: 'Store' },
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'workshop', label: 'Workshop' },
]

/** Flat column layout for the CSV export — the table has cell renderers. */
const LOCATION_EXPORT_COLUMNS: Array<{ accessorKey: string; header: string }> = [
  { accessorKey: 'name', header: 'Location' },
  { accessorKey: 'type', header: 'Type' },
  { accessorKey: 'city', header: 'City' },
  { accessorKey: 'manager', header: 'Manager' },
  { accessorKey: 'products', header: 'Products' },
  { accessorKey: 'quantity', header: 'Units' },
  { accessorKey: 'valueAtCost', header: 'Value at Cost' },
]

export default function StockLocationsPage() {
  const [locations, setLocations] = useState<InventoryLocation[]>([])
  const [summary, setSummary] = useState<Record<string, LocationStockSummary>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const load = useCallback(() => {
    Promise.all([dbApi.getInventoryLocations(), dbApi.getLocationStockSummary()])
      .then(([l, s]) => {
        setLocations(l)
        setSummary(s ?? {})
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  // Deferred a microtask: setting state directly in an effect trips the
  // react(set-state-in-effect) rule the frontend lints for.
  useEffect(() => {
    queueMicrotask(load)
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return locations
    return locations.filter(
      (l) => l.name.toLowerCase().includes(q) || (l.city ?? '').toLowerCase().includes(q) || (l.manager ?? '').toLowerCase().includes(q),
    )
  }, [locations, query])

  const totals = useMemo(
    () =>
      Object.values(summary).reduce(
        (acc, s) => ({ products: acc.products + s.products, quantity: acc.quantity + s.quantity, valueAtCost: acc.valueAtCost + s.valueAtCost }),
        { products: 0, quantity: 0, valueAtCost: 0 },
      ),
    [summary],
  )

  // Edit a location's details — stock stays attached to the location id, so
  // renaming never moves units.
  const [editTarget, setEditTarget] = useState<InventoryLocation | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', type: 'store', city: '', manager: '' })
  // Snapshot of the edit form as it opened, for the unsaved-changes close guard.
  const [editBaseline, setEditBaseline] = useState('')

  const openEdit = useCallback((loc: InventoryLocation) => {
    const next = {
      name: loc.name ?? '',
      type: loc.type ?? 'store',
      city: loc.city ?? '',
      manager: loc.manager ?? '',
    }
    setEditTarget(loc)
    setEditForm(next)
    setEditBaseline(JSON.stringify(next))
  }, [])

  const submitEdit = async () => {
    if (!editTarget) return
    const name = editForm.name.trim()
    if (!name) {
      toast.error('Give the location a name')
      return
    }
    setEditSaving(true)
    try {
      const patch = {
        name,
        type: editForm.type,
        city: editForm.city.trim(),
        manager: editForm.manager.trim(),
      }
      await dbApi.update('inventory/locations', editTarget.id, patch)
      toast.success('Location updated')
      setEditTarget(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed — a location with that name may already exist')
    } finally {
      setEditSaving(false)
    }
  }

  const columns = useMemo<ColumnDef<InventoryLocation>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Location',
        meta: { headerClassName: 'min-w-[200px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <Building2 className="h-4 w-4" />
            </div>
            <div>
              <p className="font-medium text-foreground">{row.original.name}</p>
              <p className="text-[11px] text-muted-foreground">{row.original.manager || 'No manager set'}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'type',
        header: 'Type',
        cell: ({ row }) => <Badge variant="muted">{row.original.type || 'store'}</Badge>,
      },
      {
        accessorKey: 'city',
        header: 'City',
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.city || '—'}</span>,
      },
      {
        id: 'products',
        header: 'Products',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-foreground">{formatNumber(summary[row.original.id]?.products ?? 0)}</span>,
      },
      {
        id: 'quantity',
        header: 'Units',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums font-medium text-foreground">{formatNumber(summary[row.original.id]?.quantity ?? 0)}</span>,
      },
      {
        id: 'valueAtCost',
        header: 'Value at Cost',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-foreground">{formatCurrency(summary[row.original.id]?.valueAtCost ?? 0)}</span>,
      },
      {
        id: 'actions',
        header: '',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${row.original.name}`}
            onClick={() => openEdit(row.original)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        ),
      },
    ],
    [summary, openEdit],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Stock Locations"
        subtitle="Every store, warehouse and workshop, and how much stock each one holds."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={filtered.length === 0}
              onClick={() =>
                exportTable(
                  'stock-locations',
                  LOCATION_EXPORT_COLUMNS,
                  filtered.map((l) => ({
                    name: l.name,
                    type: l.type,
                    city: l.city,
                    manager: l.manager,
                    products: summary[l.id]?.products ?? 0,
                    quantity: summary[l.id]?.quantity ?? 0,
                    valueAtCost: summary[l.id]?.valueAtCost ?? 0,
                  })),
                )
              }
            >
              Export CSV
            </Button>
            <NewLocationDialog onCreated={load} />
          </>
        }
      />

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search location, city, manager..." value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Warehouse className="h-3.5 w-3.5" /> {locations.length} locations
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Package className="h-3.5 w-3.5" /> {formatNumber(totals.quantity)} units
              </span>
              <span className="tabular-nums">{formatCurrency(totals.valueAtCost)} at cost</span>
            </div>
          </div>

          <DataTable columns={columns} data={filtered} loading={loading} emptyMessage="No locations match your search" />
        </CardContent>
      </Card>

      <AppDialog
        open={editTarget !== null}
        onOpenChange={(open) => { if (!open) setEditTarget(null) }}
        size="md"
        isDirty={editTarget !== null && JSON.stringify(editForm) !== editBaseline}
        title="Edit Location"
        description="Update the location's details. Stock held here is unaffected."
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={editSaving}>Cancel</Button>
            <Button onClick={() => void submitEdit()} disabled={editSaving || !editForm.name.trim()}>
              {editSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save changes
            </Button>
          </DialogFooter>
        }
      >
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="edit-loc-name">Name</Label>
              <Input
                id="edit-loc-name"
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Andheri Branch"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-loc-type">Type</Label>
              <Select
                id="edit-loc-type"
                options={LOCATION_TYPES}
                value={editForm.type}
                onValueChange={(v) => setEditForm((f) => ({ ...f, type: v }))}
                placeholder="Type"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-loc-city">City</Label>
              <Input id="edit-loc-city" value={editForm.city} onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-loc-manager">Manager</Label>
              <Input id="edit-loc-manager" value={editForm.manager} onChange={(e) => setEditForm((f) => ({ ...f, manager: e.target.value }))} placeholder="Optional" />
            </div>
          </div>
      </AppDialog>
    </div>
  )
}

/**
 * Create a location and, optionally, count stock into it on the spot.
 *
 * Counting stock in posts `opening` movements, so the business total goes UP.
 * This is deliberately not a split of the existing position — moving stock that
 * is already held somewhere is what a transfer is for, and doing it here would
 * quietly inflate the books.
 */
function NewLocationDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [form, setForm] = useState({ name: '', type: 'store', city: '', manager: '' })
  // Product id -> counted quantity, as typed.
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [showCounts, setShowCounts] = useState(false)

  useEffect(() => {
    if (!showCounts || products.length > 0) return
    queueMicrotask(() => {
      dbApi.getProducts().then(setProducts).catch(() => undefined)
    })
  }, [showCounts, products.length])

  const lines = useMemo(() => {
    const out: Array<{ sku: string; qty: number }> = []
    for (const p of products) {
      const raw = counts[p.id]
      const qty = Math.floor(Number(raw))
      if (raw == null || raw === '' || !Number.isFinite(qty) || qty === 0) continue
      out.push({ sku: p.sku, qty })
    }
    return out
  }, [counts, products])

  const countedTotal = lines.reduce((a, l) => a + l.qty, 0)

  const reset = () => {
    setForm({ name: '', type: 'store', city: '', manager: '' })
    setCounts({})
    setError('')
    setShowCounts(false)
  }

  const submit = async () => {
    const name = form.name.trim()
    if (!name) {
      setError('Give the location a name')
      return
    }
    setSaving(true)
    setError('')
    try {
      await dbApi.createInventoryLocation({
        name,
        type: form.type,
        city: form.city.trim() || undefined,
        manager: form.manager.trim() || undefined,
        openingBalances: lines,
      })
      setOpen(false)
      reset()
      toast.success(
        lines.length
          ? `${name} created with ${lines.length} opening balance${lines.length === 1 ? '' : 's'} (${countedTotal} units)`
          : `${name} created`,
      )
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create location')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New Location
      </Button>
      <AppDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            reset()
          }
          setOpen(next)
        }}
        size="md"
        isDirty={open && Boolean(form.name || form.city || form.manager || showCounts)}
        title="New Stock Location"
        description="Add a store, warehouse or workshop. You can count stock into it as you open it."
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!form.name.trim() || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />} Create Location
            </Button>
          </DialogFooter>
        }
      >

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5 sm:col-span-1">
              <Label htmlFor="loc-name">Name</Label>
              <Input
                id="loc-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Andheri Branch"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loc-type">Type</Label>
              <Select
                id="loc-type"
                options={LOCATION_TYPES}
                value={form.type}
                onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}
                placeholder="Type"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loc-city">City</Label>
              <Input id="loc-city" value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loc-manager">Manager</Label>
              <Input id="loc-manager" value={form.manager} onChange={(e) => setForm((f) => ({ ...f, manager: e.target.value }))} placeholder="Optional" />
            </div>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Opening stock</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Counted quantities post as opening entries and raise the total stock across all locations. To move
                  stock you already hold somewhere else, use a transfer instead.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowCounts((v) => !v)}>
                {showCounts ? 'Hide' : 'Count stock in'}
              </Button>
            </div>

            {showCounts ? (
              <div className="mt-3 max-h-[260px] space-y-1.5 overflow-y-auto">
                {products.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Loading products…</p>
                ) : (
                  products.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-3 rounded border bg-card px-2.5 py-1.5">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-foreground">{p.name}</p>
                        <p className="text-[11px] text-muted-foreground">{p.sku}</p>
                      </div>
                      <Input
                        type="number"
                        min={0}
                        aria-label={`Opening quantity for ${p.name}`}
                        placeholder="0"
                        className="h-8 w-24 text-xs"
                        value={counts[p.id] ?? ''}
                        onChange={(e) => setCounts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                      />
                    </div>
                  ))
                )}
              </div>
            ) : null}

            {showCounts && lines.length > 0 ? (
              <p className="mt-2 text-xs font-medium text-foreground">
                {lines.length} product{lines.length === 1 ? '' : 's'} · {formatNumber(countedTotal)} units will be added to
                total stock.
              </p>
            ) : null}
          </div>
        </div>

        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      </AppDialog>
    </>
  )
}