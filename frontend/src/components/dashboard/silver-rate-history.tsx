import { useCallback, useEffect, useState } from 'react'
import { ShieldAlert, Tag, TrendingDown, TrendingUp } from 'lucide-react'
import { dbApi } from '@/lib/api'
import { useSilverRate } from '@/lib/silver-rate-context'
import type {
  SilverHistoryDays,
  SilverHistoryRange,
  SilverHistoryWindow,
  SilverRate,
  SilverRatePoint,
} from '@/types'
import { rateDayLabel } from '@/lib/format'
import { SilverRateChart } from '@/components/charts/silver-rate-chart'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const WINDOWS: ReadonlyArray<{ days: SilverHistoryDays; label: string }> = [
  { days: 7, label: '7 Days' },
  { days: 30, label: '30 Days' },
  { days: 90, label: '90 Days' },
]

const MAX_CUSTOM_DAYS = 365
const DAY_MS = 86_400_000

function toISODay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseISODay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Inclusive day count (`from` and `to` both counted). */
function rangeDays(range: SilverHistoryRange): number {
  const from = parseISODay(range.from)
  const to = parseISODay(range.to)
  if (!from || !to || to < from) return 0
  return Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1
}

function defaultCustomRange(): SilverHistoryRange {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 29)
  return { from: toISODay(start), to: toISODay(end) }
}

function customRangeLabel(range: SilverHistoryRange): string {
  return `${rateDayLabel(range.from)} – ${rateDayLabel(range.to)}`
}

interface HistoryFetch {
  key: string
  attempt: number
  points: SilverRatePoint[] | null
  error: string | null
}

/** Today's rate with its day-over-day direction (green up, red down, muted flat). */
export function SilverRateBadge({ rate }: { rate: SilverRate | null }) {
  if (!rate) return <Badge variant="muted" className="text-[10px]">Today: —</Badge>
  const direction = rate.change > 0 ? 'up' : rate.change < 0 ? 'down' : 'flat'
  return (
    <Badge
      variant={direction === 'up' ? 'success' : direction === 'down' ? 'danger' : 'muted'}
      className="text-[10px]"
    >
      {direction === 'up' ? <TrendingUp /> : direction === 'down' ? <TrendingDown /> : null}
      Today: ₹{rate.rate.toFixed(2)} / gm
    </Badge>
  )
}

function CardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-7 w-44" />
      <Skeleton className="h-[200px] w-full" />
    </div>
  )
}

/** Same shape as financial-analytics' CardError, with silver-specific copy. */
function CardLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      icon={ShieldAlert}
      title="Couldn't load silver history"
      description="There was an error fetching the rate series. Please try again."
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      }
      className="px-2 py-6"
    />
  )
}

