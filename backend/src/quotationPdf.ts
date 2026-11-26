import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { getRawClient } from './db/client'
import { logger } from './logger'
import { escapeHtml } from './htmlEscape'
import { formatIstDate } from './istDate'

export interface QuotationItem {
  name: string
  sku: string
  qty: number
  weight: number
  silverRate: number
  makingCharge: number
  amount: number
}

export interface QuotationPdfData {
  id: string
  number: string
  date: string
  validUntil: string
  customerName: string
  customerPhone: string
  customerEmail: string
  customerCity: string
  items: QuotationItem[]
  subtotal: number
  gstRate: number
  gstAmount: number
  discount: number
  grandTotal: number
  amountInWords: string
  notes: string | null
  businessName: string
  businessAddress: string
  businessGstin: string
  businessPhone: string
  businessEmail: string
  upiId: string
}

const COLORS = {
  primary: '#1a1a2e',
  accent: '#c8a951',
  border: '#d1d5db',
  lightBg: '#f8f9fa',
  headerBg: '#1a1a2e',
  headerText: '#ffffff',
  text: '#1f2937',
  muted: '#6b7280',
  divider: '#e5e7eb',
}

export function numberToIndianWords(num: number): string {
  if (num === 0) return 'Zero'
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

  function convert(n: number): string {
    if (n < 20) return ones[n]
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '')
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + convert(n % 100) : '')
    if (n < 100000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + convert(n % 1000) : '')
    if (n < 10000000) return convert(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + convert(n % 100000) : '')
    return convert(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + convert(n % 10000000) : '')
  }

  const rupees = Math.floor(num)
  const paise = Math.round((num - rupees) * 100)
  let result = convert(rupees) + ' Rupees'
  if (paise > 0) result += ' and ' + convert(paise) + ' Paise'
  result += ' Only'
  return result
}

