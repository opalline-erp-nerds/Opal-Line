import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary-50 text-primary-700',
        solid: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-foreground border-border',
        success: 'border-transparent bg-success-50 text-success-700',
        warning: 'border-transparent bg-warning-50 text-warning-700',
        danger: 'border-transparent bg-red-50 text-red-700',
        info: 'border-transparent bg-info-50 text-info-700',
        muted: 'border-transparent bg-muted text-muted-foreground',
        brand: 'border-transparent bg-primary-100 text-primary-800',
      },
      dot: {
        true: 'before:size-1.5 before:rounded-full before:bg-current before:mr-0.5',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      dot: false,
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, dot, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant, dot }), className)} {...props} />
}

export { Badge }
