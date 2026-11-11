import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { db } from './db/client'
import * as s from './db/schema'
import { logger } from './logger'

/**
 * Loyalty points engine.
 *
 * Points are earned on eligible paid purchases, redeemed at billing, reversed
 * on refunds/cancellations and expired on a schedule. Every movement is one row
 * in loyalty_transactions and a customer's balance is ALWAYS the sum of that
 * ledger — never a separately stored number that can drift.
 *
 * Guarantees the engine provides:
 *  - one movement per business event (`external_ref` + partial unique index),
 *    so retried webhooks and double-clicked returns cannot double-post;
 *  - balance updates inside a database transaction that holds a per-customer
 *    advisory lock, so concurrent events produce correct `balance_after`;
 *  - refunds reverse points proportionally to the value returned, measured
 *    cumulatively, so repeated partial refunds never over- or under-reverse;
 *  - expiry is FIFO (oldest points spend first) and writes a ledger row per
 *    expired lot, so the ledger still sums to the balance.
 */

export const POINTS_PER = 100 // default ₹ spent per 1 point earned
export const POINT_VALUE = 1 // default ₹ value of 1 point

export type LoyaltyMovementType = 'earn' | 'redeem' | 'adjust' | 'refund' | 'expire'

export interface LoyaltyConfig {
  enabled: boolean
  /** Rupees of eligible spend that earn one point. */
  pointsPer: number
  /** Rupee value of one point at redemption. */
  pointValue: number
  /** Orders below this value earn nothing (0 = no minimum). */
  minOrderValue: number
  /** Months before earned points expire (null = never). */
  expiryMonths: number | null
  /** Push balances to a Shopify customer metafield. */
  shopifySync: boolean
  metafieldNamespace: string
  metafieldKey: string
}

const DEFAULT_NAMESPACE = 'opal_line'
const DEFAULT_KEY = 'loyalty_points'

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Shipped defaults, before the settings row or env overrides are applied. */
export function defaultConfig(): LoyaltyConfig {
  const expiry = envNumber('LOYALTY_EXPIRY_MONTHS', 0)
  return {
    enabled: process.env.LOYALTY_ENABLED !== 'false',
    pointsPer: positive(envNumber('LOYALTY_POINTS_PER', POINTS_PER), POINTS_PER),
    pointValue: positive(envNumber('LOYALTY_POINT_VALUE', POINT_VALUE), POINT_VALUE),
    minOrderValue: Math.max(0, envNumber('LOYALTY_MIN_ORDER', 0)),
    expiryMonths: expiry > 0 ? Math.round(expiry) : null,
    shopifySync: process.env.LOYALTY_SHOPIFY_SYNC === 'true',
    metafieldNamespace: DEFAULT_NAMESPACE,
    metafieldKey: DEFAULT_KEY,
  }
}

/** Merge the single settings row over the defaults. NULL columns keep defaults. */
export function configFromSettings(
  row: Partial<{
    loyaltyEnabled: boolean | null
    loyaltyPointsPer: number | null
    loyaltyPointValue: number | null
    loyaltyMinOrder: number | null
    loyaltyExpiryMonths: number | null
    loyaltyShopifySync: boolean | null
    loyaltyMetafieldNamespace: string | null
    loyaltyMetafieldKey: string | null
  }> | null | undefined,
  base: LoyaltyConfig = defaultConfig(),
): LoyaltyConfig {
  if (!row) return base
  const expiry = row.loyaltyExpiryMonths
  return {
    enabled: row.loyaltyEnabled ?? base.enabled,
    pointsPer: positive(row.loyaltyPointsPer, base.pointsPer),
    pointValue: positive(row.loyaltyPointValue, base.pointValue),
    minOrderValue: row.loyaltyMinOrder != null && Number.isFinite(Number(row.loyaltyMinOrder))
      ? Math.max(0, Number(row.loyaltyMinOrder))
      : base.minOrderValue,
    expiryMonths: expiry != null && Number(expiry) > 0 ? Math.round(Number(expiry)) : (expiry === 0 ? null : base.expiryMonths),
    shopifySync: row.loyaltyShopifySync ?? base.shopifySync,
    metafieldNamespace: row.loyaltyMetafieldNamespace?.trim() || base.metafieldNamespace,
    metafieldKey: row.loyaltyMetafieldKey?.trim() || base.metafieldKey,
  }
}

let configCache: { at: number; config: LoyaltyConfig } | null = null
const CONFIG_TTL_MS = 30_000

export function invalidateConfig(): void {
  configCache = null
}

/** Effective loyalty configuration (settings row, env fallbacks, defaults). */
export async function resolveConfig(): Promise<LoyaltyConfig> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.config
  let config = defaultConfig()
  if (db) {
    try {
      const [row] = await db.select().from(s.settings).where(eq(s.settings.id, 'app')).limit(1)
      config = configFromSettings(row, config)
    } catch (err) {
      logger.warn({ err }, 'loyalty: could not read settings, using defaults')
    }
  }
  configCache = { at: Date.now(), config }
  return config
}

/** Fast boolean used by callers that only need the on/off flag. */
export function isLoyaltyEnabled(): boolean {
  return configCache ? configCache.config.enabled : process.env.LOYALTY_ENABLED !== 'false'
}

// ─── Pure calculation helpers (unit tested) ────────────────────────────────

/** Points earned by a purchase value under the configured rules. */
export function earnedPointsFor(
  value: number,
  rules: { pointsPer: number; minOrderValue?: number },
): number {
  const spent = Number(value)
  if (!Number.isFinite(spent) || spent <= 0) return 0
  const min = Number(rules.minOrderValue ?? 0)
  if (min > 0 && spent < min) return 0
  const per = positive(rules.pointsPer, POINTS_PER)
  return Math.max(0, Math.floor(spent / per))
}

/**
 * Total points that should have been reversed for an award, given how much
 * value has been refunded cumulatively.
 *
 * Using a cumulative target (rather than reversing a share of what is left)
 * makes repeated partial refunds exact and idempotent: the second identical
 * refund call computes the same target and reverses nothing more.
 */
