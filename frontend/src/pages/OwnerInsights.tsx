import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ChevronRight, TrendingUp, Trophy, IndianRupee } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { dbApi } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import type { ProfitAnalytics } from '@/types'

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, 1).toLocaleString('en-IN', { month: 'short', year: '2-digit' })
}

export default function OwnerInsightsPage() {
  const [data, setData] = useState<ProfitAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [months, setMonths] = useState(12)

  useEffect(() => {
    // Defer out of the effect body: setLoading fires synchronously (react/set-state-in-effect).
    queueMicrotask(() => {
      setLoading(true)
      dbApi.getProfitAnalytics(months).then(setData).catch(() => setData(null)).finally(() => setLoading(false))
    })
  }, [months])

  const chart = useMemo(() => {
    if (!data) return null
    const maxAbs = Math.max(...data.months.map((m) => Math.max(m.revenue, m.grossProfit, m.netProfit)), 1)
    return { maxAbs }
  }, [data])

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[1300px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
        </div>
        <Skeleton className="h-80 rounded-lg" />
      </div>
    )
  }

  if (!data) {
    return <div className="px-6 py-6 text-sm text-muted-foreground">Profit analytics unavailable.</div>
  }

  const stat = (label: string, value: string, accent: string, sub?: string) => (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={`mt-1 text-2xl font-bold tabular-nums ${accent}`}>{value}</p>
        {sub ? <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  )

  return (
    <div className="mx-auto w-full max-w-[1300px] space-y-5 px-5 py-5 sm:py-6 lg:px-7">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/" className="flex items-center gap-1 hover:text-primary-700">
          <ArrowLeft className="h-3 w-3" /> Dashboard
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">Owner Insights</span>
      </div>

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300 ring-1 ring-primary-100">
              <TrendingUp className="h-5 w-5" />
            </div>
            <span>Owner Insights</span>
          </span>
        }
        subtitle="Profit trends, best sellers and expense breakdown across the business."
        actions={
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="h-9 rounded-md border bg-card px-3 text-sm"
          >
            {[3, 6, 12, 24].map((m) => <option key={m} value={m}>Last {m} months</option>)}
          </select>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stat('Revenue', formatCurrency(data.totals.revenue), 'text-foreground', `${data.months.reduce((a, m) => a + m.invoices, 0)} invoices`)}
        {stat('Gross Profit', formatCurrency(data.totals.grossProfit), 'text-success-700', `${data.totals.grossMargin}% margin`)}
        {stat('Expenses', formatCurrency(data.totals.expenses), 'text-warning-600')}
        {stat('Net Profit', formatCurrency(data.totals.netProfit), data.totals.netProfit >= 0 ? 'text-success-700' : 'text-destructive')}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Monthly Profit Trend</CardTitle>
          <CardDescription>Revenue vs gross vs net profit, net of sales returns and expenses.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2.5">
            {data.months.map((m) => (
              <div key={m.month} className="grid grid-cols-[70px_1fr_130px] items-center gap-3">
                <span className="text-xs font-medium text-muted-foreground">{monthLabel(m.month)}</span>
                <div className="space-y-1">
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary-500" style={{ width: `${Math.max(2, (m.revenue / (chart?.maxAbs ?? 1)) * 100)}%` }} />
                  </div>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-success-500" style={{ width: `${Math.max(0, (m.grossProfit / (chart?.maxAbs ?? 1)) * 100)}%` }} />
                  </div>
                </div>
                <div className="text-right text-xs tabular-nums">
                  <span className="font-semibold text-foreground">{formatCurrency(m.grossProfit)}</span>
                  <span className="ml-1 text-muted-foreground">({m.grossMargin}%)</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary-500" /> Revenue</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success-500" /> Gross profit</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><Trophy className="h-4 w-4 text-warning-500" /> Best Sellers by Profit</CardTitle>
            <CardDescription>Top products ranked by profit contribution (metal value excluded).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.bestSellers.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No invoice line items yet.</p>
            ) : (
              data.bestSellers.map((b, i) => (
                <div key={b.sku} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/40">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{b.name}</p>
                    <p className="text-[11px] text-muted-foreground">{b.sku} · {b.qty} sold · {formatCurrency(b.revenue)} revenue</p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-success-700">{formatCurrency(b.profit)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><IndianRupee className="h-4 w-4 text-warning-500" /> Expense Breakdown</CardTitle>
            <CardDescription>Where money went over the selected period.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.expenseBreakdown.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No expenses recorded in this period.</p>
            ) : (
              data.expenseBreakdown.map((e) => {
                const max = data.expenseBreakdown[0]?.amount ?? 1
                return (
                  <div key={e.category} className="flex items-center gap-3">
                    <span className="w-32 truncate text-xs font-medium text-foreground">{e.category}</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-warning-400" style={{ width: `${Math.max(2, (e.amount / max) * 100)}%` }} />
                    </div>
                    <span className="w-24 text-right text-xs font-semibold tabular-nums text-foreground">{formatCurrency(e.amount)}</span>
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Badge variant="muted">Note</Badge>
        <span>Cost is approximated as silver value + making charges on each invoice. Set cost prices on products to enable exact margin tracking.</span>
      </div>
    </div>
  )
}
