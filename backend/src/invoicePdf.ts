import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { getRawClient } from './db/client'
import { logger } from './logger'
import { escapeHtml } from './htmlEscape'

export interface InvoiceItem {
  name: string
  hsn: string
  quantity: number
  grossWeight: number
  netWeight: number
  silverRate: number
  makingCharge: number
  amount: number
  huid?: string | null
}

export interface InvoiceData {
  id: string
  invoiceNumber: string
  date: string
  customerName: string
  customerPhone?: string
  customerEmail?: string
  customerAddress?: string
  customerGstin?: string
  customerState?: string
  customerStateCode?: string
  items: InvoiceItem[]
  subtotal: number
  discount: number
  cgst: number
  sgst: number
  totalGst: number
  /** GST rate (%, e.g. 3) the totalGst was computed from — drives the printed CGST/SGST rate labels. */
  gstRate?: number
  grandTotal: number
  amountInWords: string
  businessName: string
  businessAddress: string
  businessGstin: string
  businessState: string
  businessStateCode: string
  businessPhone: string
  businessEmail: string
  paymentMethod: string
  paymentStatus: string
  shopifyOrder?: string
  tdsType?: string
  tdsRate?: number
  tdsAmount?: number
  tdsSection?: string
  adjustedTotal?: number
  upiId?: string
}