export function reversalTargetPoints(args: {
  earned: number
  alreadyReversedPoints: number
  totalValue: number
  cumulativeReversedValue: number
}): number {
  const earned = Math.max(0, Math.floor(Number(args.earned) || 0))
  const already = Math.min(earned, Math.max(0, Math.floor(Number(args.alreadyReversedPoints) || 0)))
  const total = Number(args.totalValue)
  if (!Number.isFinite(total) || total <= 0) return earned
  const reversedValue = Math.max(0, Number(args.cumulativeReversedValue) || 0)
  const share = Math.min(1, reversedValue / total)
  const target = Math.min(earned, Math.floor(earned * share + 1e-9))
  return Math.max(already, target)
}

export type LoyaltyTier = 'Bronze' | 'Silver' | 'Gold' | 'Platinum'

/** Tier shown on the Loyalty page, derived from the current balance. */
export function loyaltyTier(points: number, thresholds = { silver: 100, gold: 500, platinum: 1000 }): LoyaltyTier {
  const balance = Math.max(0, Math.floor(Number(points) || 0))
  if (balance >= thresholds.platinum) return 'Platinum'
  if (balance >= thresholds.gold) return 'Gold'
  if (balance >= thresholds.silver) return 'Silver'
  return 'Bronze'
}

export interface EarnLot {
  id: string
  points: number
  date: string
  expiresAt?: string | null
}

export interface MovementRow {
  id: string
  type: string
  points: number
  date: string
}

/**
 * FIFO allocation of a customer's movements across their point lots: the
 * oldest points are the first ones spent, which is what "points expire N
 * months after being earned" means to a customer.
 *
 * Every positive movement is a lot — an earn, or a positive manual adjustment
 * (credit). Adjustments never carry an expiry date, so they are never expired
 * themselves, but they do absorb spending before newer earned points do.
 * Returns the unspent points per lot.
 */
export function remainingByLot(lots: EarnLot[], movements: MovementRow[]): Map<string, number> {
  const ordered = [...lots].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  const remaining = new Map<string, number>()
  for (const lot of ordered) remaining.set(lot.id, Math.max(0, Math.floor(Number(lot.points) || 0)))

  const spends = movements
    .filter((m) => Number(m.points) < 0 && m.type !== 'expire')
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  for (const spend of spends) {
    let owed = Math.abs(Math.floor(Number(spend.points) || 0))
    for (const lot of ordered) {
      if (owed <= 0) break
      const left = remaining.get(lot.id) ?? 0
      if (left <= 0) continue
      const take = Math.min(left, owed)
      remaining.set(lot.id, left - take)
      owed -= take
    }
  }
  return remaining
}