export function formatCurrency(amount: number): string {
  return '\u20B9' + amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function drawRoundedRect(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, r: number, fill: string) {
  doc.save()
  doc.roundedRect(x, y, w, h, r).fill(fill)
  doc.restore()
}

export async function generateQuotationPDF(quotationId: string): Promise<Buffer | null> {
  const client = getRawClient()
  if (!client) return null

  try {
    const quotations = await client.unsafe(`SELECT * FROM quotations WHERE id = $1`, [quotationId])
    if (quotations.length === 0) return null
    const quote = quotations[0] as any

    const items = await client.unsafe(`SELECT * FROM quotation_items WHERE quotation_id = $1`, [quotationId])
    const [settings] = await client.unsafe(`SELECT * FROM settings LIMIT 1`) as any[]

    // Quotation print/email dates follow the same IST clock as invoice PDFs.
    const fmtDate = (d: unknown) =>
      d ? formatIstDate(d as string | number | Date) : '—'

    const itemData: QuotationItem[] = items.map((item: any) => ({
      name: item.product || 'Item',
      sku: item.sku || '',
      qty: Number(item.qty || 1),
      weight: Number(item.weight || 0),
      silverRate: Number(item.silver_rate || 0),
      makingCharge: Number(item.making_charge || 0),
      amount: Number(item.amount || 0),
    }))

    const validUntil = quote.valid_until
      ? fmtDate(quote.valid_until)
      : (() => {
          const d = new Date(quote.date || Date.now())
          d.setDate(d.getDate() + 15)
          return fmtDate(d)
        })()

    const data: QuotationPdfData = {
      id: quote.id,
      number: quote.number || quote.id,
      date: fmtDate(quote.date),
      validUntil,
      customerName: quote.customer || 'Walk-in Customer',
      customerPhone: quote.customer_phone || '',
      customerEmail: quote.customer_email || '',
      customerCity: quote.customer_city || '',
      items: itemData,
      subtotal: Number(quote.subtotal || 0),
      gstRate: Number(quote.gst || 3),
      gstAmount: Number(quote.gst_amount || 0),
      discount: Number(quote.discount || 0),
      grandTotal: Number(quote.grand_total || 0),
      amountInWords: numberToIndianWords(Number(quote.grand_total || 0)),
      notes: quote.notes || null,
      businessName: settings?.business_name || 'Opal Line Jewels LLP',
      businessAddress: settings?.address || 'Shop 4, Nariman Point, Mumbai - 400021',
      businessGstin: settings?.gstin || '27AAACO1234F1Z5',
      businessPhone: settings?.phone || '+91 98200 00000',
      businessEmail: settings?.email || 'hello@opalline.in',
      upiId: settings?.upi_id || '',
    }

    return createQuotationPDFBuffer(data)
  } catch (err) {
    logger.error({ err, quotationId }, 'Quotation PDF generation failed')
    return null
  }
}

/** Email a quotation to the customer with the PDF attached. */
export async function emailQuotationPDF(quotationId: string, recipientEmail: string): Promise<boolean> {
  const { sendEmail } = await import('./notifications')
  const pdfBuffer = await generateQuotationPDF(quotationId)
  if (!pdfBuffer) return false

  const client = getRawClient()
  if (!client) return false
  const [row] = await client.unsafe(`SELECT number, grand_total, customer, valid_until FROM quotations WHERE id = $1`, [
    quotationId,
  ]) as any[]
  const number = row?.number || quotationId
  const customer = row?.customer || 'Customer'
  const total = Number(row?.grand_total || 0)
  const validUntil = row?.valid_until
    ? formatIstDate(row.valid_until)
    : 'the date agreed with you'

  return sendEmail({
    to: recipientEmail,
    subject: `Quotation ${number} — Opal Line`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1a1a2e;">\uD83D\uDCCE Quotation ${escapeHtml(number)}</h2>
        <p>Dear ${escapeHtml(customer)},</p>
        <p>Thank you for your interest. Please find our quotation attached — the quoted total is
           <strong>\u20B9${total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong> and it is valid until
           <strong>${escapeHtml(validUntil)}</strong>.</p>
        <p>Prices are based on the silver rate on the day of billing. If you would like to proceed, simply reply to
           this email or visit the store.</p>
        <p style="color: #999; font-size: 12px;">Opal Line ERP — Quotation</p>
      </div>
    `,
    attachments: [{ filename: `${number}.pdf`, content: pdfBuffer }],
  })
}

export async function createQuotationPDFBuffer(data: QuotationPdfData): Promise<Buffer> {
  let upiQrBuffer: Buffer | null = null
  if (data.upiId) {
    const merchantName = data.businessName.replace(/\s+/g, '+')
    const upiString = `upi://pay?pa=${encodeURIComponent(data.upiId)}&pn=${encodeURIComponent(merchantName)}&am=${data.grandTotal}&cu=INR`
    try {
      const qrDataUrl = await QRCode.toDataURL(upiString, {
        width: 120,
        margin: 1,
        color: { dark: '#1a1a2e', light: '#ffffff' },
      })
      const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '')
      upiQrBuffer = Buffer.from(base64Data, 'base64')
    } catch {
      // Will fall back to text rendering
    }
  }

  return new Promise((resolve) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 35, bottom: 35, left: 40, right: 40 },
      info: {
        Title: `Quotation ${data.number}`,
        Author: data.businessName,
        Subject: 'Quotation',
      },
    })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const pageW = 595.28
    const left = 40
    const right = pageW - 40
    const contentW = right - left

    // ══════════════════════════════════════════════════════════════
    // HEADER — Company logo area + business name
    // ══════════════════════════════════════════════════════════════
    drawRoundedRect(doc, left, 30, contentW, 52, 4, COLORS.headerBg)
    doc.fontSize(20).font('Helvetica-Bold').fillColor(COLORS.headerText)
      .text(data.businessName, left + 16, 38, { width: contentW - 32 })
    doc.fontSize(8).font('Helvetica').fillColor('#a0aec0')
      .text(data.businessAddress, left + 16, 58, { width: contentW - 32 })
    doc.fontSize(7.5).fillColor('#a0aec0')
      .text(`GSTIN: ${data.businessGstin}  |  Ph: ${data.businessPhone}  |  ${data.businessEmail}`, left + 16, 68, { width: contentW - 32 })

    doc.y = 90

    // ══════════════════════════════════════════════════════════════
    // QUOTATION badge + details
    // ══════════════════════════════════════════════════════════════
    drawRoundedRect(doc, right - 120, 88, 120, 22, 3, COLORS.accent)
    doc.fontSize(10).font('Helvetica-Bold').fillColor(COLORS.primary)
      .text('QUOTATION', right - 120, 92, { width: 120, align: 'center' })

    doc.fontSize(9).font('Helvetica').fillColor(COLORS.text)
    const infoY = 118
    doc.font('Helvetica-Bold').text('Quote No:', left, infoY)
    doc.font('Helvetica').text(` ${data.number}`, left + 60, infoY)
    doc.font('Helvetica-Bold').text('Date:', left + 220, infoY)
    doc.font('Helvetica').text(` ${data.date}`, left + 245, infoY)

    doc.font('Helvetica-Bold').text('Valid Until:', left, infoY + 14)
    doc.font('Helvetica').text(` ${data.validUntil}`, left + 68, infoY + 14)

    doc.y = infoY + 34

    // ══════════════════════════════════════════════════════════════
    // BILL TO
    // ══════════════════════════════════════════════════════════════
    const billY = doc.y
    drawRoundedRect(doc, left, billY, contentW, 44, 3, COLORS.lightBg)

    doc.fontSize(7).font('Helvetica-Bold').fillColor(COLORS.muted)
      .text('PREPARED FOR', left + 10, billY + 6)
    doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.text)
      .text(data.customerName, left + 10, billY + 18, { width: 200 })
    doc.fontSize(8).font('Helvetica').fillColor(COLORS.muted)
    let custLine = ''
    if (data.customerPhone) custLine += data.customerPhone
    if (data.customerCity) custLine += (custLine ? '  |  ' : '') + data.customerCity
    if (custLine) doc.text(custLine, left + 10, billY + 32, { width: 200 })

    doc.y = billY + 52

    // ══════════════════════════════════════════════════════════════
    // ITEMS TABLE
    // ══════════════════════════════════════════════════════════════
    doc.y += 4
    const tableTop = doc.y

    drawRoundedRect(doc, left, tableTop, contentW, 18, 2, COLORS.headerBg)
    const cols = [
      { label: 'Description', x: left + 6, w: 160, align: 'left' as const },
      { label: 'Qty', x: left + 170, w: 35, align: 'center' as const },
      { label: 'Weight (g)', x: left + 210, w: 60, align: 'right' as const },
      { label: 'Rate (\u20B9/g)', x: left + 275, w: 65, align: 'right' as const },
      { label: 'Making (\u20B9)', x: left + 345, w: 65, align: 'right' as const },
      { label: 'Amount (\u20B9)', x: left + 416, w: 80, align: 'right' as const },
    ]

    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(COLORS.headerText)
    for (const col of cols) {
      doc.text(col.label, col.x, tableTop + 5, { width: col.w, align: col.align })
    }

    doc.y = tableTop + 22

    doc.font('Helvetica').fontSize(8).fillColor(COLORS.text)
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i]
      const rowY = doc.y

      if (i % 2 === 0) {
        doc.save()
        doc.rect(left, rowY - 2, contentW, 16).fill(COLORS.lightBg)
        doc.restore()
      }

      doc.fillColor(COLORS.text)
      doc.text(item.name, cols[0].x, rowY, { width: cols[0].w, align: cols[0].align })
      if (item.sku) {
        doc.fontSize(6.5).fillColor(COLORS.muted).text(`SKU: ${item.sku}`, cols[0].x + 2, rowY + 10, { width: cols[0].w, align: 'left' })
        doc.fontSize(8).fillColor(COLORS.text)
      }
      doc.text(String(item.qty), cols[1].x, rowY, { width: cols[1].w, align: cols[1].align })
      doc.text(item.weight.toFixed(2), cols[2].x, rowY, { width: cols[2].w, align: cols[2].align })
      doc.text(formatCurrency(item.silverRate), cols[3].x, rowY, { width: cols[3].w, align: cols[3].align })
      doc.text(formatCurrency(item.makingCharge), cols[4].x, rowY, { width: cols[4].w, align: cols[4].align })
      doc.font('Helvetica-Bold').text(formatCurrency(item.amount), cols[5].x, rowY, { width: cols[5].w, align: cols[5].align })
      doc.font('Helvetica')

      doc.y = rowY + 16
    }

    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).stroke(COLORS.border).restore()
    doc.y += 8

    // ══════════════════════════════════════════════════════════════
    // TOTALS
    // ══════════════════════════════════════════════════════════════
    const totalsX = left + 300
    const totalsW = contentW - 300
    const totalsY = doc.y
    const boxH = data.discount > 0 ? 80 : 66
    drawRoundedRect(doc, totalsX, totalsY, totalsW, boxH, 3, COLORS.lightBg)

    const labelX = totalsX + 10
    const valX = totalsX + totalsW - 10
    let ty = totalsY + 8

    doc.fontSize(8).font('Helvetica').fillColor(COLORS.text)
    doc.text('Taxable Value', labelX, ty, { width: 140 }); doc.text(formatCurrency(data.subtotal), valX - 80, ty, { width: 80, align: 'right' }); ty += 14
    doc.text(`GST @ ${data.gstRate}%`, labelX, ty, { width: 140 }); doc.text(formatCurrency(data.gstAmount), valX - 80, ty, { width: 80, align: 'right' }); ty += 14

    if (data.discount > 0) {
      doc.fillColor('#dc2626').text('Discount', labelX, ty, { width: 140 })
      doc.text(`- ${formatCurrency(data.discount)}`, valX - 80, ty, { width: 80, align: 'right' }); ty += 14
    }

    ty += 2
    doc.save().moveTo(labelX, ty - 2).lineTo(valX, ty - 2).lineWidth(1).stroke(COLORS.accent).restore()
    ty += 4
    doc.fontSize(11).font('Helvetica-Bold').fillColor(COLORS.primary)
    doc.text('QUOTED TOTAL', labelX, ty, { width: 140 })
    doc.fillColor(COLORS.accent).text(formatCurrency(data.grandTotal), valX - 80, ty, { width: 80, align: 'right' })

    doc.y = Math.max(doc.y, ty + 20)

    // ══════════════════════════════════════════════════════════════
    // AMOUNT IN WORDS
    // ══════════════════════════════════════════════════════════════
    doc.y += 4
    drawRoundedRect(doc, left, doc.y, contentW, 20, 2, '#fef3c7')
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#92400e')
      .text('Amount in Words:', left + 8, doc.y + 5)
    doc.fontSize(7.5).font('Helvetica').fillColor('#78350f')
      .text(data.amountInWords, left + 95, doc.y + 5 - 14, { width: contentW - 110 })

    doc.y += 28

    // ══════════════════════════════════════════════════════════════
    // TERMS AND CONDITIONS
    // ══════════════════════════════════════════════════════════════
    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).stroke(COLORS.divider).restore()
    doc.y += 8

    doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.primary)
      .text('Terms & Conditions', left, doc.y)
    doc.y += 12
    doc.fontSize(7).font('Helvetica').fillColor(COLORS.muted)

    const terms = [
      `1. This quotation is valid until ${data.validUntil}. Prices may vary after expiry based on prevailing silver rates.`,
      '2. Prices are based on the prevailing silver rate on the quotation date and are subject to change.',
      '3. GST will be charged at the applicable rate on the date of actual invoicing.',
      '4. Making charges as quoted above; any design modifications may result in price adjustments.',
      '5. Advance payment of 50% required to confirm the order. Balance due at the time of delivery.',
      '6. Goods once sold will only be exchanged as per store policy. No cash refunds.',
      '7. This is a proforma estimate and not a tax invoice. Actual invoice will be generated upon order confirmation.',
      '8. Delivery timeline: 7-14 working days from order confirmation, subject to stock availability.',
    ]

    for (const term of terms) {
      doc.text(term, left, doc.y, { width: contentW * 0.85 })
      doc.y += 10
    }

    doc.y += 6

    // ══════════════════════════════════════════════════════════════
    // NOTES (if any)
    // ══════════════════════════════════════════════════════════════
    if (data.notes) {
      doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).stroke(COLORS.divider).restore()
      doc.y += 8
      doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.primary)
        .text('Notes', left, doc.y)
      doc.y += 12
      doc.fontSize(7.5).font('Helvetica').fillColor(COLORS.text)
        .text(data.notes, left, doc.y, { width: contentW * 0.85 })
      doc.y += 16
    }

    // ══════════════════════════════════════════════════════════════
    // SIGNATURES
    // ══════════════════════════════════════════════════════════════
    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).stroke(COLORS.divider).restore()
    doc.y += 10

    const sigY = doc.y
    doc.fontSize(8).font('Helvetica').fillColor(COLORS.text)
    doc.text('Customer Acceptance', left, sigY, { width: 140, align: 'center' })
    doc.save().moveTo(left + 20, sigY + 14).lineTo(left + 120, sigY + 14).lineWidth(0.5).stroke(COLORS.border).restore()

    doc.text(`For ${data.businessName}`, left + contentW - 140, sigY, { width: 140, align: 'center' })
    doc.save().moveTo(left + contentW - 120, sigY + 14).lineTo(left + contentW - 20, sigY + 14).lineWidth(0.5).stroke(COLORS.border).restore()
    doc.fontSize(7).fillColor(COLORS.muted).text('Authorised Signatory', left + contentW - 140, sigY + 18, { width: 140, align: 'center' })

    doc.y = sigY + 35

    // ══════════════════════════════════════════════════════════════
    // UPI QR CODE
    // ══════════════════════════════════════════════════════════════
    if (data.upiId) {
      const qrSize = 100
      const qrX = right - qrSize - 10
      const qrY = doc.y

      doc.save()
      doc.roundedRect(qrX - 8, qrY - 4, qrSize + 16, qrSize + 28, 3).lineWidth(0.5).stroke(COLORS.border)
      doc.restore()

      if (upiQrBuffer) {
        doc.image(upiQrBuffer, qrX, qrY, { width: qrSize, height: qrSize })
      } else {
        drawRoundedRect(doc, qrX, qrY, qrSize, qrSize, 2, '#f0f0f0')
        doc.fontSize(7).font('Helvetica').fillColor(COLORS.text)
          .text(`UPI: ${data.upiId}`, qrX + 4, qrY + 30, { width: qrSize - 8, align: 'center' })
        doc.text(`₹${data.grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, qrX + 4, qrY + 44, { width: qrSize - 8, align: 'center' })
      }

      doc.fontSize(6).font('Helvetica').fillColor(COLORS.muted)
        .text('Scan to pay via UPI', qrX - 8, qrY + qrSize + 6, { width: qrSize + 16, align: 'center' })
    }

    // ══════════════════════════════════════════════════════════════
    // FOOTER
    // ══════════════════════════════════════════════════════════════
    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.3).stroke(COLORS.divider).restore()
    doc.y += 6
    doc.fontSize(6.5).font('Helvetica').fillColor(COLORS.muted)
      .text(`Generated by ${data.businessName} ERP  |  opalline.in  |  This is a computer-generated quotation`, left, doc.y, { width: contentW, align: 'center' })

    doc.end()
  })
}
