/**
 * Invoice returns: quantity-aware, per-line, idempotent.
 *
 * The old POST /invoices/:id/return clamped each item only to the *sold*
 * quantity and never looked at previous returns, so two partial returns of the
 * same SKU could restock inventory twice and an invoice stayed 'paid' after a
 * full return. Everything that is easy to get subtly wrong lives here:
 *
 *  - which stored credits count against an invoice (non-cancelled returns only)
 *  - per-SKU rollup of previously returned quantities (variants included — the
 *    rollup is keyed by the exact invoice-item SKU)
 *  - validation of a requested return against sold minus already returned
 *  - the derived invoice status after any return: no returns means keep the
 *    invoice's normal status (paid/issued/…); only returns produce
 *    'partially_returned' / 'fully_returned' — never a blanket
 *    "Refunded/Closed" state for one returned piece.
 *
 * The transactional core (applyInvoiceReturn) receives the caller's Drizzle
 * transaction, so the credit note, the (-amount) payment trail, the inventory
 * restock and the invoice status update all commit or roll back together, and
 * duplicate submissions are rejected by the remaining-quantity check instead
 * of being double-applied.
 *
 * The pure helpers import nothing at runtime (schema.ts is table definitions
 * only), so they are unit-testable without a database; applyInvoiceReturn
 * pulls the stock writer in lazily for the same reason.
 */
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import * as schema from './db/schema'
import type { Tx } from './stock'

/** The invoice-line fields the return logic needs. */
export interface InvoiceLineLike {
  product?: string | null
  sku?: string | null
  qty?: number | null
  amount?: number | null
}

/** A persisted sales_returns row: only the fields the rollup reads. */
export interface StoredReturnLike {
  status?: string | null
  returnItems?: unknown
}

/** One entry of a stored return_items jsonb payload (or a legacy {sku, qty}). */
interface StoredReturnItemLike {
  sku?: unknown
  qty?: unknown
}

/** What the UI needs per invoice line to show sold / returned / remaining. */
export interface ReturnLineSummary {
  sku: string
  product: string
  sold: number
  returned: number
  remaining: number
  /** Pro-rata unit value of the line, used for the credit-note amount. */
  unitAmount: number
}

export type InvoiceReturnStatus = 'partially_returned' | 'fully_returned'

