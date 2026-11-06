import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Loader2,
  RefreshCw,
  GripVertical,
  ListChecks,
  Receipt,
  Search,
  X,
  History,
  ExternalLink,
  MoveRight,
  Truck,
  Ban,
  Archive,
  PackageCheck,
  Link2,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select } from '@/components/ui/select'
import { AppDialog } from '@/components/ui/app-dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { dbApi } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import { confirmDialog, toast } from '@/components/ui/confirm'
import type { OrderSyncStatus, PipelineStage, SalesOrder, ShopifyOrderState } from '@/types'

const COLUMNS: Array<{ key: SalesOrder['status']; label: string; accent: string }> = [
  { key: 'imported', label: 'New', accent: 'bg-sky-500' },
  { key: 'confirmed', label: 'Confirmed', accent: 'bg-violet-500' },
  { key: 'processing', label: 'Processing', accent: 'bg-amber-500' },
  { key: 'fulfilled', label: 'Fulfilled', accent: 'bg-emerald-500' },
  { key: 'cancelled', label: 'Cancelled', accent: 'bg-rose-500' },
]

const STAGE_LABELS: Record<PipelineStage, string> = {
  open: 'Open',
  in_progress: 'In progress',
  unfulfilled: 'Ready to ship',
  partially_fulfilled: 'Partially fulfilled',
  fulfilled: 'Fulfilled',
  cancelled: 'Cancelled',
  archived: 'Archived',
}

const CANCEL_REASONS = [
  { value: 'CUSTOMER', label: 'Customer changed their mind' },
  { value: 'FRAUD', label: 'Fraud' },
  { value: 'INVENTORY', label: 'Out of stock' },
  { value: 'DECLINED', label: 'Payment declined' },
  { value: 'OTHER', label: 'Other' },
]

interface OrderEvent {
  id: string
  orderId: string
  event: string
  details: string | null
  actor: string | null
  createdAt: string
}

function eventAccent(event: string): string {
  const e = event.toLowerCase()
  if (e.includes('fulfilled')) return 'bg-emerald-500'
  if (e.includes('return')) return 'bg-rose-500'
  if (e.includes('invoice') || e.includes('convert')) return 'bg-violet-500'
  if (e.includes('cancel')) return 'bg-zinc-400'
  return 'bg-sky-500'
}

