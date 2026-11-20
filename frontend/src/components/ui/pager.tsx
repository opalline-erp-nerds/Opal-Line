import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './button'

/**
 * Prev/Next pagination footer shared by the list screens (Returns,
 * Bookings…). Extracted from Returns.tsx so a second page can reuse it
 * instead of growing a private copy per screen.
 */
export function Pager({
  page,
  pages,
  total,
  onChange,
}: {
  page: number
  pages: number
  total: number
  onChange: (page: number) => void
}) {
  if (total === 0) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground">
      <span>
        Page {page} of {pages} · {total} record{total === 1 ? '' : 's'}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <ChevronLeft className="h-3.5 w-3.5" /> Prev
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Next <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
