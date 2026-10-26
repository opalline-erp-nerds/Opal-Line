import { useCallback, useEffect, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, BarChart3, Info, ShieldAlert, ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dbApi } from '@/lib/api'
import type { FinancialRangeKey, FinancialSummary, Trend } from '@/types'
import { compactCurrency } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AGING_COLORS, EXPENSE, INCOME, SLICE_COLORS, inr } from '@/components/charts/chart-theme'
import { ExpenseDonutChart, IncomeExpenseChart, ReceivableAgingChart } from '@/components/charts/financial-charts'

/**
 * Financial Analytics — three chart cards that own their data and range.
 *
 * The section deliberately does NOT follow the page-wide filter: it fetches
 * itself (default Last 12 Months) so users can compare a wide financial
 * window while the KPI cards above stay on Today. Cards 1 and 3 share one
 * range dropdown; the Receivable Summary is point-in-time ("As of now").
 */

const FINANCIAL_RANGES: ReadonlyArray<{ key: FinancialRangeKey; label: string }> = [
  { key: 'last30', label: 'Last 30 Days' },
  { key: 'last3m', label: 'Last 3 Months' },
  { key: 'last6m', label: 'Last 6 Months' },
  { key: 'last12m', label: 'Last 12 Months' },
  { key: 'year', label: 'This Year' },
]

/** Last completed fetch; matched against the current range/attempt to derive
 * loading/error during render (no synchronous setState inside the effect). */
interface FinancialFetch {
  range: FinancialRangeKey
  attempt: number
  data: FinancialSummary | null
  error: string | null
}

