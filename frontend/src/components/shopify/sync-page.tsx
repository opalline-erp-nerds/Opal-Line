import { useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Link2, RefreshCw, Search } from 'lucide-react'
import type { RowData } from '@tanstack/react-table'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { DataTable, type ColumnDef } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import { useShopifyResource } from '@/lib/useShopifyResource'
import type { SyncResource } from '@/types/shopify'
import { formatDateTime, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ShopifyNotConfigured, SyncErrorCard } from './sync-cards'

interface SyncPageProps<TData extends RowData> {
  title: string
  subtitle: string
  resourceLabel: string
  resource: SyncResource
  icon: LucideIcon
  loader: () => Promise<{ syncedAt: string | null; data: TData[] }>
  columns: ColumnDef<TData>[]
  searchPlaceholder?: string
  emptyTitle?: string
  emptyDescription?: string
  actions?: React.ReactNode
}

export function ShopifySyncPage<TData extends RowData>({
  title,
  subtitle,
  resourceLabel,
  resource,
  icon: Icon,
  loader,
  columns,
  searchPlaceholder = 'Search...',
  emptyTitle = 'Nothing synced yet',
  emptyDescription = 'Click Sync Now to pull this resource from Shopify.',
  actions,
}: SyncPageProps<TData>) {
  const { data, syncedAt, loading, syncing, error, configured, load, syncNow } = useShopifyResource(resource, loader)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return data
    return data.filter((row) => JSON.stringify(row).toLowerCase().includes(q))
  }, [data, query])

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-6 lg:px-7">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {actions}
            <Button variant="outline" size="sm" onClick={() => load()} disabled={loading || syncing}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
            </Button>
            <Button size="sm" onClick={syncNow} disabled={syncing || loading || !configured}>
              <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
              {syncing ? 'Syncing...' : 'Sync Now'}
            </Button>
          </>
        }
      />

      {error ? <SyncErrorCard message={error} /> : null}

      {!configured ? <ShopifyNotConfigured /> : null}

      {configured && !error ? (
        <>
          <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card px-4 py-3 text-sm">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-50 text-primary-700">
              <Icon className="h-4 w-4" />
            </div>
            <div>
              <p className="font-medium text-foreground">{resourceLabel}</p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Link2 className="h-3 w-3" /> {formatNumber(data.length)} records
                {syncedAt ? <> · Last sync {formatDateTime(syncedAt)}</> : null}
              </p>
            </div>
            {syncing ? <Badge variant="warning" dot>Syncing...</Badge> : <Badge variant="success" dot>Connected</Badge>}
          </div>

          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative min-w-[240px] flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={searchPlaceholder}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <div className="ml-auto text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{filtered.length}</span> of {data.length} records
                </div>
              </div>

              <DataTable
                columns={columns}
                data={filtered}
                loading={loading}
                emptyMessage={query ? 'No records match your search' : emptyTitle}
              />
              {!loading && data.length === 0 ? (
                <p className="-mt-2 px-2 pb-2 text-xs text-muted-foreground">{emptyDescription}</p>
              ) : null}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}
