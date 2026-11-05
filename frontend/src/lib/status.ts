export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const SUCCESS = new Set(['paid', 'settled', 'received', 'fulfilled', 'completed', 'closed', 'delivered', 'active'])
const WARNING = new Set(['pending', 'partial', 'partially_paid', 'open', 'processing', 'cod', 'bank', 'unallocated', 'unfulfilled', 'low', 'partially_returned'])
const DANGER = new Set(['failed', 'cancelled', 'voided', 'overdue', 'rejected', 'critical', 'out of stock', 'fully_returned'])
const INFO = new Set(['imported', 'confirmed', 'draft', 'issued', 'sent'])

export function statusTone(status: string): StatusTone {
  const key = status.toLowerCase()
  if (SUCCESS.has(key)) return 'success'
  if (WARNING.has(key)) return 'warning'
  if (DANGER.has(key)) return 'danger'
  if (INFO.has(key)) return 'info'
  return 'neutral'
}

export function humanizeStatus(status: string): string {
  if (!status) return '—'
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
