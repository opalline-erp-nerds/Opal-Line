/**
 * One source of truth for the payment fields persisted on a sales invoice.
 *
 * Historically several write paths copied a STATUS word ("Pending", "Online",
 * "paid") into `payment_method`, which made the invoice screen print
 * "Pending / Pending" and let a blank Razorpay id still render a PAID card.
 * Every create / import / convert / update path normalises through this module
 * so the stored row can only contain a real method, a real state and a real id.
 *
 * sales_invoices has payment_method, payment_status and payment_id columns —
 * there is no payment_gateway column. A gateway is recorded by naming the real
 * method (e.g. Razorpay) and keeping the gateway's payment id, never by a
 * fabricated status word.
 */

export type InvoicePaymentStatus = 'paid' | 'partial' | 'pending' | 'failed' | 'refunded' | 'cancelled'

const STATUS_WORDS = new Set([
  'pending', 'unpaid', 'paid', 'partial', 'partially paid', 'refunded', 'cancelled', 'canceled',
  'failed', 'overdue', 'open', 'draft', 'issued', 'complete', 'completed', 'success', 'settled',
  'unknown', 'none', 'n/a', 'na', '-', '—', 'nil', '',
])

const PAYMENT_ALIASES: Record<string, string> = {
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

const STATUS_ALIASES: Record<string, InvoicePaymentStatus> = {
  paid: 'paid',
  success: 'paid',
  completed: 'paid',
  complete: 'paid',
  settled: 'paid',
  partial: 'partial',
  'partially paid': 'partial',
  partially_returned: 'partial',
  fully_returned: 'refunded',
  pending: 'pending',
  unpaid: 'pending',
  open: 'pending',
  outstanding: 'pending',
  overdue: 'pending',
  draft: 'pending',
  issued: 'pending',
  failed: 'failed',
  refunded: 'refunded',
  returned: 'refunded',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  void: 'cancelled',
}

const DOCUMENT_STATUSES = new Set([
  'draft', 'issued', 'paid', 'pending', 'partial', 'overdue', 'cancelled', 'refunded',
  'partially_returned', 'fully_returned',
])

export interface InvoicePaymentInput {
  paymentStatus?: unknown
  paymentMethod?: unknown
  paymentGateway?: unknown
  razorpayPaymentId?: unknown
  paymentId?: unknown
  status?: unknown
}

export interface NormalizedInvoicePayment {
  paymentMethod: string | null
  paymentStatus: InvoicePaymentStatus
  paymentId: string | null
  status?: string
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function isRazorpayPaymentId(value: unknown): boolean {
  return /^pay_[a-z0-9]+$/i.test(text(value))
}

/** A state word never becomes a method. Unknown, non-status methods are kept. */
export function normalizePaymentMethod(value: unknown): string | null {
  const raw = text(value)
  if (!raw || STATUS_WORDS.has(raw.toLowerCase())) return null
  return PAYMENT_ALIASES[raw.toLowerCase()] ?? raw
}

export function normalizePaymentStatus(value: unknown): InvoicePaymentStatus | null {
  const key = text(value).toLowerCase()
  return STATUS_ALIASES[key] ?? null
}

/**
 * Razorpay's real id is `pay_…`. A status word, an empty string or a reference
 * such as "Pending" is not an id and must never become one on the invoice.
 */
export function normalizePaymentId(input: InvoicePaymentInput): string | null {
  const razorpayId = text(input.razorpayPaymentId)
  if (isRazorpayPaymentId(razorpayId)) return razorpayId
  const id = text(input.paymentId)
  if (!id || STATUS_WORDS.has(id.toLowerCase())) return null
  return id
}

/** Full write: every payment column gets an explicit, truthful value. */
export function normalizeInvoicePayment(input: InvoicePaymentInput): NormalizedInvoicePayment {
  const documentStatus = text(input.status).toLowerCase()
  const methodFromInput = normalizePaymentMethod(input.paymentMethod)
  const id = normalizePaymentId(input)
  const status = normalizePaymentStatus(input.status) ?? normalizePaymentStatus(input.paymentStatus) ?? 'pending'
  // A terminal document state wins over a stale payment snapshot.
  const paymentStatus: InvoicePaymentStatus =
    documentStatus === 'refunded' || documentStatus === 'fully_returned' ? 'refunded'
      : documentStatus === 'cancelled' || documentStatus === 'canceled' ? 'cancelled'
        : documentStatus === 'partially_returned' ? 'partial'
          : normalizePaymentStatus(input.paymentStatus) ?? status

  // A real Razorpay id (or an explicit gateway field) identifies the CHANNEL,
  // not a settlement: an unpaid attempt still happened through Razorpay. The
  // UI never claims a captured payment without the real pay_ id + state.
  const gateway = text(input.paymentGateway).toLowerCase()
  const razorpayEvidence = isRazorpayPaymentId(input.razorpayPaymentId) || isRazorpayPaymentId(input.paymentId) || gateway === 'razorpay'
  const paymentMethod = methodFromInput ?? (razorpayEvidence ? 'Razorpay' : null)

  const result: NormalizedInvoicePayment = { paymentMethod, paymentStatus, paymentId: id }
  if (documentStatus && DOCUMENT_STATUSES.has(documentStatus)) {
    result.status = documentStatus === 'canceled' ? 'cancelled' : documentStatus
  }
  return result
}

/**
 * PATCH write: only touch columns the caller actually sent. Omitted fields
 * keep their persisted value; a blank string still means "no real method/id".
 * `existing` supplies that persisted snapshot so a refund/status edit cannot
 * silently erase a real Cash/UPI/Razorpay method or its gateway id.
 */
export function normalizeInvoicePaymentPatch(
  input: InvoicePaymentInput,
  existing: InvoicePaymentInput = {},
): Partial<NormalizedInvoicePayment> {
  const has = (...keys: Array<keyof InvoicePaymentInput>) => keys.some((key) => input[key] !== undefined)
  const merged = { ...existing, ...input }
  const patch: Partial<NormalizedInvoicePayment> = {}
  if (has('paymentMethod', 'paymentGateway', 'razorpayPaymentId')) {
    patch.paymentMethod = normalizeInvoicePayment(merged).paymentMethod
  } else if (has('paymentStatus')) {
    // A state-only edit preserves a real stored method but still cleans out a
    // legacy status word that used to be written into the method column.
    patch.paymentMethod = normalizePaymentMethod(existing.paymentMethod)
  }
  if (has('paymentStatus', 'status')) {
    patch.paymentStatus = normalizeInvoicePayment(merged).paymentStatus
  }
  if (has('paymentId', 'razorpayPaymentId')) {
    // An explicitly blank id clears it; an omitted id never touches it.
    patch.paymentId = normalizePaymentId(input)
  }
  if (has('status')) {
    const status = normalizeInvoicePayment(merged).status
    if (status) patch.status = status
  }
  return patch
}

/** Human copy for PDF/HTML payment boxes — no gateway claim without an id. */
export function paymentStatusLabel(status: string | null | undefined): string {
  const state = normalizePaymentStatus(status) ?? 'pending'
  return {
    paid: 'Paid',
    partial: 'Partial',
    pending: 'Pending',
    failed: 'Failed',
    refunded: 'Refunded',
    cancelled: 'Cancelled',
  }[state]
}

export function paymentMethodLabel(method: string | null | undefined): string {
  return normalizePaymentMethod(method) ?? '—'
}
