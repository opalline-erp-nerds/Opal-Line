/**
 * Sales returns (RMA) and money refunds.
 *
 * Two rules drive this whole module, and both are easy to get subtly wrong:
 *
 *  1. **Goods and money are separate events.** A refund is money going back to
 *     the customer; a return is physical goods coming back. A refund can be
 *     issued with no goods returned (goodwill, shipping refund), and goods can
 *     be received with no money moving (exchange, store credit). Inventory is
 *     therefore driven ONLY by the return's RECEIVED inspection — never by a
 *     refund, and never at request time.
 *
 *  2. **Quantity is cumulative.** A line can be returned in several pieces, so
 *     every eligibility check is "ordered − already returned", where "already
 *     returned" counts every non-rejected/non-cancelled return for the order.
 *     This is what stops the same unit being returned (and restocked) twice.
 *
 * The pure helpers import nothing at runtime, so they are unit-testable without
 * a database; the persistence functions below them lazy-load the stock writer.
 */
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from './db/client'
import * as s from './db/schema'
import { logger } from './logger'

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/**
 * Normalise an ISO currency code as Shopify/orders store it.
 *
 * Currency is carried through, never converted: the ERP has no exchange rate
 * and inventing one would misstate both the refund and the ledger. Anything
 * that is not a 3-letter code is treated as unknown (null) so readers can fall
 * back to the order instead of trusting a bad value.
 */
