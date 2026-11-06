import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CreditCard, Loader2, Search } from 'lucide-react'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/confirm'
import { formatApiError } from '@/lib/api/core'
import { refundsApi, returnsApi, type OrderSearchRow, type RefundPreview, type RefundableOrder } from '@/lib/api/returns'
import { formatCurrency } from '@/lib/format'

/**
 * Refund an order through Shopify.
 *
 * The amounts shown come from Shopify's own `suggestedRefund`, not from
 * `price × quantity`, and the refund is only reported as done once Shopify
 * returns a refund id — if the gateway rejects it, the dialog says so and the
 * refund is stored as failed so it can be retried.
 */
export function CreateRefundDialog({
  open,
  onOpenChange,
  onCreated,
  initialOrder,
  returnId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  /** Pre-select an order (from a return row). */
  initialOrder?: string | null
  returnId?: string | null
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<OrderSearchRow[]>([])
  const [searching, setSearching] = useState(false)
  const [orderName, setOrderName] = useState('')
  const [refundable, setRefundable] = useState<RefundableOrder | null>(null)
  const [qty, setQty] = useState<Record<string, number>>({})
  const [shipping, setShipping] = useState('0')
  const [note, setNote] = useState('')
  const [notify, setNotify] = useState(false)
  const [preview, setPreview] = useState<RefundPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idempotencyKey = useRef<string>(crypto.randomUUID())

  const reset = () => {
    setQuery('')
    setResults([])
    setOrderName('')
    setRefundable(null)
    setQty({})
    setShipping('0')
    setNote('')
    setNotify(false)
    setPreview(null)
    setError(null)
  }

  useEffect(() => {
    if (!open) return
    reset()
    idempotencyKey.current = crypto.randomUUID()
    if (initialOrder) setOrderName(initialOrder)
  }, [open, initialOrder])

  // Order search (only orders that exist on Shopify can be refunded there).
  useEffect(() => {
    if (!open || orderName) return
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      returnsApi
        .searchOrders(query, 20)
        .then((res) => {
          if (!cancelled) setResults(res.orders.filter((o) => o.shopifyOrder))
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
  }, [open, query, orderName])

  // Live refundable state straight from Shopify.
  useEffect(() => {
    if (!open || !orderName) return
    let cancelled = false
    setLoading(true)
    setError(null)
    refundsApi
      .refundable(orderName)
      .then((order) => {
        if (cancelled) return
        setRefundable(order)
        setQty(Object.fromEntries(order.lines.map((l) => [l.lineItemId, 0])))
      })
      .catch((err) => {
        if (!cancelled) {
          setRefundable(null)
          setError(formatApiError(err, 'Could not read the refundable amount from Shopify'))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, orderName])

  const chosen = useMemo(
    () => (refundable?.lines ?? []).filter((l) => (qty[l.lineItemId] ?? 0) > 0),
    [refundable, qty],
  )

  // Ask Shopify what this selection is actually worth (discounts + taxes).
  useEffect(() => {
    if (!open || !orderName || chosen.length === 0) {
      setPreview(null)
      return
    }
    let cancelled = false
    setPreviewing(true)
    const timer = window.setTimeout(() => {
      refundsApi
        .preview({
          orderName,
          items: chosen.map((l) => ({ lineItemId: l.lineItemId, quantity: qty[l.lineItemId] ?? 0 })),
          shippingAmount: Math.max(0, Number(shipping) || 0),
        })
        .then((res) => {
          if (!cancelled) {
            setPreview(res)
            setError(null)
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setPreview(null)
            setError(formatApiError(err, 'Could not preview the refund'))
          }
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false)
        })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, orderName, chosen, qty, shipping])

  const submit = async () => {
    if (!orderName || chosen.length === 0) {
      setError('Select at least one product to refund')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await refundsApi.create({
        orderName,
        items: chosen.map((l) => ({ lineItemId: l.lineItemId, quantity: qty[l.lineItemId] ?? 0 })),
        shippingAmount: Math.max(0, Number(shipping) || 0),
        note: note.trim() || undefined,
        notify,
        returnId: returnId ?? undefined,
        idempotencyKey: idempotencyKey.current,
      })
      if (!result.ok) {
        setError(result.error ?? 'Shopify did not confirm the refund')
        toast.error(result.error ?? 'Shopify did not confirm the refund')
        onCreated()
        return
      }
      toast.success(
        `${formatCurrency(result.amount ?? 0, { currency: result.currency ?? refundable?.currency })} refunded${
          result.status === 'pending' ? ' (pending at the gateway)' : ''
        }`,
      )
      onOpenChange(false)
      onCreated()
    } catch (err) {
      setError(formatApiError(err, 'Failed to create the refund'))
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = Boolean(orderName) && chosen.length > 0 && Boolean(preview) && !submitting && !previewing

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="New refund"
      description="Refund through Shopify. The amount is calculated by Shopify, including discounts and taxes."
      isDirty={Boolean(orderName) && !submitting}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {error ? (
              <p className="text-[12.5px] text-red-600 dark:text-red-400">{error}</p>
            ) : previewing ? (
              <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking with Shopify…
              </p>
            ) : preview ? (
              <p className="text-[12.5px] text-muted-foreground">
                Refund{' '}
                <span className="font-semibold text-foreground">
                  {formatCurrency(preview.totalAmount, { currency: preview.currency })}
                </span>{' '}
                via{' '}
                {preview.suggested[0]?.gateway ?? 'the original payment method'}
              </p>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">Pick products to see the refund amount</p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CreditCard className="mr-1.5 h-4 w-4" />}
              Refund {preview ? formatCurrency(preview.totalAmount, { currency: preview.currency }) : ''}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Order</Label>
          {orderName ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-[12.5px]">
              <Badge variant="info">{orderName}</Badge>
              {refundable ? (
                <>
                  <span className="text-muted-foreground">
                    {refundable.financialStatus || '—'} · {refundable.paymentMethod ?? 'no payment on file'}
                  </span>
                  <span className="ml-auto text-muted-foreground">
                    Refundable{' '}
                    {formatCurrency(refundable.totalPrice - refundable.totalRefunded, {
                      decimals: true,
                      currency: refundable.currency,
                    })}
                  </span>
                </>
              ) : null}
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" onClick={reset} disabled={submitting}>
                Change
              </Button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search a Shopify order number, customer or email…"
                  className="pl-9"
                />
              </div>
              <div className="max-h-48 overflow-y-auto rounded-md border">
                {searching ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-6 text-[13px] text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Searching…
                  </div>
                ) : results.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">No Shopify orders found</p>
                ) : (
                  results.map((order) => (
                    <button
                      key={order.id}
                      type="button"
                      onClick={() => setOrderName(order.shopifyOrder ?? '')}
                      className="flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-[13px] transition-colors last:border-b-0 hover:bg-muted/60"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">{order.order}</span>
                        <span className="block truncate text-[11.5px] text-muted-foreground">{order.customer || '—'}</span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatCurrency(order.value, { currency: order.currency })}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading refundable items from Shopify…
          </div>
        ) : refundable ? (
          <div className="space-y-2">
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-[12.5px]">
                <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium">SKU</th>
                    <th className="px-3 py-2 text-right font-medium">Refundable</th>
                    <th className="px-3 py-2 text-right font-medium">Unit price</th>
                    <th className="px-3 py-2 text-right font-medium">Refund qty</th>
                  </tr>
                </thead>
                <tbody>
                  {refundable.lines.map((line) => {
                    const left = line.refundableQuantity - (qty[line.lineItemId] ?? 0)
                    return (
                      <tr key={line.lineItemId} className="border-t">
                        <td className="px-3 py-2 font-medium text-foreground">{line.name}</td>
                        <td className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{line.sku || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className={line.refundableQuantity === 0 ? 'text-muted-foreground' : ''}>
                            {line.refundableQuantity}
                          </span>
                          <span className="ml-1 text-[11px] text-muted-foreground">of {line.quantity}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {formatCurrency(line.unitPrice, { decimals: true, currency: line.currency })}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min={0}
                            max={line.refundableQuantity}
                            value={qty[line.lineItemId] ?? 0}
                            disabled={line.refundableQuantity === 0 || submitting}
                            onChange={(e) =>
                              setQty((prev) => ({
                                ...prev,
                                [line.lineItemId]: Math.max(
                                  0,
                                  Math.min(line.refundableQuantity, Math.floor(Number(e.target.value) || 0)),
                                ),
                              }))
                            }
                            className="ml-auto h-8 w-20 text-right"
                          />
                          {left < 0 ? <span className="text-[11px] text-red-500">too many</span> : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              Stock is not increased by a refund — it only changes when the returned goods are received in the Returns tab.
            </p>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Shipping to refund</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={shipping}
              onChange={(e) => setShipping(e.target.value)}
              disabled={!refundable || submitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Note (visible in Shopify)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" disabled={submitting} />
          </div>
        </div>

        <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            disabled={submitting}
            className="h-3.5 w-3.5"
          />
          Email the customer about this refund
        </label>

        {preview ? (
          <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5 text-[12.5px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Products (incl. tax &amp; discounts)</span>
              <span className="tabular-nums">
                {formatCurrency(preview.itemsAmount, { decimals: true, currency: preview.currency })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Shipping</span>
              <span className="tabular-nums">
                {formatCurrency(preview.shippingAmount, { decimals: true, currency: preview.currency })}
              </span>
            </div>
            <div className="flex justify-between border-t pt-1.5 font-semibold">
              <span>Total refund</span>
              <span className="tabular-nums">
                {formatCurrency(preview.totalAmount, { decimals: true, currency: preview.currency })}
              </span>
            </div>
            <div className="flex justify-between text-[11.5px] text-muted-foreground">
              <span>Still refundable on this order</span>
              <span className="tabular-nums">
                {formatCurrency(preview.maximumRefundable, { decimals: true, currency: preview.currency })}
              </span>
            </div>
            {preview.warnings.map((warning) => (
              <p key={warning} className="flex items-start gap-1.5 text-[11.5px] text-warning-800 dark:text-warning-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {warning}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </AppDialog>
  )
}
