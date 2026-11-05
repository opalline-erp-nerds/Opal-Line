import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPrintHtml, exportHtmlPdf, invoicePrintDoc, mergePrintConfig, printHtmlToPrinter } from '@/lib/printTemplate'
import type { Invoice } from '@/types'

// The invoice screen and the printed page must show the SAME persisted values.
// These tests build the print HTML through the real invoice → doc → HTML path
// (invoicePrintDoc is exactly what InvoiceDetail prints with) and compare what
// comes out against the invoice row a details API response would return.

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-print-1',
    number: 'INV-202605101234',
    shopifyOrder: '#T1',
    customer: 'Ashok Testbuyer',
    customerEmail: 'ashok@example.com',
    customerPhone: '9000000001',
    customerAddress: '12 Test Street',
    customerCity: 'Coimbatore',
    customerState: 'Tamil Nadu',
    customerPincode: '641001',
    items: [
      { product: 'Silver Ring', sku: 'SKU-RING-A', hsn: '7113', qty: 2, weight: 25, silverRate: 0, makingCharge: 0, tax: 30, amount: 1000 },
      { product: 'Gold Pendant', sku: 'SKU-PENDANT-B', hsn: '7114', qty: 1, weight: 10, silverRate: 0, makingCharge: 45, tax: 40.52, amount: 1350.5 },
    ],
    silverValue: 0,
    makingCharge: 45,
    subtotal: 2350.5,
    gst: 3,
    gstAmount: 70.52,
    discount: 100,
    grandTotal: 2321.02,
    paymentMethod: 'upi',
    paymentStatus: 'paid',
    status: 'paid',
    date: '2026-05-10T09:00:00',
    businessName: 'Opal Line',
    ...overrides,
  }
}

const CONFIG = mergePrintConfig(undefined)

function printInvoice(invoice: Invoice, business?: NonNullable<Parameters<typeof invoicePrintDoc>[1]>['business']): string {
  return buildPrintHtml(invoicePrintDoc(invoice, { business }), CONFIG, { docType: 'invoice' })
}

/** Value printed in the totals box for a given row label, e.g. "Taxable Value". */
function rowValue(html: string, label: string): string | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = html.match(new RegExp(`<span>${esc}</span><span>([^<]*)</span>`))
  return m ? m[1] : null
}

const rupees = (cell: string | null): number => Number((cell ?? '').replace(/[^0-9.]/g, ''))

/** The <tr> that contains the given product name (its own row's markup). */
function itemRow(html: string, product: string): string {
  const rows = html.split('<tr').filter((r) => r.includes(product))
  assert.equal(rows.length, 1, `expected exactly one row for ${product}`)
  return rows[0]
}

test('invoicePrintDoc maps the persisted invoice onto the print document without recalculating', () => {
  const invoice = makeInvoice()
  const doc = invoicePrintDoc(invoice)

  // Header/total fields pass through untouched — printing reads stored values.
  assert.equal(doc.number, invoice.number)
  assert.equal(doc.customer, invoice.customer)
  assert.equal(doc.subtotal, invoice.subtotal)
  assert.equal(doc.gst, invoice.gst)
  assert.equal(doc.gstAmount, invoice.gstAmount)
  assert.equal(doc.discount, invoice.discount)
  assert.equal(doc.grandTotal, invoice.grandTotal)
  assert.equal(doc.paymentStatus, invoice.paymentStatus)

  // Every line keeps its own product, SKU, qty, tax and amount.
  assert.equal(doc.items?.length, 2)
  assert.deepEqual(
    doc.items?.map((i) => [i.product, i.sku, i.qty, i.tax, i.amount]),
    invoice.items.map((i) => [i.product, i.sku, i.qty, i.tax, i.amount]),
  )

  // Live Settings business fields win over the values stamped on the row —
  // same precedence the invoice screen applies.
  const withBusiness = invoicePrintDoc(invoice, {
    business: { businessName: 'Opal Line Jewellers', businessGstin: '33ABCDE1234F1Z5' },
  })
  assert.equal(withBusiness.businessName, 'Opal Line Jewellers')
  assert.equal(withBusiness.businessGstin, '33ABCDE1234F1Z5')
  assert.equal(withBusiness.subtotal, invoice.subtotal, 'business overrides must not touch totals')
})