export function normalizeCurrency(value: unknown): string | null {
  const code = String(value ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

/** The RMA lifecycle. A return moves forward through these (or is rejected). */
export const RETURN_STATUSES = [
  'requested',
  'approved',
  'in_transit',
  'received',
  'rejected',
  'completed',
] as const

export type ReturnStatus = (typeof RETURN_STATUSES)[number]

/**
 * Allowed transitions. Deliberately strict: you cannot receive goods that were
 * never approved, complete a return whose goods never arrived, or move a
 * rejected return onwards. A received return may still be rejected (damaged
 * goods that go back to the customer) — that path reverses the restock in
 * `setReturnStatus`.
 */
export const RETURN_TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  requested: ['approved', 'rejected'],
  approved: ['in_transit', 'received', 'rejected'],
  in_transit: ['received', 'rejected'],
  received: ['completed', 'rejected'],
  completed: [],
  rejected: [],
}

export function isValidReturnTransition(from: string, to: string): boolean {
  const allowed = RETURN_TRANSITIONS[from as ReturnStatus]
  if (!allowed) return false
  return allowed.includes(to as ReturnStatus)
}

export const RETURN_REASONS = [
  'damaged',
  'wrong_item',
  'not_as_described',
  'size_fit',
  'changed_mind',
  'quality',
  'late_delivery',
  'other',
] as const

export type RefundStatus = 'pending' | 'completed' | 'failed'

function num(v: unknown, fallback = 0): number {
  const n = Number(v ?? fallback)
  return Number.isFinite(n) ? n : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Case-insensitive SKU key — order lines and payloads may differ in case. */
export function lineKey(sku: unknown): string {
  return String(sku ?? '').trim().toLowerCase()
}

/** `#1027`, `1027`, `gid://shopify/Order/1027` all become `#1027`. */
export function normalizeOrderRef(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const gid = raw.match(/gid:\/\/shopify\/Order\/(\d+)/i)
  if (gid) return `#${gid[1]}`
  const cleaned = raw.replace(/^#/, '').replace(/^shopify-/, '')
  return cleaned ? `#${cleaned}` : ''
}

/**
 * Canonical Shopify refund key: `gid://shopify/Refund/9001` and `9001` are the
 * same refund. Webhooks send the numeric id, GraphQL sends the gid — storing
 * both would create two rows for one refund (and double-reverse loyalty points).
 */
export function normalizeRefundId(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const tail = raw.split('/').filter(Boolean).pop() ?? raw
  return tail || null
}

export function isOpenReturnStatus(status: unknown): boolean {
  const s = String(status ?? '').toLowerCase()
  // Rejected/cancelled returns never consumed returnable quantity, and the
  // legacy `processed` credit-note rows count as returned.
  return s !== 'rejected' && s !== 'cancelled'
}

// ─── Pure quantity / amount rules ───────────────────────────────────────────

export interface OrderLineLike {
  title?: unknown
  product?: unknown
  sku?: unknown
  quantity?: unknown
  qty?: unknown
  price?: unknown
  amount?: unknown
}

export interface ReturnableLine {
  sku: string
  product: string
  /** Units bought on the order. */
  ordered: number
  /** Units already on a previous, non-rejected return of this order. */
  returned: number
  /** Units that can still be returned now. */
  remaining: number
  /** Per-unit selling price from the order line (0 when the line carries none). */
  unitPrice: number
}

/** Stored `return_items` payload entry (accepts `qty` or `quantity`). */
interface StoredReturnItemLike {
  sku?: unknown
  qty?: unknown
  quantity?: unknown
  product?: unknown
  amount?: unknown
}

/**
 * The product name and line amount stored with the return matter for rows that
 * predate order links (legacy invoice credit notes): they are the only record of
 * what came back. Optional so existing callers are unaffected.
 */
export function parseStoredReturnItems(
  raw: unknown,
): Array<{ sku: string; qty: number; product?: string; amount?: number }> {
  if (!raw) return []
  let arr: unknown = raw
  if (!Array.isArray(arr)) {
    const items = (raw as Record<string, unknown>).items
    arr = Array.isArray(items) ? items : []
  }
  const out: Array<{ sku: string; qty: number; product?: string; amount?: number }> = []
  for (const entry of arr as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const it = entry as StoredReturnItemLike
    // Keep the SKU exactly as the order spells it: restocking matches
    // `products.sku` exactly, so lower-casing here would silently restock
    // nothing for an upper-case SKU. Matching uses `lineKey()` instead.
    const sku = String(it.sku ?? '').trim()
    const qty = Math.floor(num(it.qty ?? it.quantity))
    if (!sku || qty <= 0) continue
    const product = String(it.product ?? '').trim()
    const amount = Number(it.amount)
    out.push({
      sku,
      qty,
      ...(product ? { product } : {}),
      ...(Number.isFinite(amount) && amount > 0 ? { amount: round2(amount) } : {}),
    })
  }
  return out
}

/** Units already returned per SKU across a set of prior return rows. */
export function aggregateReturnedBySku(rows: Array<{ status?: unknown; returnItems?: unknown } | null | undefined>): Map<string, number> {
  const returned = new Map<string, number>()
  for (const row of rows) {
    if (!row || !isOpenReturnStatus(row.status)) continue
    for (const { sku, qty } of parseStoredReturnItems(row.returnItems)) {
      const key = lineKey(sku)
      returned.set(key, (returned.get(key) ?? 0) + qty)
    }
  }
  return returned
}

/**
 * Ordered / previously returned / remaining per order line.
 *
 * Lines without a SKU were never stock-tracked and cannot be returned — the
 * same rule the invoice flow uses, so the two never disagree about a product.
 */
export function summarizeReturnableLines(
  orderLines: Array<OrderLineLike | null | undefined>,
  returnedBySku: Map<string, number>,
): ReturnableLine[] {
  const out: ReturnableLine[] = []
  const seen = new Map<string, ReturnableLine>()
  for (const line of orderLines) {
    if (!line || typeof line !== 'object') continue
    const sku = String(line.sku ?? '').trim()
    if (!sku) continue
    const key = lineKey(sku)
    const ordered = Math.max(0, Math.floor(num(line.quantity ?? line.qty)))
    if (ordered <= 0) continue
    const amount = num(line.amount, 0)
    const price = num(line.price, 0)
    const unitPrice = price > 0 ? round2(price) : ordered > 0 ? round2(amount / ordered) : 0
    // Shopify can repeat a SKU across lines (different properties); merge them
    // so a quantity check can never be bypassed by splitting one SKU in two.
    const existing = seen.get(key)
    if (existing) {
      existing.ordered += ordered
      existing.remaining += ordered
      continue
    }
    const row: ReturnableLine = {
      sku,
      product: String(line.title ?? line.product ?? sku).trim() || sku,
      ordered,
      returned: 0,
      remaining: ordered,
      unitPrice,
    }
    seen.set(key, row)
    out.push(row)
  }
  for (const row of out) {
    const prev = Math.min(returnedBySku.get(lineKey(row.sku)) ?? 0, row.ordered)
    row.returned = prev
    row.remaining = Math.max(0, row.ordered - prev)
  }
  return out
}

export interface ParsedReturnRequest {
  error?: string
  items?: Array<{ sku: string; product: string; qty: number; amount: number; unitPrice: number }>
}

/**
 * Validate a requested return against remaining returnable quantity.
 *
 * Duplicate SKUs in one payload are summed before the check, so
 * `[{A,2},{A,3}]` cannot return 5 of a line with 3 remaining. A request for 0
 * of everything is an error, not a silent no-op.
 */
export function parseReturnRequest(rawItems: unknown, lines: ReturnableLine[]): ParsedReturnRequest {
  if (lines.length === 0) return { error: 'This order has no returnable items' }
  const byKey = new Map(lines.map((l) => [lineKey(l.sku), l]))
  const requested = new Map<string, number>()

  const entries = Array.isArray(rawItems) ? rawItems : []
  if (entries.length === 0) return { error: 'Select at least one product and quantity to return' }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const it = entry as StoredReturnItemLike
    const key = lineKey(it.sku)
    if (!key) continue
    const qty = Math.floor(num(it.qty ?? it.quantity))
    if (qty <= 0) continue
    if (!byKey.has(key)) return { error: `Unknown product on this order: ${String(it.sku)}` }
    requested.set(key, (requested.get(key) ?? 0) + qty)
  }

  if (requested.size === 0) return { error: 'Enter a quantity of at least 1 for a product' }

  const items: NonNullable<ParsedReturnRequest['items']> = []
  for (const [key, qty] of requested) {
    const line = byKey.get(key)!
    if (qty > line.remaining) {
      return {
        error:
          line.remaining === 0
            ? `${line.product} (${line.sku}) has already been fully returned`
            : `Only ${line.remaining} of ${line.product} (${line.sku}) can be returned — ${qty} requested`,
      }
    }
    items.push({
      sku: line.sku,
      product: line.product,
      qty,
      unitPrice: line.unitPrice,
      amount: round2(line.unitPrice * qty),
    })
  }
  return { items }
}

/** Inspection rollup: how much physically arrived, how much is restockable. */
export function inspectionTotals(items: Array<{ received?: number | null; accepted?: number | null; damaged?: number | null }>): {
  received: number
  accepted: number
  damaged: number
} {
  let received = 0
  let accepted = 0
  let damaged = 0
  for (const it of items) {
    const r = Math.max(0, Math.floor(num(it.received)))
    const a = Math.min(Math.max(0, Math.floor(num(it.accepted))), r)
    const d = Math.min(Math.max(0, Math.floor(num(it.damaged ?? r - a))), r - a)
    received += r
    accepted += a
    damaged += d
  }
  return { received, accepted, damaged }
}

/**
 * Normalise an inspection payload against what was requested.
 *
 * Never accepts more than was asked for (a warehouse scale typo cannot restock
 * phantom units), and always derives `accepted` from `received − damaged` when
 * only those two are supplied.
 */
export function normalizeInspection(
  requested: Array<{ sku: string; qty: number }>,
  raw: unknown,
): Array<{ sku: string; received: number; accepted: number; damaged: number }> {
  const rows = Array.isArray(raw) ? raw : []
  const byKey = new Map<string, { received: number; accepted: number; damaged: number }>()
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue
    const it = entry as Record<string, unknown>
    const key = lineKey(it.sku)
    if (!key) continue
    byKey.set(key, {
      received: Math.max(0, Math.floor(num(it.received))),
      accepted: Math.max(0, Math.floor(num(it.accepted))),
      damaged: Math.max(0, Math.floor(num(it.damaged))),
    })
  }
  const out: Array<{ sku: string; received: number; accepted: number; damaged: number }> = []
  for (const line of requested) {
    const given = byKey.get(lineKey(line.sku))
    // No inspection row for a line means "received in full, undamaged".
    if (!given) {
      out.push({ sku: line.sku, received: line.qty, accepted: line.qty, damaged: 0 })
      continue
    }
    const received = Math.min(given.received, line.qty)
    const damaged = Math.min(Math.max(given.damaged, 0), received)
    const accepted = Math.min(Math.max(given.accepted > 0 ? given.accepted : received - damaged, 0), received - damaged)
    out.push({ sku: line.sku, received, accepted, damaged })
  }
  return out
}

// ─── Numbering ──────────────────────────────────────────────────────────────

function nextNumber(prefix: 'SR' | 'RF'): string {
  const now = new Date()
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  return `${prefix}${ym}-${Math.floor(100000 + Math.random() * 900000)}`
}

// ─── Persistence: returns ───────────────────────────────────────────────────

export interface CreateReturnInput {
  /** sales_orders.id — the ERP order row. */
  orderId: string
  items: unknown
  reason?: string | null
  notes?: string | null
  /** Skip straight to approved (an operator who already agreed the return). */
  status?: string | null
  createdBy?: string | null
  idempotencyKey?: string | null
}

export type CreateReturnResult =
  | { ok: true; id: string; number: string; amount: number; replayed: boolean; alreadyReturned: ReturnableLine[] }
  | { ok: false; status: number; error: string }

export async function createSalesReturn(input: CreateReturnInput): Promise<CreateReturnResult> {
  if (!db) return { ok: false, status: 503, error: 'Database unavailable' }

  const [order] = await db
    .select()
    .from(s.salesOrders)
    .where(eq(s.salesOrders.id, String(input.orderId)))
    .limit(1)
  if (!order) return { ok: false, status: 404, error: 'Order not found' }
  if (String(order.status ?? '').toLowerCase() === 'cancelled') {
    return { ok: false, status: 400, error: 'A cancelled order cannot be returned — refund it instead' }
  }

  const idempotencyKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim() ? input.idempotencyKey.trim() : null
  if (idempotencyKey) {
    const [prior] = await db
      .select({ id: s.salesReturns.id, number: s.salesReturns.number, amount: s.salesReturns.amount })
      .from(s.salesReturns)
      .where(eq(s.salesReturns.idempotencyKey, idempotencyKey))
      .limit(1)
    if (prior) {
      return {
        ok: true,
        id: prior.id,
        number: String(prior.number),
        amount: round2(num(prior.amount)),
        replayed: true,
        alreadyReturned: [],
      }
    }
  }

  const priorRows = await db
    .select({ status: s.salesReturns.status, returnItems: s.salesReturns.returnItems })
    .from(s.salesReturns)
    .where(
      or(
        eq(s.salesReturns.orderId, order.id),
        order.shopifyId ? eq(s.salesReturns.order, order.shopifyId) : sql`false`,
      ),
    )
  const returned = aggregateReturnedBySku(priorRows)
  const lines = summarizeReturnableLines(
    Array.isArray(order.lineItems) ? (order.lineItems as OrderLineLike[]) : [],
    returned,
  )
  if (lines.length === 0) return { ok: false, status: 400, error: 'This order has no returnable items' }

  const parsed = parseReturnRequest(input.items, lines)
  if (parsed.error || !parsed.items) return { ok: false, status: 400, error: parsed.error ?? 'Invalid return' }

  const requestedStatus = String(input.status ?? 'requested').toLowerCase()
  const status: ReturnStatus = isValidReturnTransition('requested', requestedStatus) || requestedStatus === 'requested'
    ? (requestedStatus as ReturnStatus)
    : 'requested'

  const now = new Date().toISOString()
  const amount = round2(parsed.items.reduce((a, it) => a + it.amount, 0))
  const number = nextNumber('SR')

  const [row] = await db
    .insert(s.salesReturns)
    .values({
      id: randomUUID(),
      number,
      orderId: order.id,
      order: order.shopifyId ?? order.internalId ?? null,
      invoiceId: null,
      customer: order.customer ?? null,
      customerEmail: order.customerEmail ?? null,
      items: parsed.items.reduce((a, it) => a + it.qty, 0),
      amount,
      currency: normalizeCurrency(order.currency),
      status,
      reason: input.reason ? String(input.reason).slice(0, 200) : null,
      notes: input.notes ? String(input.notes).slice(0, 2000) : null,
      source: 'erp',
      returnItems: parsed.items.map((it) => ({ sku: it.sku, product: it.product, qty: it.qty, amount: it.amount })),
      requestedAt: now,
      date: now,
      createdBy: input.createdBy ?? null,
      updatedAt: now,
      idempotencyKey,
    })
    .returning({ id: s.salesReturns.id, number: s.salesReturns.number })

  return { ok: true, id: row!.id, number: String(row!.number), amount, replayed: false, alreadyReturned: lines }
}

export interface SetReturnStatusInput {
  /** Inspection for the RECEIVED transition: [{ sku, received, accepted, damaged }]. */
  inspection?: unknown
  /** Where the accepted goods go back to (defaults to the order's location). */
  locationId?: string | null
  notes?: string | null
  actor?: string | null
}

export type SetReturnStatusResult =
  | {
      ok: true
      status: ReturnStatus
      restocked: number
      inspection: Array<{ sku: string; received: number; accepted: number; damaged: number }>
      /** Result of pushing the new ERP stock to Shopify (absent when no stock moved). */
      inventory?: ShopifyStockPush
    }
  | { ok: false; status: number; error: string }

/** Outcome of mirroring a return receipt's stock change to Shopify. */
export interface ShopifyStockPush {
  ok: boolean
  updated: number
  skipped: number
  errors: string[]
  message?: string
}

/**
 * Map returned line SKUs to the parent product rows whose stock the ledger
 * changed (variant SKUs first, exactly like the stock writer resolves them).
 */
async function productIdsForSkus(skus: string[]): Promise<{ ids: string[]; unmatched: string[] }> {
  if (!db) return { ids: [], unmatched: skus }
  const keys = [...new Set(skus.map((s) => String(s ?? '').trim()).filter(Boolean))]
  if (keys.length === 0) return { ids: [], unmatched: [] }
  const ids = new Set<string>()
  const matched = new Set<string>()

  const variantRows = await db
    .select({ sku: s.productVariants.sku, productId: s.productVariants.productId })
    .from(s.productVariants)
    .where(inArray(s.productVariants.sku, keys))
  for (const row of variantRows) {
    ids.add(row.productId)
    if (row.sku) matched.add(row.sku)
  }

  const productRows = await db
    .select({ id: s.products.id, sku: s.products.sku })
    .from(s.products)
    .where(inArray(s.products.sku, keys))
  for (const row of productRows) {
    ids.add(row.id)
    if (row.sku) matched.add(row.sku)
  }

  return { ids: [...ids], unmatched: keys.filter((k) => !matched.has(k)) }
}

/**
 * Push the stock of the products a receipt touched to Shopify.
 *
 * This runs AFTER the receipt transaction commits, so a Shopify outage can
 * never roll back (or replay) the ERP restock: the ERP ledger is authoritative
 * and Shopify is brought in line with the balance this receipt produced. It is
 * called only for SKUs whose accepted quantity actually moved, by the one
 * transition that moves stock, so a retried request cannot push twice.
 *
 * It reuses the existing absolute `pushInventoryToShopify` — the same call the
 * stock-count screen uses — so the ERP rollup lands on the store's first
 * inventory location rather than inventing a second mapping.
 */
async function pushReturnStockToShopify(skus: string[]): Promise<ShopifyStockPush | null> {
  if (skus.length === 0) return null
  // Automated tests run against a scratch database but a real .env: they must
  // never reach the live store, so this whole mirror is opt-out.
  if (process.env.OPAL_DISABLE_SHOPIFY_PUSH === '1') {
    return { ok: false, updated: 0, skipped: skus.length, errors: [], message: 'Shopify stock push disabled for this process' }
  }
  const { isConfigured } = await import('./config')
  if (!isConfigured()) {
    return { ok: false, updated: 0, skipped: skus.length, errors: [], message: 'Shopify is not configured — stock changed in the ERP only' }
  }
  try {
    const { ids, unmatched } = await productIdsForSkus(skus)
    if (ids.length === 0) {
      return {
        ok: false,
        updated: 0,
        skipped: skus.length,
        errors: [`No product record found for ${unmatched.join(', ')}`],
        message: 'Shopify stock was not updated — the returned SKUs are not in the catalogue',
      }
    }
    const { pushInventoryToShopify } = await import('./shopify')
    const result = await pushInventoryToShopify(ids)
    const errors = [...result.errors]
    if (unmatched.length > 0) errors.push(`Not in the catalogue: ${unmatched.join(', ')}`)
    if (!result.ok && result.message) errors.push(result.message)
    logger.info(
      { skus, products: ids.length, updated: result.updated, skipped: result.skipped, ok: result.ok },
      'return receipt stock pushed to Shopify',
    )
    return {
      ok: result.ok && errors.length === 0,
      updated: result.updated,
      skipped: result.skipped,
      errors,
      message: result.message,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Shopify stock push failed'
    logger.warn({ err, skus }, 'return receipt stock push to Shopify failed (non-fatal)')
    return { ok: false, updated: 0, skipped: 0, errors: [message], message }
  }
}

/**
 * Move a return through its lifecycle.
 *
 * Only RECEIVED moves stock, and only the ACCEPTED quantity — damaged units stay
 * out of inventory. The transition into `received` is guarded by the row's own
 * status inside a locked transaction, so a double-click or a retried request
 * cannot restock the same goods twice. Rejecting a return that had already been
 * received reverses exactly what that receipt added.
 */
export async function setSalesReturnStatus(
  returnId: string,
  nextStatus: string,
  input: SetReturnStatusInput = {},
): Promise<SetReturnStatusResult> {
  if (!db) return { ok: false, status: 503, error: 'Database unavailable' }
  const target = String(nextStatus ?? '').toLowerCase() as ReturnStatus
  if (!RETURN_STATUSES.includes(target)) return { ok: false, status: 400, error: `Unknown return status: ${nextStatus}` }

  try {
    // SKUs whose accepted quantity moved in this transition. Collected inside
    // the transaction, pushed to Shopify only after it commits.
    const movedSkus: string[] = []
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(s.salesReturns)
        .where(eq(s.salesReturns.id, returnId))
        .limit(1)
        .for('update')
      if (!row) return { ok: false as const, status: 404, error: 'Return not found' }

      const current = String(row.status ?? '').toLowerCase()
      // Legacy credit-note rows live in the same table under `processed`; they
      // are ledger documents, not RMAs, and must not be moved through this state
      // machine.
      if (current === 'processed') {
        return { ok: false as const, status: 400, error: 'This credit note is managed by the invoice return flow' }
      }
      if (current === target) {
        return { ok: false as const, status: 400, error: `Return is already ${target.replace('_', ' ')}` }
      }
      if (!isValidReturnTransition(current, target)) {
        return {
          ok: false as const,
          status: 400,
          error: `Cannot move a ${current.replace('_', ' ')} return to ${target.replace('_', ' ')}`,
        }
      }

      const now = new Date().toISOString()
      const requested = parseStoredReturnItems(row.returnItems).map((it) => ({ sku: it.sku, qty: it.qty }))
      let restocked = 0
      const patch: Record<string, unknown> = { status: target, updatedAt: now }
      let inspection: Array<{ sku: string; received: number; accepted: number; damaged: number }> = []

      if (target === 'received') {
        inspection = normalizeInspection(requested, input.inspection)
        const { applyStockMovement } = await import('./stock')
        const [order] = row.orderId
          ? await tx.select({ locationId: s.salesOrders.locationId }).from(s.salesOrders).where(eq(s.salesOrders.id, row.orderId)).limit(1)
          : [undefined]
        const locationId =
          input.locationId ?? (order?.locationId as string | null | undefined) ?? null
        for (const line of inspection) {
          if (line.accepted <= 0) continue
          // A variant SKU resolves to its parent product inside applyStockMovement.
          const moved = await applyStockMovement({
            sku: line.sku,
            qty: line.accepted,
            type: 'sale_return_in',
            locationId,
            refType: 'return',
            refId: row.id,
            note: `Return ${row.number} received${line.damaged > 0 ? ` (${line.damaged} damaged, not restocked)` : ''}`,
            createdBy: input.actor ?? undefined,
            tx,
          })
          if (moved !== null) {
            restocked += line.accepted
            movedSkus.push(line.sku)
          }
        }
        patch.receivedItems = inspection
        patch.receivedAt = now
        patch.restocked = restocked > 0
      }

      if (target === 'rejected' && current === 'received') {
        // Undo exactly the receipt: the accepted units go back out of stock.
        const { applyStockMovement } = await import('./stock')
        const received = Array.isArray(row.receivedItems)
          ? (row.receivedItems as Array<{ sku?: string; accepted?: number }>)
          : []
        const [order] = row.orderId
          ? await tx.select({ locationId: s.salesOrders.locationId }).from(s.salesOrders).where(eq(s.salesOrders.id, row.orderId)).limit(1)
          : [undefined]
        for (const line of received) {
          const qty = Math.max(0, Math.floor(num(line.accepted)))
          if (!line.sku || qty <= 0) continue
          await applyStockMovement({
            sku: String(line.sku),
            qty: -qty,
            type: 'count_adjust',
            locationId: input.locationId ?? (order?.locationId as string | null | undefined) ?? null,
            refType: 'return',
            refId: row.id,
            note: `Return ${row.number} rejected after receipt — undoing restock`,
            createdBy: input.actor ?? undefined,
            tx,
          })
          movedSkus.push(String(line.sku))
        }
        patch.receivedItems = null
        patch.receivedAt = null
        patch.restocked = false
      }

      if (target === 'completed') patch.completedAt = now
      if (input.notes !== undefined) patch.notes = input.notes ? String(input.notes).slice(0, 2000) : null

      await tx.update(s.salesReturns).set(patch as never).where(eq(s.salesReturns.id, row.id))
      return { ok: true as const, status: target, restocked, inspection }
    })

    // Mirror the new ERP balance to Shopify. Best-effort by design: the goods
    // are already received and the ledger is written, so a Shopify failure is
    // reported to the operator (who can use the inventory sync) instead of
    // invalidating the receipt.
    if (result.ok && movedSkus.length > 0) {
      const inventory = await pushReturnStockToShopify(movedSkus)
      if (inventory) return { ...result, inventory }
    }
    return result
  } catch (err) {
    logger.error({ err, returnId, target }, 'return status change failed')
    return { ok: false, status: 500, error: 'Failed to update the return' }
  }
}

