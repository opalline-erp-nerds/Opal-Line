import 'dotenv/config'
import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'

// dotenv has already populated process.env — clear the database URL so the
// DB-backed generate*PDF entry points exercise their null guards instead of
// opening a real connection.
delete process.env.DATABASE_URL

type InvoiceData = import('./invoicePdf').InvoiceData
type QuotationPdfData = import('./quotationPdf').QuotationPdfData

let invoicePdf: typeof import('./invoicePdf')
let quotationPdf: typeof import('./quotationPdf')
let creditNotePdf: typeof import('./creditNotePdf')
let catalogPdf: typeof import('./catalogPdf')

before(async () => {
  invoicePdf = await import('./invoicePdf')
  quotationPdf = await import('./quotationPdf')
  creditNotePdf = await import('./creditNotePdf')
  catalogPdf = await import('./catalogPdf')
})

const RUPEE = '\u20B9'

function makeInvoice(overrides: Partial<InvoiceData> = {}): InvoiceData {
  return {
    id: 'inv-1',
    invoiceNumber: 'INV-2026-0042',
    date: '24 Sep 2026',
    customerName: 'Asha Traders',
    customerPhone: '+91 90000 00000',
    customerState: 'Maharashtra',
    customerStateCode: '27',
    items: [
      { name: 'Silver Chain', hsn: '7113', quantity: 1, grossWeight: 10.5, netWeight: 10.2, silverRate: 92.5, makingCharge: 150, amount: 1093.5, huid: 'HUID-9988' },
    ],
    subtotal: 1093.5,
    discount: 0,
    cgst: 16.4,
    sgst: 16.4,
    totalGst: 32.8,
    gstRate: 3,
    grandTotal: 1126.3,
    amountInWords: 'One Thousand One Hundred and Twenty Six Rupees and Thirty Paise Only',
    businessName: 'Opal Line Jewels LLP',
    businessAddress: '12 Market Road, Mumbai',
    businessGstin: '27AAACO1234F1Z5',
    businessState: 'Maharashtra',
    businessStateCode: '27',
    businessPhone: '+91 22 1234 5678',
    businessEmail: 'sales@opalline.example',
    paymentMethod: 'UPI',
    paymentStatus: 'paid',
    upiId: 'opalline@okaxis',
    ...overrides,
  }
}

function makeQuotation(overrides: Partial<QuotationPdfData> = {}): QuotationPdfData {
  return {
    id: 'q-1',
    number: 'QT-20261234',
    date: '24 Sep 2026',
    validUntil: '09 Oct 2026',
    customerName: 'Meera Jewellers',
    customerPhone: '+91 91111 22222',
    customerEmail: '',
    customerCity: 'Nashik',
    items: [
      { name: 'Sterling Ring', sku: 'SR-104', qty: 2, weight: 6.4, silverRate: 92.5, makingCharge: 120, amount: 712 },
    ],
    subtotal: 1424,
    gstRate: 3,
    gstAmount: 42.72,
    discount: 0,
    grandTotal: 1466.72,
    amountInWords: 'One Thousand Four Hundred and Sixty Six Rupees and Seventy Two Paise Only',
    notes: 'Valid for 15 days.',
    businessName: 'Opal Line Jewels LLP',
    businessAddress: '12 Market Road, Mumbai',
    businessGstin: '27AAACO1234F1Z5',
    businessPhone: '+91 22 1234 5678',
    businessEmail: 'sales@opalline.example',
    upiId: 'opalline@okaxis',
    ...overrides,
  }
}

const STRING_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }

/**
 * Inflate the PDF streams and decode every text-showing string (pdfkit emits
 * hex strings inside TJ arrays) so tests can assert on what is actually drawn.
 */
function extractPdfText(buf: Buffer): string {
  const latin = buf.toString('latin1')
  const pieces: Array<{ at: number; text: string }> = []
  let globalOffset = 0
  let from = 0
  for (;;) {
    const s = latin.indexOf('stream', from)
    if (s === -1) break
    let start = s + 'stream'.length
    if (latin[start] === '\r') start++
    if (latin[start] === '\n') start++
    const end = latin.indexOf('endstream', start)
    if (end === -1) break
    let sliceEnd = end
    while (sliceEnd > start && (buf[sliceEnd - 1] === 0x0a || buf[sliceEnd - 1] === 0x0d)) sliceEnd--
    from = end + 'endstream'.length
    let content = ''
    try {
      content = inflateSync(buf.subarray(start, sliceEnd)).toString('latin1')
    } catch {
      continue // raw or non-deflate stream
    }
    const base = globalOffset
    globalOffset += content.length + 1
    const hexRe = /<([0-9A-Fa-f\s]+)>/g
    let m: RegExpExecArray | null
    while ((m = hexRe.exec(content))) {
      const hex = m[1].replace(/\s+/g, '')
      if (hex.length % 2 !== 0) continue
      let text = ''
      for (let i = 0; i < hex.length; i += 2) text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
      pieces.push({ at: base + m.index, text })
    }
    const litRe = /\(((?:\\[\s\S]|[^\\()])*)\)/g
    while ((m = litRe.exec(content))) {
      const text = m[1]
        .replace(/\\([nrtbf()\\])/g, (_full, c: string) => STRING_ESCAPES[c] ?? c)
        .replace(/\\([0-7]{1,3})/g, (_full, oct: string) => String.fromCharCode(parseInt(oct, 8)))
      pieces.push({ at: base + m.index, text })
    }
  }
  pieces.sort((a, b) => a.at - b.at)
  return pieces.map((p) => p.text).join('')
}

