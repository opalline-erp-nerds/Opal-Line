import { useEffect, useRef, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { AppDialog } from '@/components/ui/app-dialog'
import { DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/confirm'
import { dbApi } from '@/lib/api'
import type { Invoice } from '@/types'

/**
 * Quantity-aware return dialog.
 *
 * Reads sold / previously returned / remaining from the backend's
 * return-status endpoint on open, so a partially returned invoice shows only
 * what is still returnable and the dialog is only openable again while
 * quantity remains. Submission carries an idempotency key generated per
 * dialog-open: a retry (network, double-click) replays the same credit note
 * and can never restock inventory twice.
 */
export function InvoiceReturnDialog({
  invoice,
  open,
  onOpenChange,
  onProcessed,
}: {
  invoice: Invoice | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a return lands; carries the derived invoice status. */
  onProcessed?: (opts: { returnStatus: Invoice['status'] | null; fullyReturned: boolean }) => void
}) {
  // Key lives for as long as the dialog stays open: refresh/reopen = new key,
  // retry of the same submission = same key.
  const idempotencyKey = useRef<string>('')

  const [qty, setQty] = useState<Record<string, number>>({})
  const [restock, setRestock] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [loadingLines, setLoadingLines] = useState(false)
  const [lines, setLines] = useState<Array<{ sku: string; product: string; sold: number; returned: number; remaining: number }>>([])

  // Programmatic opens (both parent pages call setReturnOpen(true) from a
  // button) never fire onOpenChange, so the load must key off `open` itself.
  // Deferred: React warns on synchronous setState inside an effect body.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) openReturnDialog()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { cancelled = true }
  }, [open])

  const openReturnDialog = (): void => {
    if (!invoice) return
    setQty({})
    setRestock(true)
    setLines([])
    idempotencyKey.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `ret-${invoice.id}-${Date.now()}`
    // Fetch the per-line truth (sold/returned/remaining) — the invoice row in
    // the list never knows how much of each line was already returned.
    setLoadingLines(true)
    dbApi.getInvoiceReturnStatus(invoice.id)
      .then((status) => setLines(status.lines))
      .catch(() => {
        // Fall back to the sold quantities from the invoice record so the
        // dialog still works when the status endpoint hiccups; the backend
        // still validates the request against prior returns.
        setLines((invoice.items ?? []).filter((it) => it.sku).map((it) => ({ sku: it.sku, product: it.product, sold: it.qty, returned: 0, remaining: it.qty })))
        toast.error('Could not load previous returns — checking sold quantities only')
      })
      .finally(() => setLoadingLines(false))
  }

  const anyReturnable = lines.some((l) => l.remaining > 0)
  const dirty = Object.values(qty).some((q) => q > 0)

  const pivotalLine = (sku: string, next: number) => {
    setQty((prev) => ({ ...prev, [sku]: Math.max(0, Math.min(next, lines.find((l) => l.sku === sku)?.remaining ?? 0)) }))
  }

  const submitReturn = async () => {
    if (!invoice) return
    const items = lines
      .map((l) => ({ sku: l.sku, qty: Math.min(qty[l.sku] ?? 0, l.remaining) }))
      .filter((it) => it.qty > 0)
    if (items.length === 0) {
      toast.error('Enter a return quantity of at least 1 for one of the lines.')
      return
    }
    setSubmitting(true)
    try {
      const r = await dbApi.createReturn(invoice.id, { items, restock, idempotencyKey: idempotencyKey.current })
      if (r.replayed) {
        toast.info(`Return already processed — credit note ${r.creditNoteNumber} remains unchanged.`)
      } else {
        toast.success(
          `Return processed — credit note ${r.creditNoteNumber}, ₹${r.amount.toLocaleString('en-IN')}${r.restocked ? ', items restocked' : ''}`,
        )
      }
      onOpenChange(false)
      onProcessed?.({ returnStatus: r.returnStatus ?? null, fullyReturned: r.returnStatus === 'fully_returned' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Return failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      isDirty={open && (dirty || restock)}
      title={
        <span className="flex items-center gap-2">
          <Undo2 className="h-4 w-4" /> Return items — {invoice?.number}
        </span>
      }
      description="Choose quantities to return against each line. A credit note is generated automatically and inventory only increases by what is actually returned."
      footer={
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={submitReturn} disabled={submitting || loadingLines || !anyReturnable}>
            {submitting ? 'Processing…' : 'Process return & credit note'}
          </Button>
        </DialogFooter>
      }
    >
      {loadingLines ? (
        <p className="py-6 text-center text-xs text-muted-foreground">Loading returnable quantities…</p>
      ) : (
        <div className="space-y-2">
          {lines.map((line) => {
            const disabled = line.remaining <= 0
            return (
              <div key={line.sku} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{line.product || line.sku}</p>
                  <p className="text-[11px] text-muted-foreground font-mono">
                    {line.sku} · sold {line.sold} · returned {line.returned} · remaining {line.remaining}
                  </p>
                </div>
                <Input
                  type="number"
                  min={0}
                  max={line.remaining}
                  value={qty[line.sku] ?? 0}
                  disabled={disabled}
                  onChange={(e) => pivotalLine(line.sku, Number(e.target.value) || 0)}
                  className="w-20"
                />
              </div>
            )
          })}
          <label className="flex items-center gap-2 pt-1 text-xs">
            <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
            Restock returned items into inventory
          </label>
          {!anyReturnable && (
            <p className="pt-1 text-xs text-muted-foreground">
              Every line has been fully returned — there is nothing left to return on this invoice.
            </p>
          )}
        </div>
      )}
    </AppDialog>
  )
}
