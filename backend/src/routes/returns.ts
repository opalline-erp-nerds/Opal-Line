/**
 * Returns (RMA) and refunds API.
 *
 * Two tabs in one page, two separate ledgers:
 *   - `/returns` is the physical-goods workflow (requested → approved →
 *     in transit → received → completed). Only `received` moves stock, and only
 *     the accepted quantity.
 *   - `/refunds` is the money workflow and is always backed by Shopify's own
 *     refund record. An ERP "refund" is only ever reported as done once Shopify
 *     returned a refund id for it.
 */
import { Router, type Request, type Response } from 'express'
import type { Express } from 'express'
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import { requireAuth } from '../sessions'
import { requirePermission } from '../rbac'
import { db } from '../db/client'
import * as s from '../db/schema'
import { logger } from '../logger'
import {
  createSalesReturn,
  getOrderReturnStatus,
  lineKey,
  normalizeCurrency,
  normalizeOrderRef,
  parseStoredReturnItems,
  RETURN_REASONS,
  RETURN_STATUSES,
  setSalesReturnStatus,
  summarizeReturnableLines,
  type OrderLineLike,
} from '../returns'
import { createRefundInShopify, previewRefund, pullRefundsForOrder, retryFailedRefund } from '../shopifyRefunds'

const MAX_LIMIT = 100

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** `YYYY-MM-DD` → start of day; timestamps pass through. */
function startOfDay(value: string): string {
  return value.length === 10 ? `${value}T00:00:00.000Z` : value
}

