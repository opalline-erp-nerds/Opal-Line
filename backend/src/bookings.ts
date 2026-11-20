import { randomUUID } from 'node:crypto'
import { and, eq, inArray, or } from 'drizzle-orm'
import * as s from './db/schema'
import { roundMoney } from './invoiceTotals'
// Type-only: pure helpers stay importable WITHOUT opening a database
// connection (the runtime class is matched structurally in convert).
import type { InsufficientStockDetail, InsufficientStockError } from './stock'
import { logger } from './logger'

// `db/client` and `routes/db` are imported LAZILY inside the functions below:
// importing this module for its pure helpers (parseBookingContact,
// normalizeBookingItems, parseBookingHeader) must never open a database
// connection — the tests rely on that to validate the rules without a
// database, before any scratch schema exists.

/**
 * Booking domain rules that live behind POST /db/bookings/:id/convert.
 *
 * Extracted from the route so the money workflow — invoice claim, status
 * transition, the advance payment row and the timeline event — can be pinned
 * by a scratch-database test instead of only running in production. The route
 * keeps the RBAC check, the audit record and the HTTP mapping; everything that
 * touches tables lives here.
 */
export type ConvertBookingResult =
  | {
      ok: true
      orderId: string
      invoiceNumber: string
      /** Advance carried into the invoice as a payment. */
      advanceApplied: number
      /** value − advance: what is still due on the invoice. */
      balance: number
      payment: 'paid' | 'pending'
    }
  | {
      ok: false
      status: 400 | 404 | 409 | 500 | 503
      error: string
      /**
       * Present on a stock refusal: the structured per-product shortfall the
       * route hands back as the standard 409 payload (product/variant, required,
       * available, shortage, and THAT store's id + name). The whole conversion
       * transaction had already rolled back — no invoice, no deduction, no
       * payment row, timeline entry or customer change.
       */
      stock?: InsufficientStockError
      /**
       * Present on an ALLOCATION_INCOMPLETE refusal: the per-line detail
       * (line index, SKU, required, allocated) the route returns with the 400
       * so the UI can point at the exact line to fix.
       */
      details?: Array<{ lineIndex?: number; sku?: string; required?: number; allocated?: number }>
    }

export interface ConvertBookingOptions {
  /** User id recorded on the order event (defaults to `system`). */
  actor?: string | null
}

/**
 * Optional contact captured with a booking (email + phone), parsed the same
 * way for create and edit so both answer one identical 400.
 *
 * The invoice generator reads `customerEmail` / `customerPhone` off the order
 * row when no customer record matches the name — the normal case for a
 * walk-in booking — so this is what carries the booking's contact onto its
 * invoice, its loyalty award and Customer 360 instead of letting it evaporate.
 */
export function parseBookingContact(body: unknown): { email: string; phone: string } | { error: string } {
  const b = (body ?? {}) as { email?: unknown; phone?: unknown }
  const email = String(b.email ?? '').trim()
  const phone = String(b.phone ?? '').trim()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'email is not a valid address' }
  if (email.length > 254 || phone.length > 40) return { error: 'contact details are too long' }
  return { email, phone }
}

// ── Booking form payload ────────────────────────────────────────────────────

/** One booking line as the totals helper sees it. */
export interface BookingLineInput {
  price: number
  quantity: number
}

export interface BookingTotals {
  /** Σ price × qty across the lines — GST-inclusive, as entered. */
  linesTotal: number
  /** Taxable value: every line backed out of GST, rounded to the paisa. */
  taxable: number
  gstAmount: number
  discount: number
  /**
   * taxable + GST − discount — EXACTLY the invoice grand total that
   * createInvoiceForOrderRow will store at convert time (same per-line
   * roundMoney, same header formula), so the booking's `value`, its advance
   * clamp, the convert endpoint's balance and the printed invoice can never
   * disagree by even a paisa.
   */
  value: number
}

/**
 * The booking money model, shared by create and edit (and mirrored by the
 * form's preview in frontend/src/lib/bookingPricing.ts):
 *   line price = PER-UNIT, GST-inclusive (the sales_orders convention)
 *   taxable_i  = round2(price_i × qty_i ÷ (1 + rate%))
 *   GST        = taxable × rate%
 *   value      = taxable + GST − discount
 */
export function computeBookingTotals(lines: BookingLineInput[], gstRate: number, discount: number): BookingTotals {
  const rate = Math.max(0, Number.isFinite(Number(gstRate)) ? Number(gstRate) : 0)
  const disc = Math.max(0, Number.isFinite(Number(discount)) ? Number(discount) : 0)
  const lineTotal = (l: BookingLineInput) => (Number(l.price) || 0) * (Number(l.quantity) || 0)
  const linesTotal = roundMoney(lines.reduce((a, l) => a + lineTotal(l), 0))
  const taxable = roundMoney(
    lines.reduce((a, l) => a + roundMoney(lineTotal(l) / (1 + rate / 100)), 0),
  )
  const gstAmount = roundMoney((taxable * rate) / 100)
  const value = roundMoney(taxable + gstAmount - disc)
  return { linesTotal, taxable, gstAmount, discount: disc, value }
}

/** A line as stored on `sales_orders.line_items` (jsonb). */
export interface StoredBookingLine {
  /**
   * Stable identity for catalogue-tracked lines (Phase 4): assigned on create,
   * on edit (inherited when product+variant+sku are unchanged) and on first
   * allocation — never rewritten while the line stays the same line, so
   * allocations and invoice items can point at it positionally-independently.
   * Absent on hand-typed lines (nothing to allocate) and on pre-Phase-4 rows
   * until their next explicit edit/allocation.
   */
  id?: string
  title: string
  sku: string
  quantity: number
  /** PER-UNIT price, GST-inclusive — the sales_orders convention (orderPricing.ts). */
  price: number
  /** Catalogue relationship, so the booking keeps pointing at the real product… */
  productId?: string
  /** …and, when the customer picked one, at the exact variant. */
  variantId?: string
}