function num(v: unknown, fallback = 0): number {
  const n = Number(v ?? fallback)
  return Number.isFinite(n) ? n : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Case-insensitive SKU key — invoice items and return payloads may differ in case. */
export function lineKey(sku: unknown): string {
  return String(sku ?? '').trim().toLowerCase()
}

const RETURN_STATUSES_EXCLUDED = new Set(['cancelled'])

/** Parse one stored sales_returns.return_items jsonb payload into {sku, qty} rows. */
export function parseStoredReturnItems(raw: unknown): Array<{ sku: string; qty: number }> {
  if (!raw) return []
  let arr: unknown = raw
  // Tolerate a payload shaped {items:[…]} as well as a plain list of rows.
  if (!Array.isArray(arr)) {
    const items = (raw as Record<string, unknown>).items
    arr = Array.isArray(items) ? items : [raw]
  }
  const out: Array<{ sku: string; qty: number }> = []
  for (const entry of arr as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const it = entry as StoredReturnItemLike
    const sku = String(it.sku ?? '').trim()
    const qty = Math.floor(num(it.qty))
    if (!sku || qty <= 0) continue
    out.push({ sku: lineKey(sku), qty })
  }
  return out
}

/**
 * Roll up the quantities already returned against an invoice, across all
 * persisted returns. Cancelled returns are excluded — they never merged
 * inventory in, so they must not consume returnable quantity either.
 */
export function aggregateReturnedBySku(rows: Array<StoredReturnLike | null | undefined>): Map<string, number> {
  const returned = new Map<string, number>()
  for (const row of rows) {
    if (!row || RETURN_STATUSES_EXCLUDED.has(String(row.status ?? '').toLowerCase())) continue
    for (const { sku, qty } of parseStoredReturnItems(row.returnItems)) {
      returned.set(sku, (returned.get(sku) ?? 0) + qty)
    }
  }
  return returned
}

/** Merge a freshly processed return into an existing rollup. */
export function addReturnedQty(returned: Map<string, number>, sku: string, qty: number): void {
  const key = lineKey(sku)
  if (!key || qty <= 0) return
  returned.set(key, (returned.get(key) ?? 0) + qty)
}

/**
 * Per-line summaries: sold, previously returned, remaining. Every consumer
 * (return endpoint, return-status endpoint, UI) shares these, so the numbers
 * can never drift between what was validated and what is shown.
 */
export function summarizeReturnLines(
  invoiceLines: Array<InvoiceLineLike | null | undefined>,
  returnedBySku: Map<string, number>,
): ReturnLineSummary[] {
  const out: ReturnLineSummary[] = []
  for (const line of invoiceLines) {
    if (!line) continue
    const sku = String(line.sku ?? '').trim()
    // Lines without a SKU were never stock-tracked and cannot be returned.
    if (!sku) continue
    const sold = Math.max(1, Math.floor(num(line.qty, 1)))
    const amount = num(line.amount, 0)
    const prev = returnedBySku.get(lineKey(sku)) ?? 0
    out.push({
      sku,
      product: String(line.product ?? '').trim(),
      sold,
      returned: Math.min(prev, sold),
      remaining: Math.max(0, sold - prev),
      unitAmount: sold > 0 ? round2(amount / sold) : 0,
    })
  }
  return out
}

/**
 * The invoice status a return implies. Null means "no returns anywhere — leave
 * the invoice's normal status (paid/issued/…) untouched", so one returned
 * piece never forces the invoice into a Frankenstein 'closed'/'refunded'
 * state the old UI's blanket Refund button produced.
 */
export function nextInvoiceStatus(lines: Array<ReturnLineSummary>): InvoiceReturnStatus | null {
  if (lines.length === 0) return null
  const anyReturned = lines.some((l) => l.returned > 0)
  const fullyReturned = lines.every((l) => l.remaining === 0)
  if (fullyReturned) return 'fully_returned'
  if (anyReturned) return 'partially_returned'
  return null
}

/** The credit-note value of a set of returned quantities (pro-rata per line, as before). */
export function creditAmountFor(returnedQtys: Map<string, number>, lines: Array<ReturnLineSummary>): number {
  let total = 0
  for (const line of lines) {
    const qty = Math.min(returnedQtys.get(lineKey(line.sku)) ?? 0, line.remaining)
    if (qty <= 0) continue
    total += Math.round(line.unitAmount * qty * 100) / 100
  }
  return round2(total)
}

export interface ParsedReturnRequest {
  /** Present when the request is invalid — the human-readable API error. */
  error?: string
  /** Requested quantity per SKU key (case-insensitive), aggregated across entries. */
  qtyBySku?: Map<string, number>
  /** Non-zero request lines aligned to invoice lines, with their credit value. */
  items?: Array<{ sku: string; product: string; qty: number; amount: number }>
}

/**
 * Validate a return request against sold minus already-returned.
 *
 * Accepts an explicit items list (partial return) or null/undefined — the
 * whole invoice, but "whole" respects what is still returnable, so a
 * whole-invoice return after a partial return only returns the leftovers.
 */
export function parseReturnRequest(
  rawItems: unknown,
  lines: Array<ReturnLineSummary>,
): ParsedReturnRequest {
  if (lines.length === 0) return { error: 'Invoice has no line items to return' }

  const entries: Array<{ sku: string; qty: number }> = []
  if (Array.isArray(rawItems) && rawItems.length > 0) {
    for (const entry of rawItems) {
      const it = (entry && typeof entry === 'object' ? entry : {}) as StoredReturnItemLike
      const sku = String(it.sku ?? '').trim()
      if (!sku) continue
      const qtyRaw = num(it.qty)
      // A piece cannot be returned in fractions; 1.5 silently floored to 1
      // would neither honour nor reject the request.
      if (!Number.isFinite(qtyRaw) || !Number.isInteger(qtyRaw) || qtyRaw <= 0) {
        return { error: `Return quantity must be a positive whole number for SKU ${sku}` }
      }
      const qty = qtyRaw
      entries.push({ sku, qty })
    }
    if (entries.length === 0) return { error: 'No matching items to return (SKU + qty required)' }
  } else {
    // Whole-invoice return: everything still returnable, nothing returned twice.
    for (const line of lines) if (line.remaining > 0) entries.push({ sku: line.sku, qty: line.remaining })
    if (entries.length === 0) return { error: 'Nothing left to return on this invoice' }
  }

  // Aggregate duplicate entries for the same SKU (two rows returning 2 = 4).
  const qtyBySku = new Map<string, number>()
  for (const { sku, qty } of entries) {
    const key = lineKey(sku)
    qtyBySku.set(key, (qtyBySku.get(key) ?? 0) + qty)
  }

  const byKey = new Map(lines.map((l) => [lineKey(l.sku), l]))
  for (const [key, qty] of qtyBySku) {
    const line = byKey.get(key)
    if (!line) return { error: `SKU "${key}" is not a line on this invoice` }
    if (line.remaining <= 0) {
      return { error: `All ${line.sold} of ${line.sku} have already been returned — nothing remains to return` }
    }
    if (qty > line.remaining) {
      return {
        error: `Cannot return ${qty} of ${line.sku} — sold ${line.sold}, ${line.returned} already returned, ${line.remaining} remaining`,
      }
    }
  }

  const items = lines
    .filter((line) => (qtyBySku.get(lineKey(line.sku)) ?? 0) > 0)
    .map((line) => {
      const qty = Math.min(qtyBySku.get(lineKey(line.sku)) ?? 0, line.remaining)
      return { sku: line.sku, product: line.product, qty, amount: Math.round(line.unitAmount * qty * 100) / 100 }
    })
    .filter((it) => it.qty > 0)

  if (items.length === 0) return { error: 'No matching items to return (SKU + qty required)' }
  return { qtyBySku, items }
}

// ─── Transactional core ─────────────────────────────────────────────────────

export interface InvoiceReturnResult {
  returnId: string
  creditNoteNumber: string
  invoiceNumber: string
  amount: number
  /** Total quantity accepted on this return (sum across all SKUs). */
  quantity: number
  restocked: boolean
  /** True when the request was a duplicate submission replayed from its
   * idempotency key — nothing was re-applied or double-stocked. */
  replayed?: boolean
  /** Status the invoice carries after this return (null = status unchanged). */
  status: InvoiceReturnStatus | null
  /** Per-line sold/returned/remaining AFTER this return was accepted. */
  lines: ReturnLineSummary[]
}

type Result =
  | { ok: true; result: InvoiceReturnResult }
  | { ok: false; status: number; error: string }

/**
 * Process a return inside the caller's transaction.
 *
 * The caller must have locked the invoice row FOR UPDATE inside the same
 * transaction, so two rapid submissions of the same partial return are applied
 * one after the other — the second either merges into the first (different
 * SKUs) or is rejected by the remaining-quantity check, never restocking
 * inventory twice. Any failure (bad quantity, failed insert, failed stock
 * write) rolls the whole return back: no credit note without its payment
 * trail, no restock without a return record.
 */
export async function applyInvoiceReturn(
  tx: Tx,
  invoiceId: string,
  payload: { items?: unknown; restock?: unknown; idempotencyKey?: unknown },
): Promise<Result> {
  const [invoice] = await tx.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId)).limit(1)
  if (!invoice) return { ok: false, status: 404, error: 'Invoice not found' }

  const invItems = await tx.select().from(schema.salesInvoiceItems).where(eq(schema.salesInvoiceItems.invoiceId, invoice.id as string))
  if (invItems.length === 0) return { ok: false, status: 400, error: 'Invoice has no line items to return' }

  // Previously returned quantities count against the sold quantity, so a
  // partial return can be resumed later without over-returning — and a
  // duplicate submission is rejected instead of restocking inventory twice.
  const priorRows = await tx
    .select({ status: schema.salesReturns.status, returnItems: schema.salesReturns.returnItems })
    .from(schema.salesReturns)
    .where(eq(schema.salesReturns.invoiceId, invoice.id as string))
  const alreadyReturned = aggregateReturnedBySku(priorRows)
  const lines = summarizeReturnLines(invItems, alreadyReturned)

  // Idempotency: the same submission (save, retry, second POST of the same
  // dialog) replays its original credit note and re-derives the current
  // state — it must never add inventory or a second credit note. NULL keys
  // (older returns, or the whole-invoice endpoint default) never match.
  const idempotencyKey = typeof payload?.idempotencyKey === 'string' && payload.idempotencyKey.trim() !== ''
    ? payload.idempotencyKey.trim()
    : null
  if (idempotencyKey) {
    const [prior] = await tx
      .select({
        id: schema.salesReturns.id,
        number: schema.salesReturns.number,
        creditNoteNumber: schema.salesReturns.creditNoteNumber,
        amount: schema.salesReturns.amount,
        restocked: schema.salesReturns.restocked,
        returnItems: schema.salesReturns.returnItems,
      })
      .from(schema.salesReturns)
      .where(eq(schema.salesReturns.idempotencyKey, idempotencyKey))
      .limit(1)
    if (prior) {
      const currentStatus = String(invoice.status ?? '').toLowerCase()
      return {
        ok: true,
        result: {
          returnId: prior.id as string,
          creditNoteNumber: String(prior.creditNoteNumber ?? prior.number ?? ''),
          invoiceNumber: String(invoice.number ?? ''),
          amount: round2(num(prior.amount, 0)),
          quantity: parseStoredReturnItems(prior.returnItems).reduce((a, it) => a + it.qty, 0),
          restocked: prior.restocked !== false,
          replayed: true,
          status: currentStatus === 'cancelled' || currentStatus === 'refunded' ? null : nextInvoiceStatus(lines),
          lines,
        },
      }
    }
  }

  const parsed = parseReturnRequest(payload?.items, lines)
  if (parsed.error) return { ok: false, status: 400, error: parsed.error }
  const returnItems = parsed.items!
  if (!returnItems) return { ok: false, status: 400, error: 'No matching items to return (SKU + qty required)' }

  const restock = payload?.restock !== false
  if (restock) {
    // Ledger-correct restock: applyStockMovement writes the stock_movements
    // audit row and the stock_levels balance, and products.stock stays a
    // consistent rollup — the old direct UPDATE drifted the ledger.
    const { applyStockMovement } = await import('./stock')
    for (const it of returnItems) {
      await applyStockMovement({ sku: it.sku, qty: it.qty, type: 'sale_return_in', refType: 'invoice', refId: invoice.id as string, tx })
    }
  }

  const amount = round2(returnItems.reduce((a, it) => a + it.amount, 0))
  const now = new Date()
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  let number = `CR${ym}-${Math.floor(100000 + Math.random() * 900000)}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const [dup] = await tx.select({ id: schema.salesReturns.id }).from(schema.salesReturns).where(eq(schema.salesReturns.number, number)).limit(1)
    if (!dup) break
    number = `CR${ym}-${Math.floor(100000 + Math.random() * 900000)}`
  }

  const [ret] = await tx.insert(schema.salesReturns).values({
    id: randomUUID(),
    number,
    invoiceId: invoice.id as string,
    creditNoteNumber: number,
    restocked: restock,
    returnItems,
    order: invoice.shopifyOrder ?? null,
    customer: invoice.customer ?? null,
    items: returnItems.reduce((a, it) => a + it.qty, 0),
    amount,
    status: 'processed',
    date: now.toISOString(),
    idempotencyKey,
  }).returning()

  // Accounting trail: negative payment against the invoice (the credit note).
  await tx.insert(schema.payments).values({
    id: randomUUID(),
    ref: number,
    invoice: invoice.number ?? null,
    customer: invoice.customer ?? null,
    amount: -amount,
    method: 'Credit Note',
    gateway: 'return',
    status: 'refunded',
    date: now.toISOString(),
  })

  // Recompute per-line quantities with THIS return merged in — the derived
  // status is always the cumulative truth, never a stale snapshot.
  const returnedBySku = new Map(alreadyReturned)
  for (const it of returnItems) addReturnedQty(returnedBySku, it.sku, it.qty)
  const linesAfter = summarizeReturnLines(invItems, returnedBySku)
  const nextStatus = nextInvoiceStatus(linesAfter)

  // One returned piece never flips a cancelled/refunded invoice (existing
  // business rules own those statuses); every other status moves to the
  // quantity-derived one.
  const currentStatus = String(invoice.status ?? '').toLowerCase()
  const statusChanged = nextStatus !== null && currentStatus !== 'cancelled' && currentStatus !== 'refunded'
  if (statusChanged) {
    await tx.update(schema.salesInvoices).set({ status: nextStatus }).where(eq(schema.salesInvoices.id, invoice.id as string))
  }    return {
      ok: true,
      result: {
        returnId: ret.id as string,
        creditNoteNumber: number,
        invoiceNumber: String(invoice.number ?? ''),
        amount,
        quantity: returnItems.reduce((a, it) => a + it.qty, 0),
        restocked: restock,
        replayed: false,
      status: statusChanged ? nextStatus : null,
      lines: linesAfter,
    },
  }
}