describe('invoice PDF rendering', () => {
  test('produces a valid one-page PDF carrying invoice metadata', async () => {
    const buf = await invoicePdf.createPDFBuffer(makeInvoice())
    assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-')
    assert.ok(buf.length > 3000, `only ${buf.length} bytes`)
    const latin = buf.toString('latin1')
    assert.match(latin, /%%EOF/)
    // pdfkit writes Info values as indirect objects: `15 0 obj (Invoice ...)`. 
    assert.ok(latin.includes('(Invoice INV-2026-0042)'), 'missing invoice title metadata')
    assert.ok(latin.includes('(Tax Invoice)'), 'missing subject metadata')
    assert.equal(latin.match(/\/Type \/Page\b/g)?.length, 1)
  })

  test('prints the customer, line items, totals and amount in words', async () => {
    const text = extractPdfText(await invoicePdf.createPDFBuffer(makeInvoice()))
    for (const expected of [
      'Opal Line Jewels LLP',
      'TAX INVOICE',
      'INV-2026-0042',
      'Asha Traders',
      'Silver Chain',
      'HUID: HUID-9988',
      'GRAND TOTAL',
      '1,126.30',
      'One Thousand One Hundred and Twenty Six Rupees and Thirty Paise Only',
      'Amount in Words:',
    ]) {
      assert.ok(text.includes(expected), `missing "${expected}" in invoice PDF text`)
    }
  })

  test('adds the TDS line and adjusted payable total when configured', async () => {
    const buf = await invoicePdf.createPDFBuffer(
      makeInvoice({ tdsType: 'TDS', tdsRate: 1, tdsAmount: 11.26, tdsSection: '194Q', adjustedTotal: 1137.56 }),
    )
    const text = extractPdfText(buf)
    assert.ok(text.includes('TDS'), 'missing TDS label')
    assert.ok(text.includes('194Q'), 'missing TDS section')
    assert.ok(text.includes('TOTAL PAYABLE'), 'missing TOTAL PAYABLE row')
    assert.ok(text.includes('1,137.56'), 'missing adjusted total')
  })

  test('embeds the UPI QR image when an upi id is set, omits it otherwise', async () => {
    const withQr = await invoicePdf.createPDFBuffer(makeInvoice())
    assert.ok(withQr.toString('latin1').includes('/Subtype /Image'))
    const withoutQr = await invoicePdf.createPDFBuffer(makeInvoice({ upiId: undefined }))
    assert.ok(!withoutQr.toString('latin1').includes('/Subtype /Image'))
  })

  test('a discounted invoice prints the GST base, rate labels and totals the screen shows', async () => {
    // Regression: the totals box used to print "Taxable Value" as
    // subtotal − discount — subtracting the discount once there and once more
    // on the Discount row, so the printed rows no longer added up to the
    // printed grand total — and it derived a made-up "effective" CGST rate
    // from that discounted base. The stored GST base IS the subtotal and
    // CGST/SGST are half the stored GST rate, exactly like the invoice screen.
    const buf = await invoicePdf.createPDFBuffer(
      makeInvoice({
        gstRate: 3,
        subtotal: 2350.5,
        discount: 100,
        cgst: 35.26,
        sgst: 35.26,
        totalGst: 70.52,
        grandTotal: 2321.02,
        items: [
          { name: 'Silver Ring', hsn: '7113', quantity: 2, grossWeight: 25, netWeight: 25, silverRate: 0, makingCharge: 0, amount: 1000 },
          { name: 'Gold Pendant', hsn: '7114', quantity: 1, grossWeight: 10, netWeight: 10, silverRate: 0, makingCharge: 0, amount: 1350.5 },
        ],
      }),
    )
    const text = extractPdfText(buf)
    // pdfkit renders inter-word spacing (e.g. the gap in "Rs. 2,350.50") as a
    // spacing operator rather than a literal space character, so compare the
    // whitespace-stripped text for money values.
    const flat = text.replace(/\s+/g, '')

    // Taxable Value = the GST base (the items-table total), NOT subtotal − discount.
    assert.ok(flat.includes('TaxableValue'), 'missing taxable value row')
    assert.ok(flat.includes('Rs.2,350.50'), 'taxable value must be the GST base (subtotal)')
    assert.ok(!flat.includes('Rs.2,250.50'), 'taxable value must not subtract the discount')
    // Rate labels come from the stored GST rate; amounts come from the stored GST money.
    assert.ok(flat.includes('CGST@1.5%'), 'CGST label must be half the stored GST rate')
    assert.ok(flat.includes('SGST@1.5%'), 'SGST label must be half the stored GST rate')
    assert.ok(flat.includes('Rs.35.26'), 'CGST/SGST amount must be the stored gst amount split in half')
    assert.ok(flat.includes('Discount'), 'missing discount row')
    // Grand total is the persisted value; together the rows add up again.
    assert.ok(flat.includes('Rs.2,321.02'), 'grand total must be the persisted value')

    // Each line keeps its own product ↔ amount association.
    const ringAt = flat.indexOf('SilverRing')
    const pendantAt = flat.indexOf('GoldPendant')
    assert.ok(ringAt !== -1, 'missing Silver Ring')
    assert.ok(pendantAt !== -1 && pendantAt > ringAt, 'missing Gold Pendant')
    const ringAmountAt = flat.indexOf('Rs.1,000.00', ringAt)
    const pendantAmountAt = flat.indexOf('Rs.1,350.50', pendantAt)
    assert.ok(ringAmountAt > ringAt && ringAmountAt < pendantAt, 'ring amount must print inside the ring row')
    assert.ok(pendantAmountAt > pendantAt, 'pendant amount must print inside the pendant row')
  })
})