/**
 * Normalise the items array for BOTH create and edit, so the two can never
 * drift: whole-piece quantities only (a booking books pieces, like every
 * order screen), a non-negative finite price, and the product/variant ids the
 * form sends carried into the stored jsonb. A client-echoed line `id` is
 * carried through here but is only EVER honoured when the previous row
 * actually contained it (see assignBookingLineIds) — a fabricated id cannot
 * persist and hijack an allocation. The invoice builder ignores the extra
 * keys and reads only title/sku/quantity/price, so conversion is unaffected
 * by them.
 */
export function normalizeBookingItems(raw: unknown): { items: StoredBookingLine[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'items must be an array' }
  const items: StoredBookingLine[] = []
  for (const it of raw as Array<Record<string, unknown>>) {
    const title = String(it?.product ?? '').trim()
    const quantity = Math.floor(Number(it?.qty ?? 0))
    if (!title || !(quantity > 0)) continue
    const price = Number(it?.price ?? 0)
    if (!Number.isFinite(price)) return { error: `price for "${title}" is not a number` }
    if (price < 0) return { error: `price for "${title}" cannot be negative` }
    const sku = String(it?.sku ?? '').trim()
    const productId = String(it?.productId ?? '').trim()
    const variantId = String(it?.variantId ?? '').trim()
    const id = String(it?.id ?? '').trim()
    items.push({
      ...(id ? { id } : {}),
      title,
      sku,
      quantity,
      price: Math.round(price * 100) / 100,
      ...(productId ? { productId } : {}),
      ...(variantId ? { variantId } : {}),
    })
  }
  if (items.length === 0) return { error: 'at least one item with product + qty is required' }
  return { items }
}

/**
 * Give every CATALOGUE-TRACKED line a stable id, without ever silently
 * remapping one line onto another:
 *
 *  - an id echoed by the client is honoured ONLY when the previous row
 *    contained it (a fabricated id can never persist);
 *  - otherwise the line inherits the id of the previous line with the SAME
 *    product + variant + sku that no other incoming line has claimed — which
 *    is what keeps ids stable through supported edits (quantity, price,
 *    customer…), and across removals/reorders of other lines;
 *  - a genuinely different line (different product/variant/sku, or brand new)
 *    gets a fresh id — an allocation pinned to the old identity can therefore
 *    never be fulfilled by the wrong line (the guards refuse instead).
 *
 * Hand-typed lines (no productId) carry no id: they have nothing to allocate.
 */
export function assignBookingLineIds(previous: StoredBookingLine[] | null, incoming: StoredBookingLine[]): StoredBookingLine[] {
  const claimed = new Set<string>()
  return incoming.map((line) => {
    if (!String(line.productId ?? '').trim()) return line
    const echoed = typeof line.id === 'string' && line.id.trim() !== '' ? line.id.trim() : null
    if (echoed && previous?.some((p) => p.id === echoed) && !claimed.has(echoed)) {
      claimed.add(echoed)
      return line
    }
    const match = (previous ?? []).find(
      (p) =>
        typeof p.id === 'string' &&
        p.id !== '' &&
        !claimed.has(p.id) &&
        String(p.productId ?? '') === String(line.productId ?? '') &&
        (String(p.variantId ?? '') || null) === (String(line.variantId ?? '') || null) &&
        String(p.sku ?? '') === String(line.sku ?? ''),
    )
    if (match && typeof match.id === 'string') {
      claimed.add(match.id)
      return { ...line, id: match.id }
    }
    return { ...line, id: randomUUID() }
  })
}

/** Header fields the booking form may write. Absent keys stay untouched. */
export interface BookingHeaderFields {
  /** ISO instant for the booking date. */
  date?: string
  /** Date-only `YYYY-MM-DD`, stored as-is (the quotations/PO convention) so re-editing round-trips without timezone drift. */
  expectedDate?: string | null
  /** GST rate (%) the booking was taken at; `null` = use the settings rate. */
  gst?: number | null
  note?: string | null
  /** Only the transitions a form may perform — `fulfilled` belongs to Convert and `cancelled` to the cancel action. */
  status?: string
  /**
   * The single store this booking sells from. Null = the default store (the
   * only store a legacy, location-less booking has ever used). Existence is
   * checked against `inventory_locations` by the route, not here.
   */
  locationId?: string | null
}

/**
 * Validate the booking form's header fields for create and edit. Mirrors the
 * Purchase Orders conventions: date-only strings round-trip as written, GST
 * is a rate between 0 and 100, notes are trimmed and length-capped.
 */
export function parseBookingHeader(body: unknown): BookingHeaderFields | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const out: BookingHeaderFields = {}

  if (b.date !== undefined) {
    const raw = String(b.date ?? '').trim()
    if (!raw || Number.isNaN(Date.parse(raw))) return { error: 'booking date is not a valid date' }
    // Date-only input (what the form sends): keep the WALL CLOCK by pinning
    // midnight explicitly instead of routing through the local zone — a plain
    // new Date('2026-11-20').toISOString() in IST stores 2026-11-19T18:30Z and
    // the date would render a day early everywhere it is displayed.
    out.date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : new Date(raw).toISOString()
  }

  if (b.expectedDate !== undefined) {
    const raw = String(b.expectedDate ?? '').trim()
    if (!raw) out.expectedDate = null
    else if (Number.isNaN(Date.parse(raw))) return { error: 'expected delivery date is not a valid date' }
    else out.expectedDate = raw.slice(0, 10)
  }

  if (b.gst !== undefined) {
    if (b.gst === null || b.gst === '') out.gst = null
    else {
      const gst = Number(b.gst)
      if (!Number.isFinite(gst) || gst < 0 || gst > 100) return { error: 'GST must be between 0 and 100' }
      out.gst = Math.round(gst * 100) / 100
    }
  }

  if (b.note !== undefined) {
    const note = String(b.note ?? '').trim().slice(0, 500)
    out.note = note || null
  }

  if (b.status !== undefined) {
    const status = String(b.status ?? '').trim()
    if (!['confirmed', 'processing'].includes(status)) {
      return { error: 'status must be one of: confirmed, processing' }
    }
    out.status = status
  }

  // The selling store: an explicit id is kept verbatim (existence is checked
  // against inventory_locations by the route); an explicit null clears back to
  // "the default store".
  if (b.locationId !== undefined) {
    const raw = String(b.locationId ?? '').trim()
    out.locationId = raw || null
  }

  return out
}