/** Per-line ordered / returned / remaining for an order (the create dialog's truth). */
export async function getOrderReturnStatus(orderId: string): Promise<
  | {
      ok: true
      orderId: string
      order: string
      customer: string
      customerEmail: string | null
      /** Currency of the original order — what the return amounts are in. */
      currency: string | null
      anyReturnable: boolean
      lines: ReturnableLine[]
    }
  | { ok: false; status: number; error: string }
> {
  if (!db) return { ok: false, status: 503, error: 'Database unavailable' }
  const [order] = await db.select().from(s.salesOrders).where(eq(s.salesOrders.id, orderId)).limit(1)
  if (!order) return { ok: false, status: 404, error: 'Order not found' }
  const priorRows = await db
    .select({ status: s.salesReturns.status, returnItems: s.salesReturns.returnItems })
    .from(s.salesReturns)
    .where(
      or(eq(s.salesReturns.orderId, order.id), order.shopifyId ? eq(s.salesReturns.order, order.shopifyId) : sql`false`),
    )
  const lines = summarizeReturnableLines(
    Array.isArray(order.lineItems) ? (order.lineItems as OrderLineLike[]) : [],
    aggregateReturnedBySku(priorRows),
  )
  return {
    ok: true,
    orderId: order.id,
    order: String(order.shopifyId ?? order.internalId ?? order.id),
    customer: String(order.customer ?? ''),
    customerEmail: (order.customerEmail as string | null) ?? null,
    currency: normalizeCurrency(order.currency),
    anyReturnable: lines.some((l) => l.remaining > 0),
    lines,
  }
}

