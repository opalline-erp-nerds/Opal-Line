import { useCallback, useEffect, useMemo, useState } from 'react'
import { Truck, RefreshCw, PackageCheck, PackageOpen } from 'lucide-react'
import { toast } from '@/components/ui/confirm'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { DataTable } from '@/components/ui/data-table'
import type { ColumnDef } from '@/lib/table'
import { dbApi } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import type { SalesOrder, Shipment } from '@/types'

const COURIERS = ['BlueDart', 'Delhivery', 'DTDC', 'Ekart', 'India Post', 'Shiprocket', 'Other']

export default function DispatchPage() {
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dispatchFor, setDispatchFor] = useState<SalesOrder | null>(null)
  const [courier, setCourier] = useState('BlueDart')
  const [customCourier, setCustomCourier] = useState('')
  const [tracking, setTracking] = useState('')
  const [expected, setExpected] = useState('')
  const [saving, setSaving] = useState(false)
  // Snapshot taken when the dialog opens; isDirty compares the live fields to
  // it so Cancel only warns when something actually changed (an always-on
  // courier preset made the old check warn on untouched dialogs too).
  const [baseline, setBaseline] = useState('')

  const dirtySnapshot = JSON.stringify({ courier, customCourier, tracking, expected })

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [o, s] = await Promise.all([dbApi.getSalesOrders(), dbApi.getShipments()])
      setOrders(o)
      setShipments(s.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(() => {
      void load()
    })
  }, [load])

  const shipmentByOrder = useMemo(() => new Map(shipments.map((sh) => [sh.orderId, sh])), [shipments])

  /** Can this order still go out? Mirrors the backend's eligibility rules —
   * see backend/src/dispatch.ts — so the page never shows a Dispatch action
   * the API would reject: not cancelled, not already delivered, and a
   * fulfilled order without a shipment (fulfilled inside Shopify, never
   * dispatched here) is not dispatchable — its goods already left via the
   * outside flow. */
  const isEligible = useCallback((o: SalesOrder) => {
    const sh = shipmentByOrder.get(o.id)
    if (o.status === 'cancelled') return false
    if (sh?.status === 'delivered') return false
    if (!sh && o.status === 'fulfilled') return false
    return true
  }, [shipmentByOrder])
  const dispatchable = useMemo(
    () => orders.filter((o) => isEligible(o)),
    [orders, isEligible],
  )

  const openDispatch = useCallback((o: SalesOrder) => {
    const existing = shipmentByOrder.get(o.id)
    const existingCourier = existing?.courier ?? null
    let nextCourier: string
    if (existingCourier && COURIERS.includes(existingCourier)) {
      // A stored courier on the preset list comes back selected as itself.
      nextCourier = existingCourier
    } else if (existingCourier) {
      // A custom courier must come back as "Other" with its name intact;
      // defaulting to BlueDart here silently overwrote custom couriers
      // (e.g. "XPRS Beu") with BlueDart on save.
      nextCourier = 'Other'
    } else {
      nextCourier = 'BlueDart'
    }
    const nextCustom = existing && !COURIERS.includes(existing.courier ?? '') ? existing.courier ?? '' : ''
    const nextTracking = existing?.trackingNumber ?? ''
    const nextExpected = existing?.expectedDelivery?.slice(0, 10) ?? ''
    setCourier(nextCourier)
    setCustomCourier(nextCustom)
    setTracking(nextTracking)
    setExpected(nextExpected)
    setBaseline(JSON.stringify({ courier: nextCourier, customCourier: nextCustom, tracking: nextTracking, expected: nextExpected }))
    setDispatchFor(o)
  }, [shipmentByOrder])

  const saveDispatch = async () => {
    if (!dispatchFor || saving) return
    const courierValue = (courier === 'Other' ? customCourier : courier).trim()
    if (courier === 'Other' && !courierValue) return // button is disabled before it can fire
    setSaving(true)
    setError('')
    try {
      await dbApi.dispatchShipment(dispatchFor.id, {
        // Present-with-empty means "clear"; omitted means "keep" (see
        // backend/src/dispatch.ts). The dialog pre-fills every editable
        // field, so an emptied field is always an intentional clearing.
        courier: courierValue || null,
        trackingNumber: tracking || null,
        expectedDelivery: expected || null,
      })
      setDispatchFor(null)
      toast.success(`Dispatched ${dispatchFor.internalId || dispatchFor.shopifyId || 'order'}`)
      await load()
    } catch (err) {
      // Trust the backend's wording (eligibility + unexpected failures) — it
      // names the exact rule that fired; the page never claims success when
      // the API failed because it only toasts inside the try block.
      const message = err instanceof Error ? err.message : 'Dispatch failed'
      setError(message)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const confirmDelivered = useCallback(async (sh: Shipment) => {
    try {
      await dbApi.confirmDelivery(sh.id)
      toast.success('Delivery confirmed')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm delivery')
    }
  }, [load])

  const columns = useMemo<Array<ColumnDef<SalesOrder>>>(() => [
    { accessorKey: 'customer', header: 'Customer', cell: ({ row }) => <span className="font-medium">{row.original.customer || 'Walk-in'}</span> },
    { accessorKey: 'internalId', header: 'Order', cell: ({ row }) => <span className="font-mono text-xs">{row.original.internalId || row.original.shopifyId || row.original.id.slice(0, 8)}</span> },
    { accessorKey: 'value', header: 'Value', cell: ({ row }) => <span className="tabular-nums">{formatCurrency(Number(row.original.value ?? 0))}</span> },
    { id: 'shipment', header: 'Shipment', cell: ({ row }) => {
      const sh = shipmentByOrder.get(row.original.id)
      if (!sh) return <Badge variant="muted">Not dispatched</Badge>
      return (
        <div className="space-y-0.5">
          <Badge variant={sh.status === 'delivered' ? 'success' : 'info'}>{sh.status}</Badge>
          {sh.courier && <p className="text-[11px] text-muted-foreground">{sh.courier}{sh.trackingNumber ? ` · ${sh.trackingNumber}` : ''}</p>}
        </div>
      )
    } },
    { id: 'actions', header: '', meta: { align: 'right' as const }, cell: ({ row }) => {
      const sh = shipmentByOrder.get(row.original.id)
      // Same rule as the eligibility gate: nothing actionable on cancelled or
      // delivered orders; a displayed delivered shipment stays as an easy
      // "confirm again is harmless" (idempotent) action.
      if (row.original.status === 'cancelled') return null
      if (sh?.status === 'delivered') {
        return <span className="flex items-center gap-1 text-xs text-emerald-600"><PackageCheck className="h-3.5 w-3.5" /> Delivered</span>
      }
      if (!isEligible(row.original)) return null
      return (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); openDispatch(row.original) }}>
            <Truck className="h-3.5 w-3.5" /> {sh ? 'Update' : 'Dispatch'}
          </Button>
          {sh?.status === 'dispatched' && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); void confirmDelivered(sh) }}>
              <PackageCheck className="h-3.5 w-3.5" /> Delivered
            </Button>
          )}
        </div>
      )
    } },
  ], [shipmentByOrder, isEligible, openDispatch, confirmDelivered])

  const dispatched = shipments.filter((sh) => sh.status === 'dispatched').length
  const delivered = shipments.filter((sh) => sh.status === 'delivered').length

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Dispatch"
        subtitle="Assign couriers, print tracking and confirm deliveries. Customers are notified automatically."
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      {error && <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500 dark:text-red-400">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Awaiting dispatch</p><p className="text-2xl font-semibold">{dispatchable.length}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">In transit</p><p className="text-2xl font-semibold">{dispatched}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Delivered</p><p className="text-2xl font-semibold">{delivered}</p></CardContent></Card>
      </div>

      <Card>
        <CardContent className="p-0">
          {/* Eligible orders stay actionable; orders already delivered or
              fulfilled outside dispatch stay visible for their shipment info
              but their action cell renders empty. */}
          <DataTable columns={columns} data={orders} loading={loading} emptyMessage="No orders awaiting dispatch" />
        </CardContent>
      </Card>

      {shipments.some((sh) => sh.status === 'dispatched') && (
        <Card>
          <CardContent className="space-y-2 p-5">
            <h3 className="flex items-center gap-2 font-semibold"><PackageOpen className="h-4 w-4 text-muted-foreground" /> In transit</h3>
            {shipments.filter((sh) => sh.status === 'dispatched').map((sh) => (
              <div key={sh.id} className="flex items-center justify-between gap-2 rounded-md border p-2.5 text-sm">
                <div>
                  <p className="font-medium">{sh.customer || 'Walk-in'} <span className="text-xs text-muted-foreground">({sh.orderRef})</span></p>
                  <p className="text-xs text-muted-foreground">{sh.courier}{sh.trackingNumber ? ` · AWB ${sh.trackingNumber}` : ''}</p>
                </div>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void confirmDelivered(sh)}>
                  <PackageCheck className="h-3.5 w-3.5" /> Mark delivered
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <AppDialog
        open={dispatchFor !== null}
        onOpenChange={(open) => { if (!open) setDispatchFor(null) }}
        size="md"
        isDirty={dispatchFor !== null && dirtySnapshot !== baseline}
        title={`Dispatch order ${dispatchFor?.internalId || dispatchFor?.shopifyId || ''}`}
        description="The customer is notified automatically with tracking details once dispatched."
        footer={
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDispatchFor(null)}>Cancel</Button>
            <Button size="sm" onClick={saveDispatch} disabled={saving || (courier === 'Other' && !customCourier.trim())}>
              <Truck className="h-4 w-4" /> {saving ? 'Saving…' : 'Dispatch & notify'}
            </Button>
          </DialogFooter>
        }
      >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Courier</Label>
              <div className="flex flex-wrap gap-1.5">
                {COURIERS.map((c) => (
                  <button key={c} type="button" onClick={() => setCourier(c)}
                    className={`rounded-full border px-3 py-1 text-xs ${courier === c ? 'border-primary bg-primary text-primary-foreground' : 'bg-card'}`}>
                    {c}
                  </button>
                ))}
              </div>
              {courier === 'Other' && (
                <>
                  <Input value={customCourier} onChange={(e) => setCustomCourier(e.target.value)} placeholder="Courier name" className="mt-1.5" />
                  {!customCourier.trim() && (
                    <p className="text-xs text-red-500">Name the courier before dispatching</p>
                  )}
                </>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tracking">Tracking / AWB number</Label>
              <Input id="tracking" value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="e.g. D40018293" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="expected">Expected delivery</Label>
              <Input id="expected" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </div>
          </div>
      </AppDialog>
    </div>
  )
}