/**
 * The store a booking will sell from — resolved and verified.
 *
 * - No id (and every LEGACY booking, whose `location_id` is NULL) resolves to
 *   the default store: that is the only location those bookings have ever
 *   validated against and deducted from, so their history is neither guessed
 *   at nor silently rewritten.
 * - An explicit id must exist: an unknown store is REFUSED rather than
 *   redirected, so a booking can never claim stock from a store that does not
 *   hold it. The default-store row is created on demand, exactly as
 *   resolveMovementLocation/ensureDefaultLocation already do at conversion.
 */
export async function ensureBookingLocation(
  id: string | null | undefined,
): Promise<{ locationId: string } | { error: string }> {
  const { db } = await import('./db/client')
  if (!db) return { error: 'Database unavailable' }
  const explicit = id == null ? '' : String(id).trim()
  if (!explicit) {
    const { resolveMovementLocation } = await import('./stock')
    return { locationId: await resolveMovementLocation(null) }
  }
  const { DEFAULT_LOCATION_ID, ensureDefaultLocation } = await import('./stock')
  if (explicit === DEFAULT_LOCATION_ID) return { locationId: await ensureDefaultLocation() }
  const [row] = await db
    .select({ id: s.inventoryLocations.id })
    .from(s.inventoryLocations)
    .where(eq(s.inventoryLocations.id, explicit))
    .limit(1)
  if (!row) return { error: 'selected store does not exist' }
  return { locationId: row.id }
}

// ── Allocation planning (Bookings Phase 3) ──────────────────────────────────

export type AllocationStatus = 'unallocated' | 'partial' | 'fully'

/** Unallocated / Partially Allocated / Fully Allocated — one line or a whole booking. */
export function allocationStatusFor(allocated: number, required: number): AllocationStatus {
  if (!(required > 0) || !(allocated > 0)) return 'unallocated'
  if (allocated >= required) return 'fully'
  return 'partial'
}

export interface AllocationLineSummary {
  lineIndex: number
  title: string
  sku: string
  productId: string | null
  variantId: string | null
  /** False for hand-typed lines: no catalogue identity, nothing to allocate. */
  tracked: boolean
  required: number
  allocated: number
  remaining: number
  status: AllocationStatus
}

export interface StoredBookingAllocation {
  id: string
  lineIndex: number
  productId: string
  variantId: string | null
  sku: string
  locationId: string
  quantity: number
}

/**
 * Derived (never stored) allocation status for a booking and its lines.
 *
 * Bookings status counts ONLY catalogue-tracked lines: a hand-typed line has
 * no product/variant to allocate against, so it can neither be allocated nor
 * block "fully allocated". Legacy bookings simply report Unallocated — their
 * rows are never invented here (no silent conversion of history).
 */
export function buildAllocationSummary(
  booking: { lineItems: unknown },
  allocations: StoredBookingAllocation[],
): { status: AllocationStatus; lines: AllocationLineSummary[] } {
  const items = Array.isArray(booking.lineItems) ? (booking.lineItems as Array<Record<string, unknown>>) : []
  const lines: AllocationLineSummary[] = items.map((li, index) => {
    const productId = String(li?.productId ?? '').trim() || null
    const required = Math.max(0, Math.floor(Number(li?.quantity ?? 0)))
    const allocated = allocations
      .filter((a) => a.lineIndex === index)
      .reduce((sum, a) => sum + Math.max(0, Math.floor(Number(a.quantity) || 0)), 0)
    return {
      lineIndex: index,
      title: String(li?.title ?? ''),
      sku: String(li?.sku ?? ''),
      productId,
      variantId: String(li?.variantId ?? '').trim() || null,
      tracked: Boolean(productId),
      required,
      allocated,
      remaining: Math.max(0, required - allocated),
      status: allocationStatusFor(allocated, required),
    }
  })
  const tracked = lines.filter((l) => l.tracked)
  return {
    status: allocationStatusFor(
      tracked.reduce((a, l) => a + l.allocated, 0),
      tracked.reduce((a, l) => a + l.required, 0),
    ),
    lines,
  }
}

/** One allocation as the PUT route receives it. */
export interface AllocationInput {
  lineIndex: number
  locationId: string
  quantity: number
  /** Optional identity cross-check — what gets STORED always comes from the line. */
  productId?: string
  variantId?: string | null
  sku?: string
}

// ── Booking advance payment ledger (Phase 5.1) ──────────────────────────────

export type AdvanceLedgerAction = 'collected' | 'none'

export interface AdvanceLedgerResult {
  action: AdvanceLedgerAction
  /** The collection row this sync INSERTED (set on 'collected'). */
  paymentId?: string
  /** Cash this sync recorded (set on 'collected'). */
  amount?: number
}

/**
 * Reconcile a booking's ADVANCE LEDGER to its terms, inside the caller's
 * transaction (the booking row is locked `FOR UPDATE`, so concurrent edits,
 * cancels and conversions serialise and always re-read the freshest state).
 *
 * The ledger is an APPEND-ONLY record of ACTUAL CASH — each row is one cash
 * event, and no row is ever overwritten or deleted:
 *   • `Advance` rows (positive, `gateway 'booking'`, `ref = internalId`) are
 *     COLLECTIONS: the initial advance is recorded at create, an INCREASE is
 *     recorded as an ADDITIONAL collection of the difference, and a legacy
 *     booking's never-ledgered advance is recorded once at first edit or
 *     conversion;
 *   • a DECREASE never touches the ledger — the `advance_paid` field is the
 *     booking's TERMS, the rows are the CASH; money that actually went back
 *     to the customer is only ever removed by an explicit refund
 *     (`POST /bookings/:id/refund-advance`);
 *   • CANCELLED bookings are never touched here: cancellation is a STATUS,
 *     not a refund. The collection stays intact and the booking simply
 *     becomes refundable (collections − refunds > 0) until an operator
 *     confirms the money was actually returned;
 *   • IDEMPOTENT: when the ledger already holds at least the terms, it
 *     writes nothing — duplicate saves, retries and re-converts change no
 *     rows.
 */
