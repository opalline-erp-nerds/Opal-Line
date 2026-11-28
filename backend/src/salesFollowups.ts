
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { logger } from './logger'
import { recordActivity } from './activity'
import { expireStaleQuotations, quotationIsExpired } from './routes/quotations'
import { createScheduler } from './lib/scheduler'
import type { CustomerIdentityInput } from './lib/customerIdentity'
import { normalizeShopifyCustomerId } from './shopifyDataEnhance'


/**
 * Sales follow-ups — the "what needs chasing today?" list.
 *
 * Three sources, all read-only queries:
 *   • Quotations that were sent / approved but never converted, once they
 *     have been sitting for a day — plus any that are about to lapse.
 *   • Sales orders sitting in the pipeline (new / confirmed / processing).
 *   • Bookings (sales orders flagged isBooking) still awaiting fulfilment, and
 *     bookings whose advance is still unpaid.
 *
 * A daily job also flips lapsed quotations to `expired` so the pipeline stays
 * honest even when nobody opens the quotations page.
 */

export type FollowUpKind = 'quotation' | 'quotation-expiring' | 'order' | 'booking' | 'booking-advance'

export interface SalesFollowUp {
  kind: FollowUpKind
  id: string
  customer: string | null
  reference: string
  detail: string
  value: number
  /** Days since the record was last touched. */
  ageDays: number
  /** Set when the follow-up is time-boxed (e.g. a lapsing quotation). */
  dueAt: string | null
  href: string
}

/** Orders that still need a human to move them along. */
const OPEN_ORDER_STATUSES = ['imported', 'confirmed', 'processing']
/** Wait at least this long after a quote goes out before nudging. */
const QUOTE_NUDGE_DAYS = 1
/** Flag a quotation this many days before it lapses. */
const QUOTE_EXPIRY_WARNING_DAYS = 2

function daysSince(value: string | null | undefined): number {
  if (!value) return 0
  const then = new Date(value).getTime()
  if (!Number.isFinite(then)) return 0
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}

/** Whole days from now until `value` (negative once it has passed). */
function daysUntil(value: string): number {
  const then = new Date(value).getTime()
  if (!Number.isFinite(then)) return 0
  return Math.ceil((then - Date.now()) / 86_400_000)
}


/**
 * Build the follow-up list.
 * Accepts customer identity fields for accurate Customer 360 filtering.
 * Calling without an identity returns the complete follow-up list.
 */
