import { useMemo, useState } from 'react'
import { AlertCircle, BadgeCheck, CheckCircle2, Minus, Tags, TrendingUp } from 'lucide-react'
import type { ColumnDef } from '@/components/ui/data-table'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { StatCard } from '@/components/ui/stat-card'
import { Input } from '@/components/ui/input'
import { Search } from 'lucide-react'
import { ShopifyNotConfigured, SyncErrorCard } from '@/components/shopify/sync-cards'
import { useShopifyResource } from '@/lib/useShopifyResource'
import { shopifyApi } from '@/lib/api'
import type { SyncPrice, SyncPriceStatus } from '@/types/shopify'
import { formatCurrency, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

const statusBadge: Record<SyncPriceStatus, { label: string; variant: 'success' | 'warning' | 'info' | 'muted' }> = {
  'up-to-date': { label: 'Up to date', variant: 'success' },
  update: { label: 'Price change', variant: 'warning' },
  updated: { label: 'Pushed', variant: 'info' },
  'no-match': { label: 'No SKU match', variant: 'muted' },
  skipped: { label: 'Over Shopify cap', variant: 'muted' },
}

export default function ShopifyPricePage() {
  const { data, syncedAt, loading, syncing, error, configured, load, syncNow } = useShopifyResource('price', shopifyApi.getPrice)
  const [query, setQuery] = useState('')
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState<{ ok: boolean; updated: number; skipped: number; errors: string[] } | null>(null)

  const pending = useMemo(() => data.filter((p) => p.status === 'update'), [data])
  const upToDate = useMemo(() => data.filter((p) => p.status === 'up-to-date' || p.status === 'updated').length, [data])
  const noMatch = useMemo(() => data.filter((p) => p.status === 'no-match').length, [data])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return data
    return data.filter((row) => JSON.stringify(row).toLowerCase().includes(q))
  }, [data, query])

  const handlePush = async () => {
    setPushing(true)
    setPushResult(null)
    try {
      const result = await shopifyApi.applyPrice()
      setPushResult(result)
      await load(true)
    } catch (e) {
      setPushResult({ ok: false, updated: 0, skipped: 0, errors: [e instanceof Error ? e.message : 'Push failed'] })
    } finally {
      setPushing(false)
    }
  }

  const columns = useMemo<ColumnDef<SyncPrice>[]>(
    () => [
      {
        accessorKey: 'title',
        header: 'Product',
        meta: { headerClassName: 'min-w-[240px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <Tags className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{row.original.title}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{row.original.sku || '—'}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'currentPrice',
        header: 'Shopify Price',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatCurrency(row.original.currentPrice)}</span>,
      },
      {
        accessorKey: 'targetPrice',
        header: 'Target Price',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <span className={cn('font-semibold tabular-nums', row.original.status === 'no-match' ? 'text-muted-foreground' : 'text-foreground')}>
            {row.original.status === 'no-match' ? '—' : formatCurrency(row.original.targetPrice)}
          </span>
        ),
      },
      {
        id: 'diff',
        header: 'Diff',
        meta: { align: 'right' as const },
        cell: ({ row }) => {
          if (row.original.status === 'no-match') return <span className="text-muted-foreground">—</span>
          const diff = row.original.targetPrice - row.original.currentPrice
          const abs = Math.abs(diff)
          if (abs <= 0.005) return <Minus className="mx-auto h-4 w-4 text-muted-foreground" />
          return (
            <span className={cn('inline-flex items-center gap-0.5 text-xs font-semibold', diff > 0 ? 'text-success-700' : 'text-red-600 dark:text-red-400')}>
              {diff > 0 ? '+' : '−'}
              {formatCurrency(abs)}
            </span>
          )
        },
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
    ],
    [],
  )

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Price Sync"
        subtitle="Compare live Shopify prices against your local catalog prices computed from silver rate, and push updates."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => load()} disabled={loading || syncing || pushing}>
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing || loading || pushing || !configured}>
              <TrendingUp className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
              {syncing ? 'Computing...' : 'Recompute'}
            </Button>
            <Button size="sm" onClick={handlePush} disabled={pushing || pending.length === 0 || !configured}>
              <BadgeCheck className={cn('h-4 w-4', pushing && 'animate-pulse')} />
              {pushing ? 'Pushing...' : `Push ${formatNumber(pending.length)} price change${pending.length === 1 ? '' : 's'}`}
            </Button>
          </>
        }
      />

      {error ? <SyncErrorCard message={error} /> : null}
      {!configured ? <ShopifyNotConfigured /> : null}

      {pushResult ? (
        <Card className={cn(pushResult.ok ? 'border-success-100 bg-success-50/50' : 'border-red-200 bg-red-50/50')}>
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            {pushResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-700" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />}
            <div>
              <p className={cn('font-semibold', pushResult.ok ? 'text-success-700' : 'text-red-700')}>
                {pushResult.ok ? 'Prices pushed to Shopify' : 'Price push failed'}
              </p>
              <p className="text-[13px] text-muted-foreground">
                {pushResult.updated} updated · {pushResult.skipped} skipped
                {pushResult.errors.length > 0 ? (
                  <span className="mt-1 block max-w-2xl truncate font-mono text-xs text-red-600 dark:text-red-400">{pushResult.errors[0]}</span>
                ) : null}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {configured && !error ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={Tags} title="Products Compared" value={formatNumber(data.length)} accent="purple" support={syncedAt ? `Computed ${syncedAt}` : 'Not computed'} />
            <StatCard icon={TrendingUp} title="Price Changes" value={formatNumber(pending.length)} accent="orange" support="Pending push" />
            <StatCard icon={CheckCircle2} title="Up to Date" value={formatNumber(upToDate)} accent="green" support="No change needed" />
            <StatCard icon={AlertCircle} title="No SKU Match" value={formatNumber(noMatch)} accent="slate" support="Not in local catalog" />
          </div>

          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
                <div className="relative min-w-[240px] flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search product, SKU..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <div className="ml-auto text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{filtered.length}</span> of {data.length} products
                </div>
              </div>

              <DataTable
                columns={columns}
                data={filtered}
                loading={loading}
                emptyMessage={query ? 'No products match your search' : 'No products yet'}
              />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}
