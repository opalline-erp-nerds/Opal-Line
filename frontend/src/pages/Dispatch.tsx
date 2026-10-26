import { useCallback, useEffect, useMemo, useState } from 'react'
import { Truck, RefreshCw, PackageCheck, PackageOpen } from 'lucide-react'
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

  const dispatchable = useMemo(
    () => orders.filter((o) => o.status !== 'cancelled' && !['delivered'].includes(shipments.find((sh) => sh.orderId === o.id)?.status ?? '')),
    [orders, shipments],
  )
  const shipmentByOrder = useMemo(() => new Map(shipments.map((sh) => [sh.orderId, sh])), [shipments])

  const openDispatch = useCallback((o: SalesOrder) => {
    const existing = shipmentByOrder.get(o.id)
    setCourier(existing?.courier && COURIERS.includes(existing.courier) ? existing.courier : 'BlueDart')
    setCustomCourier(existing && !COURIERS.includes(existing.courier ?? '') ? existing.courier ?? '' : '')
    setTracking(existing?.trackingNumber ?? '')
    setExpected(existing?.expectedDelivery?.slice(0, 10) ?? '')
    setDispatchFor(o)
  }, [shipmentByOrder])

  const saveDispatch = async () => {
    if (!dispatchFor) return
    setSaving(true)
    try {
      await dbApi.dispatchShipment(dispatchFor.id, {
        courier: courier === 'Other' ? customCourier : courier,
        trackingNumber: tracking || undefined,
        expectedDelivery: expected || undefined,
      })
      setDispatchFor(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dispatch failed')
    } finally {
      setSaving(false)
    }
  }

  const confirmDelivered = useCallback(async (sh: Shipment) => {
    try {
      await dbApi.confirmDelivery(sh.id)
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
      const isCancelled = row.original.status === 'cancelled'
      if (isCancelled) return null
      if (sh?.status === 'delivered') {
        return <span className="flex items-center gap-1 text-xs text-emerald-600"><PackageCheck className="h-3.5 w-3.5" /> Delivered</span>
      }
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
  ], [shipmentByOrder, openDispatch, confirmDelivered])

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
          <DataTable columns={columns} data={orders} loading={loading} emptyMessage="No orders" />
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
        isDirty={dispatchFor !== null && Boolean(courier || customCourier || tracking || expected)}
        title={`Dispatch order ${dispatchFor?.internalId || dispatchFor?.shopifyId || ''}`}
        description="The customer is notified automatically with tracking details once dispatched."
        footer={
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDispatchFor(null)}>Cancel</Button>
            <Button size="sm" onClick={saveDispatch} disabled={saving}>
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
                <Input value={customCourier} onChange={(e) => setCustomCourier(e.target.value)} placeholder="Courier name" className="mt-1.5" />
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