/** Native Shopify status → a readable chip; the ERP stage stays separate. */
function nativeBadge(value: string | null | undefined): { label: string; className: string } | null {
  const v = String(value ?? '').trim().toUpperCase()
  if (!v) return null
  const label = v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
  if (v.includes('REFUND') || v === 'VOIDED') return { label, className: 'bg-rose-50 text-rose-700 border-rose-200' }
  if (v === 'PAID' || v === 'FULFILLED') return { label, className: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  if (v === 'PARTIALLY_FULFILLED' || v === 'PARTIALLY_PAID') return { label, className: 'bg-amber-50 text-amber-700 border-amber-200' }
  if (v === 'UNFULFILLED' || v === 'PENDING' || v === 'AUTHORIZED') return { label, className: 'bg-sky-50 text-sky-700 border-sky-200' }
  return { label, className: 'bg-muted text-muted-foreground' }
}

function isShopifyLinked(order: SalesOrder): boolean {
  // Local/manual orders have no Shopify name; only `#1234` rows can be acted on
  // in Shopify. Legacy rows without a gid still resolve by name.
  return Boolean(order.shopifyId && /^#\d/.test(order.shopifyId))
}

function isOpenForActions(order: SalesOrder): boolean {
  return isShopifyLinked(order) && !order.cancelledAt && !order.closedAt && order.shopifyFinancialStatus !== 'VOIDED'
}

/** Kanban pipeline for sales orders — drag cards between status columns. */
export default function OrderBoard() {
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [panelOrder, setPanelOrder] = useState<SalesOrder | null>(null)
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [stage, setStage] = useState<'all' | PipelineStage>('all')
  const [sync, setSync] = useState<OrderSyncStatus | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)

  // Action dialogs. Modal state is limited to one order at a time so a stale
  // dialog can never fire an action against a different order.
  const [fulfillFor, setFulfillFor] = useState<SalesOrder | null>(null)
  const [fulfillState, setFulfillState] = useState<ShopifyOrderState | null>(null)
  const [fulfillLoading, setFulfillLoading] = useState(false)
  const [fulfillQty, setFulfillQty] = useState<Record<string, number>>({})
  const [fulfillTracking, setFulfillTracking] = useState({ number: '', company: '', url: '' })
  const [notify, setNotify] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cancelFor, setCancelFor] = useState<SalesOrder | null>(null)
  const [cancelForm, setCancelForm] = useState({ reason: 'CUSTOMER', restock: true, refund: false, note: '' })
  const [trackFor, setTrackFor] = useState<SalesOrder | null>(null)
  const [trackForm, setTrackForm] = useState({ number: '', company: '', url: '' })

  const navigate = useNavigate()

  const load = async (): Promise<SalesOrder[]> => {
    setLoading(true)
    setError('')
    try {
      const [rows, status] = await Promise.all([
        dbApi.getSalesOrders(),
        dbApi.getOrderPipelineStatus().catch(() => null),
      ])
      setOrders(rows)
      if (status) setSync(status)
      return rows
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders')
      return []
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(() => {
      void load()
    })
  }, [])

  const refreshSync = async () => {
    try {
      setSync(await dbApi.getOrderPipelineStatus())
    } catch {
      /* status is informational; the board still works without it */
    }
  }

  const openTimeline = async (o: SalesOrder) => {
    setPanelOrder(o)
    setEvents([])
    setEventsLoading(true)
    try {
      const res = await dbApi.getOrderEvents(o.id)
      setEvents(res.data ?? [])
    } catch {
      setEvents([])
    } finally {
      setEventsLoading(false)
    }
  }

  // Search across order id, customer, invoice number and tags. Filtering
  // happens before the per-column grouping so empty columns stay visible.
  const filteredOrders = useMemo(() => {
    const q = query.trim().toLowerCase()
    const scoped = stage === 'all' ? orders : orders.filter((o) => o.pipelineStage === stage)
    if (!q) return scoped
    return scoped.filter((o) =>
      (o.customer ?? '').toLowerCase().includes(q) ||
      (o.internalId ?? '').toLowerCase().includes(q) ||
      (o.shopifyId ?? '').toLowerCase().includes(q) ||
      (o.invoice ?? '').toLowerCase().includes(q) ||
      (o.tags ?? '').toLowerCase().includes(q) ||
      (o.trackingNumber ?? '').toLowerCase().includes(q),
    )
  }, [orders, query, stage])

  const byStatus = useMemo(() => {
    const map = new Map<string, SalesOrder[]>()
    for (const col of COLUMNS) map.set(col.key, [])
    for (const o of filteredOrders) {
      // Fulfilled/cancelled/refunded are real final columns; everything else
      // lands in New until an operator confirms it.
      const key = (COLUMNS.find((c) => c.key === o.status)?.key ?? 'imported') as SalesOrder['status']
      map.get(key)?.push(o)
    }
    return map
  }, [filteredOrders])

  // Select every order the current search matched — then bulk-move them.
  const selectMatches = () => setSelected(new Set(filteredOrders.map((o) => o.id)))

  const move = async (orderId: string, status: SalesOrder['status']) => {
    const order = orders.find((o) => o.id === orderId)
    if (!order || order.status === status) return
    setMoving(orderId)
    try {
      const updated = await dbApi.updateOrderStatus(orderId, status)
      // The freshly raised invoice (if any) beats the pre-update snapshot.
      const invoice = updated.autoInvoice ?? updated.invoice ?? order.invoice
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status, invoice } : o)))
      if (panelOrder?.id === orderId) setPanelOrder((p) => (p ? { ...p, status, invoice } : p))
      // Receiving the order auto-raised its sales invoice — surface it so the
      // counter knows a bill now exists without checking Sales Invoices.
      if (updated.autoInvoice) toast.success(`Invoice ${updated.autoInvoice} created for ${order.internalId ?? order.shopifyId ?? 'order'}`)
      void refreshSync()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status update failed')
    } finally {
      setMoving(null)
      setDragId(null)
      setOverCol(null)
    }
  }

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleColumn = (_status: string, colOrders: SalesOrder[]) =>
    setSelected((prev) => {
      const next = new Set(prev)
      const allSelected = colOrders.length > 0 && colOrders.every((o) => next.has(o.id))
      for (const o of colOrders) {
        if (allSelected) next.delete(o.id)
        else next.add(o.id)
      }
      return next
    })

  // Bulk stage move: one confirmed call per selection batch keeps the supply
  // chain moving faster than dragging cards one by one.
  const bulkMove = async (status: SalesOrder['status']) => {
    const ids = [...selected]
    if (ids.length === 0) return
    const col = COLUMNS.find((c) => c.key === status)
    if (!(await confirmDialog({ title: `Move ${ids.length} order(s) to "${col?.label ?? status}"?` }))) return
    setBulkBusy(true)
    try {
      const r = await dbApi.bulkOrderStatus(ids, status)
      toast.success(`${r.updated} order(s) moved to ${r.status}${r.invoicesCreated ? ` · ${r.invoicesCreated} invoice(s) created` : ''}`)
      setSelected(new Set())
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk move failed')
    } finally {
      setBulkBusy(false)
    }
  }

  const afterShopifyChange = async (orderId: string, message?: string) => {
    if (message) toast.success(message)
    const rows = await load()
    await refreshSync()
    if (panelOrder?.id === orderId) {
      const fresh = rows.find((o) => o.id === orderId) ?? null
      if (fresh) {
        setPanelOrder(fresh)
        const res = await dbApi.getOrderEvents(orderId).catch(() => null)
        if (res) setEvents(res.data ?? [])
      }
    }
  }

  const refreshOne = async (orderId: string) => {
    setSyncing(orderId)
    try {
      const r = await dbApi.refreshPipelineOrder(orderId)
      if (!r.ok) throw new Error(r.error ?? 'Refresh failed')
      toast.success(r.updated ? `Updated ${r.changed?.join(', ') ?? 'order'}` : 'Order is already current')
      await afterShopifyChange(orderId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setSyncing(null)
    }
  }

  const reconcile = async () => {
    if (!(await confirmDialog({ title: 'Reconcile recent orders with Shopify?', description: 'Re-reads the last 30 days of orders from Shopify and updates ERP state. Stock and ERP stages are not changed.', confirmLabel: 'Reconcile' }))) return
    setReconciling(true)
    try {
      const r = await dbApi.reconcileOrderPipeline({ days: 30 })
      if (!r.ok) throw new Error(r.errors?.[0] ?? 'Reconcile failed')
      toast.success(
        `Checked ${r.checked} orders · ${r.updated} updated${r.missing ? ` · ${r.missing} not linked` : ''}${r.errors.length ? ` · ${r.errors.length} error(s)` : ''}`,
      )
      await load()
      await refreshSync()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reconcile failed')
    } finally {
      setReconciling(false)
    }
  }

  const openFulfill = async (order: SalesOrder) => {
    setFulfillFor(order)
    setFulfillState(null)
    setFulfillQty({})
    setFulfillTracking({ number: order.trackingNumber ?? '', company: order.trackingCompany ?? '', url: order.trackingUrl ?? '' })
    setNotify(false)
    setFulfillLoading(true)
    try {
      const r = await dbApi.getOrderShopifyState(order.id)
      if (!r.ok || !r.state) throw new Error(r.error ?? 'Could not read this order from Shopify')
      setFulfillState(r.state)
      const defaults: Record<string, number> = {}
      for (const line of r.state.lines ?? []) defaults[line.fulfillmentOrderLineItemId] = line.remaining
      setFulfillQty(defaults)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read this order from Shopify')
      setFulfillFor(null)
    } finally {
      setFulfillLoading(false)
    }
  }

  const submitFulfill = async () => {
    if (!fulfillFor || !fulfillState) return
    const items = (fulfillState.lines ?? [])
      .map((line) => ({ sku: line.sku, quantity: Math.floor(Number(fulfillQty[line.fulfillmentOrderLineItemId] ?? 0)) }))
      .filter((i) => i.quantity > 0)
    if (items.length === 0) {
      toast.error('Select at least one item to fulfill')
      return
    }
    setBusy(true)
    try {
      const r = await dbApi.fulfillOrder(fulfillFor.id, {
        items,
        trackingNumber: fulfillTracking.number.trim() || null,
        trackingCompany: fulfillTracking.company.trim() || null,
        trackingUrl: fulfillTracking.url.trim() || null,
        notifyCustomer: notify,
      })
      if (!r.ok) throw new Error(r.error ?? 'Shopify fulfillment failed')
      const orderId = fulfillFor.id
      setFulfillFor(null)
      await afterShopifyChange(orderId, r.message ?? 'Fulfillment created in Shopify')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Shopify fulfillment failed')
    } finally {
      setBusy(false)
    }
  }

  const openTracking = (order: SalesOrder) => {
    setTrackFor(order)
    setTrackForm({ number: order.trackingNumber ?? '', company: order.trackingCompany ?? '', url: order.trackingUrl ?? '' })
    setNotify(false)
  }

  const submitTracking = async () => {
    if (!trackFor) return
    if (!trackForm.number.trim()) {
      toast.error('Tracking number is required')
      return
    }
    setBusy(true)
    try {
      const r = await dbApi.updateOrderTracking(trackFor.id, {
        trackingNumber: trackForm.number.trim(),
        trackingCompany: trackForm.company.trim() || null,
        trackingUrl: trackForm.url.trim() || null,
        notifyCustomer: notify,
      })
      if (!r.ok) throw new Error(r.error ?? 'Shopify tracking update failed')
      const orderId = trackFor.id
      setTrackFor(null)
      await afterShopifyChange(orderId, 'Tracking updated in Shopify')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Shopify tracking update failed')
    } finally {
      setBusy(false)
    }
  }

  const openCancel = (order: SalesOrder) => {
    setCancelFor(order)
    setCancelForm({ reason: 'CUSTOMER', restock: true, refund: false, note: '' })
    setNotify(false)
  }

  const submitCancel = async () => {
    if (!cancelFor) return
    setBusy(true)
    try {
      const r = await dbApi.cancelPipelineOrder(cancelFor.id, {
        ...cancelForm,
        notifyCustomer: notify,
      })
      if (!r.ok) throw new Error(r.error ?? 'Shopify cancellation failed')
      const orderId = cancelFor.id
      setCancelFor(null)
      await afterShopifyChange(orderId, r.message ?? 'Order cancelled in Shopify')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Shopify cancellation failed')
    } finally {
      setBusy(false)
    }
  }

  const archive = async (order: SalesOrder) => {
    if (!(await confirmDialog({
      title: `Archive ${order.internalId || order.shopifyId} in Shopify?`,
      description: 'Archiving closes the order. Shopify refuses this while the order is still unfulfilled or unpaid.',
      confirmLabel: 'Archive',
      danger: true,
    }))) return
    setSyncing(order.id)
    try {
      const r = await dbApi.archivePipelineOrder(order.id)
      if (!r.ok) throw new Error(r.error ?? 'Shopify archive failed')
      await afterShopifyChange(order.id, 'Order archived in Shopify')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Shopify archive failed')
    } finally {
      setSyncing(null)
    }
  }

  const stageTabs: Array<{ key: 'all' | PipelineStage; label: string; count: number }> = [
    { key: 'all', label: 'All orders', count: sync?.counts.all ?? orders.length },
    ...(['open', 'in_progress', 'unfulfilled', 'partially_fulfilled', 'fulfilled', 'cancelled', 'archived'] as PipelineStage[]).map((key) => ({
      key,
      label: STAGE_LABELS[key],
      count: sync?.counts[key] ?? orders.filter((o) => o.pipelineStage === key).length,
    })),
  ]

  const lastSynced = sync?.lastSyncedAt
    ? new Date(sync.lastSyncedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-4 sm:space-y-5 sm:py-6 lg:px-6">
      <PageHeader
        title="Order Pipeline"
        subtitle="Drag orders across the fulfilment pipeline. Click a card to see its timeline, Shopify status and actions."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={reconcile} disabled={reconciling || loading}>
              {reconciling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />} Reconcile
            </Button>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
            </Button>
          </div>
        }
      />

      {error && <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500 dark:text-red-400">{error}</p>}

      {sync?.lastError && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
          Last Shopify order sync failed ({sync.lastError.at ? new Date(sync.lastError.at).toLocaleString('en-IN') : 'time unknown'}): {sync.lastError.message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {stageTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setStage(tab.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                stage === tab.key ? 'border-primary bg-primary/10 text-foreground' : 'bg-card text-muted-foreground hover:bg-muted',
              )}
            >
              {tab.label}
              <span className={cn('rounded px-1 text-[10px]', stage === tab.key ? 'bg-primary/15' : 'bg-muted')}>{tab.count}</span>
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {lastSynced ? `Shopify synced ${lastSynced}` : 'No Shopify sync recorded yet'}
          {sync ? ` · ${sync.syncedRecently} order(s) in the last 24h` : ''}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search order id, customer, invoice, tracking..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={selectMatches} disabled={filteredOrders.length === 0}>
          <ListChecks className="h-3.5 w-3.5" /> Select all matches ({filteredOrders.length})
        </Button>
        {query.trim() && (
          <span className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{filteredOrders.length}</span> of {orders.length} orders
          </span>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
          <span className="text-xs font-medium">{selected.size} selected</span>
          {COLUMNS.filter((c) => c.key !== 'cancelled').map((c) => (
            <Button key={c.key} size="sm" variant="outline" onClick={() => bulkMove(c.key)} disabled={bulkBusy}>
              <MoveRight className="h-3.5 w-3.5" /> {c.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {loading && orders.length === 0 ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading orders…
        </div>
      ) : stage === 'all' ? (
        <div className="flex gap-3 overflow-x-auto pb-3">
          {COLUMNS.map((col) => {
            const colOrders = byStatus.get(col.key) ?? []
            const total = colOrders.reduce((a, o) => a + Number(o.value ?? 0), 0)
            return (
              <div
                key={col.key}
                className={cn(
                  'flex min-h-[320px] w-[270px] shrink-0 flex-col rounded-lg border bg-card/40 transition-colors',
                  overCol === col.key && dragId && 'border-primary bg-primary/5',
                )}
                onDragOver={(e) => { e.preventDefault(); setOverCol(col.key) }}
                onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
                onDrop={(e) => { e.preventDefault(); if (dragId) void move(dragId, col.key) }}
              >
                <div className="flex items-center gap-2 border-b p-3">
                  <span className={cn('h-2 w-2 rounded-full', col.accent)} />
                  <span className="text-sm font-medium">{col.label}</span>
                  <Badge variant="secondary" className="ml-auto">{colOrders.length}</Badge>
                  {colOrders.length > 0 && col.key !== 'cancelled' && (
                    <button
                      type="button"
                      aria-label={`Select all ${col.label} orders`}
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => toggleColumn(col.key, colOrders)}
                    >
                      select
                    </button>
                  )}
                </div>
                <p className="px-3 pt-1.5 text-xs text-muted-foreground">{formatCurrency(total)}</p>
                <div className="flex-1 space-y-2 p-2">
                  {colOrders.map((o) => {
                    const pay = nativeBadge(o.shopifyFinancialStatus)
                    const ship = nativeBadge(o.shopifyFulfillmentStatus)
                    return (
                      <div
                        key={o.id}
                        draggable
                        onDragStart={() => setDragId(o.id)}
                        onDragEnd={() => { setDragId(null); setOverCol(null) }}
                        className={cn(
                          'group cursor-grab rounded-md border bg-card p-2.5 shadow-sm transition-opacity active:cursor-grabbing',
                          dragId === o.id && 'opacity-40',
                          moving === o.id && 'animate-pulse',
                          panelOrder?.id === o.id && 'border-primary ring-1 ring-primary',
                        )}
                        onClick={() => { if (!dragId) void openTimeline(o) }}
                      >
                        <div className="flex items-start gap-1.5">
                          <input
                            type="checkbox"
                            aria-label={`Select order ${o.internalId || o.shopifyId}`}
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer"
                            checked={selected.has(o.id)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelect(o.id)}
                          />
                          <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium">{o.customer || 'Walk-in'}</p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {o.internalId || o.shopifyId || o.id.slice(0, 8)}
                              {o.isBooking ? ' · Booking' : ''}
                            </p>
                            <div className="mt-1 flex items-center justify-between gap-1">
                              <span className="text-xs font-semibold">{formatCurrency(Number(o.value ?? 0), { currency: o.currency })}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {o.date ? new Date(o.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''}
                              </span>
                            </div>
                            {(pay || ship) && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {pay && <span className={cn('rounded border px-1 py-0.5 text-[10px]', pay.className)}>{pay.label}</span>}
                                {ship && <span className={cn('rounded border px-1 py-0.5 text-[10px]', ship.className)}>{ship.label}</span>}
                              </div>
                            )}
                            {o.trackingNumber && (
                              <p className="mt-1 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                                <Truck className="h-3 w-3 shrink-0" />
                                <span className="truncate">{o.trackingCompany ? `${o.trackingCompany} · ` : ''}{o.trackingNumber}</span>
                              </p>
                            )}
                            {o.invoice ? (
                              <p className="mt-1 flex items-center gap-1 text-[10px] text-emerald-600">
                                <Receipt className="h-3 w-3" /> {o.invoice}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {colOrders.length === 0 && (
                    <p className="py-6 text-center text-[11px] text-muted-foreground/70">Drop orders here</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Fulfilment</TableHead>
                <TableHead>Tracking</TableHead>
                <TableHead>Synced</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredOrders.map((o) => {
                const pay = nativeBadge(o.shopifyFinancialStatus)
                const ship = nativeBadge(o.shopifyFulfillmentStatus)
                const actionable = isOpenForActions(o)
                return (
                  <TableRow key={o.id} className="cursor-pointer" onClick={() => void openTimeline(o)}>
                    <TableCell>
                      <p className="font-medium">{o.internalId || o.shopifyId || o.id.slice(0, 8)}</p>
                      <p className="text-[11px] text-muted-foreground">{o.date ? new Date(o.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}</p>
                    </TableCell>
                    <TableCell>{o.customer || 'Walk-in'}</TableCell>
                    <TableCell className="text-right">{formatCurrency(Number(o.value ?? 0), { currency: o.currency })}</TableCell>
                    <TableCell>{pay ? <span className={cn('rounded border px-1.5 py-0.5 text-[11px]', pay.className)}>{pay.label}</span> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                    <TableCell>{ship ? <span className={cn('rounded border px-1.5 py-0.5 text-[11px]', ship.className)}>{ship.label}</span> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-xs text-muted-foreground">{o.trackingNumber || '—'}{o.trackingCompany ? ` · ${o.trackingCompany}` : ''}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{o.shopifySyncedAt ? new Date(o.shopifySyncedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        {isShopifyLinked(o) && (
                          <Button variant="outline" size="sm" onClick={() => void refreshOne(o.id)} disabled={syncing === o.id}>
                            {syncing === o.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                          </Button>
                        )}
                        {actionable && o.pipelineStage !== 'fulfilled' && (
                          <Button variant="soft-primary" size="sm" onClick={() => void openFulfill(o)}>
                            <PackageCheck className="h-3.5 w-3.5" /> Fulfil
                          </Button>
                        )}
                        {actionable && !!o.trackingNumber && (
                          <Button variant="outline" size="sm" onClick={() => openTracking(o)}>
                            <Truck className="h-3.5 w-3.5" /> Tracking
                          </Button>
                        )}
                        {actionable && (
                          <Button variant="soft-danger" size="sm" onClick={() => openCancel(o)}>
                            <Ban className="h-3.5 w-3.5" /> Cancel
                          </Button>
                        )}
                        {actionable && !o.closedAt && (
                          <Button variant="ghost" size="sm" onClick={() => void archive(o)}>
                            <Archive className="h-3.5 w-3.5" /> Archive
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filteredOrders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                    No orders in {STAGE_LABELS[stage as PipelineStage]}.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Order timeline side panel */}
      {panelOrder && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setPanelOrder(null)} />
          <aside className="relative z-10 flex h-full w-full max-w-md flex-col border-l bg-card shadow-xl">
            <div className="flex items-start justify-between gap-2 border-b p-4">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold">{panelOrder.customer || 'Walk-in'}</h3>
                <p className="truncate text-xs text-muted-foreground">
                  {panelOrder.internalId || panelOrder.shopifyId || panelOrder.id}
                  {panelOrder.isBooking ? ' · Booking' : ''}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">{panelOrder.pipelineStage ? STAGE_LABELS[panelOrder.pipelineStage] : panelOrder.status || 'unknown'}</Badge>
                  <span className="text-sm font-semibold">{formatCurrency(Number(panelOrder.value ?? 0), { currency: panelOrder.currency })}</span>
                  {panelOrder.invoice ? (
                    <span className="flex items-center gap-1 text-xs text-emerald-600"><Receipt className="h-3 w-3" /> {panelOrder.invoice}</span>
                  ) : null}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {(() => {
                    const pay = nativeBadge(panelOrder.shopifyFinancialStatus)
                    const ship = nativeBadge(panelOrder.shopifyFulfillmentStatus)
                    return (
                      <>
                        {pay && <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', pay.className)}>{pay.label}</span>}
                        {ship && <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', ship.className)}>{ship.label}</span>}
                        {panelOrder.closedAt && <span className="rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Archived</span>}
                      </>
                    )
                  })()}
                </div>
                {panelOrder.trackingNumber && (
                  <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Truck className="h-3 w-3" />
                    {panelOrder.trackingCompany ? `${panelOrder.trackingCompany} · ` : ''}
                    {panelOrder.trackingUrl ? (
                      <a href={panelOrder.trackingUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{panelOrder.trackingNumber}</a>
                    ) : (
                      panelOrder.trackingNumber
                    )}
                  </p>
                )}
                {panelOrder.shopifySyncedAt && (
                  <p className="mt-1 text-[10px] text-muted-foreground/70">
                    Synced {new Date(panelOrder.shopifySyncedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                )}
              </div>
              <Button variant="ghost" size="icon" onClick={() => setPanelOrder(null)} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>

            {isShopifyLinked(panelOrder) && (
              <div className="flex flex-wrap gap-1.5 border-b p-3">
                <Button variant="outline" size="sm" onClick={() => void refreshOne(panelOrder.id)} disabled={syncing === panelOrder.id}>
                  {syncing === panelOrder.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
                </Button>
                {isOpenForActions(panelOrder) && panelOrder.pipelineStage !== 'fulfilled' && (
                  <Button variant="soft-primary" size="sm" onClick={() => void openFulfill(panelOrder)}>
                    <PackageCheck className="h-3.5 w-3.5" /> Fulfil
                  </Button>
                )}
                {isOpenForActions(panelOrder) && !!panelOrder.trackingNumber && (
                  <Button variant="outline" size="sm" onClick={() => openTracking(panelOrder)}>
                    <Truck className="h-3.5 w-3.5" /> Tracking
                  </Button>
                )}
                {isOpenForActions(panelOrder) && (
                  <Button variant="soft-danger" size="sm" onClick={() => openCancel(panelOrder)}>
                    <Ban className="h-3.5 w-3.5" /> Cancel
                  </Button>
                )}
                {isOpenForActions(panelOrder) && (
                  <Button variant="ghost" size="sm" onClick={() => void archive(panelOrder)}>
                    <Archive className="h-3.5 w-3.5" /> Archive
                  </Button>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-4">
              <p className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <History className="h-3.5 w-3.5" /> Order Timeline
              </p>
              {eventsLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading events…
                </div>
              ) : events.length === 0 ? (
                <p className="py-6 text-sm text-muted-foreground">No events recorded yet for this order.</p>
              ) : (
                <ol className="relative space-y-4 border-l pl-4">
                  {events.map((ev) => (
                    <li key={ev.id} className="relative">
                      <span className={cn('absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-card', eventAccent(ev.event))} />
                      <p className="text-xs font-semibold">{ev.event}</p>
                      {ev.details && <p className="mt-0.5 text-xs text-muted-foreground">{ev.details}</p>}
                      <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                        {ev.createdAt ? new Date(ev.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                        {ev.actor ? ` · by ${ev.actor}` : ''}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="border-t p-3">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => navigate(`/sales/orders?order=${panelOrder.id}`)}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open full order details
              </Button>
            </div>
          </aside>
        </div>
      )}

      {/* Fulfil in Shopify */}
      <AppDialog
        open={!!fulfillFor}
        onOpenChange={(open) => { if (!open) setFulfillFor(null) }}
        title={fulfillFor ? `Fulfil ${fulfillFor.internalId || fulfillFor.shopifyId}` : 'Fulfil order'}
        description="Only quantities Shopify says are still fulfillable can be shipped. Shopify records the fulfillment; ERP stock is not deducted again."
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setFulfillFor(null)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void submitFulfill()} disabled={busy || fulfillLoading || !fulfillState?.lines?.length}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />} Create fulfillment
            </Button>
          </>
        }
      >
        {fulfillLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading fulfilment plan from Shopify…
          </div>
        ) : !fulfillState?.lines?.length ? (
          <p className="py-6 text-sm text-muted-foreground">
            Shopify reports nothing left to fulfil on this order. Refresh the order to update its ERP state.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              {fulfillState.lines.map((line) => (
                <div key={line.fulfillmentOrderLineItemId} className="flex items-center gap-3 rounded-md border p-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{line.name}</p>
                    <p className="text-[11px] text-muted-foreground">{line.sku} · {line.remaining} of {line.total} remaining</p>
                  </div>
                  <Input
                    type="number"
                    min={0}
                    max={line.remaining}
                    className="w-20"
                    value={fulfillQty[line.fulfillmentOrderLineItemId] ?? 0}
                    onChange={(e) => {
                      const raw = Math.floor(Number(e.target.value) || 0)
                      const next = Math.max(0, Math.min(raw, line.remaining))
                      setFulfillQty((prev) => ({ ...prev, [line.fulfillmentOrderLineItemId]: next }))
                    }}
                    aria-label={`Quantity for ${line.sku}`}
                  />
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="fulfil-tracking">Tracking number</Label>
                <Input id="fulfil-tracking" value={fulfillTracking.number} onChange={(e) => setFulfillTracking((p) => ({ ...p, number: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fulfil-carrier">Carrier</Label>
                <Input id="fulfil-carrier" value={fulfillTracking.company} onChange={(e) => setFulfillTracking((p) => ({ ...p, company: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fulfil-url">Tracking URL</Label>
                <Input id="fulfil-url" value={fulfillTracking.url} onChange={(e) => setFulfillTracking((p) => ({ ...p, url: e.target.value }))} placeholder="Optional" />
              </div>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
              Notify the customer
              <Switch checked={notify} onCheckedChange={setNotify} />
            </label>
          </div>
        )}
      </AppDialog>

      {/* Update tracking */}
      <AppDialog
        open={!!trackFor}
        onOpenChange={(open) => { if (!open) setTrackFor(null) }}
        title={trackFor ? `Tracking for ${trackFor.internalId || trackFor.shopifyId}` : 'Update tracking'}
        description="Updates Shopify's tracking information for this order's fulfillment."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setTrackFor(null)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void submitTracking()} disabled={busy}>Save tracking</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="track-number">Tracking number</Label>
            <Input id="track-number" value={trackForm.number} onChange={(e) => setTrackForm((p) => ({ ...p, number: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="track-carrier">Carrier</Label>
            <Input id="track-carrier" value={trackForm.company} onChange={(e) => setTrackForm((p) => ({ ...p, company: e.target.value }))} placeholder="Optional" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="track-url">Tracking URL</Label>
            <Input id="track-url" value={trackForm.url} onChange={(e) => setTrackForm((p) => ({ ...p, url: e.target.value }))} placeholder="Optional" />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
            Notify the customer
            <Switch checked={notify} onCheckedChange={setNotify} />
          </label>
        </div>
      </AppDialog>

      {/* Cancel in Shopify */}
      <AppDialog
        open={!!cancelFor}
        onOpenChange={(open) => { if (!open) setCancelFor(null) }}
        title={cancelFor ? `Cancel ${cancelFor.internalId || cancelFor.shopifyId}` : 'Cancel order'}
        description="Shopify processes cancellation asynchronously. This page reads the order back and only reports success once Shopify confirms it."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setCancelFor(null)} disabled={busy}>Keep order</Button>
            <Button variant="destructive" onClick={() => void submitCancel()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />} Cancel in Shopify
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cancel-reason">Reason</Label>
            <Select
              id="cancel-reason"
              options={CANCEL_REASONS}
              value={cancelForm.reason}
              onValueChange={(reason) => setCancelForm((p) => ({ ...p, reason }))}
            />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
            Restock items in Shopify
            <Switch checked={cancelForm.restock} onCheckedChange={(restock) => setCancelForm((p) => ({ ...p, restock }))} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
            Refund to the original payment method
            <Switch checked={cancelForm.refund} onCheckedChange={(refund) => setCancelForm((p) => ({ ...p, refund }))} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
            Notify the customer
            <Switch checked={notify} onCheckedChange={setNotify} />
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="cancel-note">Staff note (optional)</Label>
            <Input id="cancel-note" value={cancelForm.note} onChange={(e) => setCancelForm((p) => ({ ...p, note: e.target.value }))} maxLength={500} />
          </div>
        </div>
      </AppDialog>
    </div>
  )
}