function endOfDay(value: string): string {
  return value.length === 10 ? `${value}T23:59:59.999Z` : value
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value ?? fallback)
  return Number.isFinite(n) ? n : fallback
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Currency for a money row: the code recorded on it, else its order's, else
 * INR (this ERP's books are rupee-denominated). Nothing is ever converted —
 * totals in different currencies are reported side by side, not added.
 */
function resolveCurrency(stored: unknown, orderRef: string | null, byOrder: Map<string, string>): string {
  return normalizeCurrency(stored) ?? (orderRef ? byOrder.get(orderRef) : undefined) ?? 'INR'
}

/** Order-number → currency, for rows whose own currency column is empty. */
async function orderCurrencies(refs: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const keys = [...new Set(refs.filter(Boolean))]
  if (!db || keys.length === 0) return map
  const rows = await db
    .select({ shopifyId: s.salesOrders.shopifyId, currency: s.salesOrders.currency })
    .from(s.salesOrders)
    .where(inArray(s.salesOrders.shopifyId, keys))
  for (const row of rows) {
    const code = normalizeCurrency(row.currency)
    const ref = normalizeOrderRef(row.shopifyId)
    if (code && ref) map.set(ref, code)
  }
  return map
}

interface CurrencyTotal {
  currency: string
  count: number
  amount: number
  refunded: number
  pending: number
  failed: number
}

/**
 * Group money by currency. A mixed-currency ledger must never be summed into
 * one number: the operator sees each currency's own total instead.
 */
function tallyByCurrency(rows: Array<{ currency: string; amount: number; refunded: number }>): CurrencyTotal[] {
  const map = new Map<string, CurrencyTotal>()
  for (const row of rows) {
    const entry = map.get(row.currency) ?? { currency: row.currency, count: 0, amount: 0, refunded: 0, pending: 0, failed: 0 }
    entry.count += 1
    entry.amount = round2(entry.amount + row.amount)
    entry.refunded = round2(entry.refunded + row.refunded)
    map.set(row.currency, entry)
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount)
}

function actorOf(req: Request): string | null {
  const user = (req as Request & { user?: { name?: string; email?: string } }).user
  return user?.name ?? user?.email ?? req.userId ?? null
}

/** Refund rollup per `sales_returns.id`, for the returns list. */
async function refundsByReturnIds(ids: string[]) {
  const map = new Map<string, { refunded: number; pending: number; failed: number; status: string; count: number; lastAmount: number }>()
  if (ids.length === 0 || !db) return map
  const rows = await db
    .select({
      returnId: s.refunds.returnId,
      status: s.refunds.status,
      amount: s.refunds.amount,
      refundedAmount: s.refunds.refundedAmount,
    })
    .from(s.refunds)
    .where(inArray(s.refunds.returnId, ids))
  for (const row of rows) {
    const key = String(row.returnId ?? '')
    const entry = map.get(key) ?? { refunded: 0, pending: 0, failed: 0, status: 'none', count: 0, lastAmount: 0 }
    const amount = round2(num(row.amount))
    entry.count += 1
    entry.lastAmount = amount
    if (row.status === 'completed') entry.refunded = round2(entry.refunded + round2(num(row.refundedAmount, amount)))
    else if (row.status === 'failed') entry.failed = round2(entry.failed + amount)
    else entry.pending = round2(entry.pending + amount)
    map.set(key, entry)
  }
  for (const [key, entry] of map) {
    const parts = [entry.refunded > 0 ? 'completed' : '', entry.pending > 0 ? 'pending' : '', entry.failed > 0 ? 'failed' : '']
    entry.status = parts.filter(Boolean).join('+') || 'none'
    map.set(key, entry)
  }
  return map
}

/** Refund totals for returns linked by shopify order ref (webhook refunds carry no returnId). */
async function refundsByOrderRefs(refs: string[]) {
  const map = new Map<string, { refunded: number; pending: number; failed: number; status: string; count: number; lastAmount: number }>()
  if (refs.length === 0 || !db) return map
  const rows = await db
    .select({
      order: s.refunds.shopifyOrder,
      status: s.refunds.status,
      amount: s.refunds.amount,
      refundedAmount: s.refunds.refundedAmount,
    })
    .from(s.refunds)
    .where(inArray(s.refunds.shopifyOrder, refs))
  for (const row of rows) {
    const key = String(row.order ?? '')
    const entry = map.get(key) ?? { refunded: 0, pending: 0, failed: 0, status: 'none', count: 0, lastAmount: 0 }
    const amount = round2(num(row.amount))
    entry.count += 1
    entry.lastAmount = round2(entry.lastAmount + amount)
    if (row.status === 'completed') entry.refunded = round2(entry.refunded + round2(num(row.refundedAmount, amount)))
    else if (row.status === 'failed') entry.failed = round2(entry.failed + amount)
    else entry.pending = round2(entry.pending + amount)
    map.set(key, entry)
  }
  for (const [key, entry] of map) {
    const parts = [entry.refunded > 0 ? 'completed' : '', entry.pending > 0 ? 'pending' : '', entry.failed > 0 ? 'failed' : '']
    entry.status = parts.filter(Boolean).join('+') || 'none'
    map.set(key, entry)
  }
  return map
}

export function registerReturnRoutes(app: Express) {
  const router = Router()
  // Refunds get their own router: mounting one router on both paths would expose
  // every return endpoint under /refunds (and vice versa).
  const refundRouter = Router()

  // ─── Returns ──────────────────────────────────────────────────────────────

  router.get('/summary', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const from = text(req.query.from)
      const to = text(req.query.to)
      const where = and(
        from ? gte(s.salesReturns.date, startOfDay(from)) : undefined,
        to ? lte(s.salesReturns.date, endOfDay(to)) : undefined,
      )
      const rows = await db
        .select({
          status: s.salesReturns.status,
          amount: s.salesReturns.amount,
          currency: s.salesReturns.currency,
          order: s.salesReturns.order,
        })
        .from(s.salesReturns)
        .where(where)
      const returnCurrencies = await orderCurrencies(rows.map((r) => normalizeOrderRef(r.order)))
      const byStatus: Record<string, number> = {}
      let amount = 0
      const returnMoney: Array<{ currency: string; amount: number; refunded: number }> = []
      for (const row of rows) {
        const key = String(row.status ?? 'unknown')
        byStatus[key] = (byStatus[key] ?? 0) + 1
        const value = round2(num(row.amount))
        amount += value
        returnMoney.push({ currency: resolveCurrency(row.currency, normalizeOrderRef(row.order), returnCurrencies), amount: value, refunded: 0 })
      }
      const [refundAgg] = await db
        .select({
          total: sql<string>`coalesce(sum(${s.refunds.amount}), 0)`,
          refunded: sql<string>`coalesce(sum(case when ${s.refunds.status} = 'completed' then ${s.refunds.refundedAmount} else 0 end), 0)`,
          pending: sql<string>`coalesce(sum(case when ${s.refunds.status} = 'pending' then ${s.refunds.amount} else 0 end), 0)`,
          failed: sql<string>`coalesce(sum(case when ${s.refunds.status} = 'failed' then ${s.refunds.amount} else 0 end), 0)`,
          count: sql<string>`count(*)`,
        })
        .from(s.refunds)
      // Per-currency totals, so a USD refund is never added to a rupee total.
      const moneyRows = await db
        .select({
          currency: s.refunds.currency,
          order: s.refunds.shopifyOrder,
          status: s.refunds.status,
          amount: s.refunds.amount,
          refundedAmount: s.refunds.refundedAmount,
        })
        .from(s.refunds)
      const refundCurrencies = await orderCurrencies(moneyRows.map((r) => normalizeOrderRef(r.order)))
      const refundsByCurrency = tallyByCurrency(
        moneyRows.map((row) => ({
          currency: resolveCurrency(row.currency, normalizeOrderRef(row.order), refundCurrencies),
          amount: round2(num(row.amount)),
          refunded: row.status === 'completed' ? round2(num(row.refundedAmount, num(row.amount))) : 0,
        })),
      )
      for (const entry of refundsByCurrency) {
        for (const row of moneyRows) {
          const code = resolveCurrency(row.currency, normalizeOrderRef(row.order), refundCurrencies)
          if (code !== entry.currency) continue
          if (row.status === 'pending') entry.pending = round2(entry.pending + round2(num(row.amount)))
          if (row.status === 'failed') entry.failed = round2(entry.failed + round2(num(row.amount)))
        }
      }
      const [shopifyCount] = await db
        .select({ count: sql<string>`count(*)` })
        .from(s.refunds)
        .where(eq(s.refunds.source, 'shopify'))
      const [lastSync] = await db
        .select({ at: s.refundSyncEvents.createdAt })
        .from(s.refundSyncEvents)
        .orderBy(desc(s.refundSyncEvents.createdAt))
        .limit(1)

      res.json({
        returns: {
          total: rows.length,
          byStatus,
          amount: round2(amount),
          byCurrency: tallyByCurrency(returnMoney),
        },
        refunds: {
          count: Number(refundAgg?.count ?? 0),
          total: round2(num(refundAgg?.total)),
          refunded: round2(num(refundAgg?.refunded)),
          pending: round2(num(refundAgg?.pending)),
          failed: round2(num(refundAgg?.failed)),
          fromShopify: Number(shopifyCount?.count ?? 0),
          byCurrency: refundsByCurrency,
        },
        lastSyncedAt: lastSync?.at ?? null,
        reasons: RETURN_REASONS,
        statuses: RETURN_STATUSES,
      })
    } catch (err) {
      logger.error({ err }, 'returns summary failed')
      res.status(500).json({ error: 'Failed to load the returns summary' })
    }
  })

  router.get('/orders', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const query = text(req.query.query)
      const limit = intParam(req.query.limit, 20, 1, MAX_LIMIT)
      const where = query
        ? or(
            ilike(s.salesOrders.shopifyId, `%${query}%`),
            ilike(s.salesOrders.customer, `%${query}%`),
            ilike(s.salesOrders.customerEmail, `%${query}%`),
            ilike(s.salesOrders.internalId, `%${query}%`),
          )
        : undefined
      const rows = await db
        .select({
          id: s.salesOrders.id,
          shopifyId: s.salesOrders.shopifyId,
          internalId: s.salesOrders.internalId,
          customer: s.salesOrders.customer,
          customerEmail: s.salesOrders.customerEmail,
          value: s.salesOrders.value,
          currency: s.salesOrders.currency,
          payment: s.salesOrders.payment,
          status: s.salesOrders.status,
          date: s.salesOrders.date,
          lineItems: s.salesOrders.lineItems,
        })
        .from(s.salesOrders)
        .where(where)
        .orderBy(desc(s.salesOrders.date))
        .limit(limit)
      res.json({
        orders: rows.map((row) => ({
          id: row.id,
          order: row.shopifyId ?? row.internalId ?? row.id,
          shopifyOrder: row.shopifyId ?? null,
          customer: row.customer ?? '',
          customerEmail: row.customerEmail ?? null,
          value: round2(num(row.value)),
          currency: normalizeCurrency(row.currency) ?? 'INR',
          payment: row.payment ?? null,
          status: row.status ?? null,
          date: row.date ?? null,
          items: Array.isArray(row.lineItems) ? row.lineItems.length : 0,
        })),
      })
    } catch (err) {
      logger.error({ err }, 'return order search failed')
      res.status(500).json({ error: 'Failed to search orders' })
    }
  })

  router.get('/order/:orderId', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    try {
      const result = await getOrderReturnStatus(String(req.params.orderId))
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return }
      res.json(result)
    } catch (err) {
      logger.error({ err }, 'order return status failed')
      res.status(500).json({ error: 'Failed to load returnable items' })
    }
  })

  router.get('/', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const status = text(req.query.status)
      const from = text(req.query.from)
      const to = text(req.query.to)
      const search = text(req.query.search)
      const shopifyOrder = text(req.query.order)
      const page = intParam(req.query.page, 1, 1, 10_000)
      const limit = intParam(req.query.limit, 25, 1, MAX_LIMIT)
      const offset = (page - 1) * limit

      const conditions = [
        status && status !== 'all' ? eq(s.salesReturns.status, status) : undefined,
        from ? gte(s.salesReturns.date, startOfDay(from)) : undefined,
        to ? lte(s.salesReturns.date, endOfDay(to)) : undefined,
        shopifyOrder ? eq(s.salesReturns.order, normalizeOrderRef(shopifyOrder)) : undefined,
        search
          ? or(
              ilike(s.salesReturns.number, `%${search}%`),
              ilike(s.salesReturns.customer, `%${search}%`),
              ilike(s.salesReturns.customerEmail, `%${search}%`),
              ilike(s.salesReturns.order, `%${search}%`),
            )
          : undefined,
      ].filter(Boolean)
      // Legacy credit notes (`processed`) are real returned goods recorded by
      // the older invoice-return flow. They are listed (the page must not look
      // empty on a database that predates RMA statuses) but keep their own
      // status so they are never treated as an open return.
      const where = and(...conditions)

      const [totalRow] = await db
        .select({ count: sql<string>`count(*)` })
        .from(s.salesReturns)
        .where(where)
      const rows = await db
        .select()
        .from(s.salesReturns)
        .where(where)
        .orderBy(desc(s.salesReturns.date))
        .limit(limit)
        .offset(offset)

      const refunds = await refundsByReturnIds(rows.map((r) => r.id))
      const orderRefs = rows.map((r) => normalizeOrderRef(r.order)).filter(Boolean)
      const refundsByOrder = await refundsByOrderRefs(orderRefs)

      const orderIds = rows.map((r) => r.orderId).filter((id): id is string => Boolean(id))
      const orderRows = orderIds.length
        ? await db
            .select({ id: s.salesOrders.id, value: s.salesOrders.value, shopifyId: s.salesOrders.shopifyId, currency: s.salesOrders.currency })
            .from(s.salesOrders)
            .where(inArray(s.salesOrders.id, orderIds))
        : []
      const orderMap = new Map(orderRows.map((o) => [o.id, o]))
      const currencyByRef = new Map<string, string>()
      for (const o of orderRows) {
        const code = normalizeCurrency(o.currency)
        const ref = normalizeOrderRef(o.shopifyId)
        if (code && ref) currencyByRef.set(ref, code)
      }

      res.json({
        returns: rows.map((row) => {
          const refund = refunds.get(row.id)
          const byOrder = refundsByOrder.get(normalizeOrderRef(row.order))
          const order = orderMap.get(String(row.orderId ?? ''))
          return {
            id: row.id,
            number: String(row.number),
            order: row.order ?? null,
            orderId: row.orderId ?? null,
            orderValue: round2(num(order?.value)),
            currency: resolveCurrency(row.currency, normalizeOrderRef(row.order), currencyByRef),
            customer: row.customer ?? '',
            customerEmail: row.customerEmail ?? null,
            date: row.date ?? row.requestedAt ?? null,
            requestedAt: row.requestedAt ?? null,
            receivedAt: row.receivedAt ?? null,
            completedAt: row.completedAt ?? null,
            itemsCount: Math.round(num(row.items)),
            items: parseStoredReturnItems(row.returnItems).map((it) => it.qty),
            products: parseStoredReturnItems(row.returnItems),
            reason: row.reason ?? null,
            notes: row.notes ?? null,
            status: row.status ?? 'requested',
            source: row.source ?? 'erp',
            amount: round2(num(row.amount)),
            restocked: Boolean(row.restocked),
            refundStatus: refund?.status ?? byOrder?.status ?? 'none',
            refundAmount: refund
              ? round2(refund.refunded + refund.pending + refund.failed)
              : round2(byOrder?.refunded ?? 0),
            refundCount: refund?.count ?? byOrder?.count ?? 0,
            receivedItems: Array.isArray(row.receivedItems) ? row.receivedItems : null,
          }
        }),
        pagination: { page, limit, total: Number(totalRow?.count ?? 0) },
      })
    } catch (err) {
      logger.error({ err }, 'returns list failed')
      res.status(500).json({ error: 'Failed to load returns' })
    }
  })

  router.get('/:id', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const [row] = await db.select().from(s.salesReturns).where(eq(s.salesReturns.id, String(req.params.id))).limit(1)
      if (!row) { res.status(404).json({ error: 'Return not found' }); return }

      const [order] = row.orderId
        ? await db.select().from(s.salesOrders).where(eq(s.salesOrders.id, row.orderId)).limit(1)
        : row.order
          ? await db.select().from(s.salesOrders).where(eq(s.salesOrders.shopifyId, normalizeOrderRef(row.order))).limit(1)
          : [undefined]

      const storedItems = parseStoredReturnItems(row.returnItems)

      // Previously returned = every other non-rejected return of this order.
      const siblings = await db
        .select({ id: s.salesReturns.id, status: s.salesReturns.status, returnItems: s.salesReturns.returnItems })
        .from(s.salesReturns)
        .where(
          and(
            order ? eq(s.salesReturns.orderId, order.id) : sql`false`,
            sql`${s.salesReturns.id} <> ${row.id}`,
            sql`coalesce(${s.salesReturns.status}, '') not in ('rejected','cancelled','processed')`,
          ),
        )
      const returnedBefore = new Map<string, number>()
      for (const sibling of siblings) {
        for (const it of parseStoredReturnItems(sibling.returnItems)) {
          const key = lineKey(it.sku)
          returnedBefore.set(key, (returnedBefore.get(key) ?? 0) + it.qty)
        }
      }

      const orderLines = order && Array.isArray(order.lineItems) ? (order.lineItems as OrderLineLike[]) : []
      const lines = summarizeReturnableLines(
        orderLines,
        new Map([...returnedBefore].map(([sku, qty]) => [sku, qty])),
      )
      const lineBySku = new Map(lines.map((l) => [lineKey(l.sku), l]))

      const refunds = await db
        .select()
        .from(s.refunds)
        .where(
          or(
            eq(s.refunds.returnId, row.id),
            row.order ? eq(s.refunds.shopifyOrder, normalizeOrderRef(row.order)) : sql`false`,
          ),
        )
        .orderBy(desc(s.refunds.createdAt))

      res.json({
        return: {
          id: row.id,
          number: String(row.number),
          order: row.order ?? null,
          orderId: row.orderId ?? null,
          customer: row.customer ?? '',
          customerEmail: row.customerEmail ?? null,
          date: row.date ?? row.requestedAt ?? null,
          status: row.status ?? 'requested',
          source: row.source ?? 'erp',
          reason: row.reason ?? null,
          notes: row.notes ?? null,
          amount: round2(num(row.amount)),
          currency: normalizeCurrency(row.currency) ?? normalizeCurrency(order?.currency) ?? 'INR',
          restocked: Boolean(row.restocked),
          requestedAt: row.requestedAt ?? null,
          receivedAt: row.receivedAt ?? null,
          completedAt: row.completedAt ?? null,
          createdBy: row.createdBy ?? null,
          receivedItems: Array.isArray(row.receivedItems) ? row.receivedItems : null,
        },
        order: order
          ? {
              id: order.id,
              number: order.shopifyId ?? order.internalId ?? order.id,
              customer: order.customer ?? '',
              customerEmail: order.customerEmail ?? null,
              value: round2(num(order.value)),
              currency: normalizeCurrency(order.currency) ?? 'INR',
              payment: order.payment ?? null,
              status: order.status ?? null,
              date: order.date ?? null,
            }
          : null,
        items: storedItems.map((it) => {
          const line = lineBySku.get(lineKey(it.sku))
          // Legacy credit notes have no live order line, so fall back to the name
          // and amount recorded on the return itself.
          const unitPrice = line?.unitPrice ?? (it.amount && it.qty > 0 ? round2(it.amount / it.qty) : 0)
          return {
            sku: it.sku,
            product: line?.product ?? it.product ?? it.sku,
            ordered: line?.ordered ?? it.qty,
            previouslyReturned: returnedBefore.get(lineKey(it.sku)) ?? 0,
            quantity: it.qty,
            remaining: line?.remaining ?? 0,
            unitPrice,
            amount: round2(unitPrice * it.qty),
            received: (Array.isArray(row.receivedItems)
              ? (row.receivedItems as Array<{ sku?: string; received?: number; accepted?: number; damaged?: number }>)
              : []
            ).find((r) => lineKey(r.sku) === lineKey(it.sku)),
          }
        }),
        refunds: refunds.map((refund) => ({
          id: refund.id,
          number: String(refund.number),
          shopifyRefundId: refund.shopifyRefundId ?? null,
          status: refund.status,
          source: refund.source,
          amount: round2(num(refund.amount)),
          refundedAmount: round2(num(refund.refundedAmount)),
          currency: normalizeCurrency(refund.currency) ?? normalizeCurrency(order?.currency) ?? 'INR',
          paymentMethod: refund.paymentMethod ?? null,
          note: refund.note ?? null,
          createdAt: refund.createdAt ?? null,
          processedAt: refund.processedAt ?? null,
          syncError: refund.syncError ?? null,
        })),
      })
    } catch (err) {
      logger.error({ err }, 'return detail failed')
      res.status(500).json({ error: 'Failed to load the return' })
    }
  })

  router.post('/', requireAuth, requirePermission('sales', 'create'), async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!body.orderId) { res.status(400).json({ error: 'Select an order to return' }); return }
      const result = await createSalesReturn({
        orderId: String(body.orderId),
        items: body.items,
        reason: text(body.reason),
        notes: text(body.notes),
        status: text(body.status),
        createdBy: actorOf(req),
        idempotencyKey: text(body.idempotencyKey),
      })
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return }
      logger.info({ id: result.id, number: result.number, by: req.userId, replayed: result.replayed }, 'sales return created')
      res.status(result.replayed ? 200 : 201).json(result)
    } catch (err) {
      logger.error({ err }, 'return creation failed')
      res.status(500).json({ error: 'Failed to create the return' })
    }
  })

  router.patch('/:id/status', requireAuth, requirePermission('sales', 'edit'), async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const status = text(body.status)
      if (!status) { res.status(400).json({ error: 'A target status is required' }); return }
      const result = await setSalesReturnStatus(String(req.params.id), status, {
        inspection: body.inspection,
        locationId: text(body.locationId),
        notes: body.notes === undefined ? undefined : text(body.notes),
        actor: actorOf(req),
      })
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return }
      logger.info({ id: req.params.id, status: result.status, restocked: result.restocked, by: req.userId }, 'return status changed')
      res.json(result)
    } catch (err) {
      logger.error({ err }, 'return status change failed')
      res.status(500).json({ error: 'Failed to update the return' })
    }
  })

  // ─── Refunds ──────────────────────────────────────────────────────────────

  refundRouter.get('/summary', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const from = text(req.query.from)
      const to = text(req.query.to)
      const rows = await db
        .select({
          status: s.refunds.status,
          source: s.refunds.source,
          amount: s.refunds.amount,
          refundedAmount: s.refunds.refundedAmount,
          currency: s.refunds.currency,
          order: s.refunds.shopifyOrder,
        })
        .from(s.refunds)
        .where(
          and(
            from ? gte(s.refunds.createdAt, startOfDay(from)) : undefined,
            to ? lte(s.refunds.createdAt, endOfDay(to)) : undefined,
          ),
        )
      const currencyByRef = await orderCurrencies(rows.map((r) => normalizeOrderRef(r.order)))
      const summary = {
        count: rows.length,
        completed: 0,
        pending: 0,
        failed: 0,
        refundedAmount: 0,
        pendingAmount: 0,
        failedAmount: 0,
        fromShopify: 0,
        fromErp: 0,
      }
      const moneyRows: Array<{ currency: string; amount: number; refunded: number; status: string }> = []
      for (const row of rows) {
        const amount = round2(num(row.amount))
        moneyRows.push({
          currency: resolveCurrency(row.currency, normalizeOrderRef(row.order), currencyByRef),
          amount,
          refunded: row.status === 'completed' ? round2(num(row.refundedAmount, amount)) : 0,
          status: String(row.status ?? 'pending'),
        })
        if (row.status === 'completed') {
          summary.completed += 1
          summary.refundedAmount = round2(summary.refundedAmount + round2(num(row.refundedAmount, amount)))
        } else if (row.status === 'failed') {
          summary.failed += 1
          summary.failedAmount = round2(summary.failedAmount + amount)
        } else {
          summary.pending += 1
          summary.pendingAmount = round2(summary.pendingAmount + amount)
        }
        if (row.source === 'shopify') summary.fromShopify += 1
        else summary.fromErp += 1
      }
      const byCurrency = tallyByCurrency(moneyRows)
      for (const entry of byCurrency) {
        for (const row of moneyRows) {
          if (row.currency !== entry.currency) continue
          if (row.status === 'pending') entry.pending = round2(entry.pending + row.amount)
          if (row.status === 'failed') entry.failed = round2(entry.failed + row.amount)
        }
      }
      const [lastSync] = await db
        .select({ at: s.refundSyncEvents.createdAt })
        .from(s.refundSyncEvents)
        .orderBy(desc(s.refundSyncEvents.createdAt))
        .limit(1)
      res.json({ summary: { ...summary, byCurrency }, lastSyncedAt: lastSync?.at ?? null })
    } catch (err) {
      logger.error({ err }, 'refund summary failed')
      res.status(500).json({ error: 'Failed to load the refund summary' })
    }
  })

  refundRouter.get('/refundable/:order', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    try {
      const { fetchRefundableOrder } = await import('../shopifyRefunds')
      const result = await fetchRefundableOrder(String(req.params.order))
      if (!result.ok) { res.status(502).json({ error: result.error }); return }
      res.json(result.order)
    } catch (err) {
      logger.error({ err }, 'refundable lookup failed')
      res.status(500).json({ error: 'Failed to load refundable items from Shopify' })
    }
  })

  refundRouter.post('/preview', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const orderName = text(body.orderName) ?? text(body.order)
      if (!orderName) { res.status(400).json({ error: 'A Shopify order number is required' }); return }
      const result = await previewRefund(orderName, Array.isArray(body.items) ? (body.items as never[]) : [], {
        shippingAmount: body.shippingAmount != null ? num(body.shippingAmount) : 0,
        restock: false,
      })
      if (!result.ok) { res.status(result.status ?? 400).json({ error: result.error }); return }
      res.json(result.preview)
    } catch (err) {
      logger.error({ err }, 'refund preview failed')
      res.status(500).json({ error: 'Failed to preview the refund' })
    }
  })

  refundRouter.get('/', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const status = text(req.query.status)
      const source = text(req.query.source)
      const from = text(req.query.from)
      const to = text(req.query.to)
      const search = text(req.query.search)
      const order = text(req.query.order)
      const page = intParam(req.query.page, 1, 1, 10_000)
      const limit = intParam(req.query.limit, 25, 1, MAX_LIMIT)
      const offset = (page - 1) * limit

      const where = and(
        // 'partial' is not a status: it is a refund that covers less than its
        // order. Shopify-sourced refunds carry the order number, not our id.
        // Only amounts in the order's own currency are comparable — a
        // multi-currency refund is in the customer's presentment currency.
        status === 'partial'
          ? sql`exists (select 1 from sales_orders o
                 where (o.id = ${s.refunds.orderId} or o.shopify_id = ${s.refunds.shopifyOrder})
                 and upper(coalesce(${s.refunds.currency}, o.currency)) = upper(o.currency)
                 and ${s.refunds.amount} < coalesce(o.value, 0) - 0.01)`
          : status && status !== 'all'
            ? eq(s.refunds.status, status)
            : undefined,
        source && source !== 'all' ? eq(s.refunds.source, source) : undefined,
        from ? gte(s.refunds.createdAt, startOfDay(from)) : undefined,
        to ? lte(s.refunds.createdAt, endOfDay(to)) : undefined,
        order ? eq(s.refunds.shopifyOrder, normalizeOrderRef(order)) : undefined,
        search
          ? or(
              ilike(s.refunds.number, `%${search}%`),
              ilike(s.refunds.shopifyOrder, `%${search}%`),
              ilike(s.refunds.customer, `%${search}%`),
              ilike(s.refunds.customerEmail, `%${search}%`),
              ilike(s.refunds.shopifyRefundId, `%${search}%`),
            )
          : undefined,
      )

      const [totalRow] = await db.select({ count: sql<string>`count(*)` }).from(s.refunds).where(where)
      const rows = await db
        .select()
        .from(s.refunds)
        .where(where)
        .orderBy(desc(s.refunds.createdAt))
        .limit(limit)
        .offset(offset)

      const ids = rows.map((r) => r.id)
      const orderIds = rows.map((r) => r.orderId).filter((id): id is string => Boolean(id))
      const orderRows = orderIds.length
        ? await db
            .select({ id: s.salesOrders.id, value: s.salesOrders.value, currency: s.salesOrders.currency })
            .from(s.salesOrders)
            .where(inArray(s.salesOrders.id, orderIds))
        : []
      const orderValueById = new Map(orderRows.map((o) => [o.id, round2(num(o.value))]))
      const orderCurrencyById = new Map<string, string | null>(
        orderRows.map((o) => [o.id, normalizeCurrency(o.currency)]),
      )
      // Refunds created in Shopify have no local order id, only the order number.
      const orderRefs = rows.map((r) => normalizeOrderRef(r.shopifyOrder)).filter(Boolean)
      const orderRowsByRef = orderRefs.length
        ? await db
            .select({ shopifyId: s.salesOrders.shopifyId, value: s.salesOrders.value, currency: s.salesOrders.currency })
            .from(s.salesOrders)
            .where(inArray(s.salesOrders.shopifyId, orderRefs))
        : []
      const orderValueByRef = new Map(
        orderRowsByRef.map((o) => [normalizeOrderRef(o.shopifyId), round2(num(o.value))]),
      )
      const orderCurrencyByRef = new Map<string, string>()
      for (const o of orderRowsByRef) {
        const code = normalizeCurrency(o.currency)
        const ref = normalizeOrderRef(o.shopifyId)
        if (code && ref) orderCurrencyByRef.set(ref, code)
      }
      const items = ids.length
        ? await db.select().from(s.refundLineItems).where(inArray(s.refundLineItems.refundId, ids))
        : []
      const itemsByRefund = new Map<string, typeof items>()
      for (const item of items) {
        const list = itemsByRefund.get(item.refundId) ?? []
        list.push(item)
        itemsByRefund.set(item.refundId, list)
      }

      res.json({
        refunds: rows.map((row) => ({
          id: row.id,
          number: String(row.number),
          shopifyRefundId: row.shopifyRefundId ?? null,
          order: row.shopifyOrder ?? null,
          orderId: row.orderId ?? null,
          invoiceNumber: row.invoiceNumber ?? null,
          returnId: row.returnId ?? null,
          customer: row.customer ?? '',
          customerEmail: row.customerEmail ?? null,
          date: row.createdAt ?? null,
          processedAt: row.processedAt ?? null,
          orderValue: row.orderId
            ? (orderValueById.get(row.orderId) ?? orderValueByRef.get(normalizeOrderRef(row.shopifyOrder)) ?? 0)
            : (orderValueByRef.get(normalizeOrderRef(row.shopifyOrder)) ?? 0),
          amount: round2(num(row.amount)),
          requestedAmount: round2(num(row.requestedAmount, num(row.amount))),
          refundedAmount: round2(num(row.refundedAmount)),
          currency: resolveCurrency(row.currency, normalizeOrderRef(row.shopifyOrder), orderCurrencyByRef),
          // The order's own currency, so the UI never compares a presentment
          // refund against a shop-currency total as if they were the same money.
          orderCurrency: row.orderId
            ? (orderCurrencyById.get(row.orderId) ?? orderCurrencyByRef.get(normalizeOrderRef(row.shopifyOrder)) ?? null)
            : (orderCurrencyByRef.get(normalizeOrderRef(row.shopifyOrder)) ?? null),
          paymentMethod: row.paymentMethod ?? row.gateway ?? null,
          gateway: row.gateway ?? null,
          transactionIds: row.transactionIds ?? null,
          status: row.status,
          source: row.source,
          note: row.note ?? null,
          syncError: row.syncError ?? null,
          attempts: Math.round(num(row.attempts)),
          items: (itemsByRefund.get(row.id) ?? []).map((item) => ({
            id: item.id,
            product: item.product ?? '',
            sku: item.sku ?? '',
            quantity: Math.round(num(item.quantity)),
            amount: round2(num(item.amount)),
          })),
        })),
        pagination: { page, limit, total: Number(totalRow?.count ?? 0) },
      })
    } catch (err) {
      logger.error({ err }, 'refunds list failed')
      res.status(500).json({ error: 'Failed to load refunds' })
    }
  })

  refundRouter.get('/:id', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const [row] = await db.select().from(s.refunds).where(eq(s.refunds.id, String(req.params.id))).limit(1)
      if (!row) { res.status(404).json({ error: 'Refund not found' }); return }
      const orderRef = normalizeOrderRef(row.shopifyOrder)
      const [localOrder] = orderRef
        ? await db
            .select({ value: s.salesOrders.value, currency: s.salesOrders.currency })
            .from(s.salesOrders)
            .where(eq(s.salesOrders.shopifyId, orderRef))
            .limit(1)
        : [undefined]
      const currency = normalizeCurrency(row.currency) ?? normalizeCurrency(localOrder?.currency) ?? 'INR'
      const items = await db.select().from(s.refundLineItems).where(eq(s.refundLineItems.refundId, row.id))
      const events = await db
        .select()
        .from(s.refundSyncEvents)
        .where(eq(s.refundSyncEvents.refundId, row.id))
        .orderBy(desc(s.refundSyncEvents.createdAt))
        .limit(50)
      res.json({
        refund: {
          ...row,
          amount: round2(num(row.amount)),
          requestedAmount: round2(num(row.requestedAmount, num(row.amount))),
          refundedAmount: round2(num(row.refundedAmount)),
          order: row.shopifyOrder ?? null,
          orderValue: round2(num(localOrder?.value)),
          orderCurrency: normalizeCurrency(localOrder?.currency),
          currency,
          paymentMethod: row.paymentMethod ?? row.gateway ?? null,
          items: items.map((item) => ({
            id: item.id,
            product: item.product ?? '',
            sku: item.sku ?? '',
            quantity: Math.round(num(item.quantity)),
            amount: round2(num(item.amount)),
          })),
        },
        items: items.map((item) => ({ ...item, amount: round2(num(item.amount)) })),
        events,
      })
    } catch (err) {
      logger.error({ err }, 'refund detail failed')
      res.status(500).json({ error: 'Failed to load the refund' })
    }
  })

  refundRouter.post('/', requireAuth, requirePermission('sales', 'edit'), async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const orderName = text(body.orderName) ?? text(body.order)
      if (!orderName) { res.status(400).json({ error: 'Select the Shopify order to refund' }); return }
      const items = Array.isArray(body.items) ? (body.items as never[]) : []
      const result = await createRefundInShopify({
        orderName,
        items,
        shippingAmount: body.shippingAmount != null ? num(body.shippingAmount) : 0,
        note: text(body.note),
        notify: Boolean(body.notify),
        returnId: text(body.returnId),
        createdBy: actorOf(req),
        idempotencyKey: text(body.idempotencyKey),
      })
      if (!result.ok) { res.status(502).json(result); return }
      logger.info(
        { refundId: result.refundId, orderName, amount: result.amount, by: req.userId, replayed: result.replayed },
        'refund created through Shopify',
      )
      res.status(result.replayed ? 200 : 201).json(result)
    } catch (err) {
      logger.error({ err }, 'refund creation failed')
      res.status(500).json({ ok: false, error: 'Failed to create the refund' })
    }
  })

  refundRouter.post('/:id/retry', requireAuth, requirePermission('sales', 'edit'), async (req: Request, res: Response) => {
    try {
      const result = await retryFailedRefund(String(req.params.id), actorOf(req))
      if (!result.ok) { res.status(502).json(result); return }
      logger.info({ id: req.params.id, refundId: result.refundId, by: req.userId }, 'failed refund retried')
      res.json(result)
    } catch (err) {
      logger.error({ err }, 'refund retry failed')
      res.status(500).json({ ok: false, error: 'Failed to retry the refund' })
    }
  })

  refundRouter.post('/sync', requireAuth, requirePermission('sales', 'edit'), async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const orderName = text(body.orderName) ?? text(body.order)
      if (!orderName) { res.status(400).json({ error: 'An order number is required' }); return }
      const result = await pullRefundsForOrder(orderName)
      if (!result.ok) { res.status(502).json({ error: result.error }); return }
      logger.info({ ...result, by: req.userId }, 'refunds pulled from Shopify')
      res.json(result)
    } catch (err) {
      logger.error({ err }, 'refund pull failed')
      res.status(500).json({ error: 'Failed to sync refunds from Shopify' })
    }
  })

  app.use('/api/v1/returns', router)
  app.use('/api/v1/refunds', refundRouter)
}