export async function syncBookingAdvanceLedger(
  tx: import('./stock').Tx,
  orderId: string,
): Promise<AdvanceLedgerResult> {
  const [order] = await tx
    .select()
    .from(s.salesOrders)
    .where(eq(s.salesOrders.id, orderId))
    .limit(1)
    .for('update')
  if (!order || !order.isBooking) return { action: 'none' }
  // Cancellation/refund status is separate from cash (requirement 4): the
  // cancel path never writes a refund — only the explicit endpoint does.
  if (String(order.status ?? '').toLowerCase() === 'cancelled') return { action: 'none' }

  const ref = order.internalId ?? order.id
  const terms = Math.max(0, Number(order.advancePaid ?? 0))
  const collections = await tx
    .select()
    .from(s.payments)
    .where(and(eq(s.payments.ref, ref), eq(s.payments.method, 'Advance'), eq(s.payments.gateway, 'booking')))
  const refunds = await tx
    .select()
    .from(s.payments)
    .where(and(eq(s.payments.ref, ref), eq(s.payments.method, 'Advance Refund'), eq(s.payments.gateway, 'booking')))
  const held =
    [...collections, ...refunds].reduce((a, p) => a + Number(p.amount ?? 0), 0)

  // The ledger already holds the terms (a decrease with no actual refund
  // simply leaves the surplus cash recorded — history is never rewritten).
  if (held >= terms) return { action: 'none' }

  const amount = Math.round((terms - held) * 100) / 100
  const paymentId = randomUUID()
  await tx.insert(s.payments).values({
    id: paymentId,
    ref,
    invoice: null,
    customer: order.customer,
    amount,
    method: 'Advance',
    gateway: 'booking',
    status: 'paid',
    date: new Date().toISOString(),
  })
  return { action: 'collected', paymentId, amount }
}

// ── Booking conversion financials (shared by every entry point) ──────────────

/**
 * The booking financial workflow, shared by EVERY booking→invoice entry
 * point (Convert button, kanban fulfilment auto-invoice, create-invoice,
 * re-invoice) and run INSIDE the conversion transaction, after the invoice,
 * its items, its stock movements and the allocation marks are written:
 *
 *   • the booking is marked fulfilled (status + fulfillment + invoice link);
 *   • the advance: the ledger is first reconciled to the booking's terms
 *     (a POST-created booking is already in sync; a legacy booking records
 *     its initial collection here), then EVERY collection row is re-pointed
 *     to this invoice — each is a separate cash event (initial + additional
 *     collections) and must credit the invoice exactly once. Refund rows are
 *     booking-scoped and never re-pointed (refunds only exist on cancelled
 *     bookings, which cannot convert);
 *   • a failure anywhere rolls the whole conversion back with it.
 *
 * Returns the first collection's payment id; the accounting journals for ALL
 * pointed collections are handled post-commit by `ensureInvoiceSideEffects`.
 */
export async function applyBookingInvoiceFinancials(
  tx: import('./stock').Tx,
  order: typeof s.salesOrders.$inferSelect,
  invoiceNumber: string,
): Promise<{ advancePaymentId?: string }> {
  await tx
    .update(s.salesOrders)
    .set({ invoice: invoiceNumber, status: 'fulfilled', fulfillment: 'fulfilled' })
    .where(eq(s.salesOrders.id, order.id))

  await syncBookingAdvanceLedger(tx, order.id)

  const collections = await tx
    .select()
    .from(s.payments)
    .where(and(
      eq(s.payments.ref, order.internalId ?? order.id),
      eq(s.payments.method, 'Advance'),
      eq(s.payments.gateway, 'booking'),
    ))
  for (const row of collections) {
    if (String(row.invoice ?? '') !== invoiceNumber) {
      await tx.update(s.payments).set({ invoice: invoiceNumber }).where(eq(s.payments.id, row.id))
    }
  }
  return collections[0] ? { advancePaymentId: collections[0].id } : {}
}

// ── Fulfilment plan (Bookings Phase 4, Option A) ─────────────────────────────

/**
 * Thrown inside the conversion transaction when a saved plan cannot be
 * fulfilled EXACTLY as saved — an incomplete allocation, or one whose target
 * line no longer matches. Carries per-line detail; the whole transaction
 * rolls back (no invoice, no claim, no movement, no marks, no payment) and
 * the API answers 400 with the details so the user can fix the plan.
 */
export class AllocationIncompleteError extends Error {
  readonly code = 'ALLOCATION_INCOMPLETE'
  readonly details: Array<{ lineIndex?: number; sku?: string; required?: number; allocated?: number }>
  constructor(
    message: string,
    details: Array<{ lineIndex?: number; sku?: string; required?: number; allocated?: number }> = [],
  ) {
    super(message)
    this.name = 'AllocationIncompleteError'
    this.details = details
  }
}

/** A prepared (pre-split) invoice line — the money `buildManualInvoiceLines` produced. */
export interface PreparedInvoiceLine {
  product: string
  sku: string
  qty: number
  weight: number
  silverRate: number
  makingCharge: number
  tax: number
  amount: number
  silverValue?: number
  makingValue?: number
}

/** One invoice line as the fulfilment write emits it. */
export interface BookingFulfilmentItem extends PreparedInvoiceLine {
  /** 0-based source booking line — carried for the stock-movement note. */
  lineIndex: number
  /** The store this part fulfils from (set on every allocated part). */
  locationId?: string
  bookingLineId?: string
  /** The exact allocation this part consumed. */
  bookingAllocationId?: string
}

/**
 * Resolve ONE allocation to its EXACT booking line: stable `line_id` first
 * (it must be FOUND — never remapped to a different line), then the Phase-3
 * `line_index` + identity cross-check (product + variant + sku must match).
 * Anything that does not resolve throws — fulfilment never guesses.
 */
