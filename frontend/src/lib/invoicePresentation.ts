import { round2 } from '@/lib/utils'
import type { Invoice, InvoiceItem } from '@/types'

/**
 * One source of truth for how an invoice's payment state and line money are
 * presented. The Detail page and the shared print/PDF template both consume
 * these helpers, so a row can no longer say PAID on screen and Pending on paper.
 */

export type PaymentState = 'paid' | 'partial' | 'pending' | 'failed' | 'refunded' | 'cancelled'

const PAYMENT_STATES = new Set<PaymentState>(['paid', 'partial', 'pending', 'failed', 'refunded', 'cancelled'])

/** Status words that were historically written into `payment_method`. */
const STATUS_WORDS = new Set([
  'pending', 'unpaid', 'paid', 'partial', 'partially paid', 'refunded', 'cancelled', 'canceled',
  'failed', 'overdue', 'open', 'draft', 'issued', 'complete', 'completed', 'success', 'settled',
  'unknown', 'none', 'n/a', 'na', '-', '—', 'nil',
])

const METHOD_ALIASES: Record<string, string> = {
  razorpay: 'Razorpay',
  upi: 'UPI',
  cash: 'Cash',
  cod: 'Cash on delivery',
  'cash on delivery': 'Cash on delivery',
  card: 'Card',
  online: 'Online',
  netbanking: 'Net banking',
  'net banking': 'Net banking',
  bank: 'Bank transfer',
  'bank transfer': 'Bank transfer',
  neft: 'Bank transfer',
  imps: 'Bank transfer',
  rtgs: 'Bank transfer',
  advance: 'Advance',
}

/** Real money state, never inferred from a hard-coded "everything is paid" default. */
export function invoicePaymentState(invoice: {
  paymentStatus?: string | null
  status?: string | null
}): PaymentState {
  const status = String(invoice.status ?? '').trim().toLowerCase()
  // A terminal document state wins over a stale payment snapshot: a refunded
  // or cancelled invoice must never still advertise an old "paid" snapshot.
  if (status === 'refunded') return 'refunded'
  if (status === 'cancelled' || status === 'canceled') return 'cancelled'
  if (status === 'fully_returned') return 'refunded'
  if (status === 'partially_returned') return 'partial'
  const pay = String(invoice.paymentStatus ?? '').trim().toLowerCase()
  if (PAYMENT_STATES.has(pay as PaymentState)) return pay as PaymentState
  if (PAYMENT_STATES.has(status as PaymentState)) return status as PaymentState
  return 'pending'
}

export function paymentStateLabel(state: PaymentState): string {
  return {
    paid: 'Paid',
    partial: 'Partial',
    pending: 'Pending',
    failed: 'Failed',
    refunded: 'Refunded',
    cancelled: 'Cancelled',
  }[state]
}

/**
 * A real payment method only. A status word (`Pending`, `paid`, `issued`, …) is
 * not a method: legacy rows stored one there, and printing it verbatim produced
 * the "Pending / Pending" payment box. Unknown methods render as an em dash so
 * the label never invents a gateway.
 */
export function paymentMethodLabel(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim()
  if (!value || STATUS_WORDS.has(value.toLowerCase())) return '—'
  return METHOD_ALIASES[value.toLowerCase()] ?? value
}

/** Razorpay payment ids are `pay_…`; a blank/ref/reference id is not one. */
export function isRazorpayPaymentId(raw: string | null | undefined): boolean {
  return /^pay_[a-z0-9]+$/i.test(String(raw ?? '').trim())
}

/**
 * A Razorpay card is only allowed when there is a real Razorpay payment id.
 * The method alone is not proof of a captured transaction (an attempted Razorpay
 * payment can fail, and an import can stamp the gateway without an id).
 */
export function hasRealRazorpayPayment(invoice: {
  paymentStatus?: string | null
  status?: string | null
  paymentMethod?: string | null
  paymentId?: string | null
}): boolean {
  if (!isRazorpayPaymentId(invoice.paymentId)) return false
  const method = String(invoice.paymentMethod ?? '').trim().toLowerCase()
  const state = invoicePaymentState(invoice)
  return method === 'razorpay' || state === 'paid' || state === 'partial' || state === 'refunded'
}

/**
 * Legacy invoice rows often carry tax: 0 on every line while the header has a
 * real gstAmount. Apportion the STORED money across lines by amount share so
 * the Detail table and printed table show the same GST — never derive a new
 * tax base, and never mutate the source invoice.
 */
export function reconcileInvoiceLines<T extends { tax?: unknown; amount?: unknown }>(
  items: T[],
  docGst: number,
): T[] {
  if (!(docGst > 0) || items.length === 0) return items
  if (items.some((it) => Number(it.tax) > 0)) return items
  const amounts = items.map((it) => Math.max(0, Number(it.amount) || 0))
  const base = amounts.reduce((a, b) => a + b, 0)
  if (!(base > 0)) return items
  // Largest remainder: floor to paise, then distribute the leftover cents to
  // the largest fractional shares so the column adds up to the stored total.
  const shares = amounts.map((amount) => {
    const exact = (docGst * amount * 100) / base
    return { cents: Math.floor(exact), frac: exact - Math.floor(exact) }
  })
  let leftover = Math.round(docGst * 100) - shares.reduce((sum, sh) => sum + sh.cents, 0)
  shares
    .map((sh, i) => ({ i, frac: sh.frac }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (leftover > 0) {
        shares[i].cents += 1
        leftover -= 1
      }
    })
  return items.map((it, i) => ({ ...it, tax: shares[i].cents / 100 }) as T)
}

/** Taxable (ex-GST), GST and gross (incl-GST) money for one invoice line. */
export function lineMoney(item: Pick<InvoiceItem, 'amount' | 'tax'>): {
  taxable: number
  tax: number
  total: number
} {
  const taxable = round2(Number(item.amount) || 0)
  const tax = round2(Number(item.tax) || 0)
  return { taxable, tax, total: round2(taxable + tax) }
}

/** The saved lines exactly as both the Detail table and the paper render them. */
export function displayInvoiceLines(invoice: Pick<Invoice, 'items' | 'gstAmount'>): InvoiceItem[] {
  return reconcileInvoiceLines(invoice.items ?? [], Number(invoice.gstAmount) || 0)
}
