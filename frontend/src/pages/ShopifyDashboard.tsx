import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  CloudOff,
  Link2,
  Package,
  RefreshCw,
  ShoppingBag,
  Users,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { EmptyState } from '@/components/ui/empty-state'
import { shopifyApi } from '@/lib/api'
import type { ShopifyStatus, SyncLogEntry } from '@/types/shopify'
import { formatDateTime, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

const resourceLabel: Record<string, string> = {
  orders: 'Orders',
  products: 'Products',
  customers: 'Customers',
  inventory: 'Inventory',
}

export default function ShopifyDashboardPage() {
  const [status, setStatus] = useState<ShopifyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dbSyncInfo, setDbSyncInfo] = useState<Record<string, string> | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const s = await shopifyApi.getStatus()
      setStatus(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the backend server')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  const handleSync = async () => {
    setSyncing(true)
    setError('')
    setDbSyncInfo(null)
    try {
      const res = await shopifyApi.sync()
      setDbSyncInfo(res.db ?? null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="Shopify Dashboard"
        subtitle="Live connection to your Shopify store via the Opal Line Node backend."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading || syncing}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
            </Button>
            <Button size="sm" onClick={handleSync} disabled={syncing || loading || !status?.configured}>
              <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
              {syncing ? 'Syncing...' : 'Sync Now'}
            </Button>
          </>
        }
      />

      {error ? (
        <Card className="border-red-200 bg-red-50/50 dark:border-red-500/30">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <p>{error}. Is the backend running? Start it with <code className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs">npm run dev --prefix backend</code>.</p>
          </CardContent>
        </Card>
      ) : null}

      {!loading && status && !status.configured ? (
        <Card className="border-warning-100 bg-warning-50/50">
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-warning-100 text-warning-700">
                <CloudOff className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Shopify is not connected yet</p>
                <p className="text-[13px] text-muted-foreground">Add your store credentials to connect this app to your Shopify store.</p>
              </div>
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
              <li>In Shopify admin: <strong>Settings → Apps and sales channels → Develop apps → Create an app</strong></li>
              <li>Grant Admin API scopes: <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">read_orders, read_products, read_inventory, read_customers</code></li>
              <li>Install the app and copy the <strong>Admin API access token</strong></li>
              <li>Copy <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">backend/.env.example</code> to <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">backend/.env</code>, fill in <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">SHOPIFY_STORE_URL</code> and <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">SHOPIFY_ACCESS_TOKEN</code>, restart the server, then click <strong>Sync Now</strong>.</li>
            </ol>
          </CardContent>
        </Card>
      ) : null}

      {!loading && status && status.configured ? (
        <>
          <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card px-4 py-3 text-sm">
            <Badge variant="success" dot>Connected</Badge>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Link2 className="h-3.5 w-3.5" />
              <span className="font-medium text-foreground">{status.store}.myshopify.com</span>
            </span>
            {status.syncing ? <Badge variant="warning" dot>Syncing...</Badge> : null}
            {status.lastError ? (
              <span className="ml-auto flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-3.5 w-3.5" /> {status.lastError}
              </span>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={ShoppingBag} title="Orders Synced" value={formatNumber(status.totals.orders)} accent="teal" support={lastSyncLabel(status.lastSync.orders)} />
            <StatCard icon={Package} title="Products Synced" value={formatNumber(status.totals.products)} accent="blue" support={lastSyncLabel(status.lastSync.products)} />
            <StatCard icon={Users} title="Customers Synced" value={formatNumber(status.totals.customers)} accent="green" support={lastSyncLabel(status.lastSync.customers)} />
            <StatCard icon={Boxes} title="Inventory Lines" value={formatNumber(status.totals.inventory)} accent="orange" support={lastSyncLabel(status.lastSync.inventory)} />
          </div>

          {dbSyncInfo ? (
            <div className="rounded-lg border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Saved to local database</p>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(dbSyncInfo).map(([k, v]) => (
                  <span key={k}>
                    <span className="font-semibold capitalize">{k}</span>: {v}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Sync Log</CardTitle>
            </CardHeader>
            <CardContent>
              {status.logs.length === 0 ? (
                <EmptyState
                  icon={RefreshCw}
                  title="No syncs yet"
                  description="Click Sync Now to pull orders, products, customers and inventory from Shopify."
                />
              ) : (
                <div className="space-y-2">
                  {status.logs.map((log) => (
                    <SyncLogRow key={log.id} log={log} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg border bg-card" />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function lastSyncLabel(value: string | undefined) {
  return value ? `Last sync ${formatDateTime(value)}` : 'Not synced'
}

function SyncLogRow({ log }: { log: SyncLogEntry }) {
  const ok = log.status === 'success'
  return (
    <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2.5">
      <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', ok ? 'bg-success-50 text-success-700' : 'bg-red-50 text-red-600 dark:text-red-400')}>
        {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">
          {resourceLabel[log.resource] ?? log.resource} <span className="text-muted-foreground">· {formatNumber(log.count)} records</span>
        </p>
        {log.message ? <p className="truncate text-xs text-red-600 dark:text-red-400">{log.message}</p> : null}
      </div>
      <Badge variant={ok ? 'success' : 'danger'}>{ok ? 'Success' : 'Failed'}</Badge>
      <span className="shrink-0 text-[11px] text-muted-foreground">{formatDateTime(log.time)}</span>
    </div>
  )
}