test('printed totals match the details response and add up to the grand total', () => {
  // The invoice row exactly as /db/invoices/:id + /items would return it.
  const invoice = makeInvoice()
  const html = printInvoice(invoice)

  const taxable = rowValue(html, 'Taxable Value')
  const cgst = rowValue(html, 'CGST @ 1.5%')
  const sgst = rowValue(html, 'SGST @ 1.5%')
  const totalGst = rowValue(html, 'Total GST')
  const discount = rowValue(html, 'Discount')
  const grand = rowValue(html, 'GRAND TOTAL')

  // Taxable Value = GST base = the subtotal on the details screen, never
  // subtotal − discount (the old print subtracted the discount twice).
  assert.equal(taxable, '₹2,350.50')
  assert.equal(rupees(taxable), invoice.subtotal, 'printed taxable value must equal the stored subtotal')
  assert.notEqual(rupees(taxable), invoice.subtotal - invoice.discount, 'discount must not be subtracted here')

  // CGST/SGST are half the STORED GST money, labelled with half the stored rate.
  assert.equal(cgst, '₹35.26')
  assert.equal(sgst, '₹35.26')
  assert.equal(rupees(totalGst), invoice.gstAmount, 'printed GST total must equal the stored gst amount')
  assert.equal(rupees(cgst) + rupees(sgst), invoice.gstAmount)

  assert.equal(discount, '- ₹100.00')
  assert.equal(rupees(discount), invoice.discount)
  assert.equal(grand, '₹2,321.02')
  assert.equal(rupees(grand), invoice.grandTotal, 'printed grand total must equal the stored grand total')

  // The rows on the paper must add up to the printed grand total again.
  assert.equal(
    Math.round((rupees(taxable) + rupees(totalGst) - rupees(discount)) * 100) / 100,
    rupees(grand),
  )

  // The items-table footer total shows the SAME grand total the totals box
  // shows — not the GST-exclusive subtotal sum of the Amount column.
  const foot = html.slice(html.indexOf('<tfoot>'), html.indexOf('</tfoot>'))
  const fmtIn = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  assert.ok(foot.includes(fmtIn(invoice.grandTotal)), 'table footer must show the calculated grand total')
  assert.ok(!foot.includes(fmtIn(invoice.subtotal)), 'table footer must not repeat the GST-exclusive subtotal')
  assert.ok(html.includes(fmtIn(invoice.subtotal)), 'the subtotal must still print as the Taxable Value row')
})

test('per-line GST prints as money, never as a percentage, and unknown snapshots dash', () => {
  const invoice = makeInvoice()
  const html = printInvoice(invoice)

  // Tax column: ₹ amounts like the screen's Tax column.
  assert.ok(html.includes('₹30.00'), 'ring GST amount must print as ₹30.00')
  assert.ok(html.includes('₹40.52'), 'pendant GST amount must print as ₹40.52')
  assert.ok(!html.includes('30%'), 'a tax amount must never be printed as a percentage')
  assert.ok(!html.includes('40.52%'), 'a tax amount must never be printed as a percentage')

  // Order-raised items carry no silver-rate snapshot: 0 renders as the same
  // dash the invoice screen shows, not a fake ₹0.00.
  assert.ok(!html.includes('₹0.00'), 'unknown rate/making snapshots must not print as ₹0.00')
  // A real making charge prints as the per-line "Making Value"
  // (10 g × ₹45/g = ₹450.00), the same breakdown the invoice screen
  // shows as "₹45.00/g = ₹450.00".
  assert.ok(html.includes('₹450.00'), 'the real making value must still print')

  // Percentage labels in the totals box are the GST rate halves only.
  assert.ok(html.includes('CGST @ 1.5%'))
  assert.ok(html.includes('SGST @ 1.5%'))
})

