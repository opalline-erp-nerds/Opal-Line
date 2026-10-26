import * as React from 'react'
import { Check, ChevronDown, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { dbApi } from '@/lib/api'

const DEBOUNCE_MS = 250

/** One search result row (subset of Customer the dropdown needs). */
export interface CustomerHit {
  id: string
  name: string
  phone?: string | null
  email?: string | null
}

export interface CustomerPickerProps {
  /** Fires with the picked hit so the caller can autofill phone/email. */
  onPick: (hit: CustomerHit) => void
  /** Free-text name typed by hand; fires on every keystroke (walk-in customer). */
  onNameChange?: (name: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}

/**
 * Type-ahead customer combobox for the billing form.
 *
 * Debounces keystrokes into `dbApi.searchCustomers`, guards against a slow
 * response for an old query clobbering a newer one (via a monotonic token),
 * and offers arrow-key/enter selection. Selection reports a hit upward and
 * clears the field — the input itself is uncontrolled by design so typed names
 * are never clobbered by an in-flight search.
 */
export function CustomerPicker({
  onPick,
  onNameChange,
  placeholder = 'Search or type a name…',
  className,
  disabled,
}: CustomerPickerProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [hits, setHits] = React.useState<CustomerHit[]>([])
  // Tracks the query whose results are currently in `hits`, so the spinner is
  // derived (not set in an effect): we're loading while the committed query
  // differs from the one we last resolved.
  const [resolvedQuery, setResolvedQuery] = React.useState('')
  const [activeIndex, setActiveIndex] = React.useState(-1)
  const inputRef = React.useRef<HTMLInputElement>(null)
  // Monotonic token: bumped per request; only the response whose token matches
  // is allowed to land (see shouldApplySearch in customerPickerRace.ts).
  const tokenRef = React.useRef(0)

  // Debounced remote search with a stale-response guard. State is set inside
  // the async callbacks, never synchronously in the effect body.
  React.useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q === '') {
      // Defer the reset out of the effect body (react/set-state-in-effect).
      queueMicrotask(() => {
        setHits([])
        setActiveIndex(-1)
        setResolvedQuery('')
      })
      return
    }
    const t = window.setTimeout(() => {
      const token = ++tokenRef.current
      dbApi
        .searchCustomers(q)
        .then((rows) => {
          if (token !== tokenRef.current) return // stale — a newer query won
          setHits(rows)
          setActiveIndex(rows.length > 0 ? 0 : -1)
          setResolvedQuery(q)
        })
        .catch(() => {
          if (token !== tokenRef.current) return
          setHits([])
          setActiveIndex(-1)
          setResolvedQuery(q)
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query, open])

  // Derived: a non-empty query is "loading" until results for it have landed.
  const loading = query.trim() !== '' && query.trim() !== resolvedQuery

  const choose = React.useCallback(
    (hit: CustomerHit) => {
      onPick(hit)
      setQuery('')
      setOpen(false)
    },
    [onPick],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (hits.length === 0 ? -1 : Math.min(i + 1, hits.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = activeIndex >= 0 ? hits[activeIndex] : undefined
      if (pick) choose(pick)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-left text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-primary/60 disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className="truncate text-muted-foreground/80">{query || placeholder}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          align="start"
          side="bottom"
          avoidCollisions={false}
          sideOffset={4}
          className="z-50 w-[var(--radix-dropdown-menu-trigger-width)] min-w-[16rem] p-0"
        >
          <div className="border-b p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  onNameChange?.(e.target.value)
                }}
                onKeyDown={onKeyDown}
                placeholder="Search name, phone or email…"
                className="h-8 pl-8"
                aria-label="Search customers"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-auto p-1">
            {loading ? (
              <p className="flex items-center justify-center gap-2 px-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
              </p>
            ) : hits.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                No match — keep typing for a walk-in
              </p>
            ) : (
              hits.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => choose(c)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                    i === activeIndex && 'bg-muted/60',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{c.name}</span>
                    {c.phone || c.email ? (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {[c.phone, c.email].filter(Boolean).join(' • ')}
                      </span>
                    ) : null}
                  </span>
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                </button>
              ))
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  )
}