/** Points sitting in lots whose expiry date has passed (before the balance cap). */
export function expirablePoints(
  lots: EarnLot[],
  remaining: Map<string, number>,
  nowIso: string,
): Array<{ id: string; points: number }> {
  const now = Date.parse(nowIso)
  const out: Array<{ id: string; points: number }> = []
  for (const lot of lots) {
    if (!lot.expiresAt) continue
    const expires = Date.parse(lot.expiresAt)
    if (!Number.isFinite(expires) || expires > now) continue
    const left = remaining.get(lot.id) ?? 0
    if (left > 0) out.push({ id: lot.id, points: left })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// ─── Ledger primitives ─────────────────────────────────────────────────────

export interface LoyaltyCustomer {
  id: string
  name: string
  phone: string | null
  email: string | null
  shopifyId: string | null
}

/** Normalise a Shopify order identifier to the `#1027` form used everywhere. */
export function normalizeOrderRef(name: string | number | null | undefined): string {
  const raw = String(name ?? '').trim()
  if (!raw) return ''
  return raw.startsWith('#') ? raw : `#${raw}`
}

/**
 * Resolve a customer from whichever identity a caller has. Shopify id wins
 * (names can be blank or duplicated), then email, then phone, then name.
 */
export async function resolveCustomer(input: {
  customerId?: string | null
  shopifyId?: string | null
  email?: string | null
  phone?: string | null
  name?: string | null
}): Promise<LoyaltyCustomer | null> {
  if (!db) return null
  const select = {
    id: s.customers.id,
    name: s.customers.name,
    phone: s.customers.phone,
    email: s.customers.email,
    shopifyId: s.customers.shopifyId,
  }
  const tryOne = async (where: SQL<unknown>) => {
    const [row] = await db!.select(select).from(s.customers).where(where).limit(1)
    return row ?? null
  }

  if (input.customerId?.trim()) {
    const found = await tryOne(eq(s.customers.id, input.customerId.trim()))
    if (found) return found
  }
  if (input.shopifyId?.trim()) {
    const found = await tryOne(eq(s.customers.shopifyId, input.shopifyId.trim()))
    if (found) return found
  }
  const email = input.email?.trim()
  if (email) {
    const found = await tryOne(eq(s.customers.email, email))
    if (found) return found
    const [byLc] = await db
      .select(select)
      .from(s.customers)
      .where(sql`lower(${s.customers.email}) = ${email.toLowerCase()}`)
      .limit(1)
    if (byLc) return byLc
  }
  const digits = String(input.phone ?? '').replace(/\D/g, '')
  if (digits.length >= 10) {
    const [byPhone] = await db
      .select(select)
      .from(s.customers)
      .where(sql`right(regexp_replace(coalesce(${s.customers.phone}, ''), '\\D', '', 'g'), 10) = ${digits.slice(-10)}`)
      .limit(1)
    if (byPhone) return byPhone
  }
  const name = input.name?.trim()
  // Empty names are a real state (Shopify PII redaction) — never match them,
  // otherwise every blank-named customer collapses onto one row.
  if (name && name !== 'Guest') {
    const found = await tryOne(eq(s.customers.name, name))
    if (found) return found
  }
  return null
}

/** Resolve a customer by id, name, or phone (billing lookup / legacy callers). */
export async function findCustomer(query: string): Promise<LoyaltyCustomer | null> {
  const trimmed = String(query ?? '').trim()
  if (!trimmed) return null
  return resolveCustomer({ customerId: trimmed, name: trimmed, phone: trimmed })
}

/** Current point balance = sum of the ledger. */
export async function getBalance(customerId: string): Promise<number> {
  if (!db) return 0
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${s.loyaltyTransactions.points}), 0)` })
    .from(s.loyaltyTransactions)
    .where(eq(s.loyaltyTransactions.customerId, customerId))
  return Number(row?.total ?? 0)
}

export interface PostEntryInput {
  customerId: string
  type: LoyaltyMovementType
  points: number
  invoiceId?: string | null
  invoiceNumber?: string | null
  note?: string | null
  createdBy?: string | null
  source?: string | null
  externalRef?: string | null
  value?: number | null
  expiresAt?: string | null
}

export type PostEntryResult =
  | { ok: true; posted: boolean; id: string; points: number; balanceAfter: number }
  | { ok: false; error: string }

/**
 * Post one ledger movement.
 *
 * Runs in a transaction holding a per-customer advisory lock, so two webhooks
 * arriving together cannot both read the same balance and write a stale
 * `balance_after`. `external_ref` is protected by a partial unique index: a
 * second insert for the same business event is reported as `posted: false` with
 * the original movement's numbers.
 */
export async function postEntry(
  entry: PostEntryInput,
  opts: { mustStayNonNegative?: boolean } = {},
): Promise<PostEntryResult> {
  if (!db) return { ok: false, error: 'Database unavailable' }
  const points = Number(entry.points)
  if (!Number.isFinite(points) || points === 0) {
    return { ok: false, error: 'Points must be a non-zero number' }
  }

  return db.transaction(async (tx) => {
    // Serialise every balance change for this customer.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${entry.customerId}))`)

    if (entry.externalRef) {
      const [existing] = await tx
        .select({
          id: s.loyaltyTransactions.id,
          points: s.loyaltyTransactions.points,
          balanceAfter: s.loyaltyTransactions.balanceAfter,
        })
        .from(s.loyaltyTransactions)
        .where(eq(s.loyaltyTransactions.externalRef, entry.externalRef))
        .limit(1)
      if (existing) {
        return {
          ok: true as const,
          posted: false,
          id: existing.id,
          points: Number(existing.points ?? 0),
          balanceAfter: Number(existing.balanceAfter ?? 0),
        }
      }
    }

    const [balanceRow] = await tx
      .select({ total: sql<string>`coalesce(sum(${s.loyaltyTransactions.points}), 0)` })
      .from(s.loyaltyTransactions)
      .where(eq(s.loyaltyTransactions.customerId, entry.customerId))
    const balance = Number(balanceRow?.total ?? 0)
    const balanceAfter = balance + points

    if (opts.mustStayNonNegative && balanceAfter < 0) {
      return {
        ok: false as const,
        error: `Insufficient points: balance is ${balance}, this movement needs ${Math.abs(points)}`,
      }
    }

    const id = randomUUID()
    const [inserted] = await tx
      .insert(s.loyaltyTransactions)
      .values({
        id,
        customerId: entry.customerId,
        invoiceId: entry.invoiceId ?? null,
        invoiceNumber: entry.invoiceNumber ?? null,
        type: entry.type,
        points,
        balanceAfter,
        note: entry.note ?? null,
        createdBy: entry.createdBy ?? null,
        source: entry.source ?? null,
        externalRef: entry.externalRef ?? null,
        value: entry.value ?? null,
        expiresAt: entry.expiresAt ?? null,
        date: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning({ id: s.loyaltyTransactions.id })

    if (!inserted) {
      // Lost a race on the unique ref — the other transaction posted it.
      const [existing] = await tx
        .select({
          id: s.loyaltyTransactions.id,
          points: s.loyaltyTransactions.points,
          balanceAfter: s.loyaltyTransactions.balanceAfter,
        })
        .from(s.loyaltyTransactions)
        .where(eq(s.loyaltyTransactions.externalRef, entry.externalRef ?? ''))
        .limit(1)
      return {
        ok: true as const,
        posted: false,
        id: existing?.id ?? id,
        points: Number(existing?.points ?? points),
        balanceAfter: Number(existing?.balanceAfter ?? balanceAfter),
      }
    }

    return { ok: true as const, posted: true, id, points, balanceAfter }
  })
}

function expiryDateFor(months: number | null): string | null {
  if (!months || months <= 0) return null
  const d = new Date()
  d.setMonth(d.getMonth() + months)
  return d.toISOString()
}

// ─── Earn ──────────────────────────────────────────────────────────────────

export interface InvoiceForLoyalty {
  id: string
  number: string
  customer: string | null | undefined
  grandTotal: number | string | null
  status?: string | null
  customerId?: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  shopifyOrder?: string | null
  date?: string | null
}

/**
 * Award points for a sales invoice. Idempotent per invoice (`invoice:<id>`):
 * repeated calls for the same invoice post nothing.
 *
 * When the invoice is linked to a Shopify order, an award that already exists
 * for that order without an invoice (an order imported before its invoice was
 * raised) is claimed by this invoice instead of awarding twice.
 */