// ─── Persistence: refunds ───────────────────────────────────────────────────

export interface RefundLineInput {
  shopifyLineItemId?: string | null
  product?: string | null
  sku?: string | null
  quantity?: number | null
  amount?: number | null
  restockType?: string | null
}

export interface RecordRefundInput {
  /** Shopify Refund id (numeric or gid). The external unique reference. */
  shopifyRefundId?: string | null
  shopifyOrder?: string | null
  invoiceNumber?: string | null
  returnId?: string | null
  customer?: string | null
  customerEmail?: string | null
  source: 'shopify' | 'erp'
  status?: RefundStatus
  requestedAmount?: number | null
  /** Authoritative total Shopify reported. */
  amount: number
  refundedAmount?: number | null
  currency?: string | null
  paymentMethod?: string | null
  gateway?: string | null
  transactionIds?: string | null
  note?: string | null
  items?: RefundLineInput[]
  createdBy?: string | null
  idempotencyKey?: string | null
  processedAt?: string | null
  /** 'webhook' | 'erp_push' | 'retry' | 'pull' */
  action?: string
  syncMessage?: string | null
}

export interface RecordRefundResult {
  id: string
  number: string
  created: boolean
  status: RefundStatus
}

/**
 * Insert or update a refund, keyed by Shopify's refund id.
 *
 * This is the single write path for refunds, so a `refunds/create` webhook, an
 * ERP-initiated refundCreate and a manual pull all converge on one row instead
 * of three. A later, more authoritative update (webhook after our own push)
 * refreshes the amounts/status but never re-creates the line items.
 */
