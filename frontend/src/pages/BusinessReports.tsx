import { useEffect, useState } from 'react'
import { BarChart3, Boxes, CalendarDays, Clock, Download, IndianRupee, LayoutDashboard, Package, TrendingUp, Users } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { dbApi } from '@/lib/api'
import { exportHtmlPdf } from '@/lib/printTemplate'
import { toast } from '@/components/ui/confirm'
import type { SilverRate } from '@/types'
import { formatCurrency, todayIST } from '@/lib/format'
import { escapeHtml } from '@/lib/utils'

interface AgingBucket {
  label: string
  count: number
  amount: number
}

interface BusinessStats {
  revenueMonth: number
  ordersMonth: number
  aov: number
  grossProfitMonth: number
  grossMarginPct: number
  inventoryValue: number
  lowStockCount: number
  returnRatePct: number
  aging: AgingBucket[]
  agingTotal: number
}

export default function BusinessReportsPage() {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof dbApi.getDashboardSummary>> | null>(null)
  const [rate, setRate] = useState<SilverRate | null>(null)
  const [stats, setStats] = useState<BusinessStats | null>(null)
  const [period, setPeriod] = useState('month')
  const [openInvoices, setOpenInvoices] = useState<Array<{ id: string; number: string; customer: string; grandTotal: number; date: string; paymentStatus: string }>>([])
  const [drillBucket, setDrillBucket] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      dbApi.getDashboardSummary(),
      dbApi.getSilverRate().catch(() => null),
      dbApi.getSalesOverview(period),
      dbApi.getInvoices(),
      dbApi.getLowStock(),
      dbApi.getSalesReturns(),
    ]).then(([s, r, overview, invoices, lowStock, returnsList]) => {
      const revenueMonth = overview.reduce((a, d) => a + d.revenue, 0)
      const ordersMonth = overview.reduce((a, d) => a + d.orders, 0)
      const monthKey = todayIST().slice(0, 7)
      const monthInvoices = invoices.filter((i) => String(i.date ?? '').startsWith(monthKey))
      const grossProfitMonth = monthInvoices.reduce((a, i) => a + (i.grandTotal - i.silverValue - i.makingCharge), 0)
      const inventoryValue = s.totalStockWeight * (r?.rate ?? 0)
      // Outstanding aging: unpaid, non-cancelled/refunded invoices bucketed by age
      const open = invoices.filter((i) => i.paymentStatus !== 'paid' && i.status !== 'cancelled' && i.status !== 'refunded')
      const nowMs = Date.now()
      const buckets: AgingBucket[] = [
        { label: '0–30 days', count: 0, amount: 0 },
        { label: '31–60 days', count: 0, amount: 0 },
        { label: '61–90 days', count: 0, amount: 0 },
        { label: '90+ days', count: 0, amount: 0 },
      ]
      for (const inv of open) {
        const ageDays = Math.floor((nowMs - new Date(inv.date).getTime()) / 86_400_000)
        const idx = ageDays <= 30 ? 0 : ageDays <= 60 ? 1 : ageDays <= 90 ? 2 : 3
        buckets[idx].count += 1
        buckets[idx].amount += inv.grandTotal ?? 0
      }
      setOpenInvoices(
        open
          .map((i) => ({ id: i.id, number: i.number, customer: i.customer, grandTotal: i.grandTotal ?? 0, date: String(i.date ?? ''), paymentStatus: i.paymentStatus }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      )
      setSummary(s)
      setRate(r)
      setStats({
        revenueMonth,
        ordersMonth,
        aov: ordersMonth > 0 ? revenueMonth / ordersMonth : 0,
        grossProfitMonth,
        grossMarginPct: revenueMonth > 0 ? (grossProfitMonth / revenueMonth) * 100 : 0,
        inventoryValue,
        lowStockCount: lowStock.length,
        returnRatePct: invoices.length > 0 ? (returnsList.length / invoices.length) * 100 : 0,
        aging: buckets,
        agingTotal: buckets.reduce((a, b) => a + b.amount, 0),
      })
    }).catch(() => {})
  }, [period])

  // Wall-clock snapshot: Date.now() is impure, so capture it once (via the
  // state initializer) instead of calling it inside a render-time helper.
  const [nowMs] = useState(() => Date.now())
  const bucketOf = (dateStr: string) => {
    const ageDays = Math.floor((nowMs - new Date(dateStr).getTime()) / 86_400_000)
    return ageDays <= 30 ? '0–30 days' : ageDays <= 60 ? '31–60 days' : ageDays <= 90 ? '61–90 days' : '90+ days'
  }

  const exportPdf = async () => {
    if (!summary || !stats) return
    const html = `<!doctype html><html><head><title>Business Report</title><style>
      body{font-family:Arial,sans-serif;color:#111;margin:32px}
      h1{font-size:20px;margin:0 0 4px}.sub{color:#64748b;font-size:12px;margin-bottom:20px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th{text-align:left;background:#f1f5f9;padding:8px} td{padding:8px;border-top:1px solid #e2e8f0}
    </style></head><body>
      <h1>Opal Line · Business Report</h1>
      <div class="sub">${escapeHtml(new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }))}</div>
      <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Revenue (Month)</td><td>${escapeHtml(formatCurrency(stats.revenueMonth))}</td></tr>
        <tr><td>Orders (Month)</td><td>${escapeHtml(String(stats.ordersMonth))}</td></tr>
        <tr><td>Avg Order Value</td><td>${escapeHtml(formatCurrency(stats.aov))}</td></tr>
        <tr><td>Gross Profit (Month)</td><td>${escapeHtml(formatCurrency(stats.grossProfitMonth))} (${escapeHtml(stats.grossMarginPct.toFixed(1))}% margin)</td></tr>
        <tr><td>Inventory Value</td><td>${escapeHtml(formatCurrency(stats.inventoryValue))}</td></tr>
        <tr><td>Low Stock Items</td><td>${escapeHtml(String(stats.lowStockCount))}</td></tr>
        <tr><td>Return Rate</td><td>${escapeHtml(stats.returnRatePct.toFixed(1))}%</td></tr>
        <tr><td>Total Stock (Qty)</td><td>${escapeHtml(String(summary.totalStockQty))}</td></tr>
        <tr><td>Total Stock (Weight)</td><td>${escapeHtml(String(summary.totalStockWeight))} gm</td></tr>
        <tr><td>Active Suppliers</td><td>${escapeHtml(String(summary.activeSuppliers))} of ${escapeHtml(String(summary.totalSuppliers))}</td></tr>
        <tr><td>Pending Payments</td><td>${escapeHtml(formatCurrency(summary.pendingPayments))}</td></tr>
      </table>
    </body></html>`
    // Desktop: renderToPDF + save dialog (no printer needed). Browser: the
    // old print popup, where the user picks "Save as PDF".
    const res = await exportHtmlPdf(html, 'opal-line-business-report')
    if (res.ok) {
      if (res.path) toast.success(`PDF saved to ${res.path}`)
      else toast.success('Choose "Save as PDF" in the print dialog to save the report.')
    } else if (!res.cancelled) {
      toast.error(`Could not export the PDF: ${res.error ?? 'unknown error'}`)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <PageHeader
        title="Business Reports"
        subtitle="One-page snapshot of the Opal Line business — sales, inventory, customers and suppliers."
        actions={
          <>
            <Select
              options={[
                { value: 'month', label: 'This Month' },
                { value: 'quarter', label: 'This Quarter' },
                { value: 'year', label: 'This Year' },
              ]}
              value={period}
              onValueChange={setPeriod}
              className="w-[150px]"
            />
            <Button variant="outline" size="sm" onClick={exportPdf}>
              <Download className="h-3.5 w-3.5" /> Export PDF
            </Button>
          </>
        }
      />

      {!summary || !stats ? (
        <Card className="flex h-48 items-center justify-center text-sm text-muted-foreground">Loading summary...</Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MiniCard icon={IndianRupee} label="Revenue (Month)" value={formatCurrency(stats?.revenueMonth ?? 0)} sub="Current month sales" tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
            <MiniCard icon={Package} label="AOV" value={formatCurrency(stats?.aov ?? 0)} sub={`${stats?.ordersMonth ?? 0} orders`} tint="bg-info-50 text-info-700" />
            <MiniCard icon={Users} label="Return Rate" value={`${stats ? stats.returnRatePct.toFixed(1) : '0.0'}%`} sub="Of total orders" tint="bg-success-50 text-success-700" />
            <MiniCard icon={BarChart3} label="Gross Profit (Month)" value={formatCurrency(stats?.grossProfitMonth ?? 0)} sub={`${stats ? stats.grossMarginPct.toFixed(1) : '0.0'}% margin`} tint="bg-warning-50 text-warning-700" />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">Business Snapshot</h3>
                  <CalendarDays className="ml-auto h-4 w-4 text-muted-foreground" />
                </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                   <SnapshotStat label="Total Stock (Qty)" value={String(summary.totalStockQty)} />
                   <SnapshotStat label="Total Stock (Weight)" value={`${summary.totalStockWeight} gm`} />
                   <SnapshotStat label="Suppliers" value={String(summary.totalSuppliers)} />
                   <SnapshotStat label="Active Suppliers" value={String(summary.activeSuppliers)} />
                    <SnapshotStat label="Today's Expenses" value={formatCurrency(summary?.todayExpenses ?? 0)} />
                   <SnapshotStat label="Gross Profit" value={formatCurrency(stats?.grossProfitMonth ?? 0)} />
                 </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">Quick Highlights</h3>
                </div>
                <div className="space-y-3">
                  <HighlightRow label="AOV" value={formatCurrency(stats?.aov ?? 0)} delta="Per order" />
                  <HighlightRow label="Return Rate" value={`${stats ? stats.returnRatePct.toFixed(2) : '0.00'}%`} delta="Returns vs invoices" />
                  <HighlightRow label="Gross Margin" value={`${stats ? stats.grossMarginPct.toFixed(2) : '0.00'}%`} delta="Current month" />
                  <HighlightRow label="Inventory Value" value={formatCurrency(stats?.inventoryValue ?? 0)} delta="At current rate" />
                  <HighlightRow label="Low Stock Items" value={String(stats?.lowStockCount ?? 0)} delta="Needs reorder" />
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground">Outstanding Aging</h3>
                <span className="ml-auto text-xs text-muted-foreground">
                  {stats.agingTotal > 0 ? `${formatCurrency(stats.agingTotal)} outstanding` : 'Nothing outstanding'}
                </span>
              </div>
              {stats.agingTotal === 0 ? (
                <p className="text-sm text-muted-foreground">All invoices are settled — no outstanding receivables.</p>
              ) : (
                <div>
                  {/* stacked bar */}
                  <div className="mb-3 flex h-3 w-full overflow-hidden rounded-full bg-muted">
                    {stats.aging.map((b) =>
                      b.amount > 0 ? (
                        <div
                          key={b.label}
                          className={b.label === '0–30 days' ? 'bg-emerald-500' : b.label === '31–60 days' ? 'bg-amber-500' : b.label === '61–90 days' ? 'bg-orange-500' : 'bg-red-500'}
                          style={{ width: `${(b.amount / stats.agingTotal) * 100}%` }}
                        />
                      ) : null,
                    )}
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="pb-2 font-medium">Age</th>
                        <th className="pb-2 text-right font-medium">Invoices</th>
                        <th className="pb-2 text-right font-medium">Amount</th>
                        <th className="pb-2 text-right font-medium">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.aging.map((b) => (
                        <tr
                          key={b.label}
                          className={`border-t border-border/60 ${b.count > 0 ? 'cursor-pointer hover:bg-muted/60' : ''}`}
                          onClick={() => { if (b.count > 0) setDrillBucket(drillBucket === b.label ? null : b.label) }}
                        >
                          <td className="py-2">
                            <span className="inline-flex items-center gap-2">
                              <span
                                className={`h-2 w-2 rounded-full ${b.label === '0–30 days' ? 'bg-emerald-500' : b.label === '31–60 days' ? 'bg-amber-500' : b.label === '61–90 days' ? 'bg-orange-500' : 'bg-red-500'}`}
                              />
                              {b.label}
                            </span>
                          </td>
                          <td className="py-2 text-right tabular-nums">{b.count}</td>
                          <td className="py-2 text-right tabular-nums font-medium text-foreground">{formatCurrency(b.amount)}</td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground">
                            {stats.agingTotal > 0 ? `${((b.amount / stats.agingTotal) * 100).toFixed(0)}%` : '0%'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {drillBucket ? (
                    <div className="mt-3 rounded-md border border-border/60 bg-muted/20 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{drillBucket} — by invoice</p>
                        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setDrillBucket(null)}>✕ close</button>
                      </div>
                      <div className="space-y-1">
                        {openInvoices.filter((inv) => bucketOf(inv.date) === drillBucket).map((inv) => (
                          <div key={inv.id} className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-sm">
                            <span className="shrink-0 font-medium text-foreground">{inv.number}</span>
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">{inv.customer}</span>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{new Date(inv.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>
                            <span className="shrink-0 tabular-nums font-medium text-foreground">{formatCurrency(inv.grandTotal)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3 p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success-50 text-success-700">
                <Boxes className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">Inventory valuation by current silver rate</p>
                <p className="text-xs text-muted-foreground">
                  {summary.totalStockWeight} gm of finished silver at ₹{rate ? rate.rate.toFixed(2) : '—'}/gm ≈{' '}
                  {formatCurrency(summary.totalStockWeight * (rate?.rate ?? 0))}
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      )}
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

function SnapshotStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

function HighlightRow({ label, value, delta }: { label: string; value: string; delta: string }) {
  return (
    <div className="flex items-center justify-between border-b pb-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-semibold tabular-nums text-foreground">{value}</span>
        <span className="text-[11px] text-success-700">{delta}</span>
      </span>
    </div>
  )
}
