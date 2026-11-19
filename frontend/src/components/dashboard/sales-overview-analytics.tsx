import type { ComponentType } from 'react'
import { ArrowDownRight, ArrowUpRight, IndianRupee, ShoppingBag, Users } from 'lucide-react'
import type { SalesInsights, SalesSourceKey } from '@/types'
import { formatCurrency, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

const ORDER_COLOR = '#7C5CE6'
const REVENUE_COLOR = '#2FBF71'
const CUSTOMER_COLOR = '#2F5BE0'

function growthPct(current: number, previous: number): number | null {
  if (previous > 0) return Math.round((((current - previous) / previous) * 100) * 10) / 10
  return current > 0 ? null : 0
}

function GrowthBadge({ change }: { change: number | null }) {
  if (change === null) {
    return <span className="text-[10px] font-medium text-info-700">New</span>
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

/** Tiny dependency-free trend line for the KPI cards. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const points = values.length > 1 ? values : [0, ...values]
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const coords = points.map((value, index) => {
    const x = (index / (points.length - 1)) * 100
    const y = 25 - ((value - min) / span) * 21
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg viewBox="0 0 100 28" className="h-7 w-full" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,28 ${coords.join(' ')} 100,28`} fill={color} opacity={0.08} />
      <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
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
      className="flex h-full flex-col rounded-xl border border-border/70 bg-card p-3 shadow-sm transition-shadow hover:shadow-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-[17px] font-semibold tabular-nums text-foreground">{value}</p>
        </div>
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', tint)}>
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
        tint="bg-[#F1EDFC] text-[#6D4CD6]"
        icon={ShoppingBag}
      />
      <KpiCard
        label="Total Revenue"
        value={formatCurrency(current.revenue)}
        change={growthPct(current.revenue, previous.revenue)}
        trend={trend.revenue}
        color={REVENUE_COLOR}
        tint="bg-success-50 text-success-700"
        icon={IndianRupee}
      />
      <KpiCard
        label="Total Customers"
        value={formatNumber(current.customers)}
        change={growthPct(current.customers, previous.customers)}
        trend={trend.customers}
        color={CUSTOMER_COLOR}
        tint="bg-info-50 text-info-700"
        icon={Users}
      />
    </div>
  )
}
