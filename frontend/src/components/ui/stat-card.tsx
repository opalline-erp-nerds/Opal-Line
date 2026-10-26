import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

const accentStyles = {
  purple: {
    icon: 'bg-primary-50 text-primary-700 ring-primary-100/60',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  green: {
    icon: 'bg-success-50 text-success-700 ring-success-100/60',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  orange: {
    icon: 'bg-warning-50 text-warning-700 ring-warning-100/60',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  red: {
    icon: 'bg-red-50 text-red-600 dark:text-red-400 ring-red-100/60',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  blue: {
    icon: 'bg-info-50 text-info-700 ring-info-100/60',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
  slate: {
    icon: 'bg-slate-100 text-slate-700 ring-slate-100/60 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-800/60',
    trendUp: 'text-success-700 bg-success-50',
    trendDown: 'text-red-600 dark:text-red-400 bg-red-50',
  },
}

const accentGradients: Record<keyof typeof accentStyles, string> = {
  orange: 'from-[#FF8A3D] to-[#F0502A]',
  blue: 'from-[#3B82F6] to-[#1E4FD8]',
  green: 'from-[#34C759] to-[#16A34A]',
  purple: 'from-[#8B5CF6] to-[#6D28D9]',
  red: 'from-[#F97066] to-[#D92D20]',
  slate: 'from-[#94A3B8] to-[#475569]',
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
  /** Solid accent tile or a colourful KPI gradient. */
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
  accent = 'purple',
  variant = 'default',
  className,
}: StatCardProps) {
  const styles = accentStyles[accent]
  const gradient = variant === 'gradient'
  return (
    <div
      className={cn(
        'group rounded-xl border p-4 shadow-kpi transition-all hover:-translate-y-px hover:shadow-cardHover',
        gradient
          ? cn('border-transparent bg-gradient-to-br text-white shadow-slate-900/10', accentGradients[accent])
          : 'bg-card',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={cn('text-[13px] font-medium', gradient ? 'text-white/80' : 'text-muted-foreground')}>{title}</p>
        <div className={cn('rounded-md p-1.5 ring-1', gradient ? 'bg-white/20 text-white ring-white/25' : styles.icon)}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p
        className={cn(
          'mt-2.5 text-[22px] font-bold tracking-tight',
          gradient ? 'text-white drop-shadow-sm' : 'text-foreground',
        )}
      >
        {value}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        {trend && trend !== 'flat' ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold',
              gradient ? 'bg-white/20 text-white' : trend === 'up' ? styles.trendUp : styles.trendDown,
            )}
          >
            {trend === 'up' ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {delta}
          </span>
        ) : trend === 'flat' ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold',
              gradient
                ? 'bg-white/15 text-white/90'
                : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
            )}
          >
            <Minus className="h-3 w-3" />
            {delta ?? '—'}
          </span>
        ) : null}
        {deltaLabel ? (
          <span className={cn('text-xs', gradient ? 'text-white/75' : 'text-muted-foreground')}>{deltaLabel}</span>
        ) : null}
        {support ? (
          <span className={cn('text-xs', gradient ? 'text-white/75' : 'text-muted-foreground')}>{support}</span>
        ) : null}
      </div>
    </div>
  )
}
