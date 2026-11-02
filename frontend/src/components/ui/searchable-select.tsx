import * as React from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface SearchableSelectOption {
  label: string
  value: string
  keywords?: string
  subtitle?: string
}

interface SearchableSelectProps {
  options: SearchableSelectOption[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
  /** Tighter rows and a ~200px total dropdown (search + list) for compact placements. */
  compact?: boolean
  /** Extra classes for the portalled menu panel (rounding, width caps, layering). */
  contentClassName?: string
}

export function SearchableSelect({
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  className,
  compact,
  contentClassName,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // An empty string is the app-wide "nothing chosen" state (dialog resets, new
  // lines, customers without names) — it must not count as a match, or a
  // zero-length option can hijack the trigger and blank its placeholder.
  const selected = value ? options.find((o) => o.value === value) : undefined

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q) || (o.keywords ?? '').toLowerCase().includes(q))
  }, [options, query])

  React.useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 10)
      return () => window.clearTimeout(t)
    }
  }, [open])

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-primary/60',
            className,
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground/80')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className={cn(
          'w-[var(--radix-dropdown-menu-trigger-width)] p-0',
          contentClassName,
        )}
      >
        <div className={cn('border-b p-2', compact && 'p-1.5')}>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder ?? 'Search…'}
              className="h-8 pl-8"
            />
          </div>
        </div>
        <div className={cn('overflow-y-auto p-1', compact ? 'max-h-[150px]' : 'max-h-64')}>
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">{emptyText ?? 'No matching options'}</p>
          ) : (
            filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onValueChange(o.value)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                  compact && 'py-1 text-[13px] leading-tight',
                  o.value === value && o.value !== '' && (compact ? 'bg-primary/5' : 'bg-muted/60'),
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{o.label}</span>
                  {o.subtitle ? (
                    <span className="block truncate text-[11px] leading-tight text-muted-foreground">{o.subtitle}</span>
                  ) : null}
                </span>
                {o.value === value && o.value !== '' ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
              </button>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