export async function recordRefund(input: RecordRefundInput): Promise<RecordRefundResult | null> {
  if (!db) return null
  const externalId = normalizeRefundId(input.shopifyRefundId)
  const orderRef = normalizeOrderRef(input.shopifyOrder)
  const amount = round2(Math.max(0, num(input.amount)))
  const status: RefundStatus = input.status ?? 'completed'
  const now = new Date().toISOString()

  try {
    return await db.transaction(async (tx) => {
      // Resolve the ERP order/invoice/customer from the Shopify order name —
      // refunds can arrive for orders that predate this feature.
      let orderId: string | null = null
      let customer = input.customer ?? null
      let customerEmail = input.customerEmail ?? null
      let invoiceNumber = input.invoiceNumber ?? null
      // Currency comes from the order that was actually charged. It is copied,
      // never converted — there is no exchange rate in this system.
      let currency = normalizeCurrency(input.currency)
      if (orderRef) {
        const [order] = await tx
          .select({
            id: s.salesOrders.id,
            customer: s.salesOrders.customer,
            customerEmail: s.salesOrders.customerEmail,
            currency: s.salesOrders.currency,
          })
          .from(s.salesOrders)
          .where(eq(s.salesOrders.shopifyId, orderRef))
          .limit(1)
        if (order) {
          orderId = order.id
          customer = customer || order.customer
          customerEmail = customerEmail || order.customerEmail
          // The order is authoritative: a refund of a USD order is USD, even
          // when the payload that reached us did not say so.
          currency = normalizeCurrency(input.currency) ?? normalizeCurrency(order.currency)
        }
        if (!invoiceNumber) {
          const [invoice] = await tx
            .select({ number: s.salesInvoices.number })
            .from(s.salesInvoices)
            .where(eq(s.salesInvoices.shopifyOrder, orderRef))
            .limit(1)
          invoiceNumber = invoice?.number ?? null
        }
      }

      const existing = externalId
        ? (
            await tx
              .select()
              .from(s.refunds)
              .where(eq(s.refunds.shopifyRefundId, externalId))
              .limit(1)
              .for('update')
          )[0]
        : undefined

      if (existing) {
        await tx
          .update(s.refunds)
          .set({
            status,
            amount,
            refundedAmount: round2(num(input.refundedAmount, status === 'completed' ? amount : 0)),
            requestedAmount: input.requestedAmount != null ? round2(num(input.requestedAmount)) : existing.requestedAmount,
            // Keep a known currency; otherwise stay unknown rather than asserting
            // rupees for a foreign order the ERP has not imported yet.
            currency: normalizeCurrency(existing.currency) ?? currency ?? null,
            paymentMethod: input.paymentMethod ?? existing.paymentMethod,
            gateway: input.gateway ?? existing.gateway,
            transactionIds: input.transactionIds ?? existing.transactionIds,
            note: input.note ?? existing.note,
            returnId: input.returnId ?? existing.returnId,
            orderId: existing.orderId ?? orderId,
            invoiceNumber: existing.invoiceNumber ?? invoiceNumber,
            customer: existing.customer ?? customer,
            customerEmail: existing.customerEmail ?? customerEmail,
            syncError: status === 'failed' ? (input.syncMessage ?? existing.syncError) : null,
            processedAt: input.processedAt ?? existing.processedAt ?? (status === 'completed' ? now : null),
            updatedAt: now,
          })
          .where(eq(s.refunds.id, existing.id))
        await logRefundSyncTx(tx, {
          refundId: existing.id,
          action: input.action ?? 'webhook',
          status: status === 'failed' ? 'failed' : 'success',
          message: input.syncMessage ?? `Refund ${externalId} updated (${status})`,
        })
        return { id: existing.id, number: String(existing.number), created: false, status }
      }

      const id = randomUUID()
      const number = nextNumber('RF')
      await tx.insert(s.refunds).values({
        id,
        number,
        shopifyRefundId: externalId,
        shopifyOrder: orderRef || null,
        orderId,
        invoiceNumber,
        returnId: input.returnId ?? null,
        customer,
        customerEmail,
        source: input.source,
        status,
        requestedAmount: input.requestedAmount != null ? round2(num(input.requestedAmount)) : amount,
        amount,
        refundedAmount: round2(num(input.refundedAmount, status === 'completed' ? amount : 0)),
        // Null, not 'INR': the read layer resolves the order's currency, and a
        // guess here would be indistinguishable from a verified code later.
        currency: currency ?? null,
        paymentMethod: input.paymentMethod ?? null,
        gateway: input.gateway ?? null,
        transactionIds: input.transactionIds ?? null,
        note: input.note ?? null,
        syncError: status === 'failed' ? (input.syncMessage ?? null) : null,
        attempts: 1,
        createdBy: input.createdBy ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now,
        processedAt: input.processedAt ?? (status === 'completed' ? now : null),
        updatedAt: now,
      })

      const items = (input.items ?? []).filter((it) => (it.quantity ?? 0) > 0 || num(it.amount) > 0)
      if (items.length > 0) {
        await tx.insert(s.refundLineItems).values(
          items.map((it) => ({
            id: randomUUID(),
            refundId: id,
            shopifyLineItemId: it.shopifyLineItemId ?? null,
            product: it.product ?? null,
            sku: it.sku ?? null,
            quantity: Math.max(0, Math.floor(num(it.quantity))),
            amount: round2(Math.max(0, num(it.amount))),
            restockType: it.restockType ?? null,
          })),
        )
      }

      await logRefundSyncTx(tx, {
        refundId: id,
        action: input.action ?? 'webhook',
        status: status === 'failed' ? 'failed' : 'success',
        message: input.syncMessage ?? `Refund ${number} recorded (${status})`,
      })
      return { id, number, created: true, status }
    })
  } catch (err) {
    logger.error({ err, externalId, orderRef }, 'recordRefund failed')
    return null
  }
}

