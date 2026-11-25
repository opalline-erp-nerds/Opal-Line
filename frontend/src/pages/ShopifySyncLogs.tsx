import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Clock, RefreshCw, RotateCcw } from 'lucide-react'
import type { ColumnDef } from '@/components/ui/data-table'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { StatCard } from '@/components/ui/stat-card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Search } from 'lucide-react'
import { dbApi } from '@/lib/api'
import type { SyncLog } from '@/types'
import { formatDateTime, formatNumber } from '@/lib/format'

const statusBadge: Record<SyncLog['status'], { label: string; variant: 'success' | 'warning' | 'danger' | 'muted' }> = {
  success: { label: 'Success', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
  pending: { label: 'Pending', variant: 'warning' },
  skipped: { label: 'Skipped', variant: 'muted' },
}

const entityBadge: Record<string, { variant: 'info' | 'brand' | 'success' | 'warning' | 'default' | 'muted' }> = {
  Order: { variant: 'info' },
  Product: { variant: 'brand' },
  Customer: { variant: 'success' },
  Inventory: { variant: 'warning' },
  Price: { variant: 'default' },
  Payment: { variant: 'muted' },
}

export default function ShopifySyncLogsPage() {
  const [logs, setLogs] = useState<SyncLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [entityFilter, setEntityFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setLogs(await dbApi.getSyncLogs())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sync logs')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return logs.filter((l) => {
      const matchQ = !q || JSON.stringify(l).toLowerCase().includes(q)
      const matchEntity = !entityFilter || l.entity === entityFilter
      const matchStatus = !statusFilter || l.status === statusFilter
      return matchQ && matchEntity && matchStatus
    })
  }, [logs, query, entityFilter, statusFilter])

  const counts = useMemo(
    () => ({
      success: logs.filter((l) => l.status === 'success').length,
      failed: logs.filter((l) => l.status === 'failed').length,
      pending: logs.filter((l) => l.status === 'pending').length,
    }),
    [logs],
  )

  const entities = useMemo(() => [...new Set(logs.map((l) => l.entity))].sort(), [logs])

  const columns = useMemo<ColumnDef<SyncLog>[]>(
    () => [
      {
        accessorKey: 'time',
        header: 'Time',
        meta: { headerClassName: 'min-w-[150px]' },
        cell: ({ row }) => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(row.original.time)}</span>,
      },
      {
        accessorKey: 'entity',
        header: 'Entity',
        cell: ({ row }) => {
          const b = entityBadge[row.original.entity] ?? { variant: 'muted' as const }
          return <Badge variant={b.variant}>{row.original.entity}</Badge>
        },
      },
      {
        accessorKey: 'action',
        header: 'Action',
        cell: ({ row }) => <span className="font-medium text-foreground">{row.original.action}</span>,
      },
      {
        accessorKey: 'shopifyId',
        header: 'Shopify ID',
        cell: ({ row }) => <span className="font-mono text-[12px] text-muted-foreground">{row.original.shopifyId || '—'}</span>,
      },
      {
        accessorKey: 'direction',
        header: 'Direction',
        meta: { align: 'center' as const },
        cell: ({ row }) =>
          row.original.direction === 'in' ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-info-700">
              <ArrowDownToLine className="h-3 w-3" /> Import
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-primary-700">
              <ArrowUpFromLine className="h-3 w-3" /> Push
            </span>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const b = statusBadge[row.original.status] ?? { label: row.original.status ?? "—", variant: "muted" as const }
          return <Badge variant={b.variant} dot>{b.label}</Badge>
        },
      },
      {
        id: 'retry',
        header: 'Retry',
        meta: { align: 'center' as const },
        cell: ({ row }) =>
          row.original.retry ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning-700">
              <RotateCcw className="h-3 w-3" /> Pending
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: 'error',
        header: 'Error',
        meta: { headerClassName: 'min-w-[200px]' },
        cell: ({ row }) =>
          row.original.error ? (
            <span className="block max-w-[240px] truncate font-mono text-[11px] text-red-600 dark:text-red-400">{row.original.error}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    [],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="Sync Logs"
        subtitle="Audit trail of every order, product, customer, inventory and price operation with Shopify."
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      {error ? (
        <Card className="border-red-200 bg-red-50/50 dark:border-red-500/30">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <p>{error}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={RefreshCw} title="Total Operations" value={formatNumber(logs.length)} accent="teal" />
        <StatCard icon={CheckCircle2} title="Successful" value={formatNumber(counts.success)} accent="green" />
        <StatCard icon={AlertCircle} title="Failed" value={formatNumber(counts.failed)} accent="red" />
        <StatCard icon={Clock} title="Pending / Retry" value={formatNumber(counts.pending)} accent="orange" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search ID, action, error..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[{ value: '', label: 'All Entities' }, ...entities.map((e) => ({ value: e, label: e }))]}
              value={entityFilter}
              onValueChange={setEntityFilter}
              className="w-[150px]"
            />
            <Select
              options={[
                { value: '', label: 'All Status' },
                { value: 'success', label: 'Success' },
                { value: 'failed', label: 'Failed' },
                { value: 'pending', label: 'Pending' },
                { value: 'skipped', label: 'Skipped' },
              ]}
              value={statusFilter}
              onValueChange={setStatusFilter}
              className="w-[140px]"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {logs.length} entries
            </div>
          </div>

          {loading ? (
            <DataTable columns={columns} data={[]} loading={loading} />
          ) : filtered.length > 0 ? (
            <DataTable columns={columns} data={filtered} loading={false} />
          ) : (
            <EmptyState
              icon={RefreshCw}
              title={query || entityFilter || statusFilter ? 'No logs match your filters' : 'No sync activity yet'}
              description="Run a sync from the Shopify modules to see log entries here."
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
