import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ColumnDef } from '@/lib/table'
import {
  ArrowDownToLine,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  CreditCard,
  FileDown,
  Loader2,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Search,
  Truck,
  Undo2,
  Wallet,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { DataTable } from '@/components/ui/data-table'
import { AppDialog } from '@/components/ui/app-dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from '@/components/ui/confirm'
import { backupApi } from '@/lib/api'
import { formatApiError } from '@/lib/api/core'
import type { ReturnsStats } from '@/lib/returns'
import type { SalesReturn } from '@/types'
import {
  refundsApi,
  returnsApi,
  type CurrencyTotal,
  type RefundRow,
  type ReturnDetail,
  type ReturnListRow,
  type ReturnStatus,
  type ReturnsOverview,
} from '@/lib/api/returns'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'
import { CreateReturnDialog } from '@/components/returns/create-return-dialog'
import { CreateRefundDialog } from '@/components/returns/create-refund-dialog'

type BadgeVariant = NonNullable<BadgeProps['variant']>

const RETURN_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  requested: { label: 'Requested', variant: 'warning' },
  approved: { label: 'Approved', variant: 'info' },
  in_transit: { label: 'In transit', variant: 'info' },
  received: { label: 'Received', variant: 'purple' },
  completed: { label: 'Completed', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'muted' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
  // Credit notes raised by the older invoice-return flow: goods came back and
  // were credited, so they read as completed history rather than disappearing.
  processed: { label: 'Completed (credit note)', variant: 'success' },
}

const REFUND_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  pending: { label: 'Pending', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
  none: { label: 'No refund', variant: 'muted' },
}

/** Aggregated return↔refund state, e.g. `completed+pending`. */
function refundStatusBadge(status: string) {
  const parts = String(status || 'none').split('+')
  return (
    <div className="flex flex-wrap gap-1">
      {parts.map((part) => {
        const meta = REFUND_STATUS[part] ?? REFUND_STATUS.none
        return (
          <Badge key={part} variant={meta.variant} dot>
            {meta.label}
          </Badge>
        )
      })}
    </div>
  )
}

function ReturnStatusBadge({ status }: { status: string }) {
  const meta = RETURN_STATUS[status] ?? { label: status || 'Unknown', variant: 'muted' as BadgeVariant }
  return (
    <Badge variant={meta.variant} dot>
      {meta.label}
    </Badge>
  )
}

function productsLabel(items: Array<{ sku: string; qty: number }>): string {
  if (!items.length) return '—'
  return items.map((it) => `${it.qty}× ${it.sku}`).join(', ')
}

/**
 * Total of a per-currency breakdown, in each currency's own symbol.
 *
 * Rupees and dollars are never added together — without an exchange rate that
 * would be a wrong number, so a mixed ledger is shown as `₹1,200 + $340`.
 */
function totalsByCurrency(totals: CurrencyTotal[] | undefined, field: 'amount' | 'refunded' | 'pending' | 'failed'): string {
  // Nothing recorded yet: a bare 0, because no currency has been seen and a
  // rupee sign would be a guess on a store that may sell in dollars.
  if (!totals || totals.length === 0) return '0'
  const nonZero = totals.filter((t) => Math.abs(Number(t[field] ?? 0)) > 0.004)
  const shown = nonZero.length > 0 ? nonZero : totals.slice(0, 1)
  return shown.map((t) => formatCurrency(Number(t[field] ?? 0), { currency: t.currency })).join(' + ')
}

export default function ReturnsPage() {
  const [tab, setTab] = useState('returns')
  const [overview, setOverview] = useState<ReturnsOverview | null>(null)

  const [returns, setReturns] = useState<ReturnListRow[]>([])
  const [returnsLoading, setReturnsLoading] = useState(true)
  const [returnsError, setReturnsError] = useState<string | null>(null)
  const [returnsTotal, setReturnsTotal] = useState(0)
  const [returnsPage, setReturnsPage] = useState(1)
  const [returnSearch, setReturnSearch] = useState('')
  const [returnStatus, setReturnStatus] = useState('all')
  const [returnFrom, setReturnFrom] = useState('')
  const [returnTo, setReturnTo] = useState('')

  const [refunds, setRefunds] = useState<RefundRow[]>([])
  const [refundsLoading, setRefundsLoading] = useState(true)
  const [refundsError, setRefundsError] = useState<string | null>(null)
  const [refundsTotal, setRefundsTotal] = useState(0)
  const [refundsPage, setRefundsPage] = useState(1)
  const [refundSearch, setRefundSearch] = useState('')
  const [refundStatus, setRefundStatus] = useState('all')
  const [refundSource, setRefundSource] = useState('all')
  const [refundFrom, setRefundFrom] = useState('')
  const [refundTo, setRefundTo] = useState('')

  const [createReturnOpen, setCreateReturnOpen] = useState(false)
  const [createRefundOpen, setCreateRefundOpen] = useState(false)
  const [refundSeed, setRefundSeed] = useState<{ order: string; returnId?: string } | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ReturnDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [receiving, setReceiving] = useState<Record<string, { received: number; accepted: number; damaged: number }>>({})
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refundDetail, setRefundDetail] = useState<RefundRow | null>(null)
  const [refundEvents, setRefundEvents] = useState<Array<{ id: string; action: string; status: string; message: string | null; createdAt: string | null }>>([])
  const limit = 25

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await returnsApi.overview())
    } catch {
      setOverview(null)
    }
  }, [])

  const loadReturns = useCallback(async () => {
    setReturnsLoading(true)
    setReturnsError(null)
    try {
      const res = await returnsApi.list({
        search: returnSearch.trim() || undefined,
        status: returnStatus === 'all' ? undefined : returnStatus,
        from: returnFrom || undefined,
        to: returnTo || undefined,
        page: returnsPage,
        limit,
      })
      setReturns(res.returns)
      setReturnsTotal(res.pagination.total)
    } catch (err) {
      setReturns([])
      setReturnsError(formatApiError(err, 'Failed to load returns'))
    } finally {
      setReturnsLoading(false)
    }
  }, [returnSearch, returnStatus, returnFrom, returnTo, returnsPage])

  const loadRefunds = useCallback(async () => {
    setRefundsLoading(true)
    setRefundsError(null)
    try {
      const res = await refundsApi.list({
        search: refundSearch.trim() || undefined,
        status: refundStatus === 'all' ? undefined : refundStatus,
        source: refundSource === 'all' ? undefined : refundSource,
        from: refundFrom || undefined,
        to: refundTo || undefined,
        page: refundsPage,
        limit,
      })
      setRefunds(res.refunds)
      setRefundsTotal(res.pagination.total)
    } catch (err) {
      setRefunds([])
      setRefundsError(formatApiError(err, 'Failed to load refunds'))
    } finally {
      setRefundsLoading(false)
    }
  }, [refundSearch, refundStatus, refundSource, refundFrom, refundTo, refundsPage])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadReturns(), 200)
    return () => window.clearTimeout(timer)
  }, [loadReturns])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRefunds(), 200)
    return () => window.clearTimeout(timer)
  }, [loadRefunds])

  const refreshAll = useCallback(() => {
    void loadOverview()
    void loadReturns()
    void loadRefunds()
  }, [loadOverview, loadReturns, loadRefunds])

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id)
    setDetail(null)
    setDetailLoading(true)
    try {
      const res = await returnsApi.detail(id)
      setDetail(res)
      setReceiving(
        Object.fromEntries(
          res.items.map((item) => {
            const received = item.received?.received ?? item.quantity
            const damaged = item.received?.damaged ?? 0
            return [item.sku, { received, accepted: Math.max(0, received - damaged), damaged }]
          }),
        ),
      )
    } catch (err) {
      toast.error(formatApiError(err, 'Failed to load the return'))
      setDetailId(null)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const changeStatus = async (id: string, status: ReturnStatus, inspection?: Array<{ sku: string; received: number; accepted: number; damaged: number }>) => {
    setBusy(true)
    try {
      const res = await returnsApi.setStatus(id, status, inspection ? { inspection } : {})
      toast.success(
        status === 'received'
          ? res.restocked > 0
            ? `Received — ${res.restocked} unit(s) restocked`
            : 'Received — nothing was restockable'
          : `Return marked ${status.replace('_', ' ')}`,
      )
      // The ERP ledger is already committed at this point; Shopify lagging is
      // surfaced instead of being silently swallowed, and the stock screen's
      // own "push to Shopify" action can be used to retry.
      if (res.inventory && !res.inventory.ok) {
        toast.error(
          `Stock updated in the ERP, but Shopify was not synced: ${res.inventory.errors[0] ?? res.inventory.message ?? 'push failed'}`,
        )
      } else if (res.inventory && res.inventory.ok && res.inventory.updated > 0) {
        toast.success(`Shopify stock updated for ${res.inventory.updated} product(s)`)
      }
      setReceiveOpen(false)
      await openDetail(id)
      refreshAll()
    } catch (err) {
      toast.error(formatApiError(err, 'Failed to update the return'))
    } finally {
      setBusy(false)
    }
  }

  const syncRefund = async (orderName: string) => {
    setBusy(true)
    try {
      const res = await refundsApi.sync(orderName)
      toast.success(`${orderName}: ${res.imported} new, ${res.updated} refreshed`)
      refreshAll()
    } catch (err) {
      toast.error(formatApiError(err, 'Failed to sync refunds from Shopify'))
    } finally {
      setBusy(false)
    }
  }

  const retryRefund = async (id: string) => {
    setBusy(true)
    try {
      const res = await refundsApi.retry(id)
      if (res.ok) {
        toast.success(`${formatCurrency(res.amount ?? 0, { currency: res.currency })} refunded through Shopify`)
      } else toast.error(res.error ?? 'Shopify did not confirm the refund')
      refreshAll()
    } catch (err) {
      toast.error(formatApiError(err, 'Failed to retry the refund'))
    } finally {
      setBusy(false)
    }
  }

  const openRefundDetail = async (row: RefundRow) => {
    setRefundDetail(row)
    setRefundEvents([])
    try {
      const res = await refundsApi.detail(row.id)
      setRefundEvents(res.events)
    } catch {
      /* detail is already shown from the list row */
    }
  }

  const returnColumns = useMemo<ColumnDef<ReturnListRow>[]>(
    () => [
      {
        accessorKey: 'number',
        header: 'Return',
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
      {
        accessorKey: 'order',
        header: 'Shopify order',
        cell: ({ row }) => <span className="font-mono text-[12.5px] text-muted-foreground">{row.original.order ?? '—'}</span>,
      },
      {
        accessorKey: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{row.original.customer || '—'}</p>
            <p className="truncate text-[11px] text-muted-foreground">{row.original.customerEmail ?? ''}</p>
          </div>
        ),
      },
      {
        id: 'products',
        header: 'Products',
        cell: ({ row }) => (
          <span className="text-[12.5px] text-muted-foreground">{productsLabel(row.original.products)}</span>
        ),
      },
      {
        id: 'qty',
        header: 'Qty',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums">{row.original.itemsCount}</span>,
      },
      {
        accessorKey: 'reason',
        header: 'Reason',
        cell: ({ row }) => (
          <span className="text-[12.5px] capitalize text-muted-foreground">
            {row.original.reason ? row.original.reason.replace(/_/g, ' ') : '—'}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Return status',
        meta: { align: 'center' as const },
        cell: ({ row }) => <ReturnStatusBadge status={row.original.status} />,
      },
      {
        id: 'refundStatus',
        header: 'Refund',
        meta: { align: 'center' as const },
        cell: ({ row }) => refundStatusBadge(row.original.refundStatus),
      },
      {
        id: 'refundAmount',
        header: 'Refund amount',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className="font-semibold tabular-nums text-foreground">
            {row.original.refundAmount > 0
              ? formatCurrency(row.original.refundAmount, { currency: row.original.currency })
              : '—'}
          </span>
        ),
      },
    ],
    [],
  )

  const refundColumns = useMemo<ColumnDef<RefundRow>[]>(
    () => [
      {
        accessorKey: 'number',
        header: 'Refund',
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-success-50 text-success-700">
              <Wallet className="h-4 w-4" />
            </div>
            <div>
              <p className="font-medium text-foreground">{row.original.number}</p>
              <p className="text-[11px] text-muted-foreground">{formatDate(row.original.date)}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'order',
        header: 'Shopify order',
        cell: ({ row }) => <span className="font-mono text-[12.5px] text-muted-foreground">{row.original.order ?? '—'}</span>,
      },
      {
        accessorKey: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{row.original.customer || '—'}</p>
            <p className="truncate text-[11px] text-muted-foreground">{row.original.customerEmail ?? ''}</p>
          </div>
        ),
      },
      {
        id: 'products',
        header: 'Products',
        cell: ({ row }) =>
          row.original.items.length === 0 ? (
            <span className="text-[12.5px] text-muted-foreground">—</span>
          ) : (
            <span className="text-[12.5px] text-muted-foreground">
              {row.original.items.map((item) => `${item.quantity}× ${item.sku || item.product}`).join(', ')}
            </span>
          ),
      },
      {
        accessorKey: 'amount',
        header: 'Refund amount',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <div className="text-right">
            <p className="font-semibold tabular-nums text-foreground">
              {formatCurrency(row.original.amount, { currency: row.original.currency })}
            </p>
            {/* Amounts in different currencies are not comparable: a refund in the
                customer's presentment currency is only "partial" of an order
                total that is held in the same currency. */}
            {row.original.orderValue > 0 &&
            (!row.original.orderCurrency || row.original.orderCurrency === row.original.currency) &&
            row.original.amount < row.original.orderValue - 0.01 ? (
              <p className="text-[11px] text-muted-foreground">
                partial of {formatCurrency(row.original.orderValue, { currency: row.original.orderCurrency ?? row.original.currency })}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'paymentMethod',
        header: 'Payment method',
        cell: ({ row }) => (
          <span className="text-[12.5px] capitalize text-muted-foreground">{row.original.paymentMethod ?? '—'}</span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const meta = REFUND_STATUS[row.original.status] ?? REFUND_STATUS.pending
          return (
            <Badge variant={meta.variant} dot>
              {meta.label}
            </Badge>
          )
        },
      },
      {
        id: 'source',
        header: 'Source',
        meta: { align: 'center' as const },
        cell: ({ row }) => (
          <Badge variant={row.original.source === 'shopify' ? 'purple' : 'outline'}>
            {row.original.source === 'shopify' ? 'Shopify' : 'ERP'}
          </Badge>
        ),
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
                  <Button variant="ghost" size="icon-sm" onClick={() => void openRefundDetail(row.original)}>
                    <Search className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refund details</TooltipContent>
              </Tooltip>
              {row.original.order ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      onClick={() => void syncRefund(row.original.order as string)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Re-sync this order's refunds from Shopify</TooltipContent>
                </Tooltip>
              ) : null}
              {row.original.status === 'failed' && row.original.source === 'erp' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" disabled={busy} onClick={() => void retryRefund(row.original.id)}>
                      <RotateCcw className="h-3.5 w-3.5 text-warning-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Retry this failed refund</TooltipContent>
                </Tooltip>
              ) : null}
            </TooltipProvider>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy],
  )

  const detailActions = (row: ReturnDetail) => {
    const buttons: Array<{ label: string; icon: ReactNode; run: () => void; variant?: 'default' | 'outline' | 'ghost' }> = []
    if (row.status === 'requested') {
      buttons.push({ label: 'Approve', icon: <CheckCircle2 className="h-4 w-4" />, run: () => void changeStatus(row.id, 'approved') })
      buttons.push({ label: 'Reject', icon: <Ban className="h-4 w-4" />, run: () => void changeStatus(row.id, 'rejected'), variant: 'outline' })
    } else if (row.status === 'approved') {
      buttons.push({ label: 'In transit', icon: <Truck className="h-4 w-4" />, run: () => void changeStatus(row.id, 'in_transit'), variant: 'outline' })
      buttons.push({
        label: 'Receive goods',
        icon: <ArrowDownToLine className="h-4 w-4" />,
        run: () => {
          setReceiveOpen(true)
        },
      })
      buttons.push({ label: 'Reject', icon: <Ban className="h-4 w-4" />, run: () => void changeStatus(row.id, 'rejected'), variant: 'outline' })
    } else if (row.status === 'in_transit') {
      buttons.push({ label: 'Receive goods', icon: <ArrowDownToLine className="h-4 w-4" />, run: () => setReceiveOpen(true) })
      buttons.push({ label: 'Reject', icon: <Ban className="h-4 w-4" />, run: () => void changeStatus(row.id, 'rejected'), variant: 'outline' })
    } else if (row.status === 'received') {
      buttons.push({ label: 'Complete', icon: <PackageCheck className="h-4 w-4" />, run: () => void changeStatus(row.id, 'completed') })
      buttons.push({
        label: 'Reject & undo restock',
        icon: <RotateCcw className="h-4 w-4" />,
        run: () => void changeStatus(row.id, 'rejected'),
        variant: 'outline',
      })
    }
    if (row.order && row.status !== 'rejected') {
      buttons.push({
        label: 'Refund',
        icon: <CreditCard className="h-4 w-4" />,
        run: () => {
          setRefundSeed({ order: row.order as string, returnId: row.id })
          setCreateRefundOpen(true)
        },
        variant: 'outline',
      })
    }
    return buttons
  }

  const returnsPages = Math.max(1, Math.ceil(returnsTotal / limit))
  const refundsPages = Math.max(1, Math.ceil(refundsTotal / limit))

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Returns & Refunds"
        subtitle="Returned goods and money refunded, kept in step with Shopify."
        actions={
          <>
            <Button variant="outline" onClick={refreshAll} disabled={returnsLoading && refundsLoading}>
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Refresh
            </Button>
            {tab === 'returns' ? (
              <Button onClick={() => setCreateReturnOpen(true)}>
                <Undo2 className="mr-1.5 h-4 w-4" />
                New return
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setRefundSeed(null)
                  setCreateRefundOpen(true)
                }}
              >
                <CreditCard className="mr-1.5 h-4 w-4" />
                New refund
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MiniCard
          label="Open returns"
          value={overview ? String((overview.returns.byStatus.requested ?? 0) + (overview.returns.byStatus.approved ?? 0) + (overview.returns.byStatus.in_transit ?? 0)) : '—'}
          sub={overview ? `${overview.returns.total} returns in total` : 'Loading…'}
          tint="text-warning-700"
        />
        <MiniCard
          label="Refunded"
          value={overview ? totalsByCurrency(overview.refunds.byCurrency, 'refunded') : '—'}
          sub={overview ? `${overview.refunds.count} refunds (${overview.refunds.fromShopify} from Shopify)` : 'Loading…'}
          tint="text-success-700"
        />
        <MiniCard
          label="Pending refunds"
          value={overview ? totalsByCurrency(overview.refunds.byCurrency, 'pending') : '—'}
          sub={
            overview && overview.refunds.failed > 0
              ? `${totalsByCurrency(overview.refunds.byCurrency, 'failed')} failed — retry in Refunds`
              : 'Awaiting the gateway'
          }
          tint="text-info-700"
        />
        <MiniCard
          label="Last Shopify sync"
          value={overview?.lastSyncedAt ? formatDateTime(overview.lastSyncedAt) : '—'}
          sub="Refund webhooks and manual syncs"
          tint="text-primary-700"
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="returns">
            <Undo2 /> Returns
          </TabsTrigger>
          <TabsTrigger value="refunds">
            <Wallet /> Refunds
          </TabsTrigger>
        </TabsList>

        <TabsContent value="returns">
          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex flex-wrap items-end gap-2">
                <div className="relative min-w-[220px] flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search return, order, customer…"
                    value={returnSearch}
                    onChange={(e) => {
                      setReturnSearch(e.target.value)
                      setReturnsPage(1)
                    }}
                    className="pl-9"
                  />
                </div>
                <div className="w-40">
                  <Select
                    value={returnStatus}
                    onValueChange={(value) => {
                      setReturnStatus(value)
                      setReturnsPage(1)
                    }}
                    options={[
                      { value: 'all', label: 'All statuses' },
                      { value: 'requested', label: 'Requested' },
                      { value: 'approved', label: 'Approved' },
                      { value: 'in_transit', label: 'In transit' },
                      { value: 'received', label: 'Received' },
                      { value: 'completed', label: 'Completed' },
                      { value: 'rejected', label: 'Rejected' },
                      { value: 'processed', label: 'Completed (credit note)' },
                    ]}
                  />
                </div>
                <div className="w-36">
                  <Input
                    type="date"
                    value={returnFrom}
                    onChange={(e) => {
                      setReturnFrom(e.target.value)
                      setReturnsPage(1)
                    }}
                    aria-label="From date"
                  />
                </div>
                <div className="w-36">
                  <Input
                    type="date"
                    value={returnTo}
                    onChange={(e) => {
                      setReturnTo(e.target.value)
                      setReturnsPage(1)
                    }}
                    aria-label="To date"
                  />
                </div>
              </div>

              {returnsError ? (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                  {returnsError}
                </p>
              ) : null}

              <DataTable
                columns={returnColumns}
                data={returns}
                loading={returnsLoading}
                emptyMessage="No returns yet — create one from an order that has items coming back."
                onRowDoubleClick={(row) => void openDetail(row.id)}
              />

              <Pager page={returnsPage} pages={returnsPages} total={returnsTotal} onChange={setReturnsPage} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="refunds">
          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex flex-wrap items-end gap-2">
                <div className="relative min-w-[220px] flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search refund, order, customer…"
                    value={refundSearch}
                    onChange={(e) => {
                      setRefundSearch(e.target.value)
                      setRefundsPage(1)
                    }}
                    className="pl-9"
                  />
                </div>
                <div className="w-40">
                  <Select
                    value={refundStatus}
                    onValueChange={(value) => {
                      setRefundStatus(value)
                      setRefundsPage(1)
                    }}
                    options={[
                      { value: 'all', label: 'All statuses' },
                      { value: 'pending', label: 'Pending' },
                      { value: 'completed', label: 'Completed' },
                      { value: 'failed', label: 'Failed' },
                      { value: 'partial', label: 'Partial' },
                    ]}
                  />
                </div>
                <div className="w-36">
                  <Select
                    value={refundSource}
                    onValueChange={(value) => {
                      setRefundSource(value)
                      setRefundsPage(1)
                    }}
                    options={[
                      { value: 'all', label: 'All sources' },
                      { value: 'shopify', label: 'Shopify' },
                      { value: 'erp', label: 'ERP' },
                    ]}
                  />
                </div>
                <div className="w-36">
                  <Input
                    type="date"
                    value={refundFrom}
                    onChange={(e) => {
                      setRefundFrom(e.target.value)
                      setRefundsPage(1)
                    }}
                    aria-label="From date"
                  />
                </div>
                <div className="w-36">
                  <Input
                    type="date"
                    value={refundTo}
                    onChange={(e) => {
                      setRefundTo(e.target.value)
                      setRefundsPage(1)
                    }}
                    aria-label="To date"
                  />
                </div>
              </div>

              {refundsError ? (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                  {refundsError}
                </p>
              ) : null}

              <DataTable
                columns={refundColumns}
                data={refunds}
                loading={refundsLoading}
                emptyMessage="No refunds recorded. Refunds issued in Shopify appear here automatically."
                onRowDoubleClick={(row) => void openRefundDetail(row)}
              />

              <Pager page={refundsPage} pages={refundsPages} total={refundsTotal} onChange={setRefundsPage} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <CreateReturnDialog open={createReturnOpen} onOpenChange={setCreateReturnOpen} onCreated={refreshAll} />
      <CreateRefundDialog
        open={createRefundOpen}
        onOpenChange={(open) => {
          setCreateRefundOpen(open)
          if (!open) setRefundSeed(null)
        }}
        onCreated={refreshAll}
        initialOrder={refundSeed?.order ?? null}
        returnId={refundSeed?.returnId ?? null}
      />

      {/* ── Return detail ─────────────────────────────────────────────────── */}
      <AppDialog
        open={Boolean(detailId)}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null)
            setDetail(null)
          }
        }}
        size="xl"
        title={detail ? `Return ${detail.number}` : 'Return'}
        description={detail ? `${detail.customer || 'Customer'} · ${detail.order ?? 'no order'} · ${formatDate(detail.date)}` : undefined}
        titleAdornment={detail ? <ReturnStatusBadge status={detail.status} /> : null}
        footer={
          detail ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {detailActions(detail).map((action) => (
                <Button key={action.label} variant={action.variant ?? 'default'} disabled={busy} onClick={action.run}>
                  {action.icon}
                  <span className="ml-1.5">{action.label}</span>
                </Button>
              ))}
            </div>
          ) : null
        }
      >
        {detailLoading || !detail ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading return…
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field
                label="Order value"
                value={
                  detail.orderInfo
                    ? formatCurrency(detail.orderInfo.value, { currency: detail.orderInfo.currency ?? detail.currency })
                    : '—'
                }
              />
              <Field label="Order payment" value={detail.orderInfo?.payment ?? '—'} />
              <Field label="Return reason" value={detail.reason ? detail.reason.replace(/_/g, ' ') : '—'} />
              <Field
                label="Received"
                value={detail.receivedAt ? formatDateTime(detail.receivedAt) : 'Not received yet'}
              />
            </div>

            <div>
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Items</p>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-[12.5px]">
                  <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Product</th>
                      <th className="px-3 py-2 font-medium">SKU</th>
                      <th className="px-3 py-2 text-right font-medium">Ordered</th>
                      <th className="px-3 py-2 text-right font-medium">Returned before</th>
                      <th className="px-3 py-2 text-right font-medium">This return</th>
                      <th className="px-3 py-2 text-right font-medium">Price</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="px-3 py-2 text-right font-medium">Received / accepted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((item) => (
                      <tr key={item.sku} className="border-t">
                        <td className="px-3 py-2 font-medium text-foreground">{item.product}</td>
                        <td className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{item.sku}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{item.ordered}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{item.previouslyReturned}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{item.quantity}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {formatCurrency(item.unitPrice, { decimals: true, currency: detail.currency })}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCurrency(item.amount, { currency: detail.currency })}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {item.received ? `${item.received.received ?? 0} / ${item.received.accepted ?? 0}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detail.restocked ? (
                <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-success-700">
                  <ClipboardCheck className="h-3.5 w-3.5" /> Accepted units have been restocked.
                </p>
              ) : (
                <p className="mt-2 text-[11.5px] text-muted-foreground">
                  Stock has not changed — it updates when the goods are received and inspected.
                </p>
              )}
            </div>

            {detail.notes ? (
              <div>
                <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Notes</p>
                <p className="rounded-md border bg-muted/30 px-3 py-2 text-[12.5px] text-foreground">{detail.notes}</p>
              </div>
            ) : null}

            <div>
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Refunds</p>
              {detail.refunds.length === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">No refund has been issued for this return yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {detail.refunds.map((refund) => (
                    <div
                      key={refund.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[12.5px]"
                    >
                      <span className="font-medium text-foreground">{refund.number}</span>
                      <Badge variant={(REFUND_STATUS[refund.status] ?? REFUND_STATUS.pending).variant} dot>
                        {(REFUND_STATUS[refund.status] ?? REFUND_STATUS.pending).label}
                      </Badge>
                      <Badge variant={refund.source === 'shopify' ? 'purple' : 'outline'}>
                        {refund.source === 'shopify' ? 'Shopify' : 'ERP'}
                      </Badge>
                      <span className="text-muted-foreground">{refund.paymentMethod ?? '—'}</span>
                      <span className="ml-auto font-semibold tabular-nums">
                        {formatCurrency(refund.amount, { currency: refund.currency ?? detail.currency })}
                      </span>
                      {refund.syncError ? (
                        <span className="w-full text-[11.5px] text-red-600 dark:text-red-400">{refund.syncError}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </AppDialog>

      {/* ── Receive / inspection ──────────────────────────────────────────── */}
      <AppDialog
        open={receiveOpen}
        onOpenChange={setReceiveOpen}
        size="lg"
        title="Receive returned goods"
        description="Record what physically arrived. Only accepted units are restocked."
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setReceiveOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (!detail) return
                void changeStatus(
                  detail.id,
                  'received',
                  detail.items.map((item) => ({
                    sku: item.sku,
                    received: receiving[item.sku]?.received ?? item.quantity,
                    accepted: receiving[item.sku]?.accepted ?? item.quantity,
                    damaged: receiving[item.sku]?.damaged ?? 0,
                  })),
                )
              }}
            >
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Mark received
            </Button>
          </div>
        }
      >
        {detail ? (
          <div className="space-y-3">
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-[12.5px]">
                <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 text-right font-medium">Returned qty</th>
                    <th className="px-3 py-2 text-right font-medium">Received</th>
                    <th className="px-3 py-2 text-right font-medium">Accepted</th>
                    <th className="px-3 py-2 text-right font-medium">Damaged</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((item) => {
                    const row = receiving[item.sku] ?? { received: item.quantity, accepted: item.quantity, damaged: 0 }
                    const setRow = (patch: Partial<typeof row>) =>
                      setReceiving((prev) => {
                        const base = prev[item.sku] ?? row
                        const received = Math.min(item.quantity, Math.max(0, patch.received ?? base.received))
                        const damaged = Math.min(received, Math.max(0, patch.damaged ?? base.damaged))
                        const accepted = Math.min(
                          Math.max(0, received - damaged),
                          Math.max(0, patch.accepted ?? Math.min(base.accepted, received - damaged)),
                        )
                        return { ...prev, [item.sku]: { received, accepted, damaged } }
                      })
                    return (
                      <tr key={item.sku} className="border-t">
                        <td className="px-3 py-2 font-medium text-foreground">
                          {item.product}
                          <span className="ml-1 font-mono text-[11px] text-muted-foreground">{item.sku}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{item.quantity}</td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min={0}
                            max={item.quantity}
                            value={row.received}
                            onChange={(e) => setRow({ received: Math.floor(Number(e.target.value) || 0) })}
                            className="ml-auto h-8 w-20 text-right"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min={0}
                            max={Math.max(0, row.received - row.damaged)}
                            value={row.accepted}
                            onChange={(e) => setRow({ accepted: Math.floor(Number(e.target.value) || 0) })}
                            className="ml-auto h-8 w-20 text-right"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            min={0}
                            max={row.received}
                            value={row.damaged}
                            onChange={(e) => setRow({ damaged: Math.floor(Number(e.target.value) || 0) })}
                            className="ml-auto h-8 w-20 text-right"
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              Damaged units stay out of inventory. This also sets the return to <strong>received</strong>.
            </p>
          </div>
        ) : null}
      </AppDialog>

      {/* ── Refund detail ─────────────────────────────────────────────────── */}
      <AppDialog
        open={Boolean(refundDetail)}
        onOpenChange={(open) => {
          if (!open) setRefundDetail(null)
        }}
        size="lg"
        title={refundDetail ? `Refund ${refundDetail.number}` : 'Refund'}
        description={
          refundDetail
            ? `${refundDetail.customer || 'Customer'} · ${refundDetail.order ?? 'no order'} · ${formatDate(refundDetail.date)}`
            : undefined
        }
        titleAdornment={
          refundDetail ? (
            <Badge variant={(REFUND_STATUS[refundDetail.status] ?? REFUND_STATUS.pending).variant} dot>
              {(REFUND_STATUS[refundDetail.status] ?? REFUND_STATUS.pending).label}
            </Badge>
          ) : null
        }
        footer={
          refundDetail ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {refundDetail.order ? (
                <Button variant="outline" disabled={busy} onClick={() => void syncRefund(refundDetail.order as string)}>
                  <RefreshCw className="h-4 w-4" />
                  <span className="ml-1.5">Sync from Shopify</span>
                </Button>
              ) : null}
              {refundDetail.status === 'failed' && refundDetail.source === 'erp' ? (
                <Button disabled={busy} onClick={() => void retryRefund(refundDetail.id)}>
                  <RotateCcw className="h-4 w-4" />
                  <span className="ml-1.5">Retry refund</span>
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {refundDetail ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field
                label="Amount"
                value={formatCurrency(refundDetail.amount, { decimals: true, currency: refundDetail.currency })}
              />
              <Field
                label="Settled"
                value={formatCurrency(refundDetail.refundedAmount, { decimals: true, currency: refundDetail.currency })}
              />
              <Field label="Payment method" value={refundDetail.paymentMethod ?? '—'} />
              <Field label="Gateway" value={refundDetail.gateway ?? '—'} />
              <Field
                label="Shopify refund id"
                value={refundDetail.shopifyRefundId?.split('/').pop() ?? 'Not created in Shopify'}
              />
              <Field
                label="Shopify transaction"
                value={refundDetail.transactionIds?.split(',').map((t) => t.split('/').pop()).filter(Boolean).join(', ') || '—'}
              />
            </div>

            {refundDetail.syncError ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                {refundDetail.syncError}
              </p>
            ) : null}

            <div>
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Products</p>
              {refundDetail.items.length === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">No line items recorded for this refund.</p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-[12.5px]">
                    <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Product</th>
                        <th className="px-3 py-2 font-medium">SKU</th>
                        <th className="px-3 py-2 text-right font-medium">Qty</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {refundDetail.items.map((item) => (
                        <tr key={item.id} className="border-t">
                          <td className="px-3 py-2 font-medium text-foreground">{item.product || '—'}</td>
                          <td className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{item.sku || '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{item.quantity}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatCurrency(item.amount, { currency: refundDetail.currency })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {refundEvents.length > 0 ? (
              <div>
                <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Sync log</p>
                <div className="space-y-1">
                  {refundEvents.map((event) => (
                    <div key={event.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-[11.5px]">
                      <Badge variant={event.status === 'success' ? 'success' : event.status === 'failed' ? 'danger' : 'muted'}>
                        {event.action}
                      </Badge>
                      <span className="text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                      <span className="min-w-0 flex-1 truncate text-foreground">{event.message ?? ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </AppDialog>
    </div>
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[13px] font-medium capitalize text-foreground">{value}</p>
    </div>
  )
}

function Pager({ page, pages, total, onChange }: { page: number; pages: number; total: number; onChange: (page: number) => void }) {
  if (total === 0) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground">
      <span>
        Page {page} of {pages} · {total} record{total === 1 ? '' : 's'}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <ChevronLeft className="h-3.5 w-3.5" /> Prev
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Next <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

// ── Legacy invoice-return view ───────────────────────────────────────────────
// Credit notes raised by the invoice-return workflow still render through this
// view (and its regression tests in Returns.test.tsx). The routed page above is
// the newer RMA + refund workflow, which lists the same credit notes with a
// "Completed (credit note)" status.
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