type RefundTx = Parameters<Parameters<NonNullable<typeof db>['transaction']>[0]>[0]

export async function logRefundSyncTx(
  tx: RefundTx,
  entry: { refundId?: string | null; action: string; status: 'success' | 'failed' | 'skipped'; message?: string | null },
): Promise<void> {
  await tx.insert(s.refundSyncEvents).values({
    id: randomUUID(),
    refundId: entry.refundId ?? null,
    action: entry.action,
    status: entry.status,
    message: entry.message ? String(entry.message).slice(0, 2000) : null,
    createdAt: new Date().toISOString(),
  })
}

/** Standalone sync log entry (outside a refund transaction). */
export async function logRefundSync(entry: {
  refundId?: string | null
  action: string
  status: 'success' | 'failed' | 'skipped'
  message?: string | null
}): Promise<void> {
  if (!db) return
  try {
    await db.insert(s.refundSyncEvents).values({
      id: randomUUID(),
      refundId: entry.refundId ?? null,
      action: entry.action,
      status: entry.status,
      message: entry.message ? String(entry.message).slice(0, 2000) : null,
      createdAt: new Date().toISOString(),
    })
  } catch (err) {
    logger.warn({ err }, 'could not write refund sync log')
  }
}

/**
 * Reflect settled refunds on the order's payment state.
 *
 * Only when the completed refunds cover the whole order does it become
 * `refunded`; a partial refund leaves the order's existing payment state alone
 * (the money is still mostly collected, and the Sales page's filters are built
 * around paid/pending/refunded only).
 */