export async function earnForInvoice(
  invoice: InvoiceForLoyalty,
): Promise<{ points: number; balanceAfter: number } | null> {
  try {
    if (!db) return null
    const config = await resolveConfig()
    if (!config.enabled) return null
    const status = String(invoice.status ?? '').toLowerCase()
    if (status === 'cancelled' || status === 'refunded') return null

    const value = Number(invoice.grandTotal ?? 0)
    if (!(value > 0)) return null

    const customer = await resolveCustomer({
      customerId: invoice.customerId,
      email: invoice.customerEmail,
      phone: invoice.customerPhone,
      name: invoice.customer,
    })
    if (!customer) return null // walk-in / unmatched customer — no points

    const points = earnedPointsFor(value, config)
    if (points <= 0) return null

    const invoiceRef = `invoice:${invoice.id}`
    const orderRef = invoice.shopifyOrder ? `order:${normalizeOrderRef(invoice.shopifyOrder)}` : null

    // An order-level award that never got an invoice takes ownership here.
    if (orderRef) {
      const [unclaimed] = await db
        .select({ id: s.loyaltyTransactions.id, points: s.loyaltyTransactions.points, balanceAfter: s.loyaltyTransactions.balanceAfter })
        .from(s.loyaltyTransactions)
        .where(and(eq(s.loyaltyTransactions.externalRef, orderRef), eq(s.loyaltyTransactions.type, 'earn')))
        .limit(1)
      if (unclaimed) {
        const [claimed] = await db
          .update(s.loyaltyTransactions)
          .set({ invoiceId: invoice.id, invoiceNumber: invoice.number, value })
          .where(and(eq(s.loyaltyTransactions.id, unclaimed.id), sql`${s.loyaltyTransactions.invoiceId} is null`))
          .returning({ id: s.loyaltyTransactions.id })
        if (claimed) {
          return { points: Number(unclaimed.points ?? 0), balanceAfter: Number(unclaimed.balanceAfter ?? 0) }
        }
      }
    }

    const result = await postEntry({
      customerId: customer.id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      type: 'earn',
      points,
      source: 'invoice',
      externalRef: invoiceRef,
      value,
      expiresAt: expiryDateFor(config.expiryMonths),
      note: `Earned on invoice ${invoice.number}`,
    })
    if (!result.ok) {
      logger.warn({ invoice: invoice.number, error: result.error }, 'loyalty earn skipped')
      return null
    }
    // Already awarded for this invoice: report "nothing new" to the caller.
    if (!result.posted) return null
    return { points: result.points, balanceAfter: result.balanceAfter }
  } catch (err) {
    logger.error({ err }, 'loyalty earn failed (non-fatal)')
    return null
  }
}

export interface ShopifyOrderForLoyalty {
  /** Shopify order name, with or without the leading `#`. */
  name: string
  total: number | string | null
  financialStatus?: string | null
  cancelledAt?: string | null
  customerShopifyId?: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  customerName?: string | null
}

/**
 * Award points for a paid Shopify order that has NO local invoice.
 *
 * Orders that do have an invoice earn through `earnForInvoice`, so this path
 * exists for the gap where invoicing failed or was never raised — it must never
 * run for an order the invoice path already covers.
 */
export async function earnForShopifyOrder(
  order: ShopifyOrderForLoyalty,
): Promise<{ points: number; balanceAfter: number } | null> {
  try {
    if (!db) return null
    const config = await resolveConfig()
    if (!config.enabled) return null

    const orderRef = normalizeOrderRef(order.name)
    if (!orderRef || orderRef === '#') return null
    if (order.cancelledAt) return null
    const financial = String(order.financialStatus ?? '').toLowerCase()
    if (financial && financial !== 'paid' && financial !== 'partially_refunded') return null

    const value = Number(order.total ?? 0)
    if (!(value > 0)) return null

    const customer = await resolveCustomer({
      shopifyId: order.customerShopifyId,
      email: order.customerEmail,
      phone: order.customerPhone,
      name: order.customerName,
    })
    if (!customer) return null

    // The invoice path owns orders that have an invoice.
    const [invoice] = await db
      .select({ id: s.salesInvoices.id })
      .from(s.salesInvoices)
      .where(eq(s.salesInvoices.shopifyOrder, orderRef))
      .limit(1)
    if (invoice) return null

    const points = earnedPointsFor(value, config)
    if (points <= 0) return null

    const result = await postEntry({
      customerId: customer.id,
      type: 'earn',
      points,
      source: 'shopify_order',
      externalRef: `order:${orderRef}`,
      value,
      expiresAt: expiryDateFor(config.expiryMonths),
      note: `Earned on Shopify order ${orderRef}`,
    })
    if (!result.ok) {
      logger.warn({ order: orderRef, error: result.error }, 'loyalty order earn skipped')
      return null
    }
    // Already awarded for this order (retried webhook): nothing new posted.
    if (!result.posted) return null
    return { points: result.points, balanceAfter: result.balanceAfter }
  } catch (err) {
    logger.error({ err }, 'loyalty order earn failed (non-fatal)')
    return null
  }
}

// ─── Redeem / adjust ───────────────────────────────────────────────────────

/**
 * Redeem points at billing time. Fails when the balance is insufficient — the
 * check and the write happen under one lock, so a concurrent redemption cannot
 * take the balance below zero.
 */
export async function redeem(
  customerId: string,
  points: number,
  opts: { invoiceId?: string; invoiceNumber?: string; createdBy?: string } = {},
): Promise<{ ok: true; balanceAfter: number } | { ok: false; error: string }> {
  if (!db) return { ok: false, error: 'Database unavailable' }
  const amount = Math.floor(Number(points))
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Points to redeem must be positive' }

  const result = await postEntry(
    {
      customerId,
      invoiceId: opts.invoiceId ?? null,
      invoiceNumber: opts.invoiceNumber ?? null,
      type: 'redeem',
      points: -amount,
      source: 'redeem',
      note: opts.invoiceNumber ? `Redeemed on invoice ${opts.invoiceNumber}` : 'Redeemed at billing',
      createdBy: opts.createdBy ?? null,
    },
    { mustStayNonNegative: true },
  )
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, balanceAfter: result.balanceAfter }
}

/** Manual adjustment (admin correction), with the note kept as the audit trail. */
export async function adjust(
  customerId: string,
  points: number,
  note: string,
  createdBy?: string,
): Promise<{ points: number; balanceAfter: number }> {
  const amount = Math.floor(Number(points))
  if (!Number.isFinite(amount) || amount === 0) throw new Error('Adjustment must be a non-zero whole number')
  const result = await postEntry(
    {
      customerId,
      type: 'adjust',
      points: amount,
      source: 'manual',
      note: note || 'Manual adjustment',
      createdBy: createdBy ?? null,
    },
    { mustStayNonNegative: true },
  )
  if (!result.ok) throw new Error(result.error)
  return { points: result.points, balanceAfter: result.balanceAfter }
}

// ─── Reversals ─────────────────────────────────────────────────────────────

interface AwardRow {
  id: string
  invoiceId: string | null
  points: number
  externalRef: string | null
}

