import { randomUUID } from 'node:crypto'
import { eq, or } from 'drizzle-orm'
import * as s from './db/schema'
import { roundMoney } from './invoiceTotals'
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
  | { ok: false; status: 400 | 404 | 500 | 503; error: string }

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
 * form sends carried into the stored jsonb. The invoice builder ignores the
 * extra keys and reads only title/sku/quantity/price, so conversion is
 * unaffected by them.
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
    items.push({
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

  return out
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
 *   • `payment` is levelled with the advance before invoicing, so a fully
 *     advanced booking lands as a paid invoice and a part advance stays due;
 *   • the invoice itself is claimed atomically inside createInvoiceForOrderRow
 *     (a repeated or concurrent call reuses the winner's number, never a
 *     second invoice);
 *   • on success the order is marked fulfilled AND its fulfillment column is
 *     finally set — a converted booking is delivered, and every screen that
 *     reads `fulfillment` should agree with the `status` it has always shown;
 *   • an advance > 0 becomes a `payments` row (method "Advance", gateway
 *     "booking") so Accounts sees the money the booking collected;
 *   • the timeline records who converted it.
 */
export async function convertBookingToInvoice(orderId: string, opts: ConvertBookingOptions = {}): Promise<ConvertBookingResult> {
  const { db } = await import('./db/client')
  if (!db) return { ok: false, status: 503, error: 'Database unavailable' }
  try {
    const [order] = await db.select().from(s.salesOrders).where(eq(s.salesOrders.id, orderId)).limit(1)
    if (!order) return { ok: false, status: 404, error: 'Booking not found' }
    if (order.invoice) return { ok: false, status: 400, error: `Already converted to invoice ${order.invoice}` }
    if (order.status === 'cancelled') return { ok: false, status: 400, error: 'Booking is cancelled — restore its status before converting' }

    const value = Number(order.value ?? 0)
    const advancePaid = Number(order.advancePaid ?? 0)
    const fullyPaid = advancePaid >= value && value > 0
    const payment = fullyPaid ? 'paid' : 'pending'
    await db.update(s.salesOrders).set({ payment }).where(eq(s.salesOrders.id, order.id))
    const [fresh] = await db.select().from(s.salesOrders).where(eq(s.salesOrders.id, order.id)).limit(1)
    const { createInvoiceForOrderRow } = await import('./orderEmailIngest')
    // A booking carries the GST rate it was taken at; a legacy row (NULL)
    // converts with the store-wide settings rate, exactly as it always has.
    const gstRate = fresh && fresh.gst != null ? Number(fresh.gst) : undefined
    const invoiceNumber = await createInvoiceForOrderRow(fresh!, gstRate != null ? { gstRate } : {})
    if (!invoiceNumber) return { ok: false, status: 400, error: 'Conversion failed: booking has no convertible line items' }

    await db
      .update(s.salesOrders)
      .set({ invoice: invoiceNumber, status: 'fulfilled', fulfillment: 'fulfilled' })
      .where(eq(s.salesOrders.id, order.id))

    if (advancePaid > 0) {
      const advancePaymentId = randomUUID()
      await db.insert(s.payments).values({
        id: advancePaymentId,
        ref: order.internalId ?? order.id,
        invoice: invoiceNumber,
        customer: order.customer,
        amount: advancePaid,
        method: 'Advance',
        gateway: 'booking',
        status: 'paid',
        date: new Date().toISOString(),
      })
      void import('./accounting/postings')
        .then(({ postPaymentJournal }) => postPaymentJournal(advancePaymentId, opts.actor ?? null))
        .catch((err) => logger.warn({ err, paymentId: advancePaymentId }, 'Failed to auto-post booking advance payment journal'))
    }

    const { insertOrderEvent } = await import('./routes/db')
    await insertOrderEvent(
      order.id,
      'Booking Converted',
      `Converted to invoice ${invoiceNumber}; advance applied ₹${advancePaid.toLocaleString('en-IN')}`,
      opts.actor ?? 'system',
    )

    return {
      ok: true,
      orderId: order.id,
      invoiceNumber,
      advanceApplied: advancePaid,
      balance: Math.round((value - advancePaid) * 100) / 100,
      payment,
    }
  } catch (err) {
    logger.error({ err, orderId }, 'booking convert failed')
    return { ok: false, status: 500, error: 'Failed to convert booking' }
  }
}
