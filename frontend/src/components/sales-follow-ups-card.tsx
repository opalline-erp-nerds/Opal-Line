import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, BellRing, CheckCircle2, Clock, RefreshCw, ShoppingBag } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { dbApi } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/format'
import type { SalesFollowUp, SalesFollowUpSummary } from '@/types'

const KIND_META: Record<
  SalesFollowUp['kind'],
  { icon: typeof Clock; label: string; dot: string; tint: string }
> = {
  'quotation-expiring': { icon: AlertTriangle, label: 'Lapsing', dot: 'bg-red-500', tint: 'text-red-600 dark:text-red-400' },
  'booking-advance': { icon: BellRing, label: 'Advance due', dot: 'bg-amber-500', tint: 'text-amber-600 dark:text-amber-400' },
  quotation: { icon: Clock, label: 'Quotation', dot: 'bg-primary-500', tint: 'text-primary-700 dark:text-primary-300' },
  order: { icon: ShoppingBag, label: 'Order', dot: 'bg-sky-500', tint: 'text-sky-600 dark:text-sky-400' },
  booking: { icon: ShoppingBag, label: 'Booking', dot: 'bg-primary-500', tint: 'text-primary-600 dark:text-primary-400' },
}

interface SalesFollowUpsCardProps {
  /** Scope the list to a single customer (customer 360). */
  customer?: string
  title?: string
  className?: string
}

/**
 * "What needs chasing?" — quotations awaiting a decision (and about to lapse),
 * pipeline orders that haven't moved, and bookings still to be fulfilled.
 */
export function SalesFollowUpsCard({ customer, title = 'Follow-ups', className }: SalesFollowUpsCardProps) {
  const [followUps, setFollowUps] = useState<SalesFollowUp[]>([])
  const [summary, setSummary] = useState<SalesFollowUpSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await dbApi.getSalesFollowUps(customer)
      setFollowUps(res.followUps ?? [])
      setSummary(res.summary ?? null)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load follow-ups')
    } finally {
      setLoading(false)
    }
  }, [customer])

  useEffect(() => {
    // Defer the first load out of the effect body (react/set-state-in-effect).
    queueMicrotask(() => {
      void load()
    })
  }, [load])

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <BellRing className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm">{title}</CardTitle>
          {summary && summary.total > 0 ? (
            <Badge variant="warning" className="text-[10px]">
              {summary.total} due
            </Badge>
          ) : null}
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => void load()} aria-label="Refresh follow-ups">
          <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="py-3 text-center text-[13px] text-muted-foreground">{error}</p>
        ) : loading && followUps.length === 0 ? (
          <p className="py-3 text-center text-[13px] text-muted-foreground">Loading follow-ups…</p>
        ) : followUps.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="Nothing to chase"
            description={
              customer
                ? 'No open quotations, orders or bookings for this customer.'
                : 'Every quotation has been actioned and no order is stuck in the pipeline.'
            }
          />
        ) : (
          <>
            {summary && (summary.quotations > 0 || summary.expiring > 0) ? (
              <p className="text-[11px] text-muted-foreground">
                {summary.quotations} quotation{summary.quotations === 1 ? '' : 's'} awaiting a decision
                {summary.expiring > 0 ? ` · ${summary.expiring} lapsing soon` : ''}
              </p>
            ) : null}
            <ul className="divide-y">
              {followUps.slice(0, 12).map((f) => {
                const meta = KIND_META[f.kind] ?? KIND_META.quotation
                const Icon = meta.icon
                return (
                  <li key={`${f.kind}-${f.id}`} className="flex items-start gap-2.5 py-2">
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.tint}`} />
                        <span className="truncate text-[13px] font-medium text-foreground">
                          {f.customer ?? 'Walk-in'}
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground">{f.reference}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">{f.detail}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      {f.value > 0 ? (
                        <p className="text-[12px] font-semibold tabular-nums text-foreground">
                          {formatCurrency(f.value)}
                        </p>
                      ) : null}
                      {f.dueAt ? (
                        <p className="text-[10.5px] text-muted-foreground">till {formatDate(f.dueAt)}</p>
                      ) : null}
                      <Link
                        to={f.href}
                        className="text-[11px] font-medium text-primary-700 hover:underline dark:text-primary-300"
                      >
                        Open
                      </Link>
                    </div>
                  </li>
                )
              })}
            </ul>
            {followUps.length > 12 ? (
              <p className="text-[11px] text-muted-foreground">+ {followUps.length - 12} more</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}