export async function reconcileOrderPaymentAfterRefund(orderRef: string): Promise<{ payment: string | null; refunded: number }> {
  if (!db) return { payment: null, refunded: 0 }
  const ref = normalizeOrderRef(orderRef)
  if (!ref) return { payment: null, refunded: 0 }
  const [order] = await db
    .select({ id: s.salesOrders.id, value: s.salesOrders.value, payment: s.salesOrders.payment, status: s.salesOrders.status })
    .from(s.salesOrders)
    .where(eq(s.salesOrders.shopifyId, ref))
    .limit(1)
  if (!order) return { payment: null, refunded: 0 }

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${s.refunds.refundedAmount}), 0)` })
    .from(s.refunds)
    .where(and(eq(s.refunds.shopifyOrder, ref), eq(s.refunds.status, 'completed')))
  const refunded = round2(num(row?.total))
  const orderValue = round2(num(order.value))
  if (orderValue > 0 && refunded >= orderValue - 0.01 && order.payment !== 'refunded') {
    await db
      .update(s.salesOrders)
      .set({ payment: 'refunded', status: order.status === 'cancelled' ? order.status : 'refunded' })
      .where(eq(s.salesOrders.id, order.id))
    return { payment: 'refunded', refunded }
  }
  return { payment: (order.payment as string | null) ?? null, refunded }
}

/**
 * Attach a refund that arrived with no RMA reference to the order's open return.
 *
 * A Shopify refund often settles a return the customer already sent back, but
 * Shopify does not tell us which RMA it belongs to. Linking is only safe when
 * there is exactly ONE open return awaiting money for that order — with two,
 * guessing would put the refund on the wrong return and show a wrong status.
 */
export async function linkRefundToOpenReturn(refundId: string, orderRef: string): Promise<string | null> {
  if (!db) return null
  const ref = normalizeOrderRef(orderRef)
  if (!ref) return null
  const [refund] = await db
    .select({ id: s.refunds.id, returnId: s.refunds.returnId })
    .from(s.refunds)
    .where(eq(s.refunds.id, refundId))
    .limit(1)
  if (!refund || refund.returnId) return null

  const [order] = await db.select({ id: s.salesOrders.id }).from(s.salesOrders).where(eq(s.salesOrders.shopifyId, ref)).limit(1)
  if (!order) return null

  const candidates = await db
    .select({ id: s.salesReturns.id })
    .from(s.salesReturns)
    .where(
      and(
        eq(s.salesReturns.orderId, order.id),
        inArray(s.salesReturns.status, ['approved', 'in_transit', 'received']),
      ),
    )
  if (candidates.length !== 1) return null
  const returnId = candidates[0].id
  // Only claim a return that no other refund already settles.
  const [taken] = await db.select({ id: s.refunds.id }).from(s.refunds).where(eq(s.refunds.returnId, returnId)).limit(1)
  if (taken) return null
  await db.update(s.refunds).set({ returnId, updatedAt: new Date().toISOString() }).where(eq(s.refunds.id, refundId))
  return returnId
}

/** Refund totals for an order (used by the detail view and tests). */export async function refundTotalsForOrder(orderRef: string): Promise<{ refunded: number; pending: number; failed: number; count: number }> {
  if (!db) return { refunded: 0, pending: 0, failed: 0, count: 0 }
  const ref = normalizeOrderRef(orderRef)
  if (!ref) return { refunded: 0, pending: 0, failed: 0, count: 0 }
  const rows = await db
    .select({ status: s.refunds.status, amount: s.refunds.amount, refundedAmount: s.refunds.refundedAmount })
    .from(s.refunds)
    .where(eq(s.refunds.shopifyOrder, ref))
  let refunded = 0
  let pending = 0
  let failed = 0
  for (const r of rows) {
    const amount = round2(num(r.amount))
    if (r.status === 'completed') refunded += round2(num(r.refundedAmount, amount))
    else if (r.status === 'failed') failed += amount
    else pending += amount
  }
  return { refunded: round2(refunded), pending: round2(pending), failed: round2(failed), count: rows.length }
}

/** Attach surviving refunds for a set of order refs (list view). */
export async function refundsForOrders(orderRefs: string[]): Promise<Map<string, { refunded: number; pending: number; failed: number; status: string; count: number }>> {
  const out = new Map<string, { refunded: number; pending: number; failed: number; status: string; count: number }>()
  if (!db || orderRefs.length === 0) return out
  const refs = [...new Set(orderRefs.map(normalizeOrderRef).filter(Boolean))]
  if (refs.length === 0) return out
  const rows = await db
    .select({
      order: s.refunds.shopifyOrder,
      status: s.refunds.status,
      amount: s.refunds.amount,
      refundedAmount: s.refunds.refundedAmount,
    })
    .from(s.refunds)
    .where(inArray(s.refunds.shopifyOrder, refs))
  for (const r of rows) {
    const key = String(r.order ?? '')
    const entry = out.get(key) ?? { refunded: 0, pending: 0, failed: 0, status: 'none', count: 0 }
    const amount = round2(num(r.amount))
    entry.count += 1
    if (r.status === 'completed') entry.refunded = round2(entry.refunded + round2(num(r.refundedAmount, amount)))
    else if (r.status === 'failed') entry.failed = round2(entry.failed + amount)
    else entry.pending = round2(entry.pending + amount)
    out.set(key, entry)
  }
  for (const [key, entry] of out) {
    const parts = [entry.refunded > 0 ? 'completed' : '', entry.pending > 0 ? 'pending' : '', entry.failed > 0 ? 'failed' : '']
    entry.status = parts.filter(Boolean).join('+') || 'none'
    out.set(key, entry)
  }
  return out
}

/** Most recent returns (newest first) for the dashboard and tests. */
export async function listRecentReturns(limit = 20): Promise<Array<{ id: string; number: string; status: string | null; amount: number }>> {
  if (!db) return []
  const rows = await db
    .select({ id: s.salesReturns.id, number: s.salesReturns.number, status: s.salesReturns.status, amount: s.salesReturns.amount })
    .from(s.salesReturns)
    .orderBy(desc(s.salesReturns.date))
    .limit(limit)
  return rows.map((r) => ({ id: r.id, number: String(r.number), status: r.status as string | null, amount: round2(num(r.amount)) }))
}