/**
 * Reverse points for a refund or a cancellation.
 *
 * The award being reversed is located by invoice id and/or Shopify order, the
 * cumulative refunded value is compared with the award's original value, and
 * only the missing difference is posted — so a partial refund, a second partial
 * refund, a full refund and a duplicate webhook all land on the right total.
 */
export async function reverseAward(opts: {
  invoiceId?: string | null
  invoiceNumber?: string | null
  orderName?: string | null
  customerId?: string | null
  customerName?: string | null
  /** Value being returned now. Omit for a full reversal (cancellation). */
  value?: number | null
  reason?: string
  refundId?: string | null
  /** Explicit idempotency key for this reversal (e.g. a credit-note return). */
  reference?: string | null
}): Promise<{ points: number; balanceAfter: number } | null> {
  try {
    if (!db) return null
    const config = await resolveConfig()
    if (!config.enabled) return null

    const orderRef = opts.orderName ? normalizeOrderRef(opts.orderName) : null

    // Locate the awards this reversal applies to.
    const conditions: SQL<unknown>[] = []
    if (opts.invoiceId) conditions.push(eq(s.loyaltyTransactions.invoiceId, opts.invoiceId))
    if (orderRef) {
      conditions.push(eq(s.loyaltyTransactions.externalRef, `order:${orderRef}`))
      // Awards made through the invoice path for this Shopify order.
      conditions.push(
        sql`${s.loyaltyTransactions.invoiceId} in (select id from sales_invoices where shopify_order = ${orderRef})`,
      )
    }
    if (conditions.length === 0) return null

    const awards = (await db
      .select({
        id: s.loyaltyTransactions.id,
        invoiceId: s.loyaltyTransactions.invoiceId,
        points: s.loyaltyTransactions.points,
        externalRef: s.loyaltyTransactions.externalRef,
      })
      .from(s.loyaltyTransactions)
      .where(and(eq(s.loyaltyTransactions.type, 'earn'), or(...conditions)))) as AwardRow[]

    if (awards.length === 0) return null
    const earned = awards.reduce((sum, a) => sum + Number(a.points ?? 0), 0)
    if (earned <= 0) return null

    const customerId =
      opts.customerId ??
      (
        await db
          .select({ customerId: s.loyaltyTransactions.customerId })
          .from(s.loyaltyTransactions)
          .where(eq(s.loyaltyTransactions.id, awards[0]!.id))
          .limit(1)
      )[0]?.customerId ??
      null
    if (!customerId) return null

    // Every reversal posted for these awards so far. Match on the awards'
    // invoices and their own refs — an award is identified by `invoice:<id>`
    // or `order:#1027`, never by the reversal's own refund id.
    const awardIds = awards.map((a) => a.id)
    const awardInvoiceIds = [...new Set(awards.map((a) => a.invoiceId).filter((id): id is string => Boolean(id)))]
    const awardRefs = [...new Set(awards.map((a) => a.externalRef).filter((ref): ref is string => Boolean(ref)))]
    const priorWhere: SQL<unknown>[] = []
    if (awardInvoiceIds.length > 0) priorWhere.push(inArray(s.loyaltyTransactions.invoiceId, awardInvoiceIds))
    if (awardRefs.length > 0) priorWhere.push(inArray(s.loyaltyTransactions.externalRef, awardRefs))
    if (opts.invoiceId) priorWhere.push(eq(s.loyaltyTransactions.invoiceId, opts.invoiceId))
    if (orderRef) priorWhere.push(eq(s.loyaltyTransactions.externalRef, `order:${orderRef}`))
    if (priorWhere.length === 0) priorWhere.push(sql`false`)

    const priorReversals = await db
      .select({ points: s.loyaltyTransactions.points, value: s.loyaltyTransactions.value })
      .from(s.loyaltyTransactions)
      .where(
        and(
          eq(s.loyaltyTransactions.customerId, customerId),
          inArray(s.loyaltyTransactions.type, ['adjust', 'refund']),
          or(...priorWhere),
        ),
      )

    const alreadyReversedPoints = Math.abs(
      priorReversals.reduce((sum, r) => sum + Math.min(0, Number(r.points ?? 0)), 0),
    )
    const priorReversedValue = priorReversals.reduce((sum, r) => sum + Math.max(0, Number(r.value ?? 0)), 0)

    // Original value of the award(s): the ledger row value, else the invoice.
    let totalValue = 0
    const awardValues = await db
      .select({ value: s.loyaltyTransactions.value })
      .from(s.loyaltyTransactions)
      .where(inArray(s.loyaltyTransactions.id, awardIds))
    totalValue = awardValues.reduce((sum, r) => sum + Math.max(0, Number(r.value ?? 0)), 0)
    if (totalValue <= 0 && opts.invoiceId) {
      const [invoice] = await db
        .select({ grandTotal: s.salesInvoices.grandTotal })
        .from(s.salesInvoices)
        .where(eq(s.salesInvoices.id, opts.invoiceId))
        .limit(1)
      totalValue = Math.max(0, Number(invoice?.grandTotal ?? 0))
    }

    const cumulativeValue = opts.value == null ? totalValue : priorReversedValue + Math.max(0, Number(opts.value))
    const target = reversalTargetPoints({
      earned,
      alreadyReversedPoints,
      totalValue,
      cumulativeReversedValue: cumulativeValue,
    })
    const delta = target - alreadyReversedPoints
    if (delta <= 0) return null

    const reference =
      opts.reference ? opts.reference
        : opts.refundId ? `refund:${opts.refundId}`
          : opts.value == null ? `cancel:${opts.invoiceId ?? orderRef}`
            : `return:${opts.invoiceId ?? orderRef}:${Math.round(cumulativeValue * 100)}`

    const result = await postEntry({
      customerId,
      invoiceId: opts.invoiceId ?? awards[0]?.invoiceId ?? null,
      invoiceNumber: opts.invoiceNumber ?? null,
      type: opts.refundId || opts.value != null ? 'refund' : 'adjust',
      points: -delta,
      source: opts.refundId ? 'shopify_refund' : opts.value != null ? 'return' : 'cancel',
      externalRef: reference,
      value: opts.value == null ? totalValue : Math.max(0, Number(opts.value)),
      note: opts.reason ?? `Reversed ${delta} points on ${opts.invoiceNumber ?? orderRef ?? 'award'}`,
    })
    if (!result.ok) return null
    // This exact reversal was already posted (retried webhook / return id).
    if (!result.posted) return null
    return { points: -delta, balanceAfter: result.balanceAfter }
  } catch (err) {
    logger.error({ err }, 'loyalty reversal failed (non-fatal)')
    return null
  }
}

