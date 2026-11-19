export type PeriodKey = 'today' | 'week' | 'last7' | 'last30' | 'month' | 'lastMonth' | 'year' | 'custom'

export interface DateRange {
  start: string
  end: string
}

export interface ClientRange {
  key: PeriodKey
  label: string
  rangeText: string
  from: string
  to: string
  days: number
  bucket: 'hour' | 'day' | 'month'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function toISO(d: Date) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function parseISO(value: string) {
  const d = new Date(value + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return null
  return d
}

function midnight(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}

function addDays(d: Date, n: number) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

function daysBetween(from: Date, to: Date) {
  return Math.round((to.getTime() - from.getTime()) / 86400000)
}

function shortDate(d: Date) {
  return pad(d.getDate()) + ' ' + MONTHS[d.getMonth()]
}

function longDate(d: Date) {
  return pad(d.getDate()) + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear()
}

function fmtFull(d: Date) {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function resolveClientRange(period: PeriodKey, customRange: DateRange | undefined, now: Date = new Date()): ClientRange {
  const today = midnight(now)
  if (period === 'today') {
    const to = addDays(today, 1)
    return {
      key: period,
      label: 'Today',
      rangeText: fmtFull(today),
      from: toISO(today),
      to: toISO(to),
      days: 1,
      bucket: 'hour',
    }
  }
  if (period === 'week') {
    const back = (today.getDay() + 6) % 7
    const from = addDays(today, -back)
    const to = addDays(today, 1)
    return {
      key: period,
      label: 'This Week',
      rangeText: fmtFull(from) + ' – ' + fmtFull(today),
      from: toISO(from),
      to: toISO(to),
      days: daysBetween(from, to),
      bucket: 'day',
    }
  }
  if (period === 'last7') {
    const from = addDays(today, -6)
    const to = addDays(today, 1)
    return {
      key: period,
      label: 'Last 7 Days',
      rangeText: fmtFull(from) + ' – ' + fmtFull(today),
      from: toISO(from),
      to: toISO(to),
      days: 7,
      bucket: 'day',
    }
  }
  if (period === 'last30') {
    const from = addDays(today, -29)
    const to = addDays(today, 1)
    return {
      key: period,
      label: 'Last 30 Days',
      rangeText: fmtFull(from) + ' – ' + fmtFull(today),
      from: toISO(from),
      to: toISO(to),
      days: 30,
      bucket: 'day',
    }
  }
  if (period === 'month') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1)
    const to = addDays(today, 1)
    const days = daysBetween(from, to)
    return {
      key: period,
      label: 'This Month',
      rangeText: fmtFull(from) + ' – ' + fmtFull(today),
      from: toISO(from),
      to: toISO(to),
      days,
      bucket: days > 62 ? 'month' : 'day',
    }
  }
  if (period === 'lastMonth') {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const to = new Date(today.getFullYear(), today.getMonth(), 1)
    const lastDay = addDays(to, -1)
    return {
      key: period,
      label: 'Last Month',
      rangeText: fmtFull(from) + ' – ' + fmtFull(lastDay),
      from: toISO(from),
      to: toISO(to),
      days: daysBetween(from, to),
      bucket: 'day',
    }
  }
  if (period === 'year') {
    const from = new Date(today.getFullYear(), 0, 1)
    const to = addDays(today, 1)
    return {
      key: period,
      label: 'This Year',
      rangeText: fmtFull(from) + ' – ' + fmtFull(today),
      from: toISO(from),
      to: toISO(to),
      days: daysBetween(from, to),
      bucket: 'month',
    }
  }
  const s = customRange?.start ? parseISO(customRange.start) : null
  const e = customRange?.end ? parseISO(customRange.end) : null
  if (s && e) {
    const dcount = daysBetween(s, e) + 1
    return {
      key: 'custom',
      label: shortDate(s) + ' – ' + longDate(e),
      rangeText: fmtFull(s) + ' – ' + fmtFull(e),
      from: toISO(s),
      to: toISO(addDays(midnight(e), 1)),
      days: dcount,
      bucket: dcount <= 1 ? 'hour' : dcount > 62 ? 'month' : 'day',
    }
  }
  return {
    key: 'custom',
    label: 'Custom Range',
    rangeText: 'Custom Range',
    from: toISO(today),
    to: toISO(addDays(today, 1)),
    days: 1,
    bucket: 'hour',
  }
}

export function rangeToQuery(period: PeriodKey, customRange?: DateRange) {
  if (period === 'custom' && customRange) {
    return { period, start: customRange.start, end: customRange.end }
  }
  return { period }
}