function resolveAllocationLine(
  lineItems: unknown[],
  alloc: { lineIndex: number; lineId?: string | null; productId: string; variantId?: string | null; sku: string },
): { index: number; line: Record<string, unknown> } {
  const tracked = String(alloc.productId ?? '').trim()
  const refuse = (message: string): never => {
    throw new AllocationIncompleteError(message, [{ lineIndex: alloc.lineIndex, sku: alloc.sku }])
  }
  if (!tracked) refuse(`An allocation for ${alloc.sku} carries no product — adjust the allocations before converting.`)

  let index = -1
  if (alloc.lineId) {
    index = lineItems.findIndex((l) => String((l as { id?: unknown })?.id ?? '') === alloc.lineId)
    if (index === -1) {
      refuse(
        `An allocation points at a booking line that no longer exists (was line ${alloc.lineIndex + 1}, ${alloc.sku}) — adjust the allocations before converting.`,
      )
    }
  } else {
    // Phase-3 row (written before line ids existed): positional + identity.
    index = alloc.lineIndex
  }
  const line = lineItems[index] as Record<string, unknown> | undefined
  if (!line) refuse(`An allocation points at booking line ${index + 1} (${alloc.sku}), which does not exist — adjust the allocations before converting.`)
  const lineVariant = String(line!.variantId ?? '').trim() || null
  if (
    String(line!.productId ?? '') !== tracked ||
    lineVariant !== (alloc.variantId ?? null) ||
    String(line!.sku ?? '') !== alloc.sku
  ) {
    refuse(
      `Allocation for ${alloc.sku} no longer matches booking line ${index + 1} — adjust the allocations before converting (allocations are never remapped to a different product or variant).`,
    )
  }
  return { index, line: line! }
}

/**
 * Build the multi-store fulfilment plan inside the conversion transaction.
 *
 * Pure: takes the freshly locked booking's lines, the prepared invoice items
 * (index-aligned — the manual/booking branch maps line_items 1:1) and the
 * saved allocations, and returns the items the invoice will actually store —
 * one part per (line × store), each naming its store, source line and exact
 * allocation.
 *
 * Rules (all or nothing — a single violation throws and rolls the whole
 * conversion back):
 *   • every allocation resolves to its EXACT line (line_id first, then
 *     line_index + identity) — never remapped;
 *   • every CATALOGUE-TRACKED line is FULLY allocated (Σ == booked qty) when
 *     explicit allocations exist — hand-typed lines carry no product and are
 *     exempt (they fulfil at the booking's own store, as they always have);
 *   • money is split proportionally with the LAST part absorbing the
 *     rounding, so Σ(part amounts) ≡ the original line's amount and invoice
 *     totals are IDENTICAL to an equivalent single-store conversion.
 */
export function buildBookingFulfilmentPlan(input: {
  lineItems: unknown[]
  items: PreparedInvoiceLine[]
  gstRate: number
  allocations: Array<{
    id: string
    lineIndex: number
    lineId?: string | null
    productId: string
    variantId?: string | null
    sku: string
    locationId: string
    quantity: number
  }>
}): BookingFulfilmentItem[] {
  const { lineItems, items, gstRate, allocations } = input
  if (items.length !== lineItems.length) {
    throw new AllocationIncompleteError(
      'This booking cannot be fulfilled from its saved allocations (line mapping mismatch) — adjust the allocations before converting.',
    )
  }

  // 1. Resolve every allocation to its exact line.
  const byLine = new Map<number, typeof allocations>()
  for (const alloc of allocations) {
    const { index } = resolveAllocationLine(lineItems, alloc)
    const rows = byLine.get(index)
    if (rows) rows.push(alloc)
    else byLine.set(index, [alloc])
  }

  // 2. Completeness: every catalogue-tracked line must be fully allocated.
  for (let i = 0; i < lineItems.length; i++) {
    const line = lineItems[i] as Record<string, unknown> | undefined
    if (!line || !String(line.productId ?? '').trim()) continue // hand-typed: exempt
    const required = Math.max(0, Math.floor(Number(line.quantity ?? 0)))
    const rows = byLine.get(i) ?? []
    const allocated = rows.reduce((a, r) => a + Math.max(0, Math.floor(Number(r.quantity) || 0)), 0)
    if (allocated !== required) {
      throw new AllocationIncompleteError(
        `Booking is not fully allocated: line ${i + 1} (${String(line.sku ?? '')}) has ${allocated} of ${required} unit(s) allocated — complete the allocation before converting.`,
        [{ lineIndex: i, sku: String(line.sku ?? ''), required, allocated }],
      )
    }
  }

  // 3. Split: one part per store (deterministic store order), money split
  //    proportionally with the LAST part absorbing the rounding so the sum
  //    never moves by a paisa.
  const out: BookingFulfilmentItem[] = []
  for (let i = 0; i < items.length; i++) {
    const base = items[i]
    const rows = (byLine.get(i) ?? [])
      .slice()
      .sort((a, b) => a.locationId.localeCompare(b.locationId))
    if (rows.length === 0) {
      out.push({ ...base, lineIndex: i })
      continue
    }
    const line = lineItems[i] as Record<string, unknown>
    const lineId = typeof line.id === 'string' && line.id ? line.id : undefined
    const totalQty = Math.max(1, base.qty)
    let amountLeft = base.amount
    let taxLeft = base.tax
    let weightLeft = base.weight
    for (let p = 0; p < rows.length; p++) {
      const r = rows[p]
      const last = p === rows.length - 1
      const qty = Math.max(1, Math.floor(Number(r.quantity)))
      const amount = last ? roundMoney(amountLeft) : roundMoney((base.amount * qty) / totalQty)
      const tax = last ? roundMoney(taxLeft) : roundMoney((amount * gstRate) / 100)
      const weight = last ? Math.round(weightLeft * 1000) / 1000 : Math.round(((base.weight * qty) / totalQty) * 1000) / 1000
      amountLeft = roundMoney(amountLeft - amount)
      taxLeft = roundMoney(taxLeft - tax)
      weightLeft = Math.round((weightLeft - weight) * 1000) / 1000
      out.push({
        product: base.product,
        sku: base.sku,
        qty,
        weight,
        silverRate: base.silverRate,
        makingCharge: base.makingCharge,
        tax,
        amount,
        ...(lineId ? { bookingLineId: lineId } : {}),
        locationId: r.locationId,
        bookingAllocationId: r.id,
        lineIndex: i,
      })
    }
  }
  return out
}

