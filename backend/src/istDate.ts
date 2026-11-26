const IST = 'Asia/Kolkata'

/**
 * Naive stored timestamps (no Z / offset) are UTC in this ERP, matching the
 * frontend's `lib/format.ts`. Formatting them with the server's own timezone
 * produced the 5h30m drift between the invoice screen (IST) and its PDF.
 */
function normalizeTimestamp(value: string): string {
  const s = value.trim()
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return s
  const body = s.includes('T') ? s : s.replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}$/.test(body)) return `${body}T00:00:00Z`
  return `${body}Z`
}

function toDate(value: string | number | Date): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const raw = String(value)
  const d = new Date(normalizeTimestamp(raw))
  return Number.isNaN(d.getTime()) ? null : d
}

/** IST date, optionally with the clock time used by invoice PDFs. */
export function formatIstDate(
  value: string | number | Date | null | undefined,
  opts: { withTime?: boolean } = {},
): string {
  const d = value == null ? null : toDate(value)
  if (!d) return '—'
  return d.toLocaleString('en-IN', {
    timeZone: IST,
    dateStyle: 'medium',
    ...(opts.withTime ? { timeStyle: 'short' } : {}),
  })
}
