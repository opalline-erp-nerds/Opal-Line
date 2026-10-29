import { and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import type { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { db } from '../db/client'
import * as s from '../db/schema'
import { requirePermission } from '../rbac'
import { recordActivity } from '../activity'
import { actorFromRequest } from '../activity'
import { applyPieceRateInvoiceItems, num, round2 } from './db'
import { routeParam } from '../lib/routeParams'
import { applyStockMovement, assertStockAvailable, InsufficientStockError } from '../stock'

type Handler = (req: Request, res: Response, next: NextFunction) => unknown

interface RouteRegistrar {
  get: (path: string, ...handlers: Handler[]) => void
  post: (path: string, ...handlers: Handler[]) => void
  patch: (path: string, ...handlers: Handler[]) => void
  delete: (path: string, ...handlers: Handler[]) => void
}

/**
 * Quotations — pre-sale estimates that convert into tax invoices.
 *
 * Routes (mounted under /api/v1/db/quotations by routes/db.ts):
 *   GET    /quotations            list (paginated)
 *   GET    /quotations/:id        one (with items)
 *   POST   /quotations            create
 *   PATCH  /quotations/:id        update (replaces items when provided)
 *   DELETE /quotations/:id        delete
 *   POST   /quotations/:id/status   move the quotation through its lifecycle
 *                                  (sent / approved / cancelled / reopen)
 *   POST   /quotations/:id/convert  convert into a real tax invoice (no stock movement
 *                                  until conversion; conversion mirrors manual invoices)
 *   POST   /quotations/:id/convert-order  convert into a confirmed sales order
 *                                  (no stock movement; fulfilment still happens
 *                                  on the order — for pre-orders/productions)
 */

const QUOTE_PREFIX = 'QT-'

// ─── Lifecycle ──────────────────────────────────────────────────────────────
// A quotation is created as `draft` and lives here until it is converted:
//   draft → sent → approved → converted   (or cancelled / expired at any point)
// `converted` is terminal and only set by the convert routes; `expired` is
// applied automatically once `validUntil` has passed.
export const QUOTATION_STATUSES = ['draft', 'sent', 'approved', 'converted', 'expired', 'cancelled'] as const
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number]

const STATUS_TRANSITIONS: Record<QuotationStatus, QuotationStatus[]> = {
  draft: ['sent', 'cancelled'],
  sent: ['approved', 'cancelled', 'expired'],
  approved: ['cancelled', 'expired'],
  expired: ['draft'],
  converted: [],
  cancelled: [],
}

export function isQuotationStatus(value: unknown): value is QuotationStatus {
  return typeof value === 'string' && (QUOTATION_STATUSES as readonly string[]).includes(value)
}

/** True when the quotation has a valid-until date that is already in the past. */
export function quotationIsExpired(quote: { validUntil?: string | null; status?: string | null }): boolean {
  if (!quote.validUntil) return false
  return new Date(quote.validUntil).getTime() < Date.now()
}

/** Statuses that expiry may still touch (converted / cancelled are final). */
const EXPIRABLE: QuotationStatus[] = ['draft', 'sent', 'approved']

/**
 * Flip past-valid-until quotations to `expired`. Called before listing so the
 * UI and filters never show a stale quotation as live, and from the daily
 * scheduler so the state is correct even when nobody opens the page.
 */
export async function expireStaleQuotations(): Promise<number> {
  if (!db) return 0
  try {
    const now = new Date().toISOString()
    const expired = await db
      .update(s.quotations)
      .set({ status: 'expired', updatedAt: now })
      .where(
        and(
          inArray(s.quotations.status, EXPIRABLE),
          isNotNull(s.quotations.validUntil),
          lt(s.quotations.validUntil, now),
        ),
      )
      .returning({ id: s.quotations.id })
    return expired.length
  } catch {
    // Never let a housekeeping failure break a request.
    return 0
  }
}

async function nextQuotationNumber(): Promise<string> {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${QUOTE_PREFIX}${stamp}${Math.floor(1000 + Math.random() * 9000)}`
    const [clash] = await db!
      .select({ id: s.quotations.id })
      .from(s.quotations)
      .where(eq(s.quotations.number, candidate))
      .limit(1)
    if (!clash) return candidate
  }
  throw new Error('Could not generate a unique quotation number')
}

export function normalizeQuotationItems(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((it) => {
      const item = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
      const weight = num(item.weight, 0)
      const silverRate = num(item.silverRate, 0)
      const makingChargePerGram = num(item.makingCharge, 0)
      const qty = Math.max(1, Math.floor(num(item.qty, 1)))
      const amount =
        weight > 0 && silverRate > 0
          ? round2(weight * silverRate + weight * makingChargePerGram)
          : num(item.amount, 0)
      return {
        product: String(item.product ?? item.title ?? '').trim(),
        sku: String(item.sku ?? '').trim(),
        qty,
        weight,
        silverRate,
        makingCharge: makingChargePerGram,
        amount,
      }
    })
    .filter((it) => it.sku !== '' || it.product !== '')
}

export function computeTotals(items: Array<Record<string, unknown>>, gstRate: number, discount: number) {
  const subtotal = round2(items.reduce((a, it) => a + num(it.amount, 0), 0))
  const gstAmount = round2((subtotal * gstRate) / 100)
  const grandTotal = round2(subtotal + gstAmount - discount)
  return { subtotal, gstAmount, grandTotal }
}

function sanitizeCustomer(body: Record<string, unknown>) {
  return {
    customer: String(body.customer ?? '').trim() || null,
    customerPhone: String(body.customerPhone ?? body.phone ?? '').trim() || null,
    customerEmail: String(body.customerEmail ?? body.email ?? '').trim() || null,
    customerAddress: String(body.customerAddress ?? body.address ?? '').trim() || null,
    customerCity: String(body.customerCity ?? body.city ?? '').trim() || null,
    customerState: String(body.customerState ?? body.state ?? '').trim() || null,
    customerPincode: String(body.customerPincode ?? body.pincode ?? '').trim() || null,
    notes: String(body.notes ?? '').trim() || null,
    validUntil: body.validUntil ? String(body.validUntil) : null,
  }
}

/**
 * Mark a draft quotation as sent. Called after the quotation was actually
 * delivered (email / WhatsApp) so the lifecycle reflects reality.
 */
export async function markQuotationSent(quotationId: string): Promise<boolean> {
  if (!db) return false
  const [quote] = await db.select().from(s.quotations).where(eq(s.quotations.id, quotationId)).limit(1)
  if (!quote || quote.status !== 'draft') return false
  await db.update(s.quotations).set({ status: 'sent', updatedAt: new Date().toISOString() }).where(eq(s.quotations.id, quotationId))
  return true
}

export function registerQuotationRoutes(router: RouteRegistrar) {
  router.get('/quotations', requirePermission('sales', 'view'), async (req, res) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      // Keep the list honest: anything past its valid-until date reads expired.
      await expireStaleQuotations()
      const statusFilter = typeof req.query.status === 'string' && isQuotationStatus(req.query.status) ? req.query.status : null
      const where = statusFilter ? eq(s.quotations.status, statusFilter) : undefined

      // Honor page/limit so API pagination clients (list()) don't re-read the
      // same first page forever.
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1)
      const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '200'), 10) || 200))

      const [quotes, countRows] = await Promise.all([
        db
          .select()
          .from(s.quotations)
          .where(where)
          .orderBy(desc(s.quotations.date))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        db.select({ count: sql<number>`count(*)::int` }).from(s.quotations).where(where),
      ])
      const total = Number(countRows[0]?.count ?? 0)

      // Attach line items per quotation: the UI reads items straight off the
      // list rows (view dialog, printing, edit prefill), so an items-less row
      // renders/print the quotation with zero line items.
      const items =
        quotes.length > 0
          ? await db
              .select()
              .from(s.quotationItems)
              .where(inArray(s.quotationItems.quotationId, quotes.map((q) => q.id)))
              .orderBy(s.quotationItems.id)
          : []
      const itemsByQuote = new Map<string, typeof items>()
      for (const it of items) {
        const list = itemsByQuote.get(it.quotationId) ?? []
        list.push(it)
        itemsByQuote.set(it.quotationId, list)
      }

      res.json({
        page,
        pageSize,
        total,
        status: statusFilter ?? 'all',
        data: quotes.map((q) => ({ ...q, items: itemsByQuote.get(q.id) ?? [] })),
      })
    } catch {
      res.status(500).json({ error: 'Failed to list quotations' })
    }
  })

  router.get('/quotations/:id', requirePermission('sales', 'view'), async (req, res) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const [quote] = await db.select().from(s.quotations).where(eq(s.quotations.id, routeParam(req.params.id))).limit(1)
      if (!quote) { res.status(404).json({ error: 'Not found' }); return }
      await expireStaleQuotations()
      const items = await db.select().from(s.quotationItems).where(eq(s.quotationItems.quotationId, quote.id))
      res.json({ ...quote, items })
    } catch {
      res.status(500).json({ error: 'Failed to load quotation' })
    }
  })

  router.post('/quotations', requirePermission('sales', 'create'), async (req, res) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const items = await applyPieceRateInvoiceItems(normalizeQuotationItems(body.items), db)
      if (items.length === 0) { res.status(400).json({ error: 'At least one line item is required' }); return }
      const gstRate = num(body.gst, 3)
      const discount = num(body.discount, 0)
      const { subtotal, gstAmount, grandTotal } = computeTotals(items, gstRate, discount)
      const number = await nextQuotationNumber()
      const id = randomUUID()

      const row = await db.transaction(async (tx) => {
        const [created] = await tx.insert(s.quotations).values({
          id,
          number,
          ...sanitizeCustomer(body),
          subtotal,
          gst: gstRate,
          gstAmount,
          discount,
          grandTotal,
          status: 'draft',
          createdBy: (req as Request & { userId?: string }).userId ?? null,
        }).returning()
        for (const it of items) {
          await tx.insert(s.quotationItems).values({ ...it, id: randomUUID(), quotationId: id })
        }
        return created
      })
      res.status(201).json({ ...row, items })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      res.status(400).json({ error: msg.includes('unique') ? 'Quotation number clash, retry' : 'Failed to create quotation' })
    }
  })

  router.patch('/quotations/:id', requirePermission('sales', 'edit'), async (req, res) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const [existing] = await db.select().from(s.quotations).where(eq(s.quotations.id, routeParam(req.params.id))).limit(1)
      if (!existing) { res.status(404).json({ error: 'Not found' }); return }
      if (existing.convertedInvoice) { res.status(400).json({ error: 'Quotation already converted to an invoice' }); return }

      const clean = sanitizeCustomer(body)
      const items = await applyPieceRateInvoiceItems(normalizeQuotationItems(body.items), db)
      const gstRate = num(body.gst, num(existing.gst, 3))
      const discount = num(body.discount, num(existing.discount, 0))
      let totals = {
        subtotal: num(existing.subtotal, 0),
        gstAmount: num(existing.gstAmount, 0),
        grandTotal: num(existing.grandTotal, 0),
      }
      if (items.length > 0) totals = computeTotals(items, gstRate, discount)

      // Extending the validity of an expired quotation brings it back to draft.
      const nextValidUntil = body.validUntil ? String(body.validUntil) : (existing.validUntil ?? null)
      const revivedStatus =
        existing.status === 'expired' && nextValidUntil && new Date(nextValidUntil).getTime() > Date.now()
          ? 'draft'
          : undefined

      const [row] = await db.update(s.quotations).set({
        ...clean,
        gst: gstRate,
        discount,
        ...totals,
        ...(revivedStatus ? { status: revivedStatus } : {}),
        updatedAt: new Date().toISOString(),
      }).where(eq(s.quotations.id, routeParam(req.params.id))).returning()

      if (items.length > 0) {
        await db.delete(s.quotationItems).where(eq(s.quotationItems.quotationId, routeParam(req.params.id)))
        for (const it of items) {
          await db.insert(s.quotationItems).values({ ...it, id: randomUUID(), quotationId: routeParam(req.params.id) })
        }
      }
      const freshItems = await db.select().from(s.quotationItems).where(eq(s.quotationItems.quotationId, routeParam(req.params.id)))
      res.json({ ...row, items: freshItems })
    } catch {
      res.status(400).json({ error: 'Failed to update quotation' })
    }
  })

  router.delete('/quotations/:id', requirePermission('sales', 'delete'), async (req, res) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const [existing] = await db.select().from(s.quotations).where(eq(s.quotations.id, routeParam(req.params.id))).limit(1)
      if (!existing) { res.status(404).json({ error: 'Not found' }); return }
      await db.delete(s.quotationItems).where(eq(s.quotationItems.quotationId, routeParam(req.params.id)))
      await db.delete(s.quotations).where(eq(s.quotations.id, routeParam(req.params.id)))
      res.json({ ok: true, id: routeParam(req.params.id) })
    } catch {
      res.status(500).json({ error: 'Failed to delete quotation' })
    }
  })

  // ─── Lifecycle: move a quotation between draft / sent / approved / cancelled ──
  router.post('/quotations/:id/status', requirePermission('sales', 'edit'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const next = (req.body ?? {}).status
      if (!isQuotationStatus(next)) {
        res.status(400).json({ error: `status must be one of: ${QUOTATION_STATUSES.join(', ')}` })
        return
      }
      const [quote] = await db.select().from(s.quotations).where(eq(s.quotations.id, routeParam(req.params.id))).limit(1)
      if (!quote) { res.status(404).json({ error: 'Not found' }); return }
      if (quote.convertedInvoice) {
        res.status(400).json({ error: `Quotation already converted to ${quote.convertedInvoice}` })
        return
      }

      // Refresh expiry first so a stale quotation can't be revived by mistake.
      if (quotationIsExpired(quote) && quote.status !== 'expired') await expireStaleQuotations()
      const [fresh] = await db.select().from(s.quotations).where(eq(s.quotations.id, routeParam(req.params.id))).limit(1)
      const current = (fresh?.status ?? quote.status ?? 'draft') as QuotationStatus

      if (current === next) {
        res.json({ ok: true, unchanged: true, quotation: fresh })
        return
      }
      if (!STATUS_TRANSITIONS[current]?.includes(next)) {
        res.status(400).json({
          error: `Cannot change status from ${current} to ${next}. Allowed: ${STATUS_TRANSITIONS[current]?.join(', ') || 'none'}`,
        })
        return
      }
      // Reopening an expired quotation without extending it would expire it again.
      if (next === 'draft' && fresh && quotationIsExpired(fresh)) {
        res.status(400).json({ error: 'Extend the valid-until date before reopening this quotation' })
        return
      }

      const now = new Date().toISOString()
      const [updated] = await db
        .update(s.quotations)
        .set({ status: next, updatedAt: now })
        .where(eq(s.quotations.id, routeParam(req.params.id)))
        .returning()
      const actor = actorFromRequest(req)
      void recordActivity({
        action: `Quotation ${next === 'approved' ? 'Approved' : next.charAt(0).toUpperCase() + next.slice(1)}`,
        module: 'sales',
        entity: `Quotation ${quote.number}`,
        details: `${current} → ${next} · ₹${Number(quote.grandTotal ?? 0).toLocaleString('en-IN')} · ${quote.customer ?? 'walk-in'}`,
        userId: actor.userId,
        ip: actor.ip,
      })
      res.json({ ok: true, previousStatus: current, quotation: updated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: msg.includes('unique') ? 'Failed to update status' : msg })
    }
  })

  // ─── Send to customer ───────────────────────────────────────────────────────
  // Marks a draft as sent (once it has actually left the building) and records
  // it in the activity log.
  async function markSent(quotationId: string): Promise<void> {
    await markQuotationSent(quotationId)
  }

  router.post('/quotations/:id/email', requirePermission('sales', 'edit'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const { emailQuotationPDF } = await import('../quotationPdf')
      const [quote] = await db.select().from(s.quotations).where(eq(s.quotations.id, routeParam(req.params.id))).limit(1)
      if (!quote) { res.status(404).json({ error: 'Quotation not found' }); return }
      if (quote.status === 'cancelled') { res.status(400).json({ error: 'Quotation was cancelled' }); return }

      let recipient = typeof (req.body ?? {}).to === 'string' ? String((req.body as Record<string, unknown>).to).trim() : ''
      if (!recipient && quote.customerEmail) recipient = quote.customerEmail.trim()
      if (!recipient && quote.customer) {
        const [cust] = await db.select({ email: s.customers.email }).from(s.customers).where(eq(s.customers.name, quote.customer)).limit(1)
        if (cust?.email) recipient = cust.email.trim()
      }
      if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        res.status(400).json({ error: 'No valid email address. Add one to the quotation or pass "to" in the request.' })
        return
      }

      const sent = await emailQuotationPDF(quote.id, recipient)
      if (!sent) { res.status(500).json({ error: 'Failed to send email. Check server logs.' }); return }
      await markSent(quote.id)
      const actor = actorFromRequest(req)
      void recordActivity({
        action: 'Emailed Quotation',
        module: 'sales',
        entity: `Quotation ${quote.number}`,
        details: `Quotation emailed to ${recipient}`,
        userId: actor.userId,
        ip: actor.ip,
      })
      res.json({ ok: true, to: recipient, message: 'Quotation emailed successfully' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: msg })
    }
  })

  router.post('/quotations/:id/convert', requirePermission('sales', 'create'), async (req, res) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const [quote] = await db.select().from(s.quotations).where(eq(s.quotations.id, routeParam(req.params.id))).limit(1)
      if (!quote) { res.status(404).json({ error: 'Not found' }); return }
      if (quote.convertedInvoice) {
        res.status(400).json({ error: `Already converted to ${quote.convertedInvoice}` })
        return
      }
      if (quote.status === 'expired' || quotationIsExpired(quote)) {
        res.status(400).json({ error: 'Quotation has expired — extend its valid-until date before converting' })
        return
      }
      if (quote.status === 'cancelled') {
        res.status(400).json({ error: 'Quotation was cancelled' })
        return
      }
      const items = await db.select().from(s.quotationItems).where(eq(s.quotationItems.quotationId, quote.id))
      if (items.length === 0) { res.status(400).json({ error: 'Quotation has no line items' }); return }

      // Build invoice items (same shape as manual invoice items)
      const invoiceItems = await applyPieceRateInvoiceItems(
        items.map((it) => ({
          product: it.product ?? '',
          sku: it.sku ?? '',
          qty: it.qty ?? 1,
          weight: it.weight ?? 0,
          silverRate: it.silverRate ?? 0,
          makingCharge: it.makingCharge ?? 0,
          tax: 0,
          amount: it.amount ?? 0,
        })),
        db,
      )

      // Reuse the manual invoice numbering + creation logic by inserting directly
      const { default: crypto } = await import('node:crypto')
      const [settingsRow] = await db.select().from(s.settings).where(eq(s.settings.id, 'app')).limit(1)
      const gstRate = num(quote.gst, Number(settingsRow?.gstRate ?? 3))
      const prefix = settingsRow?.invoicePrefix?.trim() || 'INV-'
      const now = new Date()
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
      let invoiceNumber = ''
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = `${prefix}${stamp}${Math.floor(1000 + Math.random() * 9000)}`
        const [clash] = await db.select({ id: s.salesInvoices.id }).from(s.salesInvoices).where(eq(s.salesInvoices.number, candidate)).limit(1)
        if (!clash) { invoiceNumber = candidate; break }
      }
      if (!invoiceNumber) { res.status(500).json({ error: 'Could not generate invoice number' }); return }

      const subtotal = round2(invoiceItems.reduce((a, it) => a + (it.amount ?? 0), 0))
      const gstAmount = round2((subtotal * gstRate) / 100)
      const discount = num(quote.discount, 0)
      const grandTotal = round2(subtotal + gstAmount - discount)

      const invoiceId = crypto.randomUUID()
      await db.transaction(async (tx) => {
        // Validate the full basket before writing the invoice: an over-request
        // aborts here, so the quotation stays unconverted and no stock moves.
        await assertStockAvailable(
          tx,
          invoiceItems.map((it) => ({ sku: String(it.sku ?? ''), qty: Number(it.qty ?? 0), name: String(it.product ?? '') })),
        )
        await tx.insert(s.salesInvoices).values({
          id: invoiceId,
          number: invoiceNumber,
          customer: quote.customer,
          customerEmail: quote.customerEmail ?? '',
          customerPhone: quote.customerPhone ?? '',
          customerAddress: quote.customerAddress ?? '',
          customerCity: quote.customerCity ?? '',
          customerState: quote.customerState ?? '',
          customerPincode: quote.customerPincode ?? '',
          silverValue: round2(invoiceItems.reduce((a, it) => a + (it.weight ?? 0) * (it.silverRate ?? 0), 0)),
          makingCharge: round2(invoiceItems.reduce((a, it) => a + (it.makingCharge ?? 0), 0)),
          subtotal,
          gst: gstRate,
          gstAmount,
          discount,
          grandTotal,
          paymentMethod: 'Pending',
          paymentStatus: 'pending',
          status: 'issued',
          date: new Date().toISOString(),
        })
        for (const it of invoiceItems) {
          await tx.insert(s.salesInvoiceItems).values({ ...it, id: crypto.randomUUID(), invoiceId })
          // Deduct stock through the ledger, same as manual invoices — a raw
          // column write left availability and the audit trail behind.
          const sku = String(it.sku ?? '')
          const qty = Number(it.qty ?? 0)
          if (sku && qty) {
            await applyStockMovement({
              sku,
              qty: -Math.abs(Math.floor(qty)),
              type: 'sale_out',
              refType: 'invoice',
              refId: invoiceId,
              tx,
            })
          }
        }
        await tx.update(s.quotations).set({
          status: 'converted',
          convertedInvoice: invoiceNumber,
          convertedAt: new Date().toISOString(),
        }).where(eq(s.quotations.id, quote.id))
      })

      res.status(201).json({ ok: true, invoiceNumber, invoiceId })
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        res.status(409).json({
          error: 'Insufficient Stock',
          code: 'INSUFFICIENT_STOCK',
          message: err.message,
          products: err.products,
        })
        return
      }
      res.status(500).json({ error: 'Failed to convert quotation' })
    }
  })

  // Convert an approved quotation into a confirmed local sales order — for
  // pre-orders and made-to-order production where fulfilment (and invoicing)
  // happens later on the order. No stock movement here; stock is only
  // deducted when the order is invoiced or a Shopify draft is fulfilled.
  router.post('/quotations/:id/convert-order', requirePermission('sales', 'create'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const [quote] = await db.select().from(s.quotations).where(eq(s.quotations.id, routeParam(req.params.id))).limit(1)
      if (!quote) { res.status(404).json({ error: 'Not found' }); return }
      if (quote.convertedInvoice) {
        res.status(400).json({ error: `Already converted to ${quote.convertedInvoice}` })
        return
      }
      if (quote.status === 'expired' || quotationIsExpired(quote)) {
        res.status(400).json({ error: 'Quotation has expired — extend its valid-until date before converting' })
        return
      }
      if (quote.status === 'cancelled') {
        res.status(400).json({ error: 'Quotation was cancelled' })
        return
      }
      const items = await db.select().from(s.quotationItems).where(eq(s.quotationItems.quotationId, quote.id))
      if (items.length === 0) { res.status(400).json({ error: 'Quotation has no line items' }); return }

      const lineItems = items.map((it) => {
        const qty = Math.max(1, Number(it.qty ?? 1))
        return {
          title: it.product ?? '',
          sku: it.sku ?? '',
          quantity: Math.max(0, Number(it.qty ?? 0)),
          price: round2(Number(it.amount ?? 0) / qty),
        }
      })

      const now = new Date()
      const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
      let internalId = ''
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = `SO${ym}-${Math.floor(100000 + Math.random() * 900000)}`
        const [clash] = await db.select({ id: s.salesOrders.id }).from(s.salesOrders).where(eq(s.salesOrders.internalId, candidate)).limit(1)
        if (!clash) { internalId = candidate; break }
      }
      if (!internalId) { res.status(500).json({ error: 'Could not generate order number' }); return }

      const discount = num(quote.discount, 0)
      const value = round2(quote.grandTotal ?? items.reduce((a, it) => a + Number(it.amount ?? 0), 0))
      const orderId = randomUUID()

      await db.transaction(async (tx) => {
        await tx.insert(s.salesOrders).values({
          id: orderId,
          internalId,
          customer: quote.customer,
          customerEmail: quote.customerEmail ?? undefined,
          customerPhone: quote.customerPhone ?? undefined,
          value,
          payment: 'pending',
          fulfillment: 'pending',
          status: 'confirmed',
          date: now.toISOString(),
          items: lineItems.reduce((a, it) => a + it.quantity, 0),
          tags: `from-quotation:${quote.number}`,
          currency: 'INR',
          discount,
          lineItems,
          // sales_orders carries addresses as jsonb, not flattened columns.
          shippingAddress: (quote.customerAddress || quote.customerCity || quote.customerState || quote.customerPincode)
            ? {
                address1: quote.customerAddress ?? '',
                city: quote.customerCity ?? '',
                province: quote.customerState ?? '',
                zip: quote.customerPincode ?? '',
                phone: quote.customerPhone ?? '',
              }
            : undefined,
        })
        await tx.update(s.quotations).set({
          status: 'converted',
          convertedInvoice: internalId,
          convertedAt: now.toISOString(),
        }).where(eq(s.quotations.id, quote.id))
      })

      res.status(201).json({ ok: true, orderNumber: internalId, orderId })
    } catch {
      res.status(500).json({ error: 'Failed to convert quotation to order' })
    }
  })
}
