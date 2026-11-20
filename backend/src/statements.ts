import PDFDocument from 'pdfkit'
import { and, asc, ne, sql } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { logger } from './logger'
import { collectedByInvoice, INVOICE_OUTSTANDING_SQL, invoiceCollected } from './outstanding'

export interface CustomerDue {
  customer: string
  invoiceCount: number
  total: number
  oldestDate: string | null
  invoiceNumbers: string[]
}

/**
 * Collect all unpaid (non-cancelled/refunded) invoices grouped by customer.
 *
 * `total` is what is actually still owed (Phase 5.2): per invoice,
 * grandTotal − collected — a booking advance credited at conversion and any
 * earlier partial payment reduce it, so the Dues page, its pay dialog's
 * pre-fill, the reminder emails and the dues statement all quote the SAME
 * number the payment endpoint will accept.
 */
export async function collectDues(): Promise<CustomerDue[]> {
  if (!db) return []
  const rows = await db
    .select({
      customer: schema.salesInvoices.customer,
      invoiceCount: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${INVOICE_OUTSTANDING_SQL}), 0)::float`,
      oldestDate: sql<string | null>`min(${schema.salesInvoices.date})::text`,
    })
    .from(schema.salesInvoices)
    .where(
      and(
        ne(schema.salesInvoices.paymentStatus, 'paid'),
        sql`${schema.salesInvoices.status} is distinct from 'cancelled'`,
        sql`${schema.salesInvoices.status} is distinct from 'refunded'`,
      ),
    )
    .groupBy(schema.salesInvoices.customer)
    .orderBy(sql`coalesce(sum(${INVOICE_OUTSTANDING_SQL}), 0) desc`)

  const withInvoices = await db
    .select({
      customer: schema.salesInvoices.customer,
      number: schema.salesInvoices.number,
      date: schema.salesInvoices.date,
    })
    .from(schema.salesInvoices)
    .where(
      and(
        ne(schema.salesInvoices.paymentStatus, 'paid'),
        sql`${schema.salesInvoices.status} is distinct from 'cancelled'`,
        sql`${schema.salesInvoices.status} is distinct from 'refunded'`,
      ),
    )
    .orderBy(asc(schema.salesInvoices.date))

  const numbersByCustomer = new Map<string, string[]>()
  for (const r of withInvoices) {
    const key = r.customer ?? 'Unknown'
    const list = numbersByCustomer.get(key) ?? []
    list.push(r.number)
    numbersByCustomer.set(key, list)
  }

  return rows
    .map((r) => ({
      customer: r.customer ?? 'Unknown',
      invoiceCount: Number(r.invoiceCount ?? 0),
      total: Number(r.total ?? 0),
      oldestDate: r.oldestDate ?? null,
      invoiceNumbers: numbersByCustomer.get(r.customer ?? 'Unknown') ?? [],
    }))
    // A customer whose open invoices are already fully collected (flag not
    // yet flipped) owes nothing — never show ₹0 rows on the Dues page.
    .filter((r) => r.total > 0)
}

export interface DuesStatement {
  buffer: Buffer
  totalDue: number
  customerCount: number
}

/** All invoices (paid + unpaid) for one customer, newest first — for account statements. */
export async function collectCustomerInvoices(customer: string) {
  if (!db) return []
  return db
    .select()
    .from(schema.salesInvoices)
    .where(sql`${schema.salesInvoices.customer} = ${customer}`)
    .orderBy(sql`${schema.salesInvoices.date} desc`)
}

export interface CustomerStatement {
  buffer: Buffer
  invoiceCount: number
  totalBilled: number
  totalPaid: number
  outstanding: number
}

/** Render an A4 account statement for one customer: every invoice + running balance. */
export async function generateCustomerStatementPDF(customer: string): Promise<CustomerStatement | null> {
  try {
    const invoices = await collectCustomerInvoices(customer)
    if (invoices.length === 0) return null

    const money = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#111827').text('Account Statement')
    doc.moveDown(0.2)
    doc.fontSize(13).font('Helvetica').fillColor('#374151').text(customer)
    doc.fontSize(10).fillColor('#6b7280').text(
      'Generated ' + new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) + '  ·  Opal Line ERP',
    )
    doc.moveDown(1)

    const drawHeader = (y: number) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280')
      doc.text('INVOICE', 50, y)
      doc.text('DATE', 160, y)
      doc.text('STATUS', 250, y)
      doc.text('AMOUNT', 470, y, { width: 75, align: 'right' })
      doc.moveTo(50, y + 14).lineTo(545, y + 14).lineWidth(0.75).strokeColor('#d1d5db').stroke()
    }

    let y = doc.y + 6
    drawHeader(y)
    y += 22
    let totalBilled = 0
    let totalPaid = 0
    // What payments have actually collected per invoice (Phase 5.2) — a
    // partially paid invoice or one carrying a booking advance contributes
    // its collected amount here, not nothing (and not its gross twice).
    const paidByInvoice = await collectedByInvoice()

    for (const inv of invoices) {
      if (y > 770) {
        doc.addPage()
        y = 60
        drawHeader(y)
        y += 22
      }
      const amount = Number(inv.grandTotal ?? 0)
      const paid = inv.paymentStatus === 'paid'
      const refunded = inv.status === 'refunded' || inv.status === 'cancelled'
      if (!refunded) {
        totalBilled += amount
        totalPaid += invoiceCollected(inv, paidByInvoice)
      }
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text(inv.number, 50, y)
      doc.font('Helvetica').fontSize(9).fillColor('#374151')
      doc.text(inv.date ? new Date(inv.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—', 160, y)
      doc.fillColor(paid ? '#16a34a' : refunded ? '#9ca3af' : '#b91c1c').text(refunded ? inv.status ?? '—' : paid ? 'PAID' : inv.paymentStatus ?? 'due', 250, y)
      doc.fillColor('#111827').font('Helvetica-Bold').text(money(amount), 470, y, { width: 75, align: 'right' })
      y += 18
    }

    const outstanding = Math.round((totalBilled - totalPaid) * 100) / 100
    if (y + 50 > 800) {
      doc.addPage()
      y = 60
    }
    doc.moveTo(50, y + 4).lineTo(545, y + 4).lineWidth(0.75).strokeColor('#9ca3af').stroke()
    doc.font('Helvetica').fontSize(9).fillColor('#6b7280')
    doc.text('Total billed', 350, y + 12)
    doc.text('Total paid', 350, y + 26)
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827')
    doc.text(money(totalBilled), 470, y + 12, { width: 75, align: 'right' })
    doc.text(money(totalPaid), 470, y + 26, { width: 75, align: 'right' })
    doc.font('Helvetica-Bold').fontSize(11).fillColor(outstanding > 0 ? '#b91c1c' : '#16a34a')
    doc.text(outstanding > 0 ? 'OUTSTANDING ' + money(outstanding) : 'FULLY SETTLED', 350, y + 44)

    doc.end()
    const buffer = await done
    return { buffer, invoiceCount: invoices.length, totalBilled, totalPaid, outstanding }
  } catch (err) {
    logger.error({ err }, 'Customer statement PDF generation failed')
    return null
  }
}

/** Render a clean A4 PDF statement of all outstanding dues, grouped by customer. */
export async function generateDuesStatementPDF(): Promise<DuesStatement | null> {
  try {
    const dues = await collectDues()
    if (dues.length === 0) return null

    const totalDue = dues.reduce((a, d) => a + d.total, 0)
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

    const money = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    // Header
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#111827').text('Outstanding Dues Statement')
    doc.moveDown(0.2)
    doc.fontSize(10).font('Helvetica').fillColor('#6b7280').text(
      'Generated ' + new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) + '  ·  Opal Line ERP',
    )
    doc.moveDown(0.8)

    // Summary box
    doc.roundedRect(50, doc.y, 495, 46, 6).fill('#eef2ff')
    const summaryY = doc.y
    doc.fillColor('#312e81').font('Helvetica-Bold').fontSize(13).text(money(totalDue), 66, summaryY + 15)
    doc.font('Helvetica').fontSize(9).fillColor('#4f46e5').text('Total outstanding', 66, summaryY + 33)
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#312e81').text(String(dues.length), 260, summaryY + 15)
    doc.font('Helvetica').fontSize(9).fillColor('#4f46e5').text('Customers with dues', 260, summaryY + 33)
    doc.y = summaryY + 62

    doc.moveDown(1)

    // Table header
    const colX = { customer: 50, invoices: 300, oldest: 400, amount: 475 }
    const drawHeader = (y: number) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280')
      doc.text('CUSTOMER', colX.customer, y)
      doc.text('INVOICES', colX.invoices, y)
      doc.text('OLDEST', colX.oldest, y)
      doc.text('OUTSTANDING', colX.amount, y, { width: 70, align: 'right' })
      doc.moveTo(50, y + 14).lineTo(545, y + 14).lineWidth(0.75).strokeColor('#d1d5db').stroke()
    }

    let y = doc.y + 6
    drawHeader(y)
    y += 22

    for (const d of dues) {
      const blockHeight = 30 + Math.min(d.invoiceNumbers.length, 3) * 11
      if (y + blockHeight > 780) {
        doc.addPage()
        y = 60
        drawHeader(y)
        y += 22
      }
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(d.customer, colX.customer, y, { width: 235 })
      doc.font('Helvetica').fontSize(9).fillColor('#374151')
      doc.text(String(d.invoiceCount), colX.invoices, y)
      const oldest = d.oldestDate ? new Date(d.oldestDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'
      doc.text(oldest, colX.oldest, y)
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#b91c1c').text(money(d.total), colX.amount, y, { width: 70, align: 'right' })
      y += 15
      // Invoice numbers (up to 3, then "…")
      doc.font('Helvetica').fontSize(8).fillColor('#9ca3af')
      const shown = d.invoiceNumbers.slice(0, 3).join(', ') + (d.invoiceNumbers.length > 3 ? `, +${d.invoiceNumbers.length - 3} more` : '')
      doc.text(shown, colX.customer + 12, y, { width: 340 })
      y += 18
      doc.moveTo(50, y).lineTo(545, y).lineWidth(0.4).strokeColor('#f3f4f6').stroke()
      y += 6
    }

    // Footer total
    if (y + 24 > 800) {
      doc.addPage()
      y = 60
    }
    doc.moveTo(50, y).lineTo(545, y).lineWidth(0.75).strokeColor('#9ca3af').stroke()
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('TOTAL DUE', 380, y + 8)
    doc.fillColor('#b91c1c').text(money(totalDue), colX.amount, y + 8, { width: 70, align: 'right' })

    doc.end()
    const buffer = await done
    return { buffer, totalDue, customerCount: dues.length }
  } catch (err) {
    logger.error({ err }, 'Dues statement PDF generation failed')
    return null
  }
}
