import { confirmDialog } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@/lib/table'
import { AlertTriangle, CheckCircle2, FilePlus2, Gem, Loader2, PackageX, Plus, Search, ShoppingBag } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { StatCard } from '@/components/ui/stat-card'
import { DataTable } from '@/components/ui/data-table'
import { DialogFooter } from '@/components/ui/dialog'
import { AppDialog } from '@/components/ui/app-dialog'
import { dbApi } from '@/lib/api'
import type { LowStockItem, Product } from '@/types'
import { formatCurrency, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

interface Row {
  id: string
  product: string
  sku: string
  stock: number
  reorderLevel: number
  status: 'critical' | 'low' | 'out'
  price: number
}

const statusBadge: Record<Row['status'], { label: string; variant: 'danger' | 'warning' | 'muted' }> = {
  critical: { label: 'Critical', variant: 'danger' },
  low: { label: 'Low', variant: 'warning' },
  out: { label: 'Out of Stock', variant: 'muted' },
}

export default function LowStockAlertPage() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [orderQty, setOrderQty] = useState('')
  const [orderTarget, setOrderTarget] = useState<Row | null>(null)
  const [allNotified, setAllNotified] = useState(false)
  const [autoPoBusy, setAutoPoBusy] = useState(false)
  const [autoPoMsg, setAutoPoMsg] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([dbApi.getLowStock(), dbApi.getProducts()]).then(([low, products]) => {
      const priceMap = new Map(products.map((p: Product) => [p.id, p.sellingPrice]))
      const combined = low.map<Row>((item: LowStockItem) => ({
        id: item.id,
        product: item.product,
        sku: item.sku,
        stock: item.stock,
        reorderLevel: item.reorderLevel,
        status: item.stock === 0 ? 'out' : item.status,
        price: priceMap.get(item.id) ?? 0,
      }))
      setRows(combined)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      const matchQ = !q || r.product.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q)
      const matchStatus = !statusFilter || r.status === statusFilter
      return matchQ && matchStatus
    })
  }, [rows, query, statusFilter])

  const counts = useMemo(
    () => ({
      critical: rows.filter((r) => r.status === 'critical').length,
      low: rows.filter((r) => r.status === 'low').length,
      out: rows.filter((r) => r.status === 'out').length,
    }),
    [rows],
  )

  const reorderCost = useMemo(
    () =>
      rows.reduce((sum, r) => {
        const toOrder = Math.max(0, r.reorderLevel * 2 - r.stock)
        return sum + toOrder * r.price
      }, 0),
    [rows],
  )

  // Hand off to the purchase order screen with the confirmed quantity — the
  // PO page opens its new-PO dialog prefilled with this product + qty.
  const handleCreatePo = useCallback(() => {
    if (!orderTarget) return
    const target = rows.find((r) => r.id === orderTarget.id) ?? orderTarget
    const qty = Math.max(1, Math.floor(Number(orderQty) || 0))
    navigate(`/purchase/orders?product=${encodeURIComponent(target.sku)}&qty=${qty}`)
    setOrderTarget(null)
    setOrderQty('')
  }, [orderTarget, orderQty, rows, navigate])

  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        accessorKey: 'product',
        header: 'Product',
        meta: { headerClassName: 'min-w-[220px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-50 text-red-600 dark:text-red-400">
              <Gem className="h-4 w-4" />
            </div>
            <div>
              <p className="font-medium text-foreground">{row.original.product}</p>
              <p className="text-[11px] text-muted-foreground">{row.original.sku}</p>
            </div>
          </div>
        ),
      },
      {
        id: 'level',
        header: 'Stock Level',
        meta: { headerClassName: 'min-w-[200px]' },
        cell: ({ row }) => {
          const pct = row.original.reorderLevel > 0 ? (row.original.stock / row.original.reorderLevel) * 100 : 0
          return (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-semibold tabular-nums text-foreground">{formatNumber(row.original.stock)} pcs</span>
                <span className="text-muted-foreground">reorder @ {row.original.reorderLevel}</span>
              </div>
              <Progress
                value={Math.min(100, pct)}
                indicatorClassName={cn(row.original.status === 'critical' && 'bg-red-500', row.original.status === 'low' && 'bg-warning', row.original.status === 'out' && 'bg-muted')}
              />
            </div>
          )
        },
      },
      {
        id: 'needed',
        header: 'To Restock',
        meta: { align: 'right' as const },
        cell: ({ row }) => {
          const needed = Math.max(0, row.original.reorderLevel * 2 - row.original.stock)
          return <span className="tabular-nums font-medium text-foreground">{formatNumber(needed)} pcs</span>
        },
      },
      {
        id: 'cost',
        header: 'Reorder Cost',
        meta: { align: 'right' as const },
        cell: ({ row }) => {
          const needed = Math.max(0, row.original.reorderLevel * 2 - row.original.stock)
          return <span className="tabular-nums text-muted-foreground">{formatCurrency(needed * row.original.price)}</span>
        },
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const s = statusBadge[row.original.status] ?? { label: row.original.status ?? "—", variant: "muted" as const }
          return <Badge variant={s.variant} dot>{s.label}</Badge>
        },
      },
      {
        id: 'actions',
        header: '',
        meta: { align: 'right' as const, headerClassName: 'w-28' },
        cell: ({ row }) => (
          <Button
            variant="soft-primary"
            size="sm"
            onClick={() => {
              setOrderTarget(row.original)
              setOrderQty(String(Math.max(0, row.original.reorderLevel * 2 - row.original.stock)))
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Reorder
          </Button>
        ),
      },
    ],
    [],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Low Stock Alert"
        subtitle="Products running below their reorder level that need restocking."
        actions={
          <>
            <Button variant="outline" size="sm" disabled={autoPoBusy} onClick={async () => {
              if (!(await confirmDialog({ title: 'Create draft purchase orders?', description: 'Draft POs will be created for all low-stock products, grouped by supplier.', confirmLabel: 'Create POs' }))) return
              setAutoPoBusy(true)
              try {
                const r = await dbApi.createPOsFromReorder()
                setAutoPoMsg(`Created ${r.created.length} draft PO(s) covering ${r.products} product(s) — review them in Purchase Orders.`)
              } catch (err) {
                setAutoPoMsg(err instanceof Error ? err.message : 'Auto-PO failed')
              } finally {
                setAutoPoBusy(false)
              }
            }}>
              {autoPoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FilePlus2 className="h-3.5 w-3.5" />}
              Auto-Create PO Drafts
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/purchase/orders')}>
              <ShoppingBag className="h-3.5 w-3.5" /> Create Bulk PO
            </Button>
            <Button size="sm" onClick={() => setAllNotified(true)} disabled={allNotified}>
              <CheckCircle2 className="h-4 w-4" /> {allNotified ? 'All Notified' : 'Mark All Notified'}
            </Button>
          </>
        }
      />

      {autoPoMsg && (
        <Card>
          <CardContent className="flex items-center gap-2 p-3 text-sm">
            <CheckCircle2 className="h-4 w-4 text-success-600" />
            <span className="text-success-800">{autoPoMsg}</span>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={AlertTriangle} title="Critical" value={String(counts.critical)} accent="red" support="Below reorder level" />
        <StatCard icon={PackageX} title="Low" value={String(counts.low)} accent="orange" support="Approaching reorder" />
        <StatCard icon={PackageX} title="Out of Stock" value={String(counts.out)} accent="slate" support="Zero quantity" />
        <StatCard icon={ShoppingBag} title="Reorder Cost" value={formatCurrency(reorderCost)} accent="blue" support="To 2× reorder level" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search product name or SKU..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[
                { value: '', label: 'All Status' },
                { value: 'critical', label: 'Critical' },
                { value: 'low', label: 'Low' },
                { value: 'out', label: 'Out of Stock' },
              ]}
              value={statusFilter}
              onValueChange={setStatusFilter}
              className="w-[140px]"
            />
            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <span><span className="font-semibold text-foreground">{filtered.length}</span> of {rows.length} products</span>
            </div>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No products need reordering right now"
          />
        </CardContent>
      </Card>

      <div className="rounded-lg border bg-card px-4 py-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5">
          <Link to="/inventory/products" className="font-medium text-primary hover:underline">
            <span className="inline-flex items-center gap-1">View all products <span aria-hidden>→</span></span>
          </Link>
          &nbsp;· Reorder levels are set per product and can be edited from the product detail page.
        </p>
      </div>

      <AppDialog
        open={orderTarget !== null}
        onOpenChange={(open) => { if (!open) setOrderTarget(null) }}
        size="sm"
        isDirty={orderTarget !== null && Number(orderQty) !== Math.max(0, (orderTarget.reorderLevel * 2) - orderTarget.stock)}
        title={`Reorder ${orderTarget?.product ?? ''}`}
        description={orderTarget ? `Current stock: ${formatNumber(orderTarget.stock)} pcs · reorder level ${orderTarget.reorderLevel}` : ''}
        footer={
          <DialogFooter>
            <Button variant="outline" onClick={() => setOrderTarget(null)}>Cancel</Button>
            <Button onClick={handleCreatePo} disabled={!orderQty || Number(orderQty) < 1}>
              <ShoppingBag className="h-4 w-4" /> Create Purchase Order
            </Button>
          </DialogFooter>
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="order-qty">Order quantity (pcs)</Label>
          <Input
            id="order-qty"
            type="number"
            min={1}
            value={orderQty}
            onChange={(e) => setOrderQty(e.target.value)}
          />
        </div>
      </AppDialog>
    </div>
  )
}