export type PutBookingAllocationsResult =
  | {
      ok: true
      status: AllocationStatus
      lines: AllocationLineSummary[]
      allocations: StoredBookingAllocation[]
    }
  | {
      ok: false
      status: 400 | 404 | 409 | 500 | 503
      error: string
      /** Per-line detail for inline form errors (over-allocation, identity mismatch). */
      details?: Array<{ lineIndex?: number; sku?: string; required?: number; allocated?: number }>
      /** Structured shortfall for INSUFFICIENT_STOCK (409). */
      stock?: InsufficientStockError
    }

/**
 * Replace a booking's allocation set — the single primitive behind "edit and
 * redistribute" (removing a store = simply not sending its row).
 *
 * Everything validates INSIDE one transaction that holds the booking row
 * `FOR UPDATE`, so concurrent saves serialise and can never merge or duplicate
 * each other, and a rejected payload writes NOTHING (earlier allocations
 * survive intact). Validation rules:
 *   • the booking must exist and be neither converted nor cancelled;
 *   • every row must point at an existing, catalogue-tracked line, and any
 *     identity the client sends must MATCH that line (an allocation can never
 *     be attached to an unrelated product/variant);
 *   • a line's allocations can never exceed its booked quantity (partial is
 *     fine — that is the point);
 *   • per stock bucket (product + variant + STORE, aggregated across lines)
 *     the allocated total must fit that store's CURRENT availability — checked
 *     with the same `availableAtLocation` the conversion guard uses, never with
 *     a combined cross-store figure.
 *
 * Allocations are planning records: nothing here moves or reserves stock.
 */
