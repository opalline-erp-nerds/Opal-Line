import type { ComponentType } from 'react'
import { ArrowDownRight, ArrowUpRight, IndianRupee, ShoppingBag, Users } from 'lucide-react'
import type { SalesInsights, SalesSourceKey } from '@/types'
import { formatCurrency, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SERIES_COLORS } from '@/components/charts/chart-theme'
import { Sparkline } from '@/components/charts/sparkline'

const ORDER_COLOR = SERIES_COLORS[0]
const REVENUE_COLOR = SERIES_COLORS[1]
const CUSTOMER_COLOR = SERIES_COLORS[2]

function growthPct(current: number, previous: number): number | null {
  if (previous > 0) return Math.round((((current - previous) / previous) * 100) * 10) / 10
  return current > 0 ? null : 0
}

function GrowthBadge({ change }: { change: number | null }) {
  if (change === null) {
    return <span className="text-[10px] font-medium text-primary-700">New</span>
  }
  const positive = change >= 0
  const Icon = positive ? ArrowUpRight : ArrowDownRight
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold tabular-nums',
        positive ? 'bg-success-50 text-success-700' : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {positive ? '+' : ''}{change.toFixed(1)}%
    </span>
  )
}

function KpiCard({
  label,
  value,
  change,
  trend,
  color,
  tint,
  icon: Icon,
  hint,
}: {
  label: string
  value: string
  change: number | null
  trend: number[]
  color: string
  tint: string
  icon: ComponentType<{ className?: string }>
  hint?: string
}) {
  return (
    <div
      title={hint}
      className="flex h-full flex-col rounded-2xl border border-border/70 bg-card p-4 shadow-kpi transition-shadow hover:shadow-card-hover"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-[19px] font-bold tabular-nums text-foreground">{value}</p>
        </div>
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', tint)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
      </div>
      <div className="mt-auto flex items-end justify-between gap-2 pt-2">
        <GrowthBadge change={change} />
        <div className="h-7 w-16 shrink-0">
          <Sparkline values={trend} color={color} />
        </div>
      </div>
    </div>
  )
}

export function SalesKpiCards({ insights, source }: { insights: SalesInsights; source: SalesSourceKey }) {
  const current = insights.current[source]
  const previous = insights.previous[source]
  const trend = insights.trends[source]
  return (
    <div className="grid auto-rows-fr grid-cols-1 gap-2.5 sm:grid-cols-3">
      <KpiCard
        label="Total Orders"
        value={formatNumber(current.orders)}
        change={growthPct(current.orders, previous.orders)}
        trend={trend.orders}
        color={ORDER_COLOR}
        tint="bg-primary-50 text-primary-600"
        icon={ShoppingBag}
      />
      <KpiCard
        label="Total Revenue"
        value={formatCurrency(current.revenue)}
        change={growthPct(current.revenue, previous.revenue)}
        trend={trend.revenue}
        color={REVENUE_COLOR}
        tint="bg-primary-50 text-primary-700"
        icon={IndianRupee}
      />
      <KpiCard
        label="Total Customers"
        value={formatNumber(current.customers)}
        change={growthPct(current.customers, previous.customers)}
        trend={trend.customers}
        color={CUSTOMER_COLOR}
        tint="bg-primary-100 text-primary-700"
        icon={Users}
      />
    </div>
  )
}
