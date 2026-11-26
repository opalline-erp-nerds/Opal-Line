import { Router, type Request, type Response } from 'express'
import { eq } from 'drizzle-orm'
import type { Express } from 'express'
import { requireAuth } from '../sessions'
import { db } from '../db/client'
import * as s from '../db/schema'
import { requirePermission } from '../rbac'
import { sendWhatsAppMessage, isWhatsAppConfigured } from '../whatsapp'
import { logger } from '../logger'
import { routeParam } from '../lib/routeParams'
import { formatIstDate } from '../istDate'

/**
 * POST /api/v1/whatsapp/invoice/:id
 * Sends the invoice summary to the customer's WhatsApp number using the
 * configured WhatsApp Business API credentials. Falls back gracefully
 * when WhatsApp isn't configured yet.
 */
export function registerWhatsappInvoiceRoutes(app: Express) {
  const router = Router()

  router.post('/invoice/:id', requireAuth, requirePermission('sales', 'edit'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ ok: false, error: 'Database unavailable' }); return }
    try {
      const [invoice] = await db.select().from(s.salesInvoices).where(eq(s.salesInvoices.id, routeParam(req.params.id))).limit(1)
      if (!invoice) { res.status(404).json({ ok: false, error: 'Invoice not found' }); return }
      if (!isWhatsAppConfigured()) {
        res.json({ ok: false, error: 'WhatsApp not configured — add WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID in Connections → Configuration' })
        return
      }
      const digits = (invoice.customerPhone ?? '').replace(/\D/g, '')
      const to = digits.length === 10 ? `91${digits}` : digits
      if (!to) { res.json({ ok: false, error: 'Invoice has no customer phone number' }); return }

      const items = await db.select().from(s.salesInvoiceItems).where(eq(s.salesInvoiceItems.invoiceId, invoice.id))
      const lines = items
        .slice(0, 8)
        .map((it) => `• ${it.product || it.sku} × ${it.qty} — ₹${Number(it.amount ?? 0).toLocaleString('en-IN')}`)
        .join('\n')
      const more = items.length > 8 ? `\n…and ${items.length - 8} more item(s)` : ''
      const message =
        `🧾 *Invoice ${invoice.number}*\n` +
        `Customer: ${invoice.customer}\n\n` +
        `${lines}${more}\n\n` +
        `Subtotal: ₹${Number(invoice.subtotal ?? 0).toLocaleString('en-IN')}\n` +
        `GST: ₹${Number(invoice.gstAmount ?? 0).toLocaleString('en-IN')}\n` +
        `*Total: ₹${Number(invoice.grandTotal ?? 0).toLocaleString('en-IN')}*\n` +
        `Payment status: ${invoice.paymentStatus ?? 'pending'}\n\n` +
        `Thank you for shopping with us! ✨`

      const result = await sendWhatsAppMessage(to, message)
      if (!result) { res.json({ ok: false, error: 'WhatsApp send failed (check credentials/logs)' }); return }
      logger.info({ invoice: invoice.number, to }, 'Invoice sent via WhatsApp')
      res.json({ ok: true, to, messageId: result.messageId })
    } catch (err) {
      logger.error({ err }, 'WhatsApp invoice send failed')
      res.status(500).json({ ok: false, error: 'Failed to send WhatsApp message' })
    }
  })

  /**
   * POST /api/v1/whatsapp/quotation/:id
   * Sends the quotation summary to the customer's WhatsApp number. A draft that
   * goes out this way is marked `sent` so the lifecycle stays truthful.
   */
  router.post('/quotation/:id', requireAuth, requirePermission('sales', 'edit'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ ok: false, error: 'Database unavailable' }); return }
    try {
      const { markQuotationSent } = await import('./quotations')
      const [quote] = await db.select().from(s.quotations).where(eq(s.quotations.id, routeParam(req.params.id))).limit(1)
      if (!quote) { res.status(404).json({ ok: false, error: 'Quotation not found' }); return }
      if (quote.status === 'cancelled') { res.status(400).json({ ok: false, error: 'Quotation was cancelled' }); return }
      if (!isWhatsAppConfigured()) {
        res.json({ ok: false, error: 'WhatsApp not configured — add WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID in Connections → Configuration' })
        return
      }
      const digits = (quote.customerPhone ?? '').replace(/\D/g, '')
      const to = digits.length === 10 ? `91${digits}` : digits
      if (!to) { res.json({ ok: false, error: 'Quotation has no customer phone number' }); return }

      const items = await db.select().from(s.quotationItems).where(eq(s.quotationItems.quotationId, quote.id))
      const lines = items
        .slice(0, 8)
        .map((it) => `• ${it.product || it.sku} × ${it.qty} — ₹${Number(it.amount ?? 0).toLocaleString('en-IN')}`)
        .join('\n')
      const more = items.length > 8 ? `\n…and ${items.length - 8} more item(s)` : ''
      const validity = quote.validUntil
        ? formatIstDate(quote.validUntil)
        : 'the date agreed with you'
      const message =
        `\uD83D\uDCCB *Quotation ${quote.number}*\n` +
        `Hello ${quote.customer || 'there'},\n\n` +
        `${lines}${more}\n\n` +
        `Total: *₹${Number(quote.grandTotal ?? 0).toLocaleString('en-IN')}*\n` +
        `Valid until: ${validity}\n\n` +
        `Prices are based on the silver rate on the day of billing. Please let us know to proceed. ✨`

      const result = await sendWhatsAppMessage(to, message)
      if (!result) { res.json({ ok: false, error: 'WhatsApp send failed (check credentials/logs)' }); return }
      const becameSent = await markQuotationSent(quote.id)
      logger.info({ quotation: quote.number, to }, 'Quotation sent via WhatsApp')
      res.json({ ok: true, to, messageId: result.messageId, markedSent: becameSent })
    } catch (err) {
      logger.error({ err }, 'WhatsApp quotation send failed')
      res.status(500).json({ ok: false, error: 'Failed to send WhatsApp message' })
    }
  })

  app.use('/api/v1/whatsapp', router)
}