export async function collectSalesFollowUps(
  customerInput?: CustomerIdentityInput | string | null,
): Promise<SalesFollowUp[]> {
  if (!db) return []

  const out: SalesFollowUp[] = []

  
  // Backward compatibility for callers that pass a customer name.
  const identity: CustomerIdentityInput =
    typeof customerInput === 'string'
      ? { name: customerInput }
      : customerInput ?? {}

  const customerId = identity.customerId?.trim() ?? ''
  const shopifyId = identity.shopifyId
    ? normalizeShopifyCustomerId(identity.shopifyId.trim())
    : ''
  const email = identity.email?.trim().toLowerCase() ?? ''
  const phone = identity.phone?.replace(/\D/g, '') ?? ''
  const name = identity.name?.trim() ?? ''

  const hasStrongIdentity = Boolean(customerId || shopifyId || email || phone)
  const hasIdentity = hasStrongIdentity || Boolean(name)

  const orderIdentityConditions = []
  const quotationIdentityConditions = []

  if (hasIdentity) {
    const customerConditions = []

    if (customerId) {
      customerConditions.push(eq(schema.customers.id, customerId))
    }
    if (shopifyId) {
      customerConditions.push(eq(schema.customers.shopifyId, shopifyId))
    }
    if (email) {
      customerConditions.push(
        sql`lower(btrim(coalesce(${schema.customers.email}, ''))) = ${email}`,
      )
    }
    if (phone) {
      customerConditions.push(
        sql`regexp_replace(coalesce(${schema.customers.phone}, ''), '\\D', '', 'g') = ${phone}`,
      )
    }

    const matchedCustomers = customerConditions.length
      ? await db
          .select({
            id: schema.customers.id,
            name: schema.customers.name,
            shopifyId: schema.customers.shopifyId,
            email: schema.customers.email,
            phone: schema.customers.phone,
          })
          .from(schema.customers)
          .where(or(...customerConditions))
      : []

    // Do not combine records when identifiers are ambiguous or conflicting.
    if (matchedCustomers.length > 1) {
      logger.warn(
        { matchedCustomerCount: matchedCustomers.length },
        'Sales follow-up identity is ambiguous or conflicting',
      )
      return []
    }

    const matchedCustomer = matchedCustomers[0]

    // Strong identifiers must resolve to a customer record.
    if (hasStrongIdentity && !matchedCustomer) {
      logger.warn(
        'Sales follow-up customer identity could not be resolved',
      )
      return []
    }

    // Use the resolved record's canonical details.
    const resolvedShopifyId = matchedCustomer?.shopifyId
      ? normalizeShopifyCustomerId(matchedCustomer.shopifyId)
      : ''
    const resolvedEmail =
      matchedCustomer?.email?.trim().toLowerCase() ?? ''
    const resolvedPhone =
      matchedCustomer?.phone?.replace(/\D/g, '') ?? ''
    const resolvedName = matchedCustomer?.name ?? name

    if (resolvedShopifyId) {
      orderIdentityConditions.push(
        eq(schema.salesOrders.customerShopifyId, resolvedShopifyId),
      )
    }

    if (resolvedEmail) {
      orderIdentityConditions.push(
        sql`lower(btrim(coalesce(${schema.salesOrders.customerEmail}, ''))) = ${resolvedEmail}`,
      )
      quotationIdentityConditions.push(
        sql`lower(btrim(coalesce(${schema.quotations.customerEmail}, ''))) = ${resolvedEmail}`,
      )
    }

    if (resolvedPhone) {
      orderIdentityConditions.push(
        sql`regexp_replace(coalesce(${schema.salesOrders.customerPhone}, ''), '\\D', '', 'g') = ${resolvedPhone}`,
      )
      quotationIdentityConditions.push(
        sql`regexp_replace(coalesce(${schema.quotations.customerPhone}, ''), '\\D', '', 'g') = ${resolvedPhone}`,
      )
    }

    // Name-only searches are retained for backward compatibility.
    if (!hasStrongIdentity && resolvedName) {
      orderIdentityConditions.push(
        eq(schema.salesOrders.customer, resolvedName),
      )
      quotationIdentityConditions.push(
        eq(schema.quotations.customer, resolvedName),
      )
    }

    // Never let an identified customer request become an unfiltered query.
    if (
      orderIdentityConditions.length === 0 &&
      quotationIdentityConditions.length === 0
    ) {
      return []
    }
  }

    .select({
      id: schema.quotations.id,
      number: schema.quotations.number,
      customer: schema.quotations.customer,
      status: schema.quotations.status,
      validUntil: schema.quotations.validUntil,
      updatedAt: schema.quotations.updatedAt,
      date: schema.quotations.date,
      grandTotal: schema.quotations.grandTotal,
    })
    .from(schema.quotations)
    .where(
      and(
        inArray(schema.quotations.status, ['sent', 'approved']),
        quotationIdentityConditions.length
          ? or(...quotationIdentityConditions)
          : undefined,
      ),
    )
    .orderBy(asc(schema.quotations.validUntil))

  const expiryWarningAt = new Date(
    Date.now() + QUOTE_EXPIRY_WARNING_DAYS * 86_400_000,
  ).toISOString()

  const nudgeCutoff = new Date(
    Date.now() - QUOTE_NUDGE_DAYS * 86_400_000,
  ).toISOString()

  for (const q of quotes) {
    if (quotationIsExpired(q)) continue
    const touched = q.updatedAt ?? q.date ?? null
    const value = Number(q.grandTotal ?? 0)
    const expiringSoon = Boolean(q.validUntil && q.validUntil <= expiryWarningAt)
    const waiting = daysSince(touched)

    if (
      !expiringSoon &&
      (waiting < QUOTE_NUDGE_DAYS || (touched !== null && touched > nudgeCutoff))
    ) {
      continue
    }

    out.push({
      kind: expiringSoon ? 'quotation-expiring' : 'quotation',
      id: q.id,
      customer: q.customer ?? null,
      reference: q.number,
      detail: expiringSoon
        ? `Quotation ${q.status} — lapses${q.validUntil && daysUntil(q.validUntil) <= 1 ? ' today' : ` in ${daysUntil(q.validUntil!)} day${daysUntil(q.validUntil!) === 1 ? '' : 's'}`}`
        : `Quotation ${q.status} — no decision for ${waiting} day${waiting === 1 ? '' : 's'}`,
      value,
      ageDays: waiting,
      dueAt: q.validUntil ?? null,
      href: '/sales/quotations',
    })
  }

 const quotes = await db
  .select({
    id: schema.quotations.id,
      internalId: schema.salesOrders.internalId,
      customer: schema.salesOrders.customer,
      status: schema.salesOrders.status,
      payment: schema.salesOrders.payment,
      fulfillment: schema.salesOrders.fulfillment,
      value: schema.salesOrders.value,
      date: schema.salesOrders.date,
      isBooking: schema.salesOrders.isBooking,
      advancePaid: schema.salesOrders.advancePaid,
    })
    .from(schema.salesOrders)
    .where(
      and(
        inArray(schema.salesOrders.status, OPEN_ORDER_STATUSES),
        orderIdentityConditions.length
          ? or(...orderIdentityConditions)
          : undefined,
      ),
    )
    .orderBy(asc(schema.salesOrders.date))


  for (const o of orders) {
    const age = daysSince(o.date)
    const value = Number(o.value ?? 0)
    const reference = o.internalId ?? o.id
    if (o.isBooking) {
      const advance = Number(o.advancePaid ?? 0)
      if (o.payment !== 'paid' && advance < value) {
        out.push({
          kind: 'booking-advance',
          id: o.id,
          customer: o.customer ?? null,
          reference,
          detail: `Booking advance pending — ₹${Math.max(0, value - advance).toLocaleString('en-IN')} outstanding (${age}d old)`,
          value: Math.max(0, value - advance),
          ageDays: age,
          dueAt: null,
          href: '/sales/bookings',
        })
      }
      out.push({
        kind: 'booking',
        id: o.id,
        customer: o.customer ?? null,
        reference,
        detail: `Booking awaiting fulfilment (${age}d old)`,
        value,
        ageDays: age,
        dueAt: null,
        href: '/sales/bookings',
      })
      continue
    }
    out.push({
      kind: 'order',
      id: o.id,
      customer: o.customer ?? null,
      reference,
      detail: `Order ${o.status} — ${age}d in pipeline${o.fulfillment && o.fulfillment !== 'pending' ? `, fulfilment ${o.fulfillment}` : ''}`,
      value,
      ageDays: age,
      dueAt: null,
      href: '/sales/orders',
    })
  }

  // Most urgent first: lapsing quotes, then oldest waiting.
  const weight: Record<FollowUpKind, number> = {
    'quotation-expiring': 0,
    'booking-advance': 1,
    quotation: 2,
    order: 3,
    booking: 4,
  }
  return out.sort((a, b) => weight[a.kind] - weight[b.kind] || b.ageDays - a.ageDays)
}

