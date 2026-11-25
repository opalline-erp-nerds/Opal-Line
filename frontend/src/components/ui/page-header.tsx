import * as React from 'react'
import { cn } from '@/lib/utils'

interface PageHeaderProps {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  /** Optional icon rendered in a tile beside the title. */
  icon?: React.ReactNode
  /** Optional classes for the icon tile (background, icon colour, ring). */
  iconTileClassName?: string
  className?: string
}

export function PageHeader({ title, subtitle, actions, icon, iconTileClassName, className }: PageHeaderProps) {
  if (icon) {
    return (
      <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-3', className)}>
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <div
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600 ring-1 ring-primary-100 dark:bg-primary-50/60 dark:text-primary-300 sm:h-12 sm:w-12',
              iconTileClassName,
            )}
          >
            {icon}
          </div>
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-[1.625rem] font-bold leading-tight tracking-tight text-foreground sm:text-[1.875rem]">
              {title}
            </h1>
            {subtitle ? (
              <p className="max-w-3xl text-[14px] leading-relaxed text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="space-y-1.5">
        <h1 className="text-[1.625rem] font-bold tracking-tight text-foreground sm:text-[1.875rem]">{title}</h1>
        {subtitle ? <p className="text-[14px] text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}
