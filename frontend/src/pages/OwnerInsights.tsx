import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ChevronRight, TrendingUp, Trophy, IndianRupee, AlertTriangle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { dbApi } from '@/lib/api'
import {
  ownerBarTone,
  ownerBarWidth,
  ownerChartMax,
  ownerMarginLabel,
  ownerMoney,
  ownerMonthLabel,
  ownerProfitTone,
} from '@/lib/ownerInsights'
import type { InventoryLocation, ProfitAnalytics } from '@/types'

export default function OwnerInsightsPage() {
  const [data, setData] = useState<ProfitAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [months, setMonths] = useState(12)
  const [locationId, setLocationId] = useState('')
  const [locations, setLocations] = useState<InventoryLocation[]>([])

  useEffect(() => {
    queueMicrotask(() => {
      dbApi.getInventoryLocations().then(setLocations).catch(() => setLocations([]))
    })
  }, [])

  useEffect(() => {
    // Defer out of the effect body: setLoading fires synchronously (react/set-state-in-effect).
    queueMicrotask(() => {
      setLoading(true)
      dbApi
        .getProfitAnalytics(months, locationId || undefined)
        .then(setData)
        .catch(() => setData(null))
        .finally(() => setLoading(false))
    })
  }, [months, locationId])

  const chartMax = useMemo(() => ownerChartMax(data?.months ?? []), [data])

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[1300px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
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
        <p className={`mt-1 whitespace-nowrap text-2xl font-bold tabular-nums ${accent}`}>{value}</p>
        {sub ? <p className="mt-0.5 whitespace-nowrap text-[11px] text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  )

  const series = [
    { key: 'revenue', label: 'Revenue', value: (m: (typeof data.months)[number]) => m.revenue, color: 'bg-primary-500', positive: 'bg-primary-500' },
    { key: 'grossProfit', label: 'Gross profit', value: (m: (typeof data.months)[number]) => m.grossProfit, color: 'bg-success', positive: 'bg-success' },
    { key: 'netProfit', label: 'Net profit', value: (m: (typeof data.months)[number]) => m.netProfit, color: 'bg-primary-700', positive: 'bg-primary-700' },
  ]

  const hasDataIssues = data.costAnomalies.length > 0 || data.totals.uncostedLines > 0

  return (
    <div className="mx-auto w-full max-w-[1300px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
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
          <div className="flex items-center gap-2">
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="h-9 rounded-md border bg-card px-3 text-sm"
              aria-label="Store"
              data-testid="owner-store-filter"
            >
              <option value="">All Stores</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <select
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
              className="h-9 rounded-md border bg-card px-3 text-sm"
              aria-label="Months"
            >
              {[3, 6, 12, 24].map((m) => <option key={m} value={m}>Last {m} months</option>)}
            </select>
          </div>
        }
      />

      {hasDataIssues ? (
        <Card className="border-warning bg-warning-50/60 dark:bg-warning-50/30">
          <CardContent className="flex flex-wrap items-start gap-2 p-3 text-xs text-warning-700 dark:text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Cost data needs attention: {data.costAnomalies.length} product(s) have cost price above selling price
              {data.costAnomalies.length > 0 ? ` (${data.costAnomalies.slice(0, 3).map((a) => a.sku).join(', ')}${data.costAnomalies.length > 3 ? '…' : ''})` : ''}
              {data.totals.uncostedLines > 0 ? ` and ${data.totals.uncostedLines} sold line(s) have no cost price, so their profit is counted at zero COGS` : ''}.
              Margins are only as accurate as the cost prices on products and variants.
            </span>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stat(
          'Revenue',
          ownerMoney(data.totals.revenue),
          'text-foreground',
          `${data.months.reduce((a, m) => a + m.invoices, 0)} invoices · ${ownerMoney(data.totals.returns)} returns`,
        )}
        {stat(
          'Gross Profit',
          ownerMoney(data.totals.grossProfit),
          ownerProfitTone(data.totals.grossProfit),
          `${ownerMarginLabel(data.totals.grossMargin)} margin · COGS ${ownerMoney(data.totals.cogs)}`,
        )}
        {stat('Expenses', ownerMoney(data.totals.expenses), 'text-warning', 'Company-wide operating costs')}
        {stat('Net Profit', ownerMoney(data.totals.netProfit), ownerProfitTone(data.totals.netProfit), 'Gross profit less expenses')}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Monthly Profit Trend</CardTitle>
          <CardDescription>Revenue vs gross vs net profit, ex-GST, net of returns and expenses.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {data.months.map((m) => (
              <div key={m.month} className="grid grid-cols-[58px_minmax(0,1fr)_minmax(140px,auto)] items-center gap-3">
                <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">{ownerMonthLabel(m.month)}</span>
                <div className="space-y-1">
                  {series.map((s) => {
                    const value = s.value(m)
                    return (
                      <div key={s.key} className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${ownerBarTone(value, s.positive)}`}
                          style={{ width: `${ownerBarWidth(value, chartMax)}%` }}
                        />
                      </div>
                    )
                  })}
                </div>
                <div className="whitespace-nowrap text-right text-xs tabular-nums">
                  <div className={ownerProfitTone(m.grossProfit)}>
                    <span className="font-semibold">{ownerMoney(m.grossProfit)}</span>
                    <span className="ml-1 opacity-80">({ownerMarginLabel(m.grossMargin)})</span>
                  </div>
                  <div className={`mt-0.5 ${ownerProfitTone(m.netProfit)}`}>
                    <span className="opacity-80">Net </span>
                    <span className="font-semibold">{ownerMoney(m.netProfit)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${s.color}`} /> {s.label}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-destructive" /> Negative profit
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><Trophy className="h-4 w-4 text-warning" /> Best Sellers by Profit</CardTitle>
            <CardDescription>Top products ranked by gross profit on units actually sold.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.bestSellers.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No invoice line items yet.</p>
            ) : (
              data.bestSellers.map((b, i) => (
                <div key={`${b.sku}-${b.variant ?? ''}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/40">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {b.name}{b.variant ? <span className="ml-1 text-muted-foreground">· {b.variant}</span> : null}
                    </p>
                    <p className="whitespace-nowrap text-[11px] text-muted-foreground">{b.sku} · {b.qty} sold · {ownerMoney(b.revenue)} revenue</p>
                  </div>
                  <span className={`shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums ${ownerProfitTone(b.profit)}`}>{ownerMoney(b.profit)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><IndianRupee className="h-4 w-4 text-warning" /> Expense Breakdown</CardTitle>
            <CardDescription>
              Where money went over the selected period.{data.expensesAreCompanyWide ? ' Expenses are company-wide.' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.expenseBreakdown.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No expenses recorded in this period.</p>
            ) : (
              data.expenseBreakdown.map((e) => {
                const max = Math.max(...data.expenseBreakdown.map((row) => row.amount), 0)
                return (
                  <div key={e.category} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-xs font-medium text-foreground">{e.category}</span>
                    <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-warning"
                        style={{ width: `${ownerBarWidth(e.amount, max)}%` }}
                      />
                    </div>
                    <span className="w-28 shrink-0 whitespace-nowrap text-right text-xs font-semibold tabular-nums text-foreground">{ownerMoney(e.amount)}</span>
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <Badge variant="muted">Basis</Badge>
        <span>
          Revenue and COGS are ex-GST. COGS is qty × weighted-average cost price, variant cost first; making charges are
          revenue, not cost. Sales returns reverse both revenue and COGS. Purchase invoices add inventory and are never
          subtracted from profit.
        </span>
      </div>
    </div>
  )
}
