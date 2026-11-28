import { useEffect, useState } from 'react'
import { Boxes, Download, IndianRupee, Package, PackageSearch, Scale, TrendingUp } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { dbApi } from '@/lib/api'
import { exportCsv } from '@/lib/export'
import type { StockCategory } from '@/types'
import { formatCurrency, formatNumber, formatWeight } from '@/lib/format'

export default function InventoryReportsPage() {
  const [categories, setCategories] = useState<StockCategory[]>([])
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof dbApi.getInventoryOverview>> | null>(null)
  const [period, setPeriod] = useState('month')

  useEffect(() => {
    dbApi.getStockCategories().then(setCategories).catch(() => {})
    dbApi.getInventoryOverview().then(setOverview).catch(() => {})
  }, [period])

  const totalValue = categories.reduce((a, c) => a + c.value, 0)
  const totalWeight = categories.reduce((a, c) => a + c.weight, 0)
  const maxValue = categories[0]?.value || 1

  const exportReport = () => {
    exportCsv('inventory-report.csv', [
      ...categories.map((c) => ({ Category: c.category, Products: c.products, Qty: c.qty, 'Weight (gm)': c.weight, 'Value (INR)': c.value })),
      {
        Category: 'TOTAL',
        Products: categories.reduce((a, c) => a + c.products, 0),
        Qty: categories.reduce((a, c) => a + c.qty, 0),
        'Weight (gm)': totalWeight,
        'Value (INR)': totalValue,
      },
    ])
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="Inventory Reports"
        subtitle="Stock valuation, category breakdown and weight-ledger summaries."
        actions={
          <>
            <Select
              options={[
                { value: 'month', label: 'This Month' },
                { value: 'quarter', label: 'This Quarter' },
              ]}
              value={period}
              onValueChange={setPeriod}
              className="w-[150px]"
            />
            <Button variant="outline" size="sm" onClick={exportReport}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniCard icon={IndianRupee} label="Inventory Value" value={formatCurrency(totalValue || overview?.inventoryValue || 0)} sub="At selling price" tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
        <MiniCard icon={Boxes} label="Stock Quantity" value={formatNumber(overview?.totalQuantity || categories.reduce((a, c) => a + c.qty, 0))} sub="Across all products" tint="bg-info-50 text-info-700" />
        <MiniCard icon={Scale} label="Stock Weight" value={formatWeight(totalWeight || overview?.totalWeight || 0)} sub="Gross weight" tint="bg-success-50 text-success-700" />
        <MiniCard icon={Package} label="Low Stock" value={String(overview?.lowStock ?? '—')} sub={`${overview?.outOfStock ?? 0} out of stock`} tint="bg-warning-50 text-warning-700" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center gap-2">
              <PackageSearch className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold text-foreground">Category Valuation</h3>
            </div>
            <div className="space-y-4">
              {categories.map((c) => (
                <div key={c.category}>
                  <div className="mb-1.5 flex items-center justify-between text-sm">
                    <span className="font-medium text-foreground">{c.category}</span>
                    <span className="font-semibold tabular-nums text-foreground">{formatCurrency(c.value)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted/50">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-primary-600 to-primary-400"
                      style={{ width: `${Math.round((c.value / maxValue) * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {c.products} products · {c.qty} pcs · {formatWeight(c.weight)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-semibold text-foreground">Weight Ledger (Silver)</h3>
            </div>
            <div className="space-y-3">
              <Row label="Total Stock Weight" value={formatWeight(totalWeight || overview?.totalWeight || 0)} />
              <Row label="Total Products" value={String(categories.reduce((a, c) => a + c.products, 0))} />
              <Row label="Total Quantity" value={formatNumber(categories.reduce((a, c) => a + c.qty, 0))} />
              <Row label="Low Stock Items" value={String(overview?.lowStock ?? '—')} />
              <Row label="Out of Stock" value={String(overview?.outOfStock ?? 0)} highlight="text-red-600 dark:text-red-400" />
              <Row label="Inventory Value" value={formatCurrency(totalValue || overview?.inventoryValue || 0)} highlight="text-primary-700" bold />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-4">
          <span className="text-sm text-muted-foreground">Reports ready:</span>
          {['Stock Valuation', 'Weight Ledger', 'Category Summary', 'Reorder Report', 'Batch / Lot Ageing'].map((r) => (
            <Badge key={r} variant="muted">{r}</Badge>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function MiniCard({ icon: Icon, label, value, sub, tint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; tint: string }) {
  return (
    <Card className="p-3 sm:p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{value}</p>
          {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
        </div>
      </div>
    </Card>
  )
}

function Row({ label, value, highlight, bold }: { label: string; value: string; highlight?: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b pb-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${bold ? 'font-bold' : 'font-semibold'} ${highlight ?? 'text-foreground'}`}>{value}</span>
    </div>
  )
}