// ─── Color palette ────────────────────────────────────────────────
const COLORS = {
  primary: '#1a1a2e',
  accent: '#c8a951',
  border: '#d1d5db',
  lightBg: '#f8f9fa',
  headerBg: '#1a1a2e',
  headerText: '#ffffff',
  text: '#1f2937',
  muted: '#6b7280',
  success: '#059669',
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

/**
 * Currency text safe for PDF drawing.
 *
 * The standard PDF fonts (Helvetica/WinAnsi) have no rupee glyph - pdfkit
 * writes U+20B9 as two stray bytes that render as a superscript-one, turning
 * every money value into unreadable noise. The PDFs therefore print "Rs."
 * while the exported formatCurrency (used by API/UI code and asserted in
 * tests) keeps the rupee sign.
 */
function pdfCurrency(amount: number): string {
  return formatCurrency(amount).replace(String.fromCharCode(0x20b9), 'Rs.')
}

export function formatCurrency(amount: number): string {
  return '\u20B9' + amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function drawRoundedRect(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, r: number, fill: string) {
  doc.save()
  doc.roundedRect(x, y, w, h, r).fill(fill)
  doc.restore()
}

export async function generateInvoicePDF(invoiceId: string): Promise<Buffer | null> {
  const client = getRawClient()
  if (!client) return null

  try {
    const invoices = await client.unsafe(`SELECT * FROM sales_invoices WHERE id = $1`, [invoiceId])
    if (invoices.length === 0) return null
    const inv = invoices[0] as any

    const items = await client.unsafe(`SELECT * FROM sales_invoice_items WHERE invoice_id = $1`, [invoiceId])
    const [settings] = await client.unsafe(`SELECT * FROM settings LIMIT 1`) as any[]

    // HUID + HSN lookup: join through SKU so printed invoices carry hallmark
    // numbers and the product's real HSN code (the items table stores neither).
    const skus = items.map((item: any) => String(item.sku || '')).filter(Boolean)
    const huidBySku = new Map<string, string>()
    const hsnBySku = new Map<string, string>()
    if (skus.length > 0) {
      const prods = await client.unsafe(`SELECT sku, huid, hsn FROM products WHERE sku = ANY($1)`, [skus]) as any[]
      for (const p of prods) {
        if (!p.sku) continue
        if (p.huid) huidBySku.set(p.sku, p.huid)
        if (p.hsn) hsnBySku.set(p.sku, p.hsn)
      }
    }

    const itemData: InvoiceItem[] = items.map((item: any) => ({
      // sales_invoice_items.product holds the product name; name/product_name
      // are legacy aliases kept only for rows from older schemas.
      name: item.product || item.name || item.product_name || 'Item',
      hsn: item.hsn || hsnBySku.get(String(item.sku || '')) || '7113',
      quantity: Number(item.qty || item.quantity || 1),
      grossWeight: Number(item.gross_weight || 0),
      netWeight: Number(item.net_weight || item.weight || 0),
      silverRate: Number(item.silver_rate || item.rate || 0),
      makingCharge: Number(item.making_charge || 0),
      amount: Number(item.amount || 0),
      huid: (item.sku && huidBySku.get(item.sku)) || null,
    }))

    const subtotal = Number(inv.subtotal || 0)
    const discount = Number(inv.discount || 0)
    // sales_invoices carries `gst` (the rate, e.g. 3) and `gst_amount` (the
    // money). Use the stored amount; the legacy fallback recomputes it the
    // same way the invoice was raised — GST on the subtotal, pre-discount.
    const gstRate = Number(inv.gst || settings?.gst_rate || 3)
    const totalGst = Number(inv.gst_amount || inv.total_gst || subtotal * gstRate / 100)
    const cgst = Math.round((totalGst / 2) * 100) / 100
    const sgst = Math.round((totalGst / 2) * 100) / 100
    const grandTotal = Number(inv.grand_total || subtotal - discount + totalGst)

    const tdsType = inv.tds_type || 'none'
    const tdsRate = Number(inv.tds_rate || 0)
    const tdsAmount = Number(inv.tds_amount || 0)
    const tdsSection = inv.tds_section || ''
    const adjustedTotal = tdsType !== 'none' && tdsAmount > 0
      ? Math.round((grandTotal + tdsAmount) * 100) / 100
      : grandTotal
    const hasTds = tdsType !== 'none' && tdsAmount > 0

    const data: InvoiceData = {
      id: inv.id,
      invoiceNumber: inv.number || inv.invoice_number || inv.id,
      date: inv.date ? new Date(inv.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      customerName: inv.customer_name || inv.customer || 'Walk-in Customer',
      customerPhone: inv.customer_phone || inv.phone || undefined,
      customerEmail: inv.customer_email || inv.email || undefined,
      customerAddress: inv.customer_address || inv.address || undefined,
      // sales_invoices.buyer_gstin is the customer's GSTIN on the row.
      customerGstin: inv.buyer_gstin || inv.customer_gstin || undefined,
      customerState: inv.customer_state || 'Maharashtra',
      customerStateCode: inv.customer_state_code || '27',
      items: itemData,
      subtotal, discount, cgst, sgst, totalGst, gstRate, grandTotal,
      amountInWords: numberToIndianWords(hasTds ? adjustedTotal : grandTotal),
      businessName: settings?.business_name || 'Opal Line Jewels LLP',
      businessAddress: settings?.address || 'Shop 4, Nariman Point, Mumbai - 400021',
      businessGstin: settings?.gstin || '27AAACO1234F1Z5',
      businessState: 'Maharashtra',
      businessStateCode: '27',
      businessPhone: settings?.phone || '+91 98200 00000',
      businessEmail: settings?.email || 'hello@opalline.in',
      paymentMethod: inv.payment_method || inv.payment || 'Online',
      paymentStatus: inv.payment_status || 'paid',
      shopifyOrder: inv.shopify_order || inv.shopifyOrder || undefined,
      tdsType,
      tdsRate,
      tdsAmount,
      tdsSection,
      adjustedTotal,
      upiId: settings?.upi_id || settings?.upiId || undefined,
    }

    return createPDFBuffer(data)
  } catch (err) {
    logger.error({ err, invoiceId }, 'Invoice PDF generation failed')
    return null
  }
}

export async function createPDFBuffer(data: InvoiceData): Promise<Buffer> {
  // Pre-generate UPI QR code buffer (async) so it's available inside PDFDocument
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
        Title: `Invoice ${data.invoiceNumber}`,
        Author: data.businessName,
        Subject: 'Tax Invoice',
      },
    })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const pageW = 595.28 // A4 width in points
    const left = 40
    const right = pageW - 40
    const contentW = right - left

    // Typography scale — bumped from the old 8/7.5pt body so the table is
    // legible in print. Money and headers are bold; the description carries
    // the product name (9.5pt) over an SKU line (7pt muted).
    const T = { body: 9, money: 9, head: 8, name: 9.5, sub: 7 }
    const PAD = 8 // inner padding for every table cell

    // ══════════════════════════════════════════════════════════════
    // HEADER — Dark banner with business name
    // ══════════════════════════════════════════════════════════════
    drawRoundedRect(doc, left, 24, contentW, 50, 4, COLORS.headerBg)
    doc.fontSize(20).font('Helvetica-Bold').fillColor(COLORS.headerText)
      .text(data.businessName, left + 16, 31, { width: contentW - 32 })
    doc.fontSize(8.5).font('Helvetica').fillColor('#a0aec0')
      .text(`${data.businessAddress}`, left + 16, 52, { width: contentW - 32 })
    doc.fontSize(8).fillColor('#a0aec0')
      .text(`GSTIN: ${data.businessGstin}  |  State: ${data.businessState} (${data.businessStateCode})  |  Ph: ${data.businessPhone}  |  ${data.businessEmail}`, left + 16, 63, { width: contentW - 32 })

    doc.y = 84

    // ══════════════════════════════════════════════════════════════
    // TAX INVOICE badge + Invoice details
    // ══════════════════════════════════════════════════════════════
    // Badge
    drawRoundedRect(doc, right - 116, 84, 116, 23, 3, COLORS.accent)
    doc.fontSize(10.5).font('Helvetica-Bold').fillColor(COLORS.primary)
      .text('TAX INVOICE', right - 116, 89, { width: 116, align: 'center', lineBreak: false })

    // Invoice info
    doc.fontSize(9.5).font('Helvetica').fillColor(COLORS.text)
    const infoY = 116
    doc.font('Helvetica-Bold').text('Invoice No:', left, infoY)
    doc.font('Helvetica').text(` ${data.invoiceNumber}`, left + 64, infoY)
    doc.font('Helvetica-Bold').text('Date:', left + 220, infoY)
    doc.font('Helvetica').text(` ${data.date}`, left + 245, infoY)

    doc.font('Helvetica-Bold').text('Payment:', left, infoY + 15)
    doc.font('Helvetica').text(` ${data.paymentMethod} (${data.paymentStatus})`, left + 54, infoY + 15)
    if (data.shopifyOrder) {
      doc.font('Helvetica-Bold').text('Order:', left + 220, infoY + 15)
      doc.font('Helvetica').text(` ${data.shopifyOrder}`, left + 245, infoY + 15)
    }

    doc.y = infoY + 36

    // ══════════════════════════════════════════════════════════════
    // BILL TO / SHIP TO
    // ══════════════════════════════════════════════════════════════
    const billY = doc.y
    drawRoundedRect(doc, left, billY, contentW, 52, 3, COLORS.lightBg)

    doc.fontSize(7).font('Helvetica-Bold').fillColor(COLORS.muted)
      .text('BILL TO', left + 10, billY + 6)
    doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.text)
      .text(data.customerName, left + 10, billY + 18, { width: 200 })
    doc.fontSize(8).font('Helvetica').fillColor(COLORS.muted)
    let custDetails = ''
    if (data.customerPhone) custDetails += data.customerPhone
    if (data.customerEmail) custDetails += (custDetails ? '  |  ' : '') + data.customerEmail
    if (custDetails) doc.text(custDetails, left + 10, billY + 32, { width: 200 })
    if (data.customerGstin) doc.text(`GSTIN: ${data.customerGstin}`, left + 10, billY + 44, { width: 200 })

    doc.fontSize(7).font('Helvetica-Bold').fillColor(COLORS.muted)
      .text('STATE', left + 300, billY + 6)
    doc.fontSize(8).font('Helvetica').fillColor(COLORS.text)
      .text(`${data.customerState} (${data.customerStateCode})`, left + 300, billY + 18)

    doc.y = billY + 60

    // ══════════════════════════════════════════════════════════════
    // ITEMS TABLE
    // Column widths are laid out right-to-left so the money columns always
    // fit, and the leftover goes to Description so long product names and
    // SKUs have room. Every gutter is >= 6pt so adjacent cells never touch.
    // ══════════════════════════════════════════════════════════════
    doc.y += 6
    const tableTop = doc.y

    const gutter = 6
    // Fixed data/money columns, sized to the widest realistic value at 9pt
    // ("Rs.1,09,350.00" ≈ 58pt) plus a small inset. Kept tight so the
    // leftover — the Description column — is as wide as possible for long
    // product names and SKUs.
    const wHsn = 44
    const wQty = 26
    const wWt = 50
    const wRate = 62
    const wMaking = 62
    const wAmount = 66
    const fixedW = wHsn + wQty + wWt + wRate + wMaking + wAmount + gutter * 6
    const wDesc = contentW - fixedW // leftover (~201pt) for the product name + SKU

    const cols: Array<{ key: string; label: string; w: number; x: number; align: 'left' | 'center' | 'right' }> = [
      { key: 'desc', label: 'Description', w: wDesc, x: 0, align: 'left' },
      { key: 'hsn', label: 'HSN', w: wHsn, x: 0, align: 'center' },
      { key: 'qty', label: 'Qty', w: wQty, x: 0, align: 'center' },
      { key: 'wt', label: 'Net Wt (g)', w: wWt, x: 0, align: 'right' },
      { key: 'rate', label: 'Rate (Rs./g)', w: wRate, x: 0, align: 'right' },
      { key: 'making', label: 'Making (Rs.)', w: wMaking, x: 0, align: 'right' },
      { key: 'amount', label: 'Amount (Rs.)', w: wAmount, x: 0, align: 'right' },
    ]
    // Resolve x positions from the widths + gutters (left → right).
    let cursorX = left
    for (const col of cols) { col.x = cursorX; cursorX += col.w + gutter }
    const descCol = cols[0]

    // Table header band — sized to the larger header type.
    const headH = 20
    drawRoundedRect(doc, left, tableTop, contentW, headH, 2, COLORS.headerBg)
    doc.fontSize(T.head).font('Helvetica-Bold').fillColor(COLORS.headerText)
    for (const col of cols) {
      doc.text(col.label, col.x + PAD, tableTop + 6, { width: col.w - PAD * 2, align: col.align, lineBreak: false })
    }

    doc.y = tableTop + headH + 4

    // ── Rows ──────────────────────────────────────────────────────
    // Each row measures its own description (name + SKU line) and HUID note so
    // the band always contains the tallest cell — nothing clips or overlaps.
    const descTextW = descCol.w - PAD * 2
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i]
      const rowY = doc.y

      // Measure the description block: product name (wraps only if needed)…
      doc.font('Helvetica-Bold').fontSize(T.name)
      const nameH = doc.heightOfString(item.name, { width: descTextW })
      // …plus a compact SKU line so the code is readable on one line.
      const skuLine = item.huid ? `HUID: ${item.huid}` : ''
      const subH = skuLine ? doc.font('Helvetica').fontSize(T.sub).heightOfString(skuLine, { width: descTextW }) : 0

      const rowH = Math.max(nameH + subH + (subH ? 3 : 0) + 8, 20)

      // Alternating row background sized to the measured height.
      if (i % 2 === 0) {
        doc.save()
        doc.rect(left, rowY, contentW, rowH).fill(COLORS.lightBg)
        doc.restore()
      }

      // Description: name over the SKU/HUID sub-line.
      doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(T.name)
        .text(item.name, descCol.x + PAD, rowY + 5, { width: descTextW, align: 'left' })
      if (skuLine) {
        doc.font('Helvetica').fontSize(T.sub).fillColor(COLORS.muted)
          .text(skuLine, descCol.x + PAD, rowY + 5 + nameH + 3, { width: descTextW, align: 'left' })
      }

      // Data + money cells, vertically centred in the band.
      const cellY = rowY + (rowH - T.body) / 2 - 1
      doc.font('Helvetica').fontSize(T.body).fillColor(COLORS.text)
      doc.text(item.hsn, cols[1].x + PAD, cellY, { width: wHsn - PAD * 2, align: 'center', lineBreak: false })
      doc.text(String(item.quantity), cols[2].x + PAD, cellY, { width: wQty - PAD * 2, align: 'center', lineBreak: false })
      doc.text(item.netWeight.toFixed(2), cols[3].x + PAD, cellY, { width: wWt - PAD * 2, align: 'right', lineBreak: false })
      // Order-imported items carry no rate/making snapshot; 0 there means
      // "unknown", so print a dash instead of a misleading Rs.0.00.
      const rateText = item.silverRate > 0 ? pdfCurrency(item.silverRate) : '-'
      const makingText = item.makingCharge > 0 ? pdfCurrency(item.makingCharge) : '-'
      doc.text(rateText, cols[4].x + PAD, cellY, { width: wRate - PAD * 2, align: 'right', lineBreak: false })
      doc.text(makingText, cols[5].x + PAD, cellY, { width: wMaking - PAD * 2, align: 'right', lineBreak: false })
      doc.font('Helvetica-Bold').fontSize(T.money)
        .text(pdfCurrency(item.amount), cols[6].x + PAD, cellY, { width: wAmount - PAD * 2, align: 'right', lineBreak: false })

      doc.y = rowY + rowH
    }

    // Table bottom border
    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).stroke(COLORS.border).restore()
    doc.y += 8

    // ══════════════════════════════════════════════════════════════
    // TOTALS — Right-aligned box
    // ══════════════════════════════════════════════════════════════
    const totalsX = left + 300
    const totalsW = contentW - 300
    const totalsY = doc.y

    const hasTds = data.tdsType !== 'none' && (data.tdsAmount ?? 0) > 0
    // Box height is derived from the row stack so nothing overflows the band:
    // 4 fixed rows (taxable/CGST/SGST/[discount]) at 16pt + grand-total block.
    const rowStep = 16
    const baseRows = data.discount > 0 ? 4 : 3
    const grandBlock = 24 // rule + spacing + the larger GRAND TOTAL line
    const tdsBlock = hasTds ? 40 : 0 // TDS row + rule + TOTAL PAYABLE
    const boxH = 10 + baseRows * rowStep + grandBlock + tdsBlock + 6
    drawRoundedRect(doc, totalsX, totalsY, totalsW, boxH, 3, COLORS.lightBg)

    // ── Payment summary (left of the totals box) ──────────────────
    // Fills the otherwise-empty region beside the totals so the block below
    // the table reads as one balanced band instead of a right-anchored island.
    const payW = 300 - 16
    drawRoundedRect(doc, left, totalsY, payW, boxH, 3, COLORS.lightBg)
    doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.muted)
      .text('PAYMENT DETAILS', left + 10, totalsY + 10, { width: payW - 20, lineBreak: false })
    doc.save().moveTo(left + 10, totalsY + 24).lineTo(left + payW - 10, totalsY + 24).lineWidth(0.5).stroke(COLORS.divider).restore()
    doc.fontSize(9).font('Helvetica').fillColor(COLORS.text)
    doc.text('Method', left + 10, totalsY + 32, { width: 110, lineBreak: false })
    doc.font('Helvetica-Bold').text(data.paymentMethod || '—', left + 120, totalsY + 32, { width: payW - 130, align: 'right', lineBreak: false })
    doc.font('Helvetica').text('Status', left + 10, totalsY + 48, { width: 110, lineBreak: false })
    doc.font('Helvetica-Bold').fillColor(data.paymentStatus === 'paid' ? COLORS.success : '#dc2626')
      .text(String(data.paymentStatus || '—').toUpperCase(), left + 120, totalsY + 48, { width: payW - 130, align: 'right', lineBreak: false })
    if (data.customerGstin) {
      doc.font('Helvetica').fillColor(COLORS.text)
        .text('Buyer GSTIN', left + 10, totalsY + 64, { width: 110, lineBreak: false })
      doc.font('Helvetica-Bold').text(data.customerGstin, left + 120, totalsY + 64, { width: payW - 130, align: 'right', lineBreak: false })
    }

    const labelX = totalsX + 10
    const valX = totalsX + totalsW - 10
    let ty = totalsY + 10

    // GST is charged on the subtotal (the items-table total), so the printed
    // Taxable Value IS the subtotal and the CGST/SGST rate labels are half the
    // stored GST rate — the same business values the invoice screen shows.
    // The discount is listed separately (exactly once) above the persisted
    // grand total, so the printed rows add up to the printed grand total.
    const gstRateHalf = String(Math.round((Number(data.gstRate) || 0) / 2 * 100) / 100)

    doc.fontSize(8.5).font('Helvetica').fillColor(COLORS.text)
    doc.text('Taxable Value', labelX, ty, { width: 140 }); doc.text(pdfCurrency(data.subtotal), valX - 80, ty, { width: 80, align: 'right', lineBreak: false }); ty += rowStep
    doc.text(`CGST @ ${gstRateHalf}%`, labelX, ty, { width: 140 }); doc.text(pdfCurrency(data.cgst), valX - 80, ty, { width: 80, align: 'right', lineBreak: false }); ty += rowStep
    doc.text(`SGST @ ${gstRateHalf}%`, labelX, ty, { width: 140 }); doc.text(pdfCurrency(data.sgst), valX - 80, ty, { width: 80, align: 'right', lineBreak: false }); ty += rowStep

    if (data.discount > 0) {
      doc.fillColor('#dc2626').text('Discount', labelX, ty, { width: 140 })
      doc.text(`- ${pdfCurrency(data.discount)}`, valX - 80, ty, { width: 80, align: 'right', lineBreak: false }); ty += rowStep
    }

    // Grand total — highlighted
    ty += 2
    doc.save().moveTo(labelX, ty - 2).lineTo(valX, ty - 2).lineWidth(1).stroke(COLORS.accent).restore()
    ty += 5
    doc.fontSize(11.5).font('Helvetica-Bold').fillColor(COLORS.primary)
    doc.text('GRAND TOTAL', labelX, ty, { width: 140, lineBreak: false })
    doc.fillColor(COLORS.accent).text(pdfCurrency(data.grandTotal), valX - 80, ty, { width: 80, align: 'right', lineBreak: false })

    if (hasTds) {
      ty += 20
      const label = data.tdsType === 'TDS' ? `TDS (${data.tdsSection || '194Q'})` : `TCS (${data.tdsSection || '206C'})`
      doc.fontSize(9).font('Helvetica').fillColor(COLORS.text)
      doc.text(label, labelX, ty, { width: 140 })
      doc.fillColor('#dc2626').text(`+ ${pdfCurrency(data.tdsAmount!)}`, valX - 80, ty, { width: 80, align: 'right', lineBreak: false })
      ty += 16
      doc.save().moveTo(labelX, ty - 2).lineTo(valX, ty - 2).lineWidth(1).stroke(COLORS.accent).restore()
      ty += 5
      doc.fontSize(10.5).font('Helvetica-Bold').fillColor(COLORS.primary)
      doc.text('TOTAL PAYABLE', labelX, ty, { width: 140, lineBreak: false })
      doc.fillColor(COLORS.accent).text(pdfCurrency(data.adjustedTotal!), valX - 80, ty, { width: 80, align: 'right', lineBreak: false })
    }

    doc.y = Math.max(doc.y, ty + 14)

    // ══════════════════════════════════════════════════════════════
    // AMOUNT IN WORDS
    // ══════════════════════════════════════════════════════════════
    doc.y += 2
    // Banner grows with the words so long amounts never spill outside the band.
    const wordsWidth = contentW - 110
    const wordsHeight = doc.heightOfString(data.amountInWords, { width: wordsWidth })
    const bannerH = Math.max(18, wordsHeight + 8)
    const bannerY = doc.y
    drawRoundedRect(doc, left, bannerY, contentW, bannerH, 2, '#fef3c7')
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#92400e')
      .text('Amount in Words:', left + 8, bannerY + 5)
    doc.fontSize(7.5).font('Helvetica').fillColor('#78350f')
      .text(data.amountInWords, left + 95, bannerY + 5, { width: wordsWidth })

    doc.y = bannerY + bannerH + 6

    // ══════════════════════════════════════════════════════════════
    // DECLARATION + SIGNATURES
    // ══════════════════════════════════════════════════════════════
    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).stroke(COLORS.divider).restore()
    doc.y += 8

    doc.fontSize(8).font('Helvetica').fillColor(COLORS.muted)
      .text('Declaration: We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct. Goods once sold will only be exchanged as per store policy. This is a computer-generated invoice.', left, doc.y, { width: contentW * 0.7, align: 'justify' })

    // Signature area
    const sigY = doc.y + 28
    doc.fontSize(8.5).font('Helvetica').fillColor(COLORS.text)
    doc.text('Customer Signature', left, sigY, { width: 120, align: 'center', lineBreak: false })
    doc.save().moveTo(left + 20, sigY + 15).lineTo(left + 100, sigY + 15).lineWidth(0.5).stroke(COLORS.border).restore()

    doc.text(`For ${data.businessName}`, left + contentW - 140, sigY, { width: 140, align: 'center', lineBreak: false })
    doc.save().moveTo(left + contentW - 120, sigY + 15).lineTo(left + contentW - 20, sigY + 15).lineWidth(0.5).stroke(COLORS.border).restore()
    doc.fontSize(7.5).fillColor(COLORS.muted).text('Authorised Signatory', left + contentW - 140, sigY + 19, { width: 140, align: 'center', lineBreak: false })

    doc.y = sigY + 36

    // ══════════════════════════════════════════════════════════════
    // UPI QR CODE (bottom-right, if UPI ID configured)
    // ══════════════════════════════════════════════════════════════
    if (data.upiId) {
      // Keep the QR on one page: shrink it when the content above has left
      // less than its natural height plus the footer band.
      const bottomLimit = 842 - 35 - 30 // leave room for the footer rule + line
      const naturalQr = 120
      const spaceLeft = bottomLimit - doc.y
      const qrSize = Math.max(72, Math.min(naturalQr, spaceLeft - 28))
      const qrX = right - qrSize - 10
      const qrY = doc.y

      // Bordered box for the QR section
      doc.save()
      doc.roundedRect(qrX - 8, qrY - 4, qrSize + 16, qrSize + 28, 3).lineWidth(0.5).stroke(COLORS.border)
      doc.restore()

      if (upiQrBuffer) {
        doc.image(upiQrBuffer, qrX, qrY, { width: qrSize, height: qrSize })
      } else {
        // Fallback: draw text-based UPI placeholder
        drawRoundedRect(doc, qrX, qrY, qrSize, qrSize, 2, '#f0f0f0')
        doc.fontSize(7).font('Helvetica').fillColor(COLORS.text)
          .text(`UPI: ${data.upiId}`, qrX + 4, qrY + 30, { width: qrSize - 8, align: 'center' })
        doc.text(`Rs.${data.grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, qrX + 4, qrY + 44, { width: qrSize - 8, align: 'center' })
      }

      // Label below QR
      doc.fontSize(6).font('Helvetica').fillColor(COLORS.muted)
        .text('Scan to pay via UPI', qrX - 8, qrY + qrSize + 6, { width: qrSize + 16, align: 'center' })
    }

    // ══════════════════════════════════════════════════════════════
    // FOOTER — anchored above the bottom margin and scaled down when the
    // content above (items + QR) would otherwise push it past the page, so
    // the invoice never spills onto a second sheet.
    // ══════════════════════════════════════════════════════════════
    const footerText = `Generated by ${data.businessName} ERP  |  opalline.in  |  This is a computer-generated invoice`
    doc.font('Helvetica').fontSize(6.5)
    const footerNatural = doc.widthOfString(footerText)
    const footerMaxW = contentW
    // Available band for the footer between its rule and the bottom margin.
    const footerBottom = 842 - 35
    const availH = Math.max(0, footerBottom - doc.y - 6)
    let footerSize = 6.5
    if (footerNatural > footerMaxW) footerSize = Math.max(5, 6.5 * (footerMaxW / footerNatural))
    doc.fontSize(footerSize)
    if (availH < 9) footerSize = Math.max(5, footerSize - 1)
    doc.save().moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.3).stroke(COLORS.divider).restore()
    doc.y += 5
    doc.font('Helvetica').fontSize(footerSize).fillColor(COLORS.muted)
      .text(footerText, left, doc.y, { width: contentW, align: 'center', lineBreak: false })

    doc.end()
  })
}

export async function emailInvoicePDF(invoiceId: string, recipientEmail: string): Promise<boolean> {
  const { sendEmail } = await import('./notifications')
  const pdfBuffer = await generateInvoicePDF(invoiceId)
  if (!pdfBuffer) return false

  const client = getRawClient()
  if (!client) return false

  // sales_invoices stores the document number in `number` — there is no
  // invoice_number column — so the emailed subject/filename must read it from
  // there, otherwise the query fails and the email never sends.
  const [inv] = await client.unsafe(`SELECT number FROM sales_invoices WHERE id = $1`, [invoiceId]) as any[]
  const invNumber = inv?.number || invoiceId

  return sendEmail({
    to: recipientEmail,
    subject: `Invoice ${invNumber} — Opal Line`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1a1a2e;">\uD83D\uDCC4 Invoice ${escapeHtml(invNumber)}</h2>
        <p>Please find your invoice attached. You can also download it from the ERP.</p>
        <p style="color: #999; font-size: 12px;">Opal Line ERP — Invoice Notification</p>
      </div>
    `,
    attachments: [{ filename: `${invNumber}.pdf`, content: pdfBuffer }],
  })
}