/**
 * Claw back points earned on an invoice that is being returned or cancelled.
 * Kept as the invoice-shaped entry point for existing callers.
 */
export async function reverseEarnedForInvoice(invoice: {
  id: string
  number: string
  customer?: string | null
  value?: number | null
  reason?: string
  customerId?: string | null
  shopifyOrder?: string | null
  reference?: string | null
}): Promise<{ points: number; balanceAfter: number } | null> {
  return reverseAward({
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    orderName: invoice.shopifyOrder ?? null,
    customerId: invoice.customerId ?? null,
    customerName: invoice.customer,
    value: invoice.value,
    reason: invoice.reason,
    reference: invoice.reference ?? null,
  })
}

// ─── Expiry ────────────────────────────────────────────────────────────────

/**
 * Expire points whose lot has passed its expiry date (FIFO).
 *
 * Each expired lot gets one `expire:<lot id>` movement, so re-running is a
 * no-op and the ledger still sums to the balance. Expiry never takes a balance
 * below zero — points already spent are simply not expired twice.
 */
export async function expirePoints(
  opts: { customerId?: string; now?: Date } = {},
): Promise<{ expiredPoints: number; lots: number; customers: number }> {
  if (!db) return { expiredPoints: 0, lots: 0, customers: 0 }
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()

  const dueWhere = [
    eq(s.loyaltyTransactions.type, 'earn'),
    isNotNull(s.loyaltyTransactions.expiresAt),
    lte(s.loyaltyTransactions.expiresAt, nowIso),
  ]
  if (opts.customerId) dueWhere.push(eq(s.loyaltyTransactions.customerId, opts.customerId))

  const due = await db
    .select({
      id: s.loyaltyTransactions.id,
      customerId: s.loyaltyTransactions.customerId,
      points: s.loyaltyTransactions.points,
      expiresAt: s.loyaltyTransactions.expiresAt,
      date: s.loyaltyTransactions.date,
    })
    .from(s.loyaltyTransactions)
    .where(and(...dueWhere))
  if (due.length === 0) return { expiredPoints: 0, lots: 0, customers: 0 }

  const customerIds = [...new Set(due.map((d) => d.customerId))]
  let expiredPoints = 0
  let lots = 0

  for (const customerId of customerIds) {
    const rows = await db
      .select({
        id: s.loyaltyTransactions.id,
        type: s.loyaltyTransactions.type,
        points: s.loyaltyTransactions.points,
        date: s.loyaltyTransactions.date,
        expiresAt: s.loyaltyTransactions.expiresAt,
        externalRef: s.loyaltyTransactions.externalRef,
      })
      .from(s.loyaltyTransactions)
      .where(eq(s.loyaltyTransactions.customerId, customerId))

    // Every positive movement is a point lot; only earned lots carry expiry.
    const lotRows = rows.filter((r) => Number(r.points ?? 0) > 0)
    const movements = rows.map((r) => ({ id: r.id, type: r.type, points: Number(r.points ?? 0), date: r.date ?? '' }))
    const remaining = remainingByLot(
      lotRows.map((r) => ({ id: r.id, points: Number(r.points ?? 0), date: r.date ?? '', expiresAt: r.expiresAt })),
      movements,
    )

    const alreadyExpired = new Map<string, number>()
    for (const row of rows) {
      if (row.type !== 'expire' || !row.externalRef?.startsWith('expire:')) continue
      const lot = row.externalRef.slice('expire:'.length)
      alreadyExpired.set(lot, (alreadyExpired.get(lot) ?? 0) + Math.abs(Number(row.points ?? 0)))
    }

    const expirable = expirablePoints(
      lotRows.map((r) => ({ id: r.id, points: Number(r.points ?? 0), date: r.date ?? '', expiresAt: r.expiresAt })),
      remaining,
      nowIso,
    )

    let balance = rows.reduce((sum, r) => sum + Number(r.points ?? 0), 0)

    for (const lot of expirable) {
      const pending = lot.points - (alreadyExpired.get(lot.id) ?? 0)
      if (pending <= 0) continue
      // Never push the balance below zero: a customer who already spent these
      // points has nothing left to expire.
      const points = Math.min(pending, Math.max(0, balance))
      if (points <= 0) continue
      const result = await postEntry({
        customerId,
        type: 'expire',
        points: -points,
        source: 'expiry',
        externalRef: `expire:${lot.id}`,
        note: `Expired ${points} points earned on ${new Date(lotRows.find((r) => r.id === lot.id)?.date ?? nowIso).toISOString().slice(0, 10)}`,
      })
      if (!result.ok || !result.posted) continue
      balance = result.balanceAfter
      expiredPoints += points
      lots += 1
    }
  }

  return { expiredPoints, lots, customers: customerIds.length }
}

// ─── Reporting ─────────────────────────────────────────────────────────────

export interface LoyaltyRange {
  from?: string | null
  to?: string | null
}

function rangeConditions(range: LoyaltyRange | undefined) {
  const where = []
  if (range?.from) where.push(gte(s.loyaltyTransactions.date, range.from))
  if (range?.to) where.push(lte(s.loyaltyTransactions.date, range.to))
  return where
}

export interface LoyaltySummary {
  enrolledCustomers: number
  pointsIssued: number
  pointsRedeemed: number
  pointsRefunded: number
  pointsAdjusted: number
  pointsExpired: number
  pointsOutstanding: number
  transactions: number
  lastActivityAt: string | null
}

