import { toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ColumnDef } from '@/lib/table'
import { Ban, CheckCircle2, FileDown, Search, Undo2, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { dbApi, backupApi } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/format'
import { loadReturns, type ReturnsStats } from '@/lib/returns'
import type { SalesReturn } from '@/types'

type ReturnStatusVariant = 'success' | 'warning' | 'muted'

interface ReturnStatusMeta {
  label: string
  variant: ReturnStatusVariant
}

const statusMeta: Record<string, ReturnStatusMeta> = {
  pending: { label: 'Pending', variant: 'warning' },
  approved: { label: 'Approved', variant: 'success' },
  processed: { label: 'Processed', variant: 'success' },
  refunded: { label: 'Refunded', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'muted' },
}

/**
 * Badge content for a return's status — never undefined.
 *
 * Credit notes raised by the invoice return workflow are stored with the
 * status `processed`, and the column itself is nullable, so a bare lookup used
 * to throw inside the table cell ("Cannot read properties of undefined (reading
 * 'variant')") and drop the whole page into the error boundary. Unknown values
 * now render as themselves instead of taking the list down with them.
 */
function returnStatusMeta(status: string | null | undefined): ReturnStatusMeta {
  const key = String(status ?? '').trim().toLowerCase()
  return statusMeta[key] ?? { label: status ? String(status) : 'Unknown', variant: 'muted' }
}

type ReturnStatusChange = (id: string, status: 'approved' | 'rejected' | 'refunded') => void

/** The table columns, built once and reused by every render of the list. */
function returnsColumns(onStatusChange?: ReturnStatusChange): ColumnDef<SalesReturn>[] {
  return [
    {
      accessorKey: 'number',
      header: 'Return Number',
      cell: ({ row }) => (
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-warning-50 text-warning-700">
            <Undo2 className="h-4 w-4" />
          </div>
          <div>
            <p className="font-medium text-foreground">{row.original.number}</p>
            <p className="text-[11px] text-muted-foreground">{formatDate(row.original.date)}</p>
          </div>
        </div>
      ),
    },
    { accessorKey: 'order', header: 'Shopify Order', cell: ({ row }) => <span className="font-mono text-[12.5px] text-muted-foreground">{row.original.order}</span> },
    { accessorKey: 'customer', header: 'Customer', cell: ({ row }) => <span className="font-medium text-foreground">{row.original.customer}</span> },
    {
      accessorKey: 'amount',
      header: 'Refund Amount',
      meta: { align: 'right' as const },
      cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.amount)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      meta: { align: 'center' as const },
      cell: ({ row }) => {
        const s = returnStatusMeta(row.original.status)
        return <Badge variant={s.variant} dot>{s.label}</Badge>
      },
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
                <Button variant="ghost" size="icon-sm" onClick={() => backupApi.downloadCreditNotePDF(row.original.id)}>
                  <FileDown className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Credit note PDF</TooltipContent>
            </Tooltip>
            {row.original.status === 'pending' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => onStatusChange?.(row.original.id, 'approved')}>
                    <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Approve return</TooltipContent>
              </Tooltip>
            )}
            {row.original.status === 'pending' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => onStatusChange?.(row.original.id, 'rejected')}>
                    <Ban className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reject return</TooltipContent>
              </Tooltip>
            )}
            {row.original.status === 'approved' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => onStatusChange?.(row.original.id, 'refunded')}>
                    <Wallet className="h-3.5 w-3.5 text-warning-600" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Process refund via Razorpay</TooltipContent>
              </Tooltip>
            )}
          </TooltipProvider>
        </div>
      ),
    },
  ]
}

interface ReturnsViewProps {
  returns: SalesReturn[]
  loading: boolean
  /** Set when the list could not be fetched — the table stays empty but says why. */
  error: string | null
  stats: ReturnsStats | null
  onStatusChange: ReturnStatusChange
}

/** The page body. Pure on purpose: every state (data / empty / failed) renders without hooks of its own beyond search. */
export function ReturnsView({ returns, loading, error, stats, onStatusChange }: ReturnsViewProps) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return returns
    return returns.filter(
      (r) =>
        String(r.id ?? '').toLowerCase().includes(q) ||
        String(r.customer ?? '').toLowerCase().includes(q) ||
        String(r.number ?? '').toLowerCase().includes(q) ||
        String(r.order ?? '').toLowerCase().includes(q) ||
        String(r.status ?? '').toLowerCase().includes(q),
    )
  }, [returns, query])

  const columns = useMemo(() => returnsColumns(onStatusChange), [onStatusChange])

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Sales Returns"
        subtitle="Returns requested against Shopify orders — approve and refund through Razorpay."
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniCard label="Total Returns" value={stats ? String(stats.total) : '—'} sub="All returns" tint="text-primary-700" />
        <MiniCard
          label="Pending Approval"
          value={stats ? String(stats.pending) : '—'}
          sub={stats ? `${formatCurrency(stats.pendingAmount)} pending` : '—'}
          tint="text-warning-700"
        />
        <MiniCard
          label="Refunded"
          value={stats ? String(stats.refunded) : '—'}
          sub={stats ? `${formatCurrency(stats.refundedAmount)} refunded` : '—'}
          tint="text-success-700"
        />
        <MiniCard
          label="Return Rate"
          value={stats ? `${stats.rate.toFixed(2)}%` : '—'}
          sub="Returns vs invoices"
          tint="text-info-700"
        />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="relative min-w-[240px] max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search return, order, customer..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage={error ? '—' : 'No returns found'}
          />
        </CardContent>
      </Card>
    </div>
  )
}

export default function ReturnsPage() {
  const [returns, setReturns] = useState<SalesReturn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<ReturnsStats | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    loadReturns()
      .then((res) => {
        setReturns(res.returns)
        setStats(res.stats)
        setError(res.error)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  const setReturnStatus = useCallback<ReturnStatusChange>(async (id, status) => {
    try {
      await dbApi.update('sales-returns', id, { status })
      setReturns((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    }
  }, [])

  return (
    <ReturnsView
      returns={returns}
      loading={loading}
      error={error}
      stats={stats}
      onStatusChange={setReturnStatus}
    />
  )
}

function MiniCard({ label, value, sub, tint }: { label: string; value: string; sub?: string; tint: string }) {
  return (
    <Card className="p-3 sm:p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tint}`}>{value}</p>
      {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
    </Card>
  )
}
