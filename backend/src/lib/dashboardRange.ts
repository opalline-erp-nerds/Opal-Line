/**
 * Shared date-range resolution for the dashboard.
 *
 * Every dashboard endpoint that reports "in the period" resolves its window
 * through this module so the whole page agrees on one range. Boundaries are
 * half-open — `[from, to)`, where `to` is the first instant *after* the range —
 * which keeps SQL `date >= from AND date < to` correct and matches the way the
 * bundled Postgres stores local-naive timestamps ('YYYY-MM-DD HH:MM:SS').
 *
 * "Today" is IST midnight; preset weeks start on Monday, in line with the
 * business-day reporting the rest of the app uses.
 */

export type PeriodKey = 'today' | 'week' | 'last7' | 'last30' | 'last3m' | 'last6m' | 'last12m' | 'month' | 'lastMonth' | 'year' | 'custom'

export interface DashboardRange {
  key: PeriodKey
  /** Human label for the range, e.g. "This Week" or "01 Oct – 16 Oct 2026". */
  label: string
  /** Inclusive lower bound, naive 'YYYY-MM-DDTHH:MM:SS'. */
  from: string
  /** Exclusive upper bound (first instant after the range). */
  to: string
  /** The equivalent previous window, used for the delta chips. */
  prevFrom: string
  prevTo: string
  prevLabel: string
  days: number
  /** How the chart should group: hourly for a single day, monthly for long spans. */
  bucket: 'hour' | 'day' | 'month'
}

export type RangeResult =
  | { ok: true; range: DashboardRange }
  | { ok: false; status: number; error: string }

const PERIODS: readonly PeriodKey[] = ['today', 'week', 'last7', 'last30', 'last3m', 'last6m', 'last12m', 'month', 'lastMonth', 'year', 'custom']

const pad = (n: number) => String(n).padStart(2, '0')