describe('quotation PDF rendering', () => {
  test('produces a valid PDF with quotation metadata', async () => {
    const buf = await quotationPdf.createQuotationPDFBuffer(makeQuotation())
    assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-')
    assert.ok(buf.length > 3000, `only ${buf.length} bytes`)
    const latin = buf.toString('latin1')
    assert.ok(latin.includes('(Quotation QT-20261234)'), 'missing quotation title metadata')
    assert.ok(latin.includes('(Quotation)'), 'missing quotation subject metadata')
  })

  test('prints quotation number, customer, GST and quoted total', async () => {
    const text = extractPdfText(await quotationPdf.createQuotationPDFBuffer(makeQuotation()))
    for (const expected of [
      'QUOTATION',
      'QT-20261234',
      '09 Oct 2026',
      'Meera Jewellers',
      'Nashik',
      'Sterling Ring',
      'SKU: SR-104',
      'GST @ 3%',
      'QUOTED TOTAL',
      '1,466.72',
    ]) {
      assert.ok(text.includes(expected), `missing "${expected}" in quotation PDF text`)
    }
  })

  test('embeds the UPI QR only when an upi id is present', async () => {
    const withQr = await quotationPdf.createQuotationPDFBuffer(makeQuotation())
    assert.ok(withQr.toString('latin1').includes('/Subtype /Image'))
    const withoutQr = await quotationPdf.createQuotationPDFBuffer(makeQuotation({ upiId: '' }))
    assert.ok(!withoutQr.toString('latin1').includes('/Subtype /Image'))
  })
})

describe('amount-in-words helper (shared by invoice and quotation PDFs)', () => {
  test('converts Indian numbering units', () => {
    assert.equal(invoicePdf.numberToIndianWords(0), 'Zero')
    assert.equal(invoicePdf.numberToIndianWords(999), 'Nine Hundred and Ninety Nine Rupees Only')
    assert.equal(invoicePdf.numberToIndianWords(1999), 'One Thousand Nine Hundred and Ninety Nine Rupees Only')
    assert.equal(invoicePdf.numberToIndianWords(99.99), 'Ninety Nine Rupees and Ninety Nine Paise Only')
    assert.equal(invoicePdf.numberToIndianWords(100000), 'One Lakh Rupees Only')
    assert.equal(invoicePdf.numberToIndianWords(1250000.75), 'Twelve Lakh Fifty Thousand Rupees and Seventy Five Paise Only')
    assert.equal(invoicePdf.numberToIndianWords(10000000), 'One Crore Rupees Only')
  })

  test('quotation copy stays in sync with the invoice copy', () => {
    for (const v of [0, 999, 1999, 45678.05, 100000, 1250000.75, 10000000]) {
      assert.equal(quotationPdf.numberToIndianWords(v), invoicePdf.numberToIndianWords(v), `mismatch at ${v}`)
    }
  })
})

describe('currency formatting', () => {
  test('uses Indian digit grouping with two decimals', () => {
    assert.equal(invoicePdf.formatCurrency(0), RUPEE + '0.00')
    assert.equal(invoicePdf.formatCurrency(1234.5), RUPEE + '1,234.50')
    assert.equal(invoicePdf.formatCurrency(45678.05), RUPEE + '45,678.05')
    assert.equal(invoicePdf.formatCurrency(100000), RUPEE + '1,00,000.00')
  })

  test('quotation copy matches the invoice copy', () => {
    for (const v of [0, 1, 999.995, 100000, 12345678.9]) {
      assert.equal(quotationPdf.formatCurrency(v), invoicePdf.formatCurrency(v))
    }
  })
})

describe('DB-backed PDF entry points without a database', () => {
  test('return null instead of throwing', async () => {
    assert.equal(await invoicePdf.generateInvoicePDF('missing'), null)
    assert.equal(await quotationPdf.generateQuotationPDF('missing'), null)
    assert.equal(await creditNotePdf.generateCreditNotePDF('missing'), null)
    assert.equal(await catalogPdf.generateCatalogPDF(), null)
  })
})