test('every item row keeps its own product, quantity, HSN and amount', () => {
  const invoice = makeInvoice()
  const html = printInvoice(invoice)

  const ringRow = itemRow(html, 'Silver Ring')
  assert.ok(ringRow.includes('SKU-RING-A'), 'ring row must carry the ring SKU')
  assert.ok(ringRow.includes('7113'), 'ring row must carry the ring HSN code')
  assert.ok(ringRow.includes('>2<'), 'ring row must carry the ring quantity')
  assert.ok(ringRow.includes('₹1,030.00'), 'ring Amount cell = taxable ₹1,000.00 + its GST ₹30.00')
  assert.ok(ringRow.includes('₹30.00'), 'ring row must carry the ring GST')
  assert.ok(!ringRow.includes('1,350.50'), 'the pendant amount must not leak into the ring row')

  const pendantRow = itemRow(html, 'Gold Pendant')
  assert.ok(pendantRow.includes('SKU-PENDANT-B'), 'pendant row must carry the pendant SKU')
  assert.ok(pendantRow.includes('7114'), 'pendant row must carry the pendant HSN code')
  assert.ok(pendantRow.includes('>1<'), 'pendant row must carry the pendant quantity')
  assert.ok(pendantRow.includes('₹1,391.02'), 'pendant Amount cell = taxable ₹1,350.50 + its GST ₹40.52')
  assert.ok(pendantRow.includes('₹40.52'), 'pendant row must carry the pendant GST')
  assert.ok(!pendantRow.includes('1,000.00'), 'the ring amount must not leak into the pendant row')
})

test('printing is idempotent and never mutates the invoice it prints', () => {
  const invoice = makeInvoice()
  const before = JSON.stringify(invoice)

  const first = printInvoice(invoice)
  const second = printInvoice(invoice)
  assert.equal(first, second, 'the same invoice must render byte-identical HTML every time')

  assert.equal(JSON.stringify(invoice), before, 'building print HTML must not modify the invoice')
})

test('switching to another invoice cannot leak values from the previously printed one', () => {
  const invoiceA = makeInvoice()
  const invoiceB = makeInvoice({
    id: 'inv-print-2',
    number: 'INV-202605109999',
    shopifyOrder: '#T2',
    customer: 'Latha Secondbuyer',
    customerEmail: 'latha@example.com',
    items: [
      { product: 'Nose Pin', sku: 'SKU-NOSE-C', hsn: '7113', qty: 5, weight: 7.5, silverRate: 0, makingCharge: 10, tax: 15, amount: 500 },
    ],
    silverValue: 0,
    makingCharge: 10,
    subtotal: 500,
    gst: 3,
    gstAmount: 15,
    discount: 0,
    grandTotal: 515,
    paymentMethod: 'cod',
    paymentStatus: 'pending',
    status: 'issued',
  })

  const htmlA = printInvoice(invoiceA)
  const htmlB = printInvoice(invoiceB)

  // Invoice B's document must contain none of invoice A's business values.
  for (const leaked of ['Ashok Testbuyer', 'INV-202605101234', 'Silver Ring', 'SKU-RING-A', '2,350.50', '2,321.02', '1,350.50']) {
    assert.ok(!htmlB.includes(leaked), `"${leaked}" from the previous invoice must not appear in the next one`)
  }
  // And B's own values must all be there.
  for (const own of ['Latha Secondbuyer', 'INV-202605109999', 'Nose Pin', 'SKU-NOSE-C', '₹515.00']) {
    assert.ok(htmlB.includes(own), `"${own}" must appear in invoice B's document`)
  }

  // Re-printing A after B still yields A's original document (no shared state).
  assert.equal(printInvoice(invoiceA), htmlA)
})

