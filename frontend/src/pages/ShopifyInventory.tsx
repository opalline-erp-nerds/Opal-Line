import { useMemo, useState } from 'react'
import { Boxes, CheckCircle2, Upload } from 'lucide-react'
import type { ColumnDef } from '@/components/ui/data-table'
import { ShopifySyncPage } from '@/components/shopify/sync-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { shopifyApi } from '@/lib/api'
import type { SyncInventory } from '@/types/shopify'
import { formatNumber } from '@/lib/format'
import { LOCATION_UNAVAILABLE } from '@/lib/locations'

export default function ShopifyInventoryPage() {
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState<{ updated: number; skipped: number; errors: string[]; message?: string } | null>(null)

  const pushToShopify = async () => {
    setPushing(true)
    setPushResult(null)
    try {
      const res = await shopifyApi.pushInventory()
      setPushResult({ updated: res.updated ?? 0, skipped: res.skipped ?? 0, errors: res.errors ?? [], message: res.message })
    } catch (err) {
      setPushResult({ updated: 0, skipped: 0, errors: [err instanceof Error ? err.message : 'Failed to push inventory'], message: undefined })
    } finally {
      setPushing(false)
    }
  }

  const columns = useMemo<ColumnDef<SyncInventory>[]>(
    () => [
      {
        accessorKey: 'title',
        header: 'Product',
        meta: { headerClassName: 'min-w-[240px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <Boxes className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{row.original.title || 'Unknown product'}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{row.original.sku || '—'}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'locationName',
        header: 'Location',
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.locationName || LOCATION_UNAVAILABLE}</span>
        ),
      },
      {
        accessorKey: 'available',
        header: 'Available',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <Badge variant={row.original.available > 0 ? 'success' : 'danger'}>{formatNumber(row.original.available)}</Badge>
        ),
      },
      {
        accessorKey: 'inventoryItemId',
        header: 'Item ID',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-mono text-[12px] text-muted-foreground">{row.original.inventoryItemId}</span>,
      },
      // No "Location ID" column: Shopify's location id is an internal
      // identifier. The Location column above carries the human name, with the
      // shared fallback when a name is missing.
    ],
    [],
  )

  return (
    <ShopifySyncPage
      title="Inventory Sync"
      subtitle="Stock levels per location from Shopify, matched to your local catalog by SKU."
      resourceLabel="Inventory Lines"
      resource="inventory"
      icon={Boxes}
      loader={shopifyApi.getInventory}
      columns={columns}
      searchPlaceholder="Search product, SKU, location..."
      emptyDescription="Inventory levels pulled from your Shopify store will appear here after the first sync."
      actions={
        <>
          <Button size="sm" onClick={pushToShopify} disabled={pushing}>
            <Upload className={pushing ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />
            {pushing ? 'Pushing...' : 'Push Inventory to Shopify'}
          </Button>
          {pushResult ? (
            <Badge variant={pushResult.errors.length ? 'danger' : 'success'} className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              {pushResult.errors.length
                ? `${pushResult.errors.length} error${pushResult.errors.length === 1 ? '' : 's'}`
                : `${pushResult.updated} updated, ${pushResult.skipped} skipped`}
            </Badge>
          ) : null}
        </>
      }
    />
  )
}