export interface FollowUpSummary {
  total: number
  quotations: number
  orders: number
  bookings: number
  expiring: number
  customerCount: number
  topCustomers: Array<{ customer: string; count: number }>
}

export async function summariseSalesFollowUps(followUps: SalesFollowUp[]): Promise<FollowUpSummary> {
  const perCustomer = new Map<string, number>()
  for (const f of followUps) {
    const key = f.customer ?? 'Walk-in'
    perCustomer.set(key, (perCustomer.get(key) ?? 0) + 1)
  }
  return {
    total: followUps.length,
    quotations: followUps.filter((f) => f.kind === 'quotation' || f.kind === 'quotation-expiring').length,
    orders: followUps.filter((f) => f.kind === 'order').length,
    bookings: followUps.filter((f) => f.kind === 'booking' || f.kind === 'booking-advance').length,
    expiring: followUps.filter((f) => f.kind === 'quotation-expiring').length,
    customerCount: perCustomer.size,
    topCustomers: [...perCustomer.entries()]
      .map(([customer, count]) => ({ customer, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  }
}

// ─── Daily job ──────────────────────────────────────────────────────────────
const HOUR = 10
const MINUTE = 5

function msUntilNextRun(now = new Date()): number {
  const next = new Date(now)
  next.setHours(HOUR, MINUTE, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

/**
 * Housekeeping pass: expire lapsed quotations and record what needs chasing,
 * so the follow-up work shows up in the activity log without anyone asking.
 */
export async function runSalesFollowUps(): Promise<{ expired: number; followUps: number }> {
  const expired = await expireStaleQuotations()
  const followUps = await collectSalesFollowUps()
  if (followUps.length > 0) {
    const summary = await summariseSalesFollowUps(followUps)
    await recordActivity({
      action: 'Sales follow-ups',
      module: 'sales',
      entity: 'Pipeline',
      details:
        `${followUps.length} item(s) need chasing — ${summary.quotations} quotation(s)` +
        `${summary.expiring ? ` (${summary.expiring} lapsing)` : ''}, ${summary.orders} order(s), ${summary.bookings} booking(s)` +
        `${expired > 0 ? `. ${expired} quotation(s) auto-expired` : ''}`,
    })
  } else if (expired > 0) {
    await recordActivity({
      action: 'Quotations auto-expired',
      module: 'sales',
      entity: 'Quotations',
      details: `${expired} quotation(s) lapsed past their valid-until date`,
    })
  }
  logger.info({ expired, followUps: followUps.length }, 'Sales follow-up sweep complete')
  return { expired, followUps: followUps.length }
}

const scheduler = createScheduler({
  label: 'Sales follow-up sweep',
  msUntilNextRun,
  run: () => runSalesFollowUps(),
  // The original re-armed in `.finally`, so a slow sweep delayed the next one.
  mode: 'run-then-rearm',
  onError: (err) => logger.error({ err }, 'Sales follow-up sweep failed'),
})

export function startSalesFollowUps(): void {
  if (scheduler.armed) return
  scheduler.schedule()
  logger.info(
    { next: new Date(Date.now() + msUntilNextRun()).toISOString() },
    'Sales follow-up scheduler started (daily 10:05)',
  )
}

export function stopSalesFollowUps(): void {
  scheduler.stop()
}