test('quotations share the same totals block: the discount is subtracted exactly once', () => {
  // The builder is shared with quotations; pin the invariant there too so the
  // taxable-value fix cannot regress one document type while fixing another.
  const quote = makeInvoice({ gstAmount: 0, gst: 0, discount: 150, subtotal: 1200, grandTotal: 1050 })
  const html = buildPrintHtml(invoicePrintDoc(quote), CONFIG, { docType: 'quotation', totalLabel: 'QUOTED TOTAL' })

  const taxable = rowValue(html, 'Taxable Value')
  const discount = rowValue(html, 'Discount')
  const total = rowValue(html, 'QUOTED TOTAL')
  assert.equal(rupees(taxable), 1200, 'taxable value = subtotal, discount gets its own row')
  assert.equal(rupees(discount), 150)
  assert.equal(rupees(total), 1050)
  assert.equal(rupees(taxable) - rupees(discount), rupees(total), 'quoted rows must add up too')
  assert.ok(!html.includes('CGST'), 'a 0% document must not print GST split rows')
})

test('legacy rows with tax: 0 reconcile their GST column to the stored summary', () => {
  // The SI202610243588 bug: invoice creation never wrote per-line tax (0 on
  // every row) while gstAmount on the invoice row was real, so the printed
  // GST column dashed every line even though the summary showed CGST/SGST.
  const invoice = makeInvoice({
    items: [
      { product: 'Silver Ring', sku: 'SKU-RING-A', hsn: '7113', qty: 2, weight: 25, silverRate: 0, makingCharge: 0, tax: 0, amount: 1000 },
      { product: 'Gold Pendant', sku: 'SKU-PENDANT-B', hsn: '7114', qty: 1, weight: 10, silverRate: 0, makingCharge: 45, tax: 0, amount: 1350.5 },
    ],
    gst: 3,
    gstAmount: 70.52,
    discount: 0,
    subtotal: 2350.5,
    grandTotal: 2421.02,
  })
  const before = JSON.stringify(invoice)
  const html = printInvoice(invoice)
  assert.equal(printInvoice(invoice), html, 'reconciliation must be deterministic')
  assert.equal(JSON.stringify(invoice), before, 'reconciliation must not mutate the invoice')

  // Both lines now carry money in the GST column (largest-remainder split of
  // the STORED gstAmount, in proportion to the line amounts) …
  const ringRow = itemRow(html, 'Silver Ring')
  const pendantRow = itemRow(html, 'Gold Pendant')
  assert.ok(ringRow.includes('₹30.00'), 'ring GST cell must show its share of the stored GST')
  assert.ok(pendantRow.includes('₹40.52'), 'pendant GST cell must show its share of the stored GST')

  // … and the printed column sums EXACTLY to the printed summary total.
  // The GST cell is the right-aligned cell immediately before the bold amount.
  const gstCell = (row: string): number => {
    const m = row.match(/text-align:right;">₹([\d,]+\.\d{2})<\/td>\s*<td[^>]*font-weight:600/)
    assert.ok(m, 'expected a GST cell before the amount cell')
    return Number(m[1].replace(/,/g, ''))
  }
  const totalGst = rowValue(html, 'Total GST')
  assert.equal(rupees(totalGst), invoice.gstAmount, 'summary Total GST must equal the stored amount')
  const lineGstTotal = Math.round((gstCell(ringRow) + gstCell(pendantRow)) * 100) / 100
  assert.equal(lineGstTotal, rupees(totalGst), 'line GST cells must add up to the summary')
  assert.equal(lineGstTotal, invoice.gstAmount, 'line GST totals must match the invoice GST exactly')

  // The Amount column stays the taxable line amount EXCLUDING GST, and the
  // grand total follows the invoice calculation rule:
  // taxable + GST − discount = printed grand total = stored grand total.
  const printedDiscount = rowValue(html, 'Discount')
  const taxable = rupees(rowValue(html, 'Taxable Value'))
  const grand = rupees(rowValue(html, 'GRAND TOTAL'))
  assert.equal(taxable, invoice.subtotal, 'Taxable Value must remain the GST-exclusive total of the line amounts')
  assert.equal(
    Math.round((taxable + invoice.gstAmount - (printedDiscount ? rupees(printedDiscount) : 0)) * 100) / 100,
    grand,
    'grand total must reconcile as taxable + GST − discount',
  )
  assert.equal(grand, invoice.grandTotal, 'printed grand total must equal the stored grand total')

  // Intra-state defaults: supply line + split rows with the rate labels.
  assert.ok(html.includes('Intra-state supply · GST @ 3%'))
  assert.ok(html.includes('CGST @ 1.5%') && html.includes('SGST @ 1.5%'))
  // The column shows a money amount, so it is named as a money column.
  assert.ok(html.includes('>GST AMOUNT (₹)</th>'), 'the GST column must be named GST AMOUNT (₹)')
})

test('inter-state invoices (buyer GSTIN in another state) print IGST, not CGST/SGST', () => {
  const invoice = makeInvoice({
    customerState: 'Tamil Nadu',
    buyerGstin: '33AABCU9603R1ZX', // TN buyer vs the business's 27… GSTIN
  })
  const html = printInvoice(invoice, { businessGstin: '27AAACO1234F1Z5' })

  assert.ok(html.includes('Inter-state supply · IGST @ 3%'), 'supply line must declare the inter-state supply')
  const igst = rowValue(html, 'IGST @ 3%')
  assert.equal(rupees(igst), invoice.gstAmount, 'IGST must equal the stored GST money')
  assert.equal(rowValue(html, 'CGST @ 1.5%'), null, 'inter-state summary must not split CGST')
  assert.equal(rowValue(html, 'SGST @ 1.5%'), null, 'inter-state summary must not split SGST')
  assert.ok(!html.includes('CGST') && !html.includes('SGST'), 'no CGST/SGST labels at all on an inter-state invoice')

  // Reconciliation holds for the inter-state shape too.
  const taxable = rupees(rowValue(html, 'Taxable Value'))
  const discount = rupees(rowValue(html, 'Discount'))
  const grand = rupees(rowValue(html, 'GRAND TOTAL'))
  assert.equal(Math.round((taxable + invoice.gstAmount - discount) * 100) / 100, grand)
})

test('a different GST rate (12%) reconciles the same way', () => {
  // GST rates are data (sales_invoices.gst), not a 3% constant — verify the
  // line column, the summary rows and the header all follow a 12% invoice.
  const invoice = makeInvoice({
    items: [
      { product: 'Silver Ring', sku: 'SKU-RING-A', hsn: '7113', qty: 2, weight: 25, silverRate: 0, makingCharge: 0, tax: 0, amount: 1000 },
      { product: 'Gold Pendant', sku: 'SKU-PENDANT-B', hsn: '7114', qty: 1, weight: 10, silverRate: 0, makingCharge: 45, tax: 0, amount: 1350.5 },
    ],
    gst: 12,
    gstAmount: 282.06, // 12% of 2,350.50
    discount: 0,
    subtotal: 2350.5,
    grandTotal: 2632.56,
  })
  const html = printInvoice(invoice)

  const ringRow = itemRow(html, 'Silver Ring')
  const pendantRow = itemRow(html, 'Gold Pendant')
  assert.ok(ringRow.includes('₹120.00'), '12% of ₹1,000.00 must land in the ring GST cell')
  assert.ok(pendantRow.includes('₹162.06'), '12% of ₹1,350.50 must land in the pendant GST cell')
  assert.equal(Math.round((120 + 162.06) * 100) / 100, invoice.gstAmount, 'line cells must sum to the stored GST')

  assert.ok(html.includes('>GST AMOUNT (₹)</th>'), 'the GST column must be named GST AMOUNT (₹)')
  const cgst = rowValue(html, 'CGST @ 6%')
  const sgst = rowValue(html, 'SGST @ 6%')
  assert.equal(rupees(cgst) + rupees(sgst), invoice.gstAmount, 'split rows must sum to the stored GST')
  assert.equal(rupees(rowValue(html, 'GRAND TOTAL')), invoice.grandTotal)
})

test('same-state buyer GSTIN keeps the intra-state CGST/SGST split', () => {
  const invoice = makeInvoice({ buyerGstin: '27AABCU9603R1ZX' })
  const html = printInvoice(invoice, { businessGstin: '27AAACO1234F1Z5' })
  assert.ok(html.includes('Intra-state supply · GST @ 3%'))
  assert.ok(html.includes('CGST @ 1.5%'), 'same-state buyer must keep the CGST row')
  assert.ok(html.includes('IGST @') === false, 'intra-state summary must not show IGST')
})

test('header and row cells stay in the same column order, with and without images', () => {
  // Regression for SI202610246991.pdf: InvoiceDetail prints with showImages
  // on, but a product WITHOUT an image skipped its <td> while the header
  // still reserved the image <th> — shifting every later cell one column
  // left, so Making Value showed under Rate, GST under MAKING VALUE and the
  // Amount under GST AMOUNT. The row must emit exactly one cell per header.
  const invoice = makeInvoice({
    items: [
      { product: 'Twisted Rope Chain 22 inch', sku: 'OL-CHN-003', hsn: '7113', qty: 1, weight: 50.2385, silverRate: 125, makingCharge: 20, tax: 0, amount: 7284.6 },
    ],
    gst: 3,
    gstAmount: 218.54,
    discount: 0,
    subtotal: 7284.6,
    grandTotal: 7503.14,
  })

  /** Cell texts of a <thead>/<tr> fragment, in DOM order. */
  const colTexts = (fragment: string, tag: 'th' | 'td'): string[] =>
    fragment.split(`<${tag}`).slice(1).map((chunk) => {
      const inner = chunk.slice(chunk.indexOf('>') + 1)
      return inner.slice(0, inner.indexOf(`</${tag}>`)).replace(/<br\s*\/?>/g, ' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    })
  const headerOf = (html: string): string[] => {
    const start = html.indexOf('<thead>') + '<thead>'.length
    return colTexts(html.slice(start, html.indexOf('</thead>')), 'th')
  }

  // 1) Image column reserved, product has NO image — the bug condition.
  const noImageHtml = buildPrintHtml(
    invoicePrintDoc(invoice, { imagesBySku: new Map() }),
    CONFIG,
    { docType: 'invoice', showImages: true },
  )
  const ths = headerOf(noImageHtml)
  assert.deepEqual(
    ths,
    ['', 'Product', 'HSN', 'Qty', 'Weight (g)', 'Rate (₹/g)', 'Making Value (₹)', 'GST AMOUNT (₹)', 'Amount (₹)'],
    'header column order must match the invoice table contract',
  )
  const tds = colTexts(itemRow(noImageHtml, 'Twisted Rope Chain 22 inch'), 'td')
  assert.equal(tds.length, ths.length, `image-less row must still emit one cell per header (got ${tds.length} vs ${ths.length})`)

  // Every value sits directly beneath its own heading.
  const under = (label: string): string => {
    const idx = ths.indexOf(label)
    assert.ok(idx >= 0, `header must contain ${label}`)
    return tds[idx]
  }
  assert.equal(under('Product'), 'Twisted Rope Chain 22 inch OL-CHN-003')
  assert.equal(under('HSN'), '7113')
  assert.equal(under('Qty'), '1')
  assert.equal(under('Weight (g)'), '50.24')
  assert.equal(under('Rate (₹/g)'), '₹125.00')
  assert.equal(under('Making Value (₹)'), '₹1,004.77', 'Making Value must show weight × making charge')
  assert.equal(under('GST AMOUNT (₹)'), '₹218.54', 'GST AMOUNT must show the allocated line GST')
  assert.equal(under('Amount (₹)'), '₹7,503.14', 'Amount must show the gross line total: taxable ₹7,284.60 + GST ₹218.54')

  // 2) Same invoice WITH an image: still one cell per header column.
  const withImageHtml = buildPrintHtml(
    invoicePrintDoc(invoice, { imagesBySku: new Map([['OL-CHN-003', 'data:image/png;base64,AAAA']]) }),
    CONFIG,
    { docType: 'invoice', showImages: true },
  )
  assert.equal(colTexts(itemRow(withImageHtml, 'Twisted Rope Chain 22 inch'), 'td').length, ths.length)

  // 3) showImages off: header drops the column, rows must too.
  const plainHtml = printInvoice(invoice)
  const plainThs = headerOf(plainHtml)
  assert.equal(colTexts(itemRow(plainHtml, 'Twisted Rope Chain 22 inch'), 'td').length, plainThs.length)
})

// ── Hand-off to the browser ───────────────────────────────────────────────────
// Without the desktop bridge, Print and "Save as PDF" both end in
// window.open(): that popup is where Chrome's print dialog (and its
// "Save as PDF" destination) opens. A popup the browser refuses must surface
// as a failure — it used to be swallowed, so a blocked Save reported
// "Labels saved as PDF" while no file was ever written.

interface StubWindow {
  written: string[]
  handle: { opener: unknown; document: { write: (s: string) => void; close: () => void } }
}

const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window')
const originalWindow = (globalThis as { window?: unknown }).window

function stubWindow(handle: StubWindow['handle']): void {
  ;(globalThis as { window?: unknown }).window = { open: () => handle }
}

function stubBlockedPopup(): void {
  ;(globalThis as { window?: unknown }).window = { open: () => null }
}

test.after(() => {
  if (hadWindow) (globalThis as { window?: unknown }).window = originalWindow
  else delete (globalThis as { window?: unknown }).window
})

test('a blocked popup is reported as a failed PDF export, not a fake success', async () => {
  stubBlockedPopup()
  const res = await exportHtmlPdf('<!doctype html><html><body>label sheet</body></html>', 'product-labels')
  assert.equal(res.ok, false, 'a popup Chrome refused must not be reported as a saved PDF')
  assert.equal(res.cancelled, undefined)
  assert.match(String(res.error), /pop-ups/i, 'the failure must tell the user how to unblock it')
})

test('printHtmlToPrinter throws when the print popup is blocked', async () => {
  stubBlockedPopup()
  await assert.rejects(
    () => printHtmlToPrinter('<!doctype html><html><body>label sheet</body></html>', 'Product Labels', 'silent'),
    /pop-ups/i,
    'a blocked print must reach the caller so it can toast instead of silently doing nothing',
  )
})

test('an allowed popup receives the whole document and the print-on-load script', async () => {
  const stub: StubWindow = {
    written: [],
    handle: {
      opener: undefined,
      document: { write: (s: string) => void stub.written.push(s), close: () => {} },
    },
  }
  stubWindow(stub.handle)

  const html = '<!doctype html><html><head><style>@page{size:A4;margin:0;}</style></head><body>labels</body></html>'
  const res = await exportHtmlPdf(html, 'product-labels')
  assert.equal(res.ok, true)
  const out = stub.written.join('')
  assert.ok(out.includes('labels'), 'the popup must carry the built document')
  assert.ok(out.includes('@page{size:A4;margin:0;}'), 'the sheet geometry must survive the hand-off')
  assert.ok(out.includes('window.print()'), 'the popup must print itself on load')
})
