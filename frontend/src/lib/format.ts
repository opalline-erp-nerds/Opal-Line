const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
})

const inrDecimal = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
})

const number = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

const IST_TIMEZONE = 'Asia/Kolkata'

export function formatCurrency(value: number | null | undefined, opts?: { decimals?: boolean; compact?: boolean }) {
  if (value == null || !Number.isFinite(value)) return '—'
  if (opts?.compact) {
    return compactCurrency(value)
  }
  return opts?.decimals ? inrDecimal.format(value) : inr.format(value)
}

export function formatNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  return number.format(value)
}

export function formatWeight(value: number | null | undefined, opts?: { decimals?: number }) {
  // A 0 weight is not a real measurement — on imported or quoted items it
  // means "weight never captured". Show it as unknown rather than "0.00 gm".
  if (value == null || !Number.isFinite(value) || value === 0) return '—'
  const dec = opts?.decimals ?? 2
  return `${value.toLocaleString('en-IN', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  })} gm`
}

export function formatPieces(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${number.format(value)} pcs`
}

function normalizeTimestamp(str: string): string {
  const s = str.trim()
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return s
  const body = s.includes('T') ? s : s.replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}$/.test(body)) return `${body}T00:00:00Z`
  return `${body}Z`
}

function toDate(date: Date | string | null | undefined): Date | null {
  if (date == null) return null
  const d = typeof date === 'string' ? new Date(normalizeTimestamp(date)) : date
  return Number.isNaN(d.getTime()) ? null : d
}

const istDateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function istDateKey(date: Date | string | null | undefined): string {
  const d = toDate(date)
  if (!d) return ''
  return istDateKeyFormatter.format(d)
}

export function todayIST(): string {
  return istDateKey(new Date())
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Chart axis/tooltip label for a saved rate timestamp or IST calendar day. */
export function rateAxisLabel(value: string | null | undefined): string {
  const s = String(value ?? '')
  if (!s.includes('T')) return rateDayLabel(s)
  const d = toDate(s)
  if (!d) return s
  return d.toLocaleString('en-IN', {
    timeZone: IST_TIMEZONE,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

/** Chart axis/tooltip label for an IST calendar day: "2026-10-05" → "5 Oct". */
export function rateDayLabel(isoDay: string): string {
  const [, m, d] = String(isoDay).split('-')
  const month = SHORT_MONTHS[Number(m) - 1]
  if (!month || !d) return String(isoDay)
  return `${Number(d)} ${month}`
}

export function formatDate(date: Date | string | null | undefined) {
  const d = toDate(date)
  if (!d) return '—'
  return d.toLocaleDateString('en-IN', {
    timeZone: IST_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export function formatDateTime(date: Date | string | null | undefined) {
  const d = toDate(date)
  if (!d) return '—'
  return d.toLocaleDateString('en-IN', {
    timeZone: IST_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

export function formatTime(date: Date | string | null | undefined) {
  const d = toDate(date)
  if (!d) return '—'
  return d.toLocaleTimeString('en-IN', { timeZone: IST_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: true })
}

export function compactCurrency(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)}Cr`
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)}L`
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}k`
  return `${sign}₹${Math.round(abs)}`
}

export function formatPercent(value: number | null | undefined, opts?: { signed?: boolean; decimals?: number }) {
  if (value == null || !Number.isFinite(value)) return '—'
  const dec = opts?.decimals ?? 2
  const prefix = opts?.signed && value > 0 ? '+' : ''
  return `${prefix}${value.toFixed(dec)}%`
}