/** Dashboard totals, straight from the ledger (never a client-side sum). */
export async function getSummary(range?: LoyaltyRange): Promise<LoyaltySummary> {
  const empty: LoyaltySummary = {
    enrolledCustomers: 0,
    pointsIssued: 0,
    pointsRedeemed: 0,
    pointsRefunded: 0,
    pointsAdjusted: 0,
    pointsExpired: 0,
    pointsOutstanding: 0,
    transactions: 0,
    lastActivityAt: null,
  }
  if (!db) return empty
  const where = rangeConditions(range)
  const t = s.loyaltyTransactions

  const [totals] = await db
    .select({
      issued: sql<string>`coalesce(sum(case when ${t.type} = 'earn' then ${t.points} else 0 end), 0)`,
      redeemed: sql<string>`coalesce(sum(case when ${t.type} = 'redeem' then -${t.points} else 0 end), 0)`,
      refunded: sql<string>`coalesce(sum(case when ${t.type} = 'refund' then -${t.points} else 0 end), 0)`,
      adjusted: sql<string>`coalesce(sum(case when ${t.type} = 'adjust' then ${t.points} else 0 end), 0)`,
      expired: sql<string>`coalesce(sum(case when ${t.type} = 'expire' then -${t.points} else 0 end), 0)`,
      outstanding: sql<string>`coalesce(sum(${t.points}), 0)`,
      transactions: sql<string>`count(*)`,
      customers: sql<string>`count(distinct ${t.customerId})`,
      lastActivity: sql<string | null>`max(${t.date})`,
    })
    .from(t)
    .where(where.length > 0 ? and(...where) : undefined)

  return {
    enrolledCustomers: Number(totals?.customers ?? 0),
    pointsIssued: Number(totals?.issued ?? 0),
    pointsRedeemed: Number(totals?.redeemed ?? 0),
    pointsRefunded: Number(totals?.refunded ?? 0),
    pointsAdjusted: Number(totals?.adjusted ?? 0),
    pointsExpired: Number(totals?.expired ?? 0),
    pointsOutstanding: Number(totals?.outstanding ?? 0),
    transactions: Number(totals?.transactions ?? 0),
    lastActivityAt: totals?.lastActivity ? String(totals.lastActivity) : null,
  }
}

export interface LoyaltyCustomerRow {
  id: string
  name: string
  phone: string | null
  email: string | null
  shopifyId: string | null
  city: string | null
  status: string | null
  balance: number
  totalEarned: number
  totalRedeemed: number
  totalAdjusted: number
  totalExpired: number
  transactions: number
  lastActivityAt: string | null
  tier: LoyaltyTier
}

/** Customers with loyalty activity, with server-computed balances. */
export async function listCustomers(opts: {
  query?: string
  limit?: number
  offset?: number
  minBalance?: number
} = {}): Promise<{ customers: LoyaltyCustomerRow[]; total: number }> {
  if (!db) return { customers: [], total: 0 }
  const t = s.loyaltyTransactions
  const c = s.customers
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)))
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const q = opts.query?.trim()

  const where = q
    ? or(
        ilike(c.name, `%${q}%`),
        sql`coalesce(${c.phone}, '') like ${`%${q}%`}`,
        sql`coalesce(${c.email}, '') ilike ${`%${q}%`}`,
      )
    : undefined

  const rows = await db
    .select({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      shopifyId: c.shopifyId,
      city: c.city,
      status: c.status,
      balance: sql<string>`coalesce(sum(${t.points}), 0)`,
      earned: sql<string>`coalesce(sum(case when ${t.type} = 'earn' then ${t.points} else 0 end), 0)`,
      redeemed: sql<string>`coalesce(sum(case when ${t.type} = 'redeem' then -${t.points} else 0 end), 0)`,
      adjusted: sql<string>`coalesce(sum(case when ${t.type} = 'adjust' then ${t.points} else 0 end), 0)`,
      expired: sql<string>`coalesce(sum(case when ${t.type} = 'expire' then -${t.points} else 0 end), 0)`,
      transactions: sql<string>`count(${t.id})`,
      lastActivity: sql<string | null>`max(${t.date})`,
    })
    .from(c)
    .innerJoin(t, eq(t.customerId, c.id))
    .where(where)
    .groupBy(c.id)
    .orderBy(sql`coalesce(sum(${t.points}), 0) desc`)
    .limit(limit)
    .offset(offset)

  const [countRow] = await db
    .select({ total: sql<string>`count(distinct ${t.customerId})` })
    .from(t)
    .innerJoin(c, eq(c.id, t.customerId))
    .where(where)

  const customers = rows
    .map((row) => {
      const balance = Number(row.balance ?? 0)
      return {
        id: row.id,
        name: row.name ?? '',
        phone: row.phone,
        email: row.email,
        shopifyId: row.shopifyId,
        city: row.city,
        status: row.status,
        balance,
        totalEarned: Number(row.earned ?? 0),
        totalRedeemed: Number(row.redeemed ?? 0),
        totalAdjusted: Number(row.adjusted ?? 0),
        totalExpired: Number(row.expired ?? 0),
        transactions: Number(row.transactions ?? 0),
        lastActivityAt: row.lastActivity ? String(row.lastActivity) : null,
        tier: loyaltyTier(balance),
      }
    })
    .filter((row) => (opts.minBalance == null ? true : row.balance >= opts.minBalance))

  return { customers, total: Number(countRow?.total ?? customers.length) }
}

export interface LoyaltyTransactionRow {
  id: string
  customerId: string
  customerName: string
  customerPhone: string | null
  shopifyId: string | null
  type: string
  points: number
  balanceAfter: number | null
  invoiceId: string | null
  invoiceNumber: string | null
  source: string | null
  externalRef: string | null
  note: string | null
  createdBy: string | null
  date: string
}