export async function putBookingAllocations(
  orderId: string,
  items: unknown,
): Promise<PutBookingAllocationsResult> {
  const { db } = await import('./db/client')
  if (!db) return { ok: false, status: 503, error: 'Database unavailable' }

  // Shape check (pure): each row needs a line index, a store and a quantity ≥ 1.
  if (!Array.isArray(items)) return { ok: false, status: 400, error: 'items must be an array' }
  const rows: AllocationInput[] = []
  for (const raw of items as Array<Record<string, unknown>>) {
    const lineIndex = Number(raw?.lineIndex)
    const locationId = String(raw?.locationId ?? '').trim()
    const quantity = Math.floor(Number(raw?.quantity))
    if (!Number.isInteger(lineIndex) || lineIndex < 0) return { ok: false, status: 400, error: 'lineIndex must be a non-negative integer' }
    if (!locationId) return { ok: false, status: 400, error: 'every allocation needs a store' }
    if (!Number.isFinite(quantity) || quantity < 1) return { ok: false, status: 400, error: 'allocation quantity must be at least 1' }
    rows.push({
      lineIndex,
      locationId,
      quantity,
      ...(raw?.productId !== undefined ? { productId: String(raw.productId).trim() } : {}),
      ...(raw?.variantId !== undefined ? { variantId: String(raw.variantId ?? '').trim() || null } : {}),
      ...(raw?.sku !== undefined ? { sku: String(raw.sku).trim() } : {}),
    })
  }

  try {
    return await db.transaction(async (tx): Promise<PutBookingAllocationsResult> => {
      // Serialise allocation edits for THIS booking: two concurrent saves can
      // never interleave into a merged or duplicated set.
      const [booking] = await tx
        .select()
        .from(s.salesOrders)
        .where(eq(s.salesOrders.id, orderId))
        .limit(1)
        .for('update')
      if (!booking) return { ok: false, status: 404, error: 'Booking not found' }
      if (booking.invoice) return { ok: false, status: 400, error: 'Booking already converted to an invoice — allocations are closed' }
      if (booking.status === 'cancelled') return { ok: false, status: 400, error: 'Booking is cancelled — allocations are closed' }

      const lineItems = Array.isArray(booking.lineItems) ? (booking.lineItems as Array<Record<string, unknown>>) : []

      // Identity + per-line totals. What gets STORED comes from the line
      // itself; any identity the client sent must match it.
      const perLine = new Map<number, number>()
      for (const row of rows) {
        const line = lineItems[row.lineIndex]
        if (!line) return { ok: false, status: 400, error: `line ${row.lineIndex + 1} does not exist on this booking`, details: [{ lineIndex: row.lineIndex }] }
        const lineProductId = String(line.productId ?? '').trim()
        if (!lineProductId) {
          return {
            ok: false,
            status: 400,
            error: `line ${row.lineIndex + 1} is not a tracked catalogue product — only catalogue lines can be allocated`,
            details: [{ lineIndex: row.lineIndex }],
          }
        }
        const lineVariantId = String(line.variantId ?? '').trim() || null
        if (row.productId !== undefined && row.productId !== lineProductId) {
          return { ok: false, status: 400, error: `line ${row.lineIndex + 1}: allocation product does not match the booked line`, details: [{ lineIndex: row.lineIndex }] }
        }
        if (row.variantId !== undefined && (row.variantId || null) !== lineVariantId) {
          return { ok: false, status: 400, error: `line ${row.lineIndex + 1}: allocation variant does not match the booked line`, details: [{ lineIndex: row.lineIndex }] }
        }
        perLine.set(row.lineIndex, (perLine.get(row.lineIndex) ?? 0) + row.quantity)
      }

      // Never allocate more than the booking itself books.
      const overLines: Array<{ lineIndex: number; sku: string; required: number; allocated: number }> = []
      for (const [lineIndex, allocated] of perLine) {
        const required = Math.max(0, Math.floor(Number(lineItems[lineIndex]?.quantity ?? 0)))
        if (allocated > required) {
          overLines.push({ lineIndex, sku: String(lineItems[lineIndex]?.sku ?? ''), required, allocated })
        }
      }
      if (overLines.length > 0) {
        return { ok: false, status: 400, error: 'allocated quantity exceeds the booked line quantity', details: overLines }
      }

      // Availability per stock bucket (product + variant + store), aggregated
      // across lines that draw the same bucket — the combined figure is never
      // consulted: two stores' stock can never satisfy one store's allocation.
      const buckets = new Map<
        string,
        { productId: string; variantId: string | null; ledgerSku: string; title: string; locationId: string; requested: number }
      >()
      for (const row of rows) {
        const line = lineItems[row.lineIndex]!
        const productId = String(line.productId ?? '').trim()
        const variantId = String(line.variantId ?? '').trim() || null
        const key = `${productId}|${variantId ?? ''}|${row.locationId}`
        const existing = buckets.get(key)
        if (existing) existing.requested += row.quantity
        else {
          buckets.set(key, {
            productId,
            variantId,
            ledgerSku: String(line.sku ?? ''),
            title: String(line.title ?? ''),
            locationId: row.locationId,
            requested: row.quantity,
          })
        }
      }

      const locationIds = [...new Set([...buckets.values()].map((b) => b.locationId))]
      const locationRows = locationIds.length > 0
        ? await tx.select().from(s.inventoryLocations).where(inArray(s.inventoryLocations.id, locationIds))
        : []
      const nameById = new Map(locationRows.map((l) => [l.id, l.name]))
      // A store that no longer exists fails safe: refused, never substituted.
      for (const locationId of locationIds) {
        if (!nameById.has(locationId)) return { ok: false, status: 400, error: 'selected store does not exist' }
      }

      const { availableAtLocation, InsufficientStockError } = await import('./stock')
      const short: InsufficientStockDetail[] = []
      for (const bucket of buckets.values()) {
        const available = await availableAtLocation(
          tx,
          { productId: bucket.productId, ledgerSku: bucket.ledgerSku, ...(bucket.variantId ? { variantId: bucket.variantId } : {}) },
          bucket.locationId,
        )
        if (bucket.requested > available) {
          short.push({
            sku: bucket.ledgerSku,
            name: bucket.title,
            available,
            requested: bucket.requested,
            shortage: bucket.requested - available,
            productId: bucket.productId,
            variantId: bucket.variantId,
            locationId: bucket.locationId,
            location: nameById.get(bucket.locationId) ?? bucket.locationId,
          })
        }
      }
      if (short.length > 0) {
        return { ok: false, status: 409, error: 'Insufficient Stock', stock: new InsufficientStockError(short) }
      }

      // Write the WHOLE set — only after every rule passed (a rejected
      // payload therefore leaves the previous allocations untouched).
      //
      // Stable line identity (Phase 4): the FIRST allocation of a booking
      // gives every catalogue line its id — under this lock, existing ids
      // never rewritten — and each row stores the id of the exact line it
      // fulfils. Phase-3 rows (line_id NULL) still resolve by line_index +
      // identity at convert time, so history is preserved as-is.
      let idsChanged = false
      const identified = lineItems.map((line) => {
        const tracked = Boolean(String(line?.productId ?? '').trim())
        if (!tracked || (typeof line.id === 'string' && line.id)) return line
        idsChanged = true
        return { ...line, id: randomUUID() }
      })
      if (idsChanged) {
        await tx.update(s.salesOrders).set({ lineItems: identified }).where(eq(s.salesOrders.id, orderId))
      }

      await tx.delete(s.bookingAllocations).where(eq(s.bookingAllocations.orderId, orderId))
      if (rows.length > 0) {
        const now = new Date().toISOString()
        await tx.insert(s.bookingAllocations).values(
          rows.map((row) => {
            const line = identified[row.lineIndex]!
            return {
              id: randomUUID(),
              orderId,
              lineIndex: row.lineIndex,
              lineId: typeof line.id === 'string' && line.id ? line.id : null,
              productId: String(line.productId ?? '').trim(),
              variantId: String(line.variantId ?? '').trim() || null,
              sku: String(line.sku ?? ''),
              locationId: row.locationId,
              quantity: row.quantity,
              createdAt: now,
            }
          }),
        )
      }
      const saved = await tx
        .select()
        .from(s.bookingAllocations)
        .where(eq(s.bookingAllocations.orderId, orderId))
        .orderBy(s.bookingAllocations.lineIndex, s.bookingAllocations.locationId)
      const summary = buildAllocationSummary(booking, saved as StoredBookingAllocation[])
      return { ok: true, status: summary.status, lines: summary.lines, allocations: saved as StoredBookingAllocation[] }
    })
  } catch (err) {
    logger.error({ err, orderId }, 'booking allocations save failed')
    return { ok: false, status: 500, error: 'Failed to save allocations' }
  }
}

/** What happened to the `customers` row a booking linked to. */
export type CustomerLinkOutcome = 'updated' | 'created' | 'skipped'

/**
 * Keep the booking ↔ customer relationship REAL instead of free text.
 *
 * Same identity rules as the manual-order flow (index.ts) and the email
 * ingest (ensureCustomerFromEmail), because they encode hard-won data
 * integrity:
 *   1. an explicit customer id (the picker named the row) links directly;
 *   2. otherwise match by email/phone — NEVER by name: two different people
 *      can share a name, and merging them corrupts orders/totalSpent stats;
 *   3. no contact at all → create nothing; the booking stays name-linked,
 *      which is how invoices and Customer 360 already resolve customers.
 *
 * Contact values only ever fill: a blank email/phone on a booking edit can
 * never wipe what the customer record already holds.
 */