/** Chart body: window toggle + line, or the empty state. Exported for tests. */
export function SilverRateHistoryBody({
  points,
  days,
  onDaysChange,
  customRange,
  onCustomApply,
  onSetRate,
}: {
  points: SilverRatePoint[]
  days: SilverHistoryWindow
  onDaysChange: (window: SilverHistoryWindow) => void
  customRange?: SilverHistoryRange
  onCustomApply?: (range: SilverHistoryRange) => void
  onSetRate: () => void
}) {
  const [draft, setDraft] = useState<SilverHistoryRange>(customRange ?? defaultCustomRange())

  if (points.length === 0 && days !== 'custom') {
    return (
      <EmptyState
        icon={Tag}
        title="No silver rate history"
        description="Update today's rate to start the trend line."
        action={
          <Button size="sm" variant="soft-primary" onClick={onSetRate}>
            Set Silver Rate
          </Button>
        }
        className="px-2 py-6"
      />
    )
  }

  const today = toISODay(new Date())
  const from = parseISODay(draft.from)
  const to = parseISODay(draft.to)
  const draftDays = rangeDays(draft)
  const valid = Boolean(from && to && to >= from && draftDays > 0 && draftDays <= MAX_CUSTOM_DAYS)

  const applyCustom = () => {
    if (!valid) return
    onCustomApply?.(draft)
    onDaysChange('custom')
  }

  return (
    <>
      <Tabs
        value={String(days)}
        onValueChange={(v) => onDaysChange(v === 'custom' ? 'custom' : (Number(v) as SilverHistoryDays))}
      >
        <TabsList className="h-7">
          {WINDOWS.map((w) => (
            <TabsTrigger key={w.days} value={String(w.days)} className="h-6 px-2.5 text-[11px]">
              {w.label}
            </TabsTrigger>
          ))}
          <TabsTrigger value="custom" className="h-6 px-2.5 text-[11px]">
            Custom
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {days === 'custom' ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            From
            <input
              type="date"
              value={draft.from}
              max={today}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              className="h-7 rounded-md border bg-card px-2 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            To
            <input
              type="date"
              value={draft.to}
              min={draft.from}
              max={today}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              className="h-7 rounded-md border bg-card px-2 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          <Button size="sm" className="h-7" onClick={applyCustom} disabled={!valid}>
            Apply
          </Button>
          {!valid ? (
            <p className="w-full text-[11px] text-red-600 dark:text-red-400">
              {draftDays > MAX_CUSTOM_DAYS
                ? `Range cannot exceed ${MAX_CUSTOM_DAYS} days`
                : 'To must be on or after From'}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3">
        {points.length > 0 ? (
          <SilverRateChart data={points} />
        ) : (
          <EmptyState
            icon={Tag}
            title="No silver rate history"
            description="No rate was recorded in this range."
            className="px-2 py-6"
          />
        )}
      </div>
    </>
  )
}

/**
 * Silver Rate History card. It owns its preset window (7/30/90, anchored on
 * today) or a custom inclusive date range: the page-wide dashboard range does
 * not drive it. Server-side backfill guarantees one point per IST day inside
 * the window.
 */
export function SilverRateHistoryCard({ onSetRate }: { onSetRate: () => void }) {
  const { rate } = useSilverRate()
  const [window, setWindow] = useState<SilverHistoryWindow>(7)
  const [customRange, setCustomRange] = useState<SilverHistoryRange>(() => defaultCustomRange())
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<HistoryFetch | null>(null)

  const key = window === 'custom' ? `custom:${customRange.from}:${customRange.to}` : String(window)

  useEffect(() => {
    let cancelled = false
    const wanted = { key, attempt }
    const requested = window === 'custom' ? customRange : window
    dbApi
      .getSilverRateHistory(requested)
      .then((points) => {
        if (!cancelled) setResult({ ...wanted, points, error: null })
      })
      .catch((err: unknown) => {
        console.error('Silver history error:', err)
        if (!cancelled) setResult({ ...wanted, points: null, error: 'Failed to load rate history' })
      })
    return () => {
      cancelled = true
    }
  }, [key, window, customRange, attempt])

  const reload = useCallback(() => setAttempt((a) => a + 1), [])

  // A result for a superseded window (or attempt) is stale: keep showing the
  // skeleton instead of flashing the old range while the new one loads.
  const matched = result && result.key === key && result.attempt === attempt ? result : null
  const windowLabel = window === 'custom' ? customRangeLabel(customRange) : `Last ${window} days`

  return (
    <Card className="w-full">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Silver Rate History ({rate?.purity ?? 92.5})</CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{windowLabel} · ₹ / gm</p>
        </div>
        <SilverRateBadge rate={rate} />
      </CardHeader>
      <CardContent>
        {!matched ? (
          <CardSkeleton />
        ) : matched.error ? (
          <CardLoadError onRetry={reload} />
        ) : matched.points ? (
          <SilverRateHistoryBody
            points={matched.points}
            days={window}
            onDaysChange={setWindow}
            customRange={customRange}
            onCustomApply={setCustomRange}
            onSetRate={onSetRate}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}
