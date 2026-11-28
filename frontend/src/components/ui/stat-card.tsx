import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Sparkline } from '@/components/charts/sparkline'
import { cn } from '@/lib/utils'

const accentStyles = {
  teal: {
    icon: 'bg-primary-50 text-primary-600',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  green: {
    icon: 'bg-success-50 text-success-700',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  orange: {
    icon: 'bg-warning-50 text-warning-700',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  red: {
    icon: 'bg-red-50 text-red-600 dark:text-red-400',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  blue: {
    icon: 'bg-info-50 text-info-700',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  slate: {
    icon: 'bg-muted text-muted-foreground',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  champagne: {
    icon: 'bg-gold-muted text-gold-foreground',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
}

interface StatCardProps {
  icon: LucideIcon
  title: string
  value: string
  trend?: 'up' | 'down' | 'flat'
  delta?: string
  /** Context for the delta, e.g. "vs yesterday" or "vs last week". */
  deltaLabel?: string
  support?: string
  accent?: keyof typeof accentStyles
  /** Real series for the corner sparkline. Omit for cards with no series. */
  sparkline?: number[]
  sparklineColor?: string
  /** Point-in-time metric: draws a dashed flat line instead of a fake trend. */
  snapshot?: boolean
  /** Retained for call-site compatibility; the cards are always light. */
  variant?: 'default' | 'gradient'
  className?: string
}

export function StatCard({
  icon: Icon,
  title,
  value,
  trend,
  delta,
  deltaLabel,
  support,
  accent = 'teal',
  sparkline,
  sparklineColor = '#008F78',
  snapshot = false,
  className,
}: StatCardProps) {
  const styles = accentStyles[accent]
  const showSparkline = snapshot || (sparkline != null && sparkline.length > 0)

  return (
    <div
      className={cn(
        'group flex min-h-[124px] flex-col rounded-2xl border border-border/70 bg-card p-5 shadow-kpi transition-all hover:-translate-y-px hover:shadow-card-hover',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="truncate pr-2 text-[13.5px] font-semibold text-foreground/80">{title}</p>
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]', styles.icon)}>
          <Icon className="h-[17px] w-[17px]" />
        </div>
      </div>
      <p className="mt-2.5 truncate text-[29px] font-bold leading-tight tracking-tight text-foreground">
        {value}
      </p>
      <div className="mt-auto flex items-end justify-between gap-3 pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {trend && trend !== 'flat' ? (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold',
                trend === 'up' ? styles.trendUp : styles.trendDown,
              )}
            >
              {trend === 'up' ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
              {delta}
            </span>
          ) : trend === 'flat' ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground">
              <Minus className="h-3 w-3" />
              {delta ?? '-'}
            </span>
          ) : null}
          {deltaLabel ? <span className="truncate text-[11px] text-muted-foreground">{deltaLabel}</span> : null}
          {support ? <span className="truncate text-[11px] text-muted-foreground">{support}</span> : null}
        </div>
        {showSparkline ? (
          <div className="h-7 w-[72px] shrink-0">
            <Sparkline
              values={sparkline}
              color={sparklineColor}
              snapshot={snapshot}
              className="h-7"
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