/** Paginated transaction ledger with the filters the Loyalty page exposes. */
export async function listTransactions(opts: {
  customerId?: string
  types?: string[]
  from?: string
  to?: string
  search?: string
  limit?: number
  offset?: number
} = {}): Promise<{ transactions: LoyaltyTransactionRow[]; total: number }> {
  if (!db) return { transactions: [], total: 0 }
  const t = s.loyaltyTransactions
  const c = s.customers
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 50)))
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))

  const where = []
  if (opts.customerId) where.push(eq(t.customerId, opts.customerId))
  if (opts.types?.length) where.push(inArray(t.type, opts.types))
  if (opts.from) where.push(gte(t.date, opts.from))
  if (opts.to) where.push(lte(t.date, opts.to))
  const search = opts.search?.trim()
  if (search) {
    where.push(
      or(
        ilike(c.name, `%${search}%`),
        sql`coalesce(${c.phone}, '') like ${`%${search}%`}`,
        sql`coalesce(${t.invoiceNumber}, '') like ${`%${search}%`}`,
        sql`coalesce(${t.note}, '') ilike ${`%${search}%`}`,
      ),
    )
  }
  const clause = where.length > 0 ? and(...where) : undefined

  const rows = await db
    .select({
      id: t.id,
      customerId: t.customerId,
      customerName: c.name,
      customerPhone: c.phone,
      shopifyId: c.shopifyId,
      type: t.type,
      points: t.points,
      balanceAfter: t.balanceAfter,
      invoiceId: t.invoiceId,
      invoiceNumber: t.invoiceNumber,
      source: t.source,
      externalRef: t.externalRef,
      note: t.note,
      createdBy: t.createdBy,
      date: t.date,
    })
    .from(t)
    .leftJoin(c, eq(c.id, t.customerId))
    .where(clause)
    .orderBy(desc(t.date))
    .limit(limit)
    .offset(offset)

  const [countRow] = await db
    .select({ total: sql<string>`count(*)` })
    .from(t)
    .leftJoin(c, eq(c.id, t.customerId))
    .where(clause)

  return {
    transactions: rows.map((row) => ({
      id: row.id,
      customerId: row.customerId,
      customerName: row.customerName ?? '',
      customerPhone: row.customerPhone ?? null,
      shopifyId: row.shopifyId ?? null,
      type: row.type,
      points: Number(row.points ?? 0),
      balanceAfter: row.balanceAfter == null ? null : Number(row.balanceAfter),
      invoiceId: row.invoiceId ?? null,
      invoiceNumber: row.invoiceNumber ?? null,
      source: row.source ?? null,
      externalRef: row.externalRef ?? null,
      note: row.note ?? null,
      createdBy: row.createdBy ?? null,
      date: String(row.date ?? ''),
    })),
    total: Number(countRow?.total ?? rows.length),
  }
}

/** Ledger history for a customer, newest first. */
export async function history(customerId: string, limit = 50) {
  if (!db) return []
  return db
    .select()
    .from(s.loyaltyTransactions)
    .where(eq(s.loyaltyTransactions.customerId, customerId))
    .orderBy(desc(s.loyaltyTransactions.date))
    .limit(Math.min(500, Math.max(1, limit)))
}

/** Full loyalty profile for one customer (summary + ledger). */
export async function getCustomerProfile(customerId: string, limit = 100) {
  if (!db) return null
  const customer = await resolveCustomer({ customerId })
  if (!customer) return null
  const t = s.loyaltyTransactions
  const [totals] = await db
    .select({
      balance: sql<string>`coalesce(sum(${t.points}), 0)`,
      earned: sql<string>`coalesce(sum(case when ${t.type} = 'earn' then ${t.points} else 0 end), 0)`,
      redeemed: sql<string>`coalesce(sum(case when ${t.type} = 'redeem' then -${t.points} else 0 end), 0)`,
      refunded: sql<string>`coalesce(sum(case when ${t.type} = 'refund' then -${t.points} else 0 end), 0)`,
      adjusted: sql<string>`coalesce(sum(case when ${t.type} = 'adjust' then ${t.points} else 0 end), 0)`,
      expired: sql<string>`coalesce(sum(case when ${t.type} = 'expire' then -${t.points} else 0 end), 0)`,
      transactions: sql<string>`count(*)`,
      lastActivity: sql<string | null>`max(${t.date})`,
    })
    .from(t)
    .where(eq(t.customerId, customerId))
  const entries = await history(customerId, limit)
  const balance = Number(totals?.balance ?? 0)
  return {
    customer,
    balance,
    tier: loyaltyTier(balance),
    totalEarned: Number(totals?.earned ?? 0),
    totalRedeemed: Number(totals?.redeemed ?? 0),
    totalRefunded: Number(totals?.refunded ?? 0),
    totalAdjusted: Number(totals?.adjusted ?? 0),
    totalExpired: Number(totals?.expired ?? 0),
    transactions: Number(totals?.transactions ?? 0),
    lastActivityAt: totals?.lastActivity ? String(totals.lastActivity) : null,
    entries: entries.map((e) => ({ ...e, points: Number(e.points ?? 0), balanceAfter: e.balanceAfter == null ? null : Number(e.balanceAfter) })),
  }
}

/**
 * Reconciliation view: customer balances as computed from the ledger vs the
 * stored running balance of each customer's latest movement.
 */
export async function reconcileLedger(): Promise<{
  checked: number
  mismatches: Array<{ customerId: string; name: string; ledgerBalance: number; lastBalanceAfter: number }>
}> {
  if (!db) return { checked: 0, mismatches: [] }
  const t = s.loyaltyTransactions
  const rows = await db
    .select({
      customerId: t.customerId,
      name: s.customers.name,
      ledgerBalance: sql<string>`coalesce(sum(${t.points}), 0)`,
      lastBalanceAfter: sql<string | null>`(array_agg(${t.balanceAfter} order by ${t.date} desc, ${t.id} desc))[1]`,
    })
    .from(t)
    .leftJoin(s.customers, eq(s.customers.id, t.customerId))
    .groupBy(t.customerId, s.customers.name)

  const mismatches = rows
    .map((row) => ({
      customerId: row.customerId,
      name: row.name ?? '',
      ledgerBalance: Number(row.ledgerBalance ?? 0),
      lastBalanceAfter: Number(row.lastBalanceAfter ?? 0),
    }))
    .filter((row) => Math.abs(row.ledgerBalance - row.lastBalanceAfter) > 0.0001)

  return { checked: rows.length, mismatches }
}