export async function ensureBookingCustomer(input: {
  name: string
  email?: string | null
  phone?: string | null
  customerId?: string | null
}): Promise<CustomerLinkOutcome> {
  const { db } = await import('./db/client')
  if (!db) return 'skipped'
  const name = input.name.trim()
  const email = input.email?.trim() || null
  const phone = input.phone?.trim() || null

  if (input.customerId) {
    const [row] = await db.select().from(s.customers).where(eq(s.customers.id, input.customerId)).limit(1)
    if (row) {
      // The booking's name is what the invoice generator matches on later, so
      // it stays in step with the linked record.
      await db
        .update(s.customers)
        .set({ ...(name ? { name } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}) })
        .where(eq(s.customers.id, row.id))
      return 'updated'
    }
    // An id that no longer resolves falls through to the identity rules.
  }

  const conditions = []
  if (email) conditions.push(eq(s.customers.email, email))
  if (phone) conditions.push(eq(s.customers.phone, phone))
  if (conditions.length > 0) {
    const [existing] = await db.select().from(s.customers).where(or(...conditions)).limit(1)
    if (existing) {
      await db
        .update(s.customers)
        .set({ ...(name ? { name } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}) })
        .where(eq(s.customers.id, existing.id))
      return 'updated'
    }
    await db.insert(s.customers).values({
      id: randomUUID(),
      name: name || 'Customer',
      email,
      phone,
      orders: 0,
      totalSpent: 0,
      status: 'active',
      joined: new Date().toISOString().slice(0, 10),
    })
    return 'created'
  }

  return 'skipped'
}

/**
 * Convert a booking into its sales invoice.
 *
 * Rules, in order (they mirror the original route exactly):
 *   • the booking must exist (404) and must not already carry an invoice (400);
 *   • a cancelled booking is not convertible — cancelling means the goods are
 *     not coming back, so the invoice is refused at the API too, not only by
 *     hiding the button;
 *   • `payment` is levelled with the advance ON THE LOCKED ROW inside the
 *     conversion transaction, so a fully advanced booking lands as a paid
 *     invoice and a part advance stays due — from ONE consistent snapshot;
 *   • the invoice itself is claimed atomically inside the conversion
 *     transaction (a repeated or concurrent call reuses the winner's number,
 *     never a second invoice — and the loser writes NO financial record);
 *   • PHASE 4 (Option A): the whole conversion is ONE transaction — the order
 *     row lock, the fulfilment plan (every tracked line fully allocated, one
 *     item part per store), the per-store stock guard, the claim, the invoice
 *     + items, the per-store movements, the allocation fulfilment marks, the
 *     fulfilled status AND the advance payment row commit together or not at
 *     all. A failure anywhere rolls back every store and every record, so
 *     partially completed financial state is impossible and the advance can
 *     never be recorded twice;
 *   • an advance > 0 becomes a `payments` row (method "Advance", gateway
 *     "booking") so Accounts sees the money the booking collected — written
 *     inside that transaction, journaled once after commit;
 *   • the timeline records who converted it (post-commit, winner only).
 */
export async function convertBookingToInvoice(orderId: string, opts: ConvertBookingOptions = {}): Promise<ConvertBookingResult> {
  const { db } = await import('./db/client')
  if (!db) return { ok: false, status: 503, error: 'Database unavailable' }
  try {
    const [order] = await db.select().from(s.salesOrders).where(eq(s.salesOrders.id, orderId)).limit(1)
    if (!order) return { ok: false, status: 404, error: 'Booking not found' }
    if (order.invoice) return { ok: false, status: 400, error: `Already converted to invoice ${order.invoice}` }
    if (order.status === 'cancelled') return { ok: false, status: 400, error: 'Booking is cancelled — restore its status before converting' }

    const { raiseInvoiceForOrder } = await import('./orderEmailIngest')
    // The raise LOCKS the booking row and derives EVERY financial value from
    // that locked snapshot — payment levelling, customer, discount, GST,
    // totals, advance and line items — so a concurrent header edit can never
    // leak stale values into the invoice: it either commits first (its values
    // are billed) or is refused by the conditional edit guard afterwards.
    // The fulfilled status and the advance payment are written by the shared
    // booking workflow INSIDE that same transaction, for every entry point.
    const raised = await raiseInvoiceForOrder(order, { actor: opts.actor ?? null })
    if (!raised.number) return { ok: false, status: 400, error: 'Conversion failed: booking has no convertible line items' }

    // The final committed row — this conversion's result, or (when a
    // concurrent conversion won the claim) the winner's identical workflow.
    const [finalRow] = await db.select().from(s.salesOrders).where(eq(s.salesOrders.id, orderId)).limit(1)
    const value = Number(finalRow?.value ?? 0)
    const advancePaid = Number(finalRow?.advancePaid ?? 0)
    const payment: 'paid' | 'pending' =
      finalRow?.payment === 'paid' || finalRow?.payment === 'pending'
        ? finalRow.payment
        : advancePaid >= value && value > 0
          ? 'paid'
          : 'pending'

    if (raised.claimed) {
      // Post-commit timeline entry, winner only — the loser wrote nothing.
      const { insertOrderEvent } = await import('./routes/db')
      await insertOrderEvent(
        order.id,
        'Booking Converted',
        `Converted to invoice ${raised.number}; advance applied ₹${advancePaid.toLocaleString('en-IN')}`,
        opts.actor ?? 'system',
      )
    }

    return {
      ok: true,
      orderId: order.id,
      invoiceNumber: raised.number,
      advanceApplied: advancePaid,
      balance: Math.round((value - advancePaid) * 100) / 100,
      payment,
    }
  } catch (err) {
    // The stock guard refuses BEFORE anything is written and rolls its
    // transaction back — surface the structured shortfall (matched
    // structurally so this module needs no runtime import of ./stock) instead
    // of collapsing it into an opaque 500. The booking, its advance, its
    // payment history and its customer link are untouched.
    if (err instanceof Error && (err as { code?: string }).code === 'INSUFFICIENT_STOCK') {
      return { ok: false, status: 409, error: err.message, stock: err as InsufficientStockError }
    }
    // Incomplete or mismatched allocations refuse the WHOLE conversion the
    // same way — the transaction had already rolled back; hand the route the
    // per-line detail so the UI can point at the exact line to fix.
    if (err instanceof Error && (err as { code?: string }).code === 'ALLOCATION_INCOMPLETE') {
      return { ok: false, status: 400, error: err.message, details: (err as AllocationIncompleteError).details }
    }
    logger.error({ err, orderId }, 'booking convert failed')
    return { ok: false, status: 500, error: 'Failed to convert booking' }
  }
}