function naive(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function midnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function shortDate(d: Date): string {
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]}`
}

function longDate(d: Date): string {
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

function parseISODate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000)
}

/**
 * Resolve a dashboard range from request query params.
 *
 * Presets read `period`; `custom` additionally reads `start` and `end`
 * (`YYYY-MM-DD`, inclusive). Any invalid input returns `{ ok: false }` with the
 * HTTP status the caller should send.
 */
export function resolveDashboardRange(query: Record<string, unknown>, now: Date = new Date()): RangeResult {
  const raw = String(query.period ?? 'today')
  if (!(PERIODS as readonly string[]).includes(raw)) {
    return { ok: false, status: 400, error: 'Unknown period' }
  }
  const key = raw as PeriodKey
  const today = midnight(now)

  if (key === 'today') {
    const to = addDays(today, 1)
    return {
      ok: true,
      range: {
        key, label: 'Today',
        from: naive(today), to: naive(to),
        prevFrom: naive(addDays(today, -1)), prevTo: naive(today),
        prevLabel: 'vs yesterday',
        days: 1, bucket: 'hour',
      },
    }
  }

  if (key === 'week') {
    const back = (today.getDay() + 6) % 7 // Monday = 0
    const from = addDays(today, -back)
    const to = addDays(today, 1)
    return {
      ok: true,
      range: {
        key, label: 'This Week',
        from: naive(from), to: naive(to),
        prevFrom: naive(addDays(from, -7)), prevTo: naive(addDays(to, -7)),
        prevLabel: 'vs last week',
        days: daysBetween(from, to), bucket: 'day',
      },
    }
  }

  if (key === 'last7') {
    const from = addDays(today, -6)
    const to = addDays(today, 1)
    return {
      ok: true,
      range: {
        key, label: 'Last 7 Days',
        from: naive(from), to: naive(to),
        prevFrom: naive(addDays(from, -7)), prevTo: naive(addDays(to, -7)),
        prevLabel: 'vs previous 7 days',
        days: 7, bucket: 'day',
      },
    }
  }

  if (key === 'last30') {
    const from = addDays(today, -29)
    const to = addDays(today, 1)
    return {
      ok: true,
      range: {
        key, label: 'Last 30 Days',
        from: naive(from), to: naive(to),
        prevFrom: naive(addDays(from, -30)), prevTo: naive(addDays(to, -30)),
        prevLabel: 'vs previous 30 days',
        days: 30, bucket: 'day',
      },
    }
  }

  // Rolling N-month presets for the Financial Analytics section: whole calendar
  // months from the 1st (N-1 months back) through tomorrow, so a "Last 12
  // Months" view always shows exactly 12 monthly buckets ending this month.
  if (key === 'last3m' || key === 'last6m' || key === 'last12m') {
    const months = key === 'last3m' ? 3 : key === 'last6m' ? 6 : 12
    const from = new Date(today.getFullYear(), today.getMonth() - (months - 1), 1)
    const to = addDays(today, 1)
    const prevFrom = new Date(today.getFullYear(), today.getMonth() - (months * 2 - 1), 1)
    // Previous window ends where the current one begins (half-open [from, to)).
    const prevTo = from
    return {
      ok: true,
      range: {
        key, label: `Last ${months} Months`,
        from: naive(from), to: naive(to),
        prevFrom: naive(prevFrom), prevTo: naive(prevTo),
        prevLabel: `vs previous ${months} months`,
        days: daysBetween(from, to), bucket: 'month',
      },
    }
  }

  if (key === 'month') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1)
    const to = addDays(today, 1)
    const prevFrom = new Date(from.getFullYear(), from.getMonth() - 1, 1)
    const prevTo = new Date(to.getFullYear(), to.getMonth() - 1, to.getDate())
    const days = daysBetween(from, to)
    return {
      ok: true,
      range: {
        key, label: 'This Month',
        from: naive(from), to: naive(to),
        prevFrom: naive(prevFrom), prevTo: naive(prevTo),
        prevLabel: 'vs last month',
        days, bucket: days > 62 ? 'month' : 'day',
      },
    }
  }

  if (key === 'lastMonth') {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const to = new Date(today.getFullYear(), today.getMonth(), 1)
    const prevFrom = new Date(today.getFullYear(), today.getMonth() - 2, 1)
    return {
      ok: true,
      range: {
        key, label: 'Last Month',
        from: naive(from), to: naive(to),
        prevFrom: naive(prevFrom), prevTo: naive(from),
        prevLabel: 'vs previous month',
        days: daysBetween(from, to), bucket: 'day',
      },
    }
  }

  if (key === 'year') {
    const from = new Date(today.getFullYear(), 0, 1)
    const to = addDays(today, 1)
    const prevFrom = new Date(from.getFullYear() - 1, 0, 1)
    const prevTo = new Date(to.getFullYear() - 1, to.getMonth(), to.getDate())
    return {
      ok: true,
      range: {
        key, label: 'This Year',
        from: naive(from), to: naive(to),
        prevFrom: naive(prevFrom), prevTo: naive(prevTo),
        prevLabel: 'vs last year',
        days: daysBetween(from, to), bucket: 'month',
      },
    }
  }

  // Custom inclusive [start, end]
  const start = parseISODate(String(query.start ?? ''))
  const end = parseISODate(String(query.end ?? ''))
  if (!start || !end) {
    return { ok: false, status: 400, error: 'Valid start and end dates (YYYY-MM-DD) are required for a custom range' }
  }
  if (end.getTime() < start.getTime()) {
    return { ok: false, status: 400, error: 'End date must be on or after start date' }
  }
  const days = daysBetween(start, end) + 1
  if (days > 366) {
    return { ok: false, status: 400, error: 'Custom range cannot exceed 366 days' }
  }
  const from = midnight(start)
  const to = addDays(midnight(end), 1)
  return {
    ok: true,
    range: {
      key, label: `${shortDate(start)} – ${longDate(end)}`,
      from: naive(from), to: naive(to),
      prevFrom: naive(addDays(from, -days)), prevTo: naive(from),
      prevLabel: 'vs previous period',
      days, bucket: days <= 1 ? 'hour' : days > 62 ? 'month' : 'day',
    },
  }
}
export interface BucketPoint {
  key: string
  label: string
  date: string
}

export function enumerateBuckets(range: { from: string; to: string; days: number; bucket: 'hour' | 'day' | 'month' }): BucketPoint[] {
  const points: BucketPoint[] = []
  const pad = (n: number) => String(n).padStart(2, '0')
  const start = new Date(range.from)
  const toDate = new Date(range.to)
  const lastDay = new Date(toDate.getTime() - 86400000)

  if (range.bucket === 'hour') {
    const day = start.getFullYear() + '-' + pad(start.getMonth() + 1) + '-' + pad(start.getDate())
    for (let h = 0; h < 24; h++) {
      const hh = pad(h)
      points.push({ key: hh, label: hh + ':00', date: day + 'T' + hh + ':00:00' })
    }
    return points
  }

  if (range.bucket === 'month') {
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
    const last = new Date(lastDay.getFullYear(), lastDay.getMonth(), 1)
    while (cursor.getTime() <= last.getTime()) {
      const key = cursor.getFullYear() + '-' + pad(cursor.getMonth() + 1)
      points.push({
        key,
        label: cursor.toLocaleDateString('en-IN', { month: 'short' }),
        date: key + '-01',
      })
      cursor.setMonth(cursor.getMonth() + 1)
    }
    return points
  }

  const cursor = new Date(start)
  for (let i = 0; i < range.days; i++) {
    const key = cursor.getFullYear() + '-' + pad(cursor.getMonth() + 1) + '-' + pad(cursor.getDate())
    points.push({
      key,
      label: cursor.toLocaleDateString('en-IN', { weekday: 'short' }) + ' ' + key.slice(8, 10),
      date: key,
    })
    cursor.setDate(cursor.getDate() + 1)
  }
  return points
}
