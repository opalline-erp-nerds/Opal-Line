import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, PackageSearch, Search } from 'lucide-react'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/confirm'
import { formatApiError } from '@/lib/api/core'
import { returnsApi, type OrderReturnStatus, type OrderSearchRow, type ReturnStatus } from '@/lib/api/returns'
import { formatCurrency, formatDate } from '@/lib/format'

/** Stable empty list so the memo below is not invalidated every render. */
const EMPTY_LINES: OrderReturnStatus['lines'] = []

/**
 * Raise an RMA against an existing order.
 *
 * Quantities are validated against the order's remaining returnable units,
 * which the backend computes as `ordered − already returned` — so the same unit
 * can never be returned twice, whatever the operator types here.
 */
export function CreateReturnDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<OrderSearchRow[]>([])
  const [searching, setSearching] = useState(false)
  const [orderId, setOrderId] = useState('')
  const [orderStatus, setOrderStatus] = useState<OrderReturnStatus | null>(null)
  const [loadingOrder, setLoadingOrder] = useState(false)
  const [qty, setQty] = useState<Record<string, number>>({})
  const [reason, setReason] = useState('damaged')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One key per dialog session: a double-submitted request replays instead of
  // creating a second return, while reopening the dialog starts a new return.
  const idempotencyKey = useRef<string>(crypto.randomUUID())

  useEffect(() => {
    if (!open) return
    idempotencyKey.current = crypto.randomUUID()
    setQuery('')
    setResults([])
    setOrderId('')
    setOrderStatus(null)
    setQty({})
    setReason('damaged')
    setNotes('')
    setError(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      returnsApi
        .searchOrders(query, 20)
        .then((res) => {
          if (!cancelled) setResults(res.orders)
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query])

  useEffect(() => {
    if (!orderId) {
      setOrderStatus(null)
      return
    }
    let cancelled = false
    setLoadingOrder(true)
    returnsApi
      .orderStatus(orderId)
      .then((res) => {
        if (cancelled) return
        setOrderStatus(res)
        setQty(Object.fromEntries(res.lines.map((l) => [l.sku, 0])))
      })
      .catch((err) => {
        if (!cancelled) {
          setOrderStatus(null)
          setError(formatApiError(err, 'Could not load the returnable items'))
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingOrder(false)
      })
    return () => {
      cancelled = true
    }
  }, [orderId])

  const selected = results.find((o) => o.id === orderId)
  // A return's amounts live in the original order's currency; the ERP never
  // converts them, so everything in this dialog uses the order's symbol.
  const currency = orderStatus?.currency ?? selected?.currency ?? null
  const lines = orderStatus?.lines ?? EMPTY_LINES
  const chosen = useMemo(() => lines.filter((l) => (qty[l.sku] ?? 0) > 0), [lines, qty])
  const total = useMemo(
    () => chosen.reduce((sum, l) => sum + (qty[l.sku] ?? 0) * l.unitPrice, 0),
    [chosen, qty],
  )
  const invalid = chosen.some((l) => (qty[l.sku] ?? 0) > l.remaining)
  const dirty = Boolean(orderId) || Boolean(notes) || chosen.length > 0

  const submit = async () => {
    if (!orderId || chosen.length === 0) {
      setError('Select an order and at least one product quantity')
      return
    }
    if (invalid) {
      setError('A quantity is higher than what can still be returned')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await returnsApi.create({
        orderId,
        items: chosen.map((l) => ({ sku: l.sku, qty: qty[l.sku] ?? 0 })),
        reason,
        notes: notes.trim() || undefined,
        status: 'requested',
        idempotencyKey: idempotencyKey.current,
      })
      toast.success(`Return ${result.number} created`)
      onOpenChange(false)
      onCreated()
    } catch (err) {
      setError(formatApiError(err, 'Failed to create the return'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="New return"
      description="Pick an order, choose the products coming back, and record why."
      isDirty={dirty && !saving}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {error ? (
              <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">
                {chosen.length > 0
                  ? `${chosen.length} product${chosen.length > 1 ? 's' : ''} · ${formatCurrency(total, { currency })}`
                  : 'No products selected'}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving || chosen.length === 0 || invalid}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Create return
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Order</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by order number, customer or email…"
              className="pl-9"
            />
          </div>
          {selected ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-[12.5px]">
              <Badge variant="info">{selected.order}</Badge>
              <span className="font-medium text-foreground">{selected.customer || '—'}</span>
              <span className="text-muted-foreground">{selected.customerEmail ?? ''}</span>
              <span className="text-muted-foreground">· {formatDate(selected.date)}</span>
              <span className="text-muted-foreground">
                · {formatCurrency(selected.value, { currency: selected.currency })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-[12px]"
                onClick={() => {
                  setOrderId('')
                  setOrderStatus(null)
                  setQty({})
                }}
              >
                Change
              </Button>
            </div>
          ) : (
            <div className="max-h-56 overflow-y-auto rounded-md border">
              {searching ? (
                <div className="flex items-center justify-center gap-2 px-3 py-6 text-[13px] text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Searching orders…
                </div>
              ) : results.length === 0 ? (
                <div className="flex flex-col items-center gap-1 px-3 py-6 text-center text-[13px] text-muted-foreground">
                  <PackageSearch className="h-5 w-5" />
                  <p>No orders found{query ? ` for “${query}”` : ''}</p>
                </div>
              ) : (
                results.map((order) => (
                  <button
                    key={order.id}
                    type="button"
                    onClick={() => setOrderId(order.id)}
                    className="flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-[13px] transition-colors last:border-b-0 hover:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">{order.order}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {order.customer || '—'}
                        {order.customerEmail ? ` · ${order.customerEmail}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-medium tabular-nums">
                        {formatCurrency(order.value, { currency: order.currency })}
                      </span>
                      <span className="block text-[11.5px] text-muted-foreground">{formatDate(order.date)}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {loadingOrder ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading returnable items…
          </div>
        ) : orderStatus ? (
          <div className="space-y-2">
            {!orderStatus.anyReturnable ? (
              <p className="rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-[12.5px] text-warning-800">
                Every item on this order has already been returned.
              </p>
            ) : null}
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-[12.5px]">
                <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium">SKU</th>
                    <th className="px-3 py-2 text-right font-medium">Ordered</th>
                    <th className="px-3 py-2 text-right font-medium">Returned</th>
                    <th className="px-3 py-2 text-right font-medium">Return now</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    const value = qty[line.sku] ?? 0
                    const over = value > line.remaining
                    return (
                      <tr key={line.sku} className="border-t">
                        <td className="px-3 py-2 font-medium text-foreground">{line.product}</td>
                        <td className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{line.sku}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{line.ordered}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{line.returned}</td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min={0}
                            max={line.remaining}
                            value={value}
                            disabled={line.remaining === 0}
                            onChange={(e) =>
                              setQty((prev) => ({
                                ...prev,
                                [line.sku]: Math.max(0, Math.min(line.remaining, Math.floor(Number(e.target.value) || 0))),
                              }))
                            }
                            className={`ml-auto h-8 w-20 text-right ${over ? 'border-red-500' : ''}`}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              Stock is only added back when the goods are received and inspected — not when the return is created.
            </p>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Select
              value={reason}
              onValueChange={setReason}
              options={[
                { value: 'damaged', label: 'Damaged' },
                { value: 'wrong_item', label: 'Wrong item' },
                { value: 'not_as_described', label: 'Not as described' },
                { value: 'size_fit', label: 'Size / fit' },
                { value: 'quality', label: 'Quality issue' },
                { value: 'late_delivery', label: 'Late delivery' },
                { value: 'changed_mind', label: 'Changed mind' },
                { value: 'other', label: 'Other' },
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Internal notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </div>
        </div>
      </div>
    </AppDialog>
  )
}

export type { ReturnStatus }