export function FinancialAnalytics() {
  const [range, setRange] = useState<FinancialRangeKey>('last12m')
  const [result, setResult] = useState<FinancialFetch | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    dbApi
      .getDashboardFinancial(range)
      .then(
        (data) => {
          if (!cancelled) setResult({ range, attempt, data, error: null })
        },
        () => {
          if (!cancelled) setResult({ range, attempt, data: null, error: 'Couldn\'t load financial summary' })
        },
      )
    return () => {
      cancelled = true
    }
  }, [range, attempt])

  const matched = result !== null && result.range === range && result.attempt === attempt
  const loading = !matched
  const data = matched ? result.data : null
  const error = matched ? result.error : null

  const reload = useCallback(() => setAttempt((a) => a + 1), [])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
          <BarChart3 className="h-4 w-4" />
        </div>
        <h2 className="text-sm font-semibold text-foreground">Financial Analytics</h2>
        <Badge variant="muted" className="text-[10px]">
          Live from Orders, Invoices &amp; Expenses
        </Badge>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="How this section gets its range"
                className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px]">
              Runs on its own range (default Last 12 Months) — independent of the page filter. Use the dropdown on a
              card to change it.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* ── Income vs Expense ─────────────────────────────────────────── */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">Income vs Expense</CardTitle>
            <RangeSelect value={range} onChange={setRange} />
          </CardHeader>
          <CardContent>
            {error ? (
              <CardError onRetry={reload} />
            ) : loading || !data ? (
              <CardSkeleton />
            ) : (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Net Revenue</p>
                    <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
                      {compactCurrency(data.netRevenue)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <span
                      className={cn(
                        'whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold tabular-nums',
                        data.net < 0
                          ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                          : 'bg-success-50 text-success-700 dark:bg-success-700/20 dark:text-success-300',
                      )}
                    >
                      Net {data.net < 0 ? '−' : '+'}
                      {compactCurrency(Math.abs(data.net))}
                    </span>
                    <DeltaText trend={data.netRevenueTrend} delta={data.netRevenueDelta} suffix={data.prevLabel} />
                  </div>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {compactCurrency(data.sales)} invoiced
                  {data.returns > 0 ? ` − ${compactCurrency(data.returns)} returns` : ''}
                </p>
                <div className="mt-3 flex items-center gap-4 text-[11px]">
                  <LegendDot color={INCOME} label="Income" value={compactCurrency(data.income)} />
                  <LegendDot color={EXPENSE} label="Expense" value={compactCurrency(data.expense)} />
                </div>
                <div className="mt-2">
                  <IncomeExpenseChart
                    points={data.points}
                    emptyMessage={isBlank(data.points) ? 'No income or expenses in this period' : undefined}
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── Receivable Summary (point in time) ────────────────────────── */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">Receivable Summary</CardTitle>
            <Badge variant="muted" className="text-[10px]">
              As of now
            </Badge>
          </CardHeader>
          <CardContent>
            {error ? (
              <CardError onRetry={reload} />
            ) : loading || !data ? (
              <CardSkeleton />
            ) : (
              <ReceivableBody data={data} />
            )}
          </CardContent>
        </Card>

        {/* ── Top Expense ───────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">Top Expense</CardTitle>
            <RangeSelect value={range} onChange={setRange} />
          </CardHeader>
          <CardContent>
            {error ? (
              <CardError onRetry={reload} />
            ) : loading || !data ? (
              <CardSkeleton />
            ) : data.expenses.length === 0 || data.expense === 0 ? (
              <div className="flex h-[210px] flex-col items-center justify-center gap-1 text-center">
                <p className="text-sm font-medium text-muted-foreground">No expenses recorded in this period</p>
                <p className="text-[11px] text-muted-foreground">Expenses you record in this range will be charted here.</p>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Total spent</p>
                    <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{compactCurrency(data.expense)}</p>
                  </div>
                  <DeltaText trend={data.expenseTrend} delta={data.expenseDelta} goodWhenDown suffix={data.prevLabel} />
                </div>
                <div className="mt-2 flex flex-col items-center gap-3 sm:flex-row sm:items-center">
                  <div className="w-full shrink-0 sm:w-[210px]">
                    <ExpenseDonutChart
                      slices={data.expenses}
                      centerLabel="Total"
                      centerValue={compactCurrency(data.expense)}
                      fixedSize={{ width: 210, height: 210 }}
                    />
                  </div>
                  <div className="w-full min-w-0 space-y-1">
                    {data.expenses.map((slice, i) => (
                      <div key={slice.category} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }}
                          />
                          <span className="truncate">{slice.category}</span>
                        </span>
                        <span className="shrink-0 font-medium tabular-nums text-foreground">
                          {compactCurrency(slice.amount)}
                          <span className="ml-1 text-muted-foreground">{slice.share}%</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/** Receivable card body — exported for server-render tests. */
export function ReceivableBody({ data }: { data: FinancialSummary }) {
  const { receivable } = data
  if (receivable.invoiceCount === 0) {
    return (
      <div className="flex h-[210px] flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm font-medium text-muted-foreground">No invoices yet</p>
        <p className="text-[11px] text-muted-foreground">Receivables appear here as soon as you create an invoice.</p>
      </div>
    )
  }
  return (
    <>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md bg-muted/50 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Invoiced total</p>
          <p className="truncate text-[13px] font-semibold tabular-nums text-foreground">{inr(receivable.invoicedTotal)}</p>
          <p className="text-[10px] text-muted-foreground">
            {receivable.invoiceCount} invoice{receivable.invoiceCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Received</p>
          <p className="truncate text-[13px] font-semibold tabular-nums text-success-700">{inr(receivable.paid)}</p>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Outstanding</p>
          <p className="truncate text-[13px] font-semibold tabular-nums text-red-600 dark:text-red-400">
            {inr(receivable.outstanding)}
          </p>
        </div>
      </div>
      {receivable.outstanding > 0 ? (
        <div className="mt-3 flex flex-col items-center gap-3 sm:flex-row sm:items-center">
          <div className="w-full shrink-0 sm:w-[210px]">
            <ReceivableAgingChart
              aging={receivable.aging}
              centerLabel="Outstanding"
              centerValue={compactCurrency(receivable.outstanding)}
              fixedSize={{ width: 210, height: 210 }}
            />
          </div>
          <div className="w-full min-w-0 space-y-1">
            {receivable.aging.map((band, i) => (
              <div key={band.key} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: AGING_COLORS[i] ?? AGING_COLORS[AGING_COLORS.length - 1] }} />
                  <span className="truncate">{band.label}</span>
                </span>
                <span className="shrink-0 font-medium tabular-nums text-foreground">
                  {band.value > 0 ? inr(band.value) : '—'}
                  {band.count > 0 ? <span className="ml-1 text-muted-foreground">· {band.count}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex h-[120px] flex-col items-center justify-center gap-1 text-center">
          <p className="text-sm font-medium text-muted-foreground">All invoices are settled — no outstanding balances.</p>
        </div>
      )}
    </>
  )
}

function RangeSelect({ value, onChange }: { value: FinancialRangeKey; onChange: (key: FinancialRangeKey) => void }) {
  const current = FINANCIAL_RANGES.find((r) => r.key === value) ?? FINANCIAL_RANGES[3]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]">
          {current.label}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {FINANCIAL_RANGES.map((option) => (
          <DropdownMenuItem key={option.key} onClick={() => onChange(option.key)} className="gap-2 text-xs">
            <span className="flex h-3.5 w-3.5 items-center justify-center">
              {option.key === value ? <Check className="h-3.5 w-3.5" /> : null}
            </span>
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CardSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-28" />
      </div>
      <Skeleton className="h-[240px] w-full" />
    </div>
  )
}

/** Per-card error block — exported for server-render tests. */
export function CardError({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      icon={ShieldAlert}
      title="Couldn't load this card"
      description="There was an error fetching the financial figures. Please try again."
      action={
        <Button size="sm" variant="soft-primary" onClick={onRetry}>
          Retry
        </Button>
      }
    />
  )
}

function LegendDot({ color, label, value }: { color: string; label: string; value?: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
      {value ? <span className="font-medium tabular-nums text-foreground">{value}</span> : null}
    </span>
  )
}

/** True when every bucket has no income and no expense (flat zero line). */
function isBlank(points: FinancialSummary['points']): boolean {
  return points.every((p) => p.income === 0 && p.expense === 0)
}

/** Small trend line: arrow + delta vs the previous window, colored by meaning.
 * `goodWhenDown` flips the colors for metrics where a fall is an improvement
 * (expenses, overdue balances). A flat '—' delta renders as plain muted text. */
function DeltaText({
  trend,
  delta,
  suffix,
  goodWhenDown,
}: {
  trend: Trend
  delta: string
  suffix?: string
  goodWhenDown?: boolean
}) {
  if (trend === 'flat' || delta === '—') {
    return (
      <span className="text-[11px] text-muted-foreground">
        {delta}
        {suffix ? ` · ${suffix}` : ''}
      </span>
    )
  }
  const good = goodWhenDown ? trend === 'down' : trend === 'up'
  return (
    <span
      className={cn(
        'flex items-center gap-0.5 text-[11px] font-semibold',
        good ? 'text-success-700' : 'text-red-600 dark:text-red-400',
      )}
    >
      {trend === 'up' ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {delta}
      {suffix ? <span className="font-normal text-muted-foreground">· {suffix}</span> : null}
    </span>
  )
}
