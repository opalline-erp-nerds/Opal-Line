import { escapeHtml, numberToIndianWords } from '@/lib/utils'
import type { Invoice } from '@/types'

/**
 * Shared print-template builder — one source of truth for printable documents.
 * The Print Designer page renders live previews with it AND the real print
 * flows (invoice detail, quotations, sales orders) build their printouts with
 * it, so a saved design instantly applies to every document of that type.
 *
 * Keep the defaults in sync with backend/src/routes/printTemplates.ts
 * (defaultPrintConfig + sanitizePrintConfig); the backend clamps and stores
 * the config, this side renders it.
 */

export interface PrintDesignerConfig {
  accent: string
  accent2: string
  headerStyle: 'banner' | 'minimal' | 'boxed' | 'modern'
  font: 'inter' | 'georgia' | 'arial'
  fontScale: number
  pageSize: 'a4' | 'letter'
  margins: { top: number; right: number; bottom: number; left: number }
  cornerRadius: number
  paperTint: 'white' | 'cream'
  tableHeaderStyle: 'dark' | 'accent' | 'light'
  borderStyle: 'rows' | 'full' | 'none'
  tableZebra: boolean
  showLogo: boolean
  logoAlign: 'left' | 'center'
  logoDataUrl: string | null
  showTagline: boolean
  showGSTIN: boolean
  showContactBoxes: boolean
  showPayment: boolean
  showQr: boolean
  qrDataUrl: string | null
  qrCaption: string
  showAmountWords: boolean
  showSignature: boolean
  showDeclaration: boolean
  showHsn: boolean
  showWeight: boolean
  showRate: boolean
  showTax: boolean
  signatoryName: string
  bankDetails: string
  footerNote: string
  thankYouNote: string
  declaration: string
  watermark: string | null
  /** Barcode-label only: physical label size preset (mm). */
  labelPreset: '50x25' | '50x22' | '35x22' | '50x10' | 'custom'
  /** Custom label width in mm (used when labelPreset === 'custom'). */
  labelWidthMm: number
  /** Custom label height in mm (used when labelPreset === 'custom'). */
  labelHeightMm: number
  /** Print the front side of the label. */
  labelShowFront: boolean
  /** Print the back side of the label (second sheet / duplex pass). */
  labelShowBack: boolean
  /** Front-side field toggles. */
  labelFrontCompany: boolean
  labelFrontName: boolean
  labelFrontRate: boolean
  /** Back-side field toggles. */
  labelBackSku: boolean
  labelBackName: boolean
  labelFrontSku?: boolean
  labelBackCompany?: boolean
  labelBackProduct?: boolean
  labelFrontFontSizeMm?: number
  labelFrontFontAlign?: 'left' | 'center' | 'right'
  labelFrontTextPosition?: 'top' | 'center' | 'bottom'
  labelBackFontSizeMm?: number
  labelBackFontAlign?: 'left' | 'center' | 'right'
  labelBackTextPosition?: 'top' | 'center' | 'bottom'
  labelBorder?: boolean
  labelBackgroundColor?: string
  labelRadiusMm?: number
}

export const LABEL_PRESETS: Record<Exclude<PrintDesignerConfig['labelPreset'], 'custom'>, { width: number; height: number }> = {
  '50x25': { width: 50, height: 25 },
  '50x22': { width: 50, height: 22 },
  '35x22': { width: 35, height: 22 },
  '50x10': { width: 50, height: 10 },
}

/** Resolve the active label size in mm (custom values are clamped to sane bounds). */
export function resolveLabelSize(config: PrintDesignerConfig): { width: number; height: number } {
  if (config.labelPreset === 'custom') {
    return {
      width: Math.min(130, Math.max(15, Number(config.labelWidthMm) || 50)),
      height: Math.min(60, Math.max(8, Number(config.labelHeightMm) || 25)),
    }
  }
  return LABEL_PRESETS[config.labelPreset]
}

export const DEFAULT_PRINT_CONFIG: PrintDesignerConfig = {
  accent: '#c8a951',
  accent2: '#1a1a2e',
  headerStyle: 'banner',
  font: 'inter',
  fontScale: 1,
  pageSize: 'a4',
  margins: { top: 12, right: 12, bottom: 12, left: 12 },
  cornerRadius: 6,
  paperTint: 'white',
  tableHeaderStyle: 'dark',
  borderStyle: 'rows',
  tableZebra: true,
  showLogo: false,
  logoAlign: 'left',
  logoDataUrl: null,
  showTagline: true,
  showGSTIN: true,
  showContactBoxes: true,
  showPayment: true,
  showQr: false,
  qrDataUrl: null,
  qrCaption: 'Scan to pay',
  showAmountWords: true,
  showSignature: true,
  showDeclaration: true,
  showHsn: true,
  showWeight: true,
  showRate: true,
  showTax: true,
  signatoryName: '',
  bankDetails: '',
  footerNote: '',
  thankYouNote: 'Thank you for your business!',
  declaration:
    'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct. Goods once sold will only be exchanged as per store policy. This is a computer-generated invoice.',
  watermark: null,
  labelPreset: '50x25',
  labelWidthMm: 50,
  labelHeightMm: 25,
  labelShowFront: true,
  labelShowBack: true,
  labelFrontCompany: true,
  labelFrontName: true,
  labelFrontRate: true,
  labelBackSku: true,
  labelBackName: false,
  labelFrontSku: true,
  labelBackCompany: true,
  labelBackProduct: true,
  labelFrontFontSizeMm: 0,
  labelFrontFontAlign: 'right',
  labelFrontTextPosition: 'bottom',
  labelBackFontSizeMm: 0,
  labelBackFontAlign: 'left',
  labelBackTextPosition: 'top',
  labelBorder: true,
  labelBackgroundColor: '#ffffff',
  labelRadiusMm: 1,
}

const IMAGE_DATAURL = 'data:image/'

function mergeImage(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith(IMAGE_DATAURL) ? v : null
}

/** Merge a stored config over the defaults so new options never break old saves. */
export function mergePrintConfig(saved: unknown): PrintDesignerConfig {
  const s = (typeof saved === 'object' && saved !== null ? saved : {}) as Record<string, unknown>
  const d = DEFAULT_PRINT_CONFIG
  const num = (v: unknown, min: number, max: number, fb: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb
  }
  const hex = (v: unknown, fb: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fb)
  const m = (typeof s.margins === 'object' && s.margins !== null ? s.margins : {}) as Record<string, unknown>
  return {
    accent: hex(s.accent, d.accent),
    accent2: hex(s.accent2, d.accent2),
    headerStyle: ['minimal', 'boxed', 'modern'].includes(String(s.headerStyle)) ? (s.headerStyle as PrintDesignerConfig['headerStyle']) : 'banner',
    font: ['georgia', 'arial'].includes(String(s.font)) ? (s.font as PrintDesignerConfig['font']) : 'inter',
    fontScale: num(s.fontScale, 0.8, 1.3, 1),
    pageSize: s.pageSize === 'letter' ? 'letter' : 'a4',
    margins: {
      top: num(m.top, 0, 40, 12),
      right: num(m.right, 0, 40, 12),
      bottom: num(m.bottom, 0, 40, 12),
      left: num(m.left, 0, 40, 12),
    },
    cornerRadius: num(s.cornerRadius, 0, 16, 6),
    paperTint: s.paperTint === 'cream' ? 'cream' : 'white',
    tableHeaderStyle: s.tableHeaderStyle === 'accent' || s.tableHeaderStyle === 'light' ? (s.tableHeaderStyle as PrintDesignerConfig['tableHeaderStyle']) : 'dark',
    borderStyle: s.borderStyle === 'full' || s.borderStyle === 'none' ? (s.borderStyle as PrintDesignerConfig['borderStyle']) : 'rows',
    tableZebra: s.tableZebra !== false,
    showLogo: s.showLogo === true && mergeImage(s.logoDataUrl) !== null,
    logoAlign: s.logoAlign === 'center' ? 'center' : 'left',
    logoDataUrl: mergeImage(s.logoDataUrl),
    showTagline: s.showTagline !== false,
    showGSTIN: s.showGSTIN !== false,
    showContactBoxes: s.showContactBoxes !== false,
    showPayment: s.showPayment !== false,
    showQr: s.showQr === true && mergeImage(s.qrDataUrl) !== null,
    qrDataUrl: mergeImage(s.qrDataUrl),
    qrCaption: typeof s.qrCaption === 'string' ? s.qrCaption.slice(0, 120) : d.qrCaption,
    showAmountWords: s.showAmountWords !== false,
    showSignature: s.showSignature !== false,
    showDeclaration: s.showDeclaration !== false,
    showHsn: s.showHsn !== false,
    showWeight: s.showWeight !== false,
    showRate: s.showRate !== false,
    showTax: s.showTax !== false,
    signatoryName: typeof s.signatoryName === 'string' ? s.signatoryName.slice(0, 120) : '',
    bankDetails: typeof s.bankDetails === 'string' ? s.bankDetails.slice(0, 600) : '',
    footerNote: typeof s.footerNote === 'string' ? s.footerNote : '',
    thankYouNote: typeof s.thankYouNote === 'string' ? s.thankYouNote : d.thankYouNote,
    declaration: typeof s.declaration === 'string' ? s.declaration : d.declaration,
    watermark: typeof s.watermark === 'string' && s.watermark.trim() !== '' ? s.watermark.trim() : null,
    labelPreset: ['50x22', '35x22', '50x10', 'custom'].includes(String(s.labelPreset)) ? (s.labelPreset as PrintDesignerConfig['labelPreset']) : '50x25',
    labelWidthMm: num(s.labelWidthMm, 15, 130, 50),
    labelHeightMm: num(s.labelHeightMm, 8, 60, 25),
    labelShowFront: s.labelShowFront !== false,
    labelShowBack: s.labelShowBack !== false,
    labelFrontCompany: s.labelFrontCompany !== false,
    labelFrontName: s.labelFrontName !== false,
    labelFrontRate: s.labelFrontRate !== false,
    labelBackSku: s.labelBackSku !== false,
    labelBackName: s.labelBackName === true,
    labelFrontSku: s.labelFrontSku !== false,
    labelBackCompany: s.labelBackCompany !== false,
    labelBackProduct: s.labelBackProduct !== false,
    labelFrontFontSizeMm: num(s.labelFrontFontSizeMm, 1, 10, 0),
    labelFrontFontAlign: ['center', 'right'].includes(String(s.labelFrontFontAlign)) ? (s.labelFrontFontAlign as 'center' | 'right') : 'right',
    labelFrontTextPosition: ['center', 'top'].includes(String(s.labelFrontTextPosition)) ? (s.labelFrontTextPosition as 'center' | 'top') : 'bottom',
    labelBackFontSizeMm: num(s.labelBackFontSizeMm, 1, 10, 0),
    labelBackFontAlign: ['center', 'right'].includes(String(s.labelBackFontAlign)) ? (s.labelBackFontAlign as 'center' | 'right') : 'left',
    labelBackTextPosition: ['center', 'bottom'].includes(String(s.labelBackTextPosition)) ? (s.labelBackTextPosition as 'center' | 'bottom') : 'top',
    labelBorder: s.labelBorder !== false,
    labelBackgroundColor: hex(s.labelBackgroundColor, '#ffffff'),
    labelRadiusMm: num(s.labelRadiusMm, 0, 5, 1),
  }
}

/** Minimal shape the builder needs — Invoice, Quotation and the sample doc all satisfy it. */
export interface PrintDoc {
  number: string
  shopifyOrder?: string
  customer: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  customerAddress?: string | null
  customerCity?: string | null
  customerState?: string | null
  customerPincode?: string | null
  /** Buyer GSTIN (sales_invoices.buyer_gstin) — drives intra vs inter-state. */
  customerGstin?: string | null
  businessName?: string
  businessGstin?: string | null
  businessAddress?: string | null
  businessPhone?: string | null
  businessEmail?: string | null
  gst: number
  gstAmount: number
  discount: number
  subtotal: number
  grandTotal: number
  paymentMethod?: string
  paymentStatus?: string
  date: string
  items?: Array<Record<string, unknown>>
}

/**
 * Map a PERSISTED invoice onto the print document — the only path from an
 * invoice to paper. The invoice screen and the printed page render the same
 * saved values (subtotal, gst rate, gst amount, discount, grand total and the
 * per-item snapshots); printing never recalculates business amounts.
 *
 * `business` lets the caller override with live Settings values (business
 * name/GSTIN/address/phone/email), mirroring what the invoice detail screen
 * does; `imagesBySku` supplies optional product thumbnails.
 */
export function invoicePrintDoc(
  invoice: Invoice,
  opts: { imagesBySku?: ReadonlyMap<string, string>; business?: Partial<PrintDoc> } = {},
): PrintDoc {
  const doc: PrintDoc = {
    number: invoice.number,
    shopifyOrder: invoice.shopifyOrder,
    customer: invoice.customer,
    customerEmail: invoice.customerEmail,
    customerPhone: invoice.customerPhone ?? null,
    customerAddress: invoice.customerAddress ?? null,
    customerCity: invoice.customerCity ?? null,
    customerState: invoice.customerState ?? null,
    customerPincode: invoice.customerPincode ?? null,
    customerGstin: invoice.buyerGstin ?? invoice.customerGstin ?? null,
    businessName: invoice.businessName,
    businessGstin: invoice.businessGstin ?? null,
    businessAddress: invoice.businessAddress ?? null,
    businessPhone: invoice.businessPhone ?? null,
    businessEmail: invoice.businessEmail ?? null,
    gst: invoice.gst,
    gstAmount: invoice.gstAmount,
    discount: invoice.discount,
    subtotal: invoice.subtotal,
    grandTotal: invoice.grandTotal,
    paymentMethod: invoice.paymentMethod,
    paymentStatus: invoice.paymentStatus,
    date: invoice.date,
    items: invoice.items.map((i) => ({
      product: i.product,
      sku: i.sku,
      hsn: i.hsn,
      qty: i.qty,
      weight: i.weight,
      silverRate: i.silverRate,
      makingCharge: i.makingCharge,
      tax: i.tax,
      amount: i.amount,
      image: opts.imagesBySku?.get(i.sku),
    })),
  }
  if (opts.business) Object.assign(doc, opts.business)
  return doc
}

/** Open one or more built documents in print windows (batch = one window per
 *  doc). The print chooser is shown ONCE for the whole batch, and a Cancel
 *  aborts every document — asking per-document would spam a dialog per order. */
export async function printDocuments(
  batch: Array<{ doc: PrintDoc; config: PrintDesignerConfig; extras: PrintDocExtras }>,
): Promise<void> {
  const picked = await choosePrintMode()
  if (picked === 'cancel') return
  for (const b of batch) printDocument(b.doc, b.config, b.extras, picked)
}

export interface PrintDocExtras {
  docType: 'invoice' | 'quotation' | 'order' | 'packing-slip' | 'pick-list' | 'barcode-label'
  /** Sub-line under the business name in the header. */
  tagline?: string
  /** Extra key/value box (e.g. "Valid Until" on quotations). */
  extraBox?: { label: string; value: string }
  /** Extra line under the customer (e.g. quotation notes). */
  notes?: string
  /** Label for the customer box (default "Bill To"; quotations use "Prepared For"). */
  billToLabel?: string
  /** Label for the grand total row (default "GRAND TOTAL"; quotations use "QUOTED TOTAL"). */
  totalLabel?: string
  /** Optional terms paragraph printed after the totals (quotations). */
  terms?: string
  /** Show product thumbnails on fulfilment docs (packing slip / pick list). */
  showImages?: boolean
}

const FONTS: Record<PrintDesignerConfig['font'], string> = {
  inter: "'Inter', 'Segoe UI', Arial, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  arial: "Arial, Helvetica, sans-serif",
}

const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

const lighten = (hex: string, amount: number): string => {
  const n = hex.replace('#', '')
  const r = parseInt(n.slice(0, 2), 16)
  const g = parseInt(n.slice(2, 4), 16)
  const b = parseInt(n.slice(4, 6), 16)
  const mix = (c: number) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0')
  return `#${mix(r)}${mix(g)}${mix(b)}`
}

interface LabelItem {
  product: string
  sku: string
  rate: number
  weight: number
}

function labelItemsFromDoc(doc: PrintDoc): LabelItem[] {
  const raw = (doc.items ?? []) as Array<Record<string, unknown>>
  const d = doc as any
  const items = raw.map((i: any) => ({
    product: String(i.product ?? i.name ?? i.description ?? d.productName ?? ''),
    sku: String(i.sku ?? i.code ?? d.sku ?? ''),
    rate: Number(i.sellingPrice ?? i.rate ?? i.amount ?? i.price ?? d.rate ?? 0),
    weight: Number(i.weight ?? i.netWeight ?? 0),
  }))
  return items.length > 0
    ? items
    : [{
        product: String(d.productName ?? '92.5 Sterling Silver Pendant'),
        sku: String(d.sku ?? 'SL-PD-001'),
        rate: Number(d.rate ?? 3250),
        weight: 2.8,
      }]
}

/**
 * Build an A4 sheet of product labels at true physical size.
 *
 * Every label is laid out in `mm` inside a CSS grid whose column/row count is
 * derived from the real label dimensions, so 50×25, 50×22, 35×22, 50×10 and
 * custom sizes all print at the exact size with no scaling. Front and back
 * sides print as consecutive sheets so duplex printers can flip the stock.
 */
export function buildBarcodeLabelHtml(doc: PrintDoc, config: PrintDesignerConfig, _extras: PrintDocExtras): string {
  const c = config
  const { width: lw, height: lh } = resolveLabelSize(c)
  const items = labelItemsFromDoc(doc)
  const companyName = doc.businessName || 'OPAL LINE JEWELS LLP'
  const fontStack = FONTS[c.font]
  const accent2 = c.accent2
  const radius = `${Math.max(0, (c.labelRadiusMm ?? 1))}mm`

  // Font sizes derived from the physical label height so every preset fits.
  const fsFront = (c.labelFrontFontSizeMm && c.labelFrontFontSizeMm > 0) ? c.labelFrontFontSizeMm : Math.max(2.4, Math.min(3.6, lh * 0.16))
  const fsBack = (c.labelBackFontSizeMm && c.labelBackFontSizeMm > 0) ? c.labelBackFontSizeMm : Math.max(2.2, Math.min(3.4, lh * 0.15))

  const frontLabel = (it: LabelItem) => `
    <div class="lbl">
      <div class="lbl-inner lbl-front">
        ${c.labelFrontSku !== false ? `<div class="sku">${escapeHtml(it.sku || '')}</div>` : ''}
        ${c.labelFrontRate ? `<div class="rate">₹${fmt(it.rate)}</div>` : ''}
      </div>
    </div>`

  const backLabel = (it: LabelItem) => `
    <div class="lbl">
      <div class="lbl-inner lbl-back">
        ${c.labelBackCompany !== false ? `<div class="company">${escapeHtml(companyName)}</div>` : ''}
        ${c.labelBackProduct !== false ? `<div class="pname">${escapeHtml(it.product)}</div>` : ''}
      </div>
    </div>`

  const sideSheet = (render: (it: LabelItem) => string) => `
    <div class="sheet">
      ${render(items[0])}
    </div>`

  const sheets =
    (c.labelShowFront ? sideSheet(frontLabel) : '') +
    (c.labelShowBack ? sideSheet(backLabel) : '')

   return `<!doctype html><html><head><title>Product Labels</title><style>
      @page{size:${lw}mm ${lh}mm;margin:0;}
      *{margin:0;padding:0;box-sizing:border-box;}
      body{font-family:${fontStack};color:#232733;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;margin:0;padding:0;}
      .sheet{width:${lw}mm;height:${lh}mm;padding:0;margin:0;page-break-after:avoid;display:flex;align-items:flex-start;justify-content:flex-start;}
      .sheet:last-child{page-break-after:avoid;}
      .lbl{width:${lw}mm;height:${lh}mm;${c.labelBorder !== false ? `border:0.15mm solid #00000055;` : 'border:none;'}border-radius:${radius};overflow:hidden;background:${c.labelBackgroundColor || '#ffffff'};flex:none;box-sizing:border-box;margin:0;}
      .lbl-inner{width:100%;height:100%;display:flex;flex-direction:column;gap:0.3mm;box-sizing:border-box;padding:0.4mm 0.5mm;justify-content:center;align-items:center;}
      .lbl-front{justify-content:center;align-items:center;}
      .lbl-back{justify-content:center;align-items:center;}
      .sku{font-size:${fsFront}mm;font-weight:800;color:${accent2};letter-spacing:.01em;text-align:center;line-height:1.1;word-break:break-word;}
      .rate{font-size:${fsFront}mm;font-weight:900;color:${accent2};text-align:center;line-height:1.1;}
      .company{font-size:${fsBack}mm;font-weight:800;color:${accent2};white-space:normal;overflow:visible;text-overflow:clip;letter-spacing:.01em;text-align:center;line-height:1.08;word-break:break-word;}
      .pname{font-size:${fsBack}mm;font-weight:700;color:#1f2937;line-height:1.05;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-align:center;word-break:break-word;}
      @media print{body{background:#fff;margin:0;padding:0;} .sheet{padding:0;margin:0;} .lbl{border-color:#000;}}
      @media screen{body{display:flex;flex-wrap:wrap;gap:4mm;justify-content:center;align-items:flex-start;padding:6mm;background:#eef0f4;} .sheet{margin:0;}}
    </style></head><body>${sheets}</body></html>`

}

/**
 * Build the complete printable HTML document (A4/Letter, print-CSS ready).
 * The returned string is opened in a print window or embedded in an iframe.
 */
/**
 * Reconcile per-line GST with the document's stored GST money for invoices
 * whose rows never got a line-level tax snapshot (legacy rows store tax: 0
 * while gstAmount is real — this is why the printed GST column used to dash
 * every line even though the summary showed CGST/SGST).
 *
 * The stored document GST is apportioned across lines by their amount share
 * with largest-remainder rounding, so the printed column sums EXACTLY to the
 * printed Total GST. It only splits what is already stored — it never derives
 * a second GST base, so nothing is added twice. Lines that already carry tax
 * are returned untouched. Only invoices reconcile: orders legitimately dash.
 */
function applyLineTax(items: Array<Record<string, unknown>>, docGst: number): Array<Record<string, unknown>> {
  if (!(docGst > 0) || items.length === 0) return items
  if (items.some((it) => Number(it.tax) > 0)) return items
  const amounts = items.map((it) => Math.max(0, Number(it.amount) || 0))
  const base = amounts.reduce((a, b) => a + b, 0)
  if (!(base > 0)) return items
  // Largest-remainder: floor every line to paise, then hand leftover cents to
  // the largest fractional parts so the column adds up to the stored total.
  const shares = amounts.map((amount) => {
    const exact = (docGst * amount * 100) / base
    return { cents: Math.floor(exact), frac: exact - Math.floor(exact) }
  })
  let leftover = Math.round(docGst * 100) - shares.reduce((s, sh) => s + sh.cents, 0)
  shares
    .map((sh, i) => ({ i, frac: sh.frac }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (leftover > 0) {
        shares[i].cents += 1
        leftover -= 1
      }
    })
  return items.map((it, i) => ({ ...it, tax: shares[i].cents / 100 }))
}

export function buildPrintHtml(doc: PrintDoc, config: PrintDesignerConfig, extras: PrintDocExtras): string {
  if (extras.docType === 'barcode-label') return buildBarcodeLabelHtml(doc, config, extras)
  const c = config
  const docItems = doc.items ?? []
  const gstRate = Number(doc.gst) || 0
  // GST is charged on the subtotal (the sum of the printed line amounts), so
  // the printed "Taxable Value" IS the subtotal — the discount gets its own
  // row further down and must not be subtracted twice. With this base the
  // printed rows add up to the persisted grand total (subtotal + GST − discount).
  const taxable = Math.max(0, Number(doc.subtotal) || 0)
  const totalTax = Number(doc.gstAmount) || 0
  // Invoice lines historically stored no per-line GST snapshot (tax: 0) while
  // the invoice-level gstAmount was real — the printed GST column dashed every
  // row because of it. Reconcile at render time so each line carries its share
  // of the STORED document GST (never a freshly derived base → no double count).
  const items = extras.docType === 'invoice' ? applyLineTax(docItems, totalTax) : docItems
  // Supply type: a buyer GSTIN in another state than the business GSTIN means
  // an inter-state supply, taxed as IGST instead of CGST + SGST — the same
  // GSTIN-prefix rule backend/src/purchases.ts uses for the input-tax split.
  const stateCode = (g: unknown) => (/^\d{2}/.test(String(g ?? '')) ? String(g).slice(0, 2) : null)
  const bizStateCode = stateCode(doc.businessGstin)
  const buyStateCode = stateCode(doc.customerGstin)
  const interState = bizStateCode !== null && buyStateCode !== null && bizStateCode !== buyStateCode
  const halfTax = Math.round((totalTax / 2) * 100) / 100
  const hsnCodes = [...new Set(items.map((i) => String(i.hsn ?? '')).filter(Boolean))]
  const hsnDisplay = hsnCodes.length > 0 ? hsnCodes.join(', ') : '7113'
  const totalWeight = items.reduce((a, i) => a + (Number(i.weight) || 0), 0)
  const totalQty = items.reduce((a, i) => a + (Number(i.qty) || 0), 0)
  const accentSoft = lighten(c.accent, 0.82)
  const accentSoft2 = lighten(c.accent, 0.93)
  const radius = `${c.cornerRadius}px`
  const pageWidth = c.pageSize === 'letter' ? '216mm' : '210mm'
  const docLabel =
    extras.docType === 'quotation' ? 'QUOTATION'
    : extras.docType === 'order' ? 'SALES ORDER'
    : extras.docType === 'packing-slip' ? 'PACKING SLIP'
    : extras.docType === 'pick-list' ? 'PICK LIST'
    : 'TAX INVOICE'
  const docNumberLabel =
    extras.docType === 'quotation' ? 'Quotation No'
    : extras.docType === 'order' ? 'Order No'
    : extras.docType === 'packing-slip' || extras.docType === 'pick-list' ? 'Order No'
    : 'Invoice No'
  const tagline = extras.tagline || '92.5 Sterling Silver Jewellery'
  // Fulfilment documents (packing slip / pick list) are internal: no GST
  // math, no amounts, no payment box — just products, SKUs and quantities.
  const fulfilmentDoc = extras.docType === 'packing-slip' || extras.docType === 'pick-list'

  const cellBorder =
    c.borderStyle === 'full' ? 'border:1px solid #e5e7eb;' : c.borderStyle === 'rows' ? 'border-bottom:1px solid #e5e7eb;' : ''
  const headBg =
    c.tableHeaderStyle === 'dark' ? `background:#1a1a2e;color:#fff;` : c.tableHeaderStyle === 'accent' ? `background:${c.accent};color:#1a1a2e;` : `background:${accentSoft2};color:#374151;border-bottom:2px solid ${c.accent};`
  const zebra = (idx: number) => (c.tableZebra && idx % 2 === 0 ? `background:#fafafa;` : '')

  // Fulfilment rows: product + SKU + qty (+ weight), with tick boxes on pick
  // lists so staff can mark each line as collected. Optional thumbnails when
  // the caller supplies image URLs per item.
  const fulfilmentRows = items
    .map((i, idx) => {
      const tick = extras.docType === 'pick-list'
        ? `<td style="padding:7px 10px;${cellBorder}width:34px;"><span style="display:inline-block;width:16px;height:16px;border:2px solid ${c.accent2};border-radius:3px;"></span></td>`
        : ''
      const imgSrc = typeof i.image === 'string' && i.image ? i.image : ''
      // The header reserves the image column whenever showImages is on, so
      // EVERY row must emit the cell too — otherwise a product without an
      // image shifts its whole row one column left in the PDF (Making Value
      // under Rate, GST under MAKING VALUE, Amount under GST AMOUNT).
      const imgCell = extras.showImages
        ? `<td style="padding:6px 8px;${cellBorder}width:56px;">${imgSrc ? `<img src="${escapeHtml(imgSrc)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid #e5e7eb;" onerror="this.style.display='none'"/>` : ''}</td>`
        : ''
      return `<tr style="${zebra(idx)}">
          ${tick}
          ${imgCell}
          <td style="padding:7px 10px;${cellBorder}font-size:11px;">${escapeHtml(String(i.product ?? ''))}<br/><span style="color:#8a8fa3;font-size:9px;">${escapeHtml(String(i.sku ?? ''))}</span></td>
          <td style="padding:7px 10px;${cellBorder}font-size:11px;text-align:right;">${Number(i.qty) || 0}</td>
          ${c.showWeight ? `<td style="padding:7px 10px;${cellBorder}font-size:11px;text-align:right;">${(Number(i.weight) || 0).toFixed(2)}</td>` : ''}
        </tr>`
    })
    .join('')
  const fulfilmentHeadCols =
    (extras.docType === 'pick-list' ? `<th style="width:34px;"></th>` : '') +
    (extras.showImages ? `<th style="width:56px;"></th>` : '') +
    `<th>Product</th><th style="text-align:right;">Qty</th>` +
    (c.showWeight ? `<th style="text-align:right;">Weight (g)</th>` : '')

  // 0 in the rate/making/tax snapshot columns means "unknown" (order-raised
  // items carry no rate or making snapshot) — dash it exactly like the
  // invoice screen does, instead of printing a misleading ₹0.00 / 0%.
  // `tax` holds a MONEY amount (the per-line GST), never a percentage.
  const money = (v: unknown) => (Number(v) > 0 ? `₹${fmt(Number(v))}` : '—')

  const itemRows = items
    .map((i, idx) => {
      const imgSrc = typeof i.image === 'string' && i.image ? i.image : ''
      // The header reserves the image column whenever showImages is on, so
      // EVERY row must emit the cell too — otherwise a product without an
      // image shifts its whole row one column left in the PDF (Making Value
      // under Rate, GST under MAKING VALUE, Amount under GST AMOUNT).
      const imgCell = extras.showImages
        ? `<td style="padding:6px 8px;${cellBorder}width:56px;">${imgSrc ? `<img src="${escapeHtml(imgSrc)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid #e5e7eb;" onerror="this.style.display='none'"/>` : ''}</td>`
        : ''
      const lineMakingValue = (Number(i.weight) || 0) * (Number(i.makingCharge) || 0)
      // AMOUNT column = taxable line amount + that line's GST — the gross the
      // customer pays for the line (confirmed replacement for the old ex-GST
      // figure); the GST portion stays separately visible in GST AMOUNT.
      const lineAmount = (Number(i.amount) || 0) + (Number(i.tax) || 0)
      return `<tr style="${zebra(idx)}">
          ${imgCell}
          <td style="padding:7px 10px;${cellBorder}font-size:11px;">${escapeHtml(String(i.product ?? ''))}<br/><span style="color:#8a8fa3;font-size:9px;">${escapeHtml(String(i.sku ?? ''))}</span></td>
          ${c.showHsn ? `<td style="padding:7px 10px;${cellBorder}font-size:11px;text-align:center;">${escapeHtml(String(i.hsn ?? hsnDisplay))}</td>` : ''}
          <td style="padding:7px 10px;${cellBorder}font-size:11px;text-align:right;">${Number(i.qty) || 0}</td>
          ${c.showWeight ? `<td style="padding:7px 10px;${cellBorder}font-size:11px;text-align:right;">${(Number(i.weight) || 0).toFixed(2)}</td>` : ''}
          ${c.showRate ? `<td style="padding:7px 10px;${cellBorder}font-size:11px;text-align:right;">${money(i.silverRate)}</td><td style="padding:7px 10px;${cellBorder}font-size:11px;text-align:right;">${money(lineMakingValue)}</td>` : ''}
          ${c.showTax ? `<td style="padding:7px 10px;${cellBorder}font-size:11px;text-align:right;">${money(i.tax)}</td>` : ''}
          <td style="padding:7px 10px;${cellBorder}font-size:11px;text-align:right;font-weight:600;">₹${fmt(lineAmount)}</td>
        </tr>`
    })
    .join('')

  const headCols =
    (extras.showImages ? `<th style="width:56px;"></th>` : '') +
    `<th>Product</th>` +
    (c.showHsn ? `<th style="text-align:center;">HSN</th>` : '') +
    `<th style="text-align:right;">Qty</th>` +
    (c.showWeight ? `<th style="text-align:right;">Weight (g)</th>` : '') +
    (c.showRate ? `<th style="text-align:right;">Rate (₹/g)</th><th style="text-align:right;">Making Value (₹)</th>` : '') +
    (c.showTax ? `<th style="text-align:right;">GST AMOUNT (₹)</th>` : '') +
    `<th style="text-align:right;">Amount (₹)</th>`
  const footSpans =
    `<td colspan="${(extras.showImages ? 1 : 0) + (c.showHsn ? 2 : 1)}" style="padding:7px 10px;border-top:2px solid ${c.accent};font-size:10px;">Total: ${totalQty} item(s)</td>` +
    `<td style="padding:7px 10px;border-top:2px solid ${c.accent};text-align:right;font-size:10px;">${totalQty}</td>` +
    (c.showWeight ? `<td style="padding:7px 10px;border-top:2px solid ${c.accent};text-align:right;font-size:10px;">${totalWeight.toFixed(2)} g</td>` : '') +
    (c.showRate ? `<td colspan="2"></td>` : '') +
    (c.showTax ? `<td></td>` : '') +
    `<td style="padding:7px 10px;border-top:2px solid ${c.accent};text-align:right;font-size:11px;">₹${fmt(doc.grandTotal)}</td>`

  const logoImg = c.showLogo && c.logoDataUrl ? `<img class="logo" src="${c.logoDataUrl}" alt="logo"/>` : ''
  const logoLeft = c.logoAlign === 'left'

  const businessLines = `
          <h1>${escapeHtml(doc.businessName || 'OPAL LINE JEWELS LLP')}</h1>
          ${c.showTagline ? `<div class="sub">${escapeHtml(tagline)}</div>` : ''}
          ${c.showGSTIN && doc.businessGstin ? `<div class="sub">GSTIN: ${escapeHtml(doc.businessGstin)}</div>` : ''}
          ${doc.businessAddress ? `<div class="sub">${escapeHtml(doc.businessAddress)}</div>` : ''}
          ${doc.businessPhone || doc.businessEmail ? `<div class="sub">${[doc.businessPhone, doc.businessEmail].filter(Boolean).map((v) => escapeHtml(String(v))).join(' · ')}</div>` : ''}`

  const headerBlock =
    c.headerStyle === 'banner'
      ? `<div class="header-banner">
        ${logoLeft ? logoImg : ''}
        <div style="flex:1;">${businessLines}</div>
        ${!logoLeft ? logoImg : ''}
        <div class="badge" style="background:${c.accent};">${docLabel}</div>
      </div>`
      : c.headerStyle === 'modern'
        ? `<div class="header-modern">
        <div class="modern-left" style="${logoLeft ? '' : 'flex-direction:row-reverse;'}">${logoImg}<div>${businessLines}</div></div>
        <div style="text-align:right;">
          <div class="modern-label" style="color:${c.accent};">${docLabel}</div>
          <div class="modern-number">${escapeHtml(doc.number)}</div>
        </div>
      </div>
      <div class="modern-rule" style="background:linear-gradient(90deg, ${c.accent}, ${c.accent2});"></div>`
        : c.headerStyle === 'minimal'
          ? `<div class="header-minimal">
        <div style="display:flex;align-items:center;gap:12px;${logoLeft ? '' : 'flex-direction:row-reverse;'}">${logoImg}<div>${businessLines}</div></div>
        <div class="minimal-badge" style="color:${c.accent};border-color:${c.accent};">${docLabel}</div>
      </div>`
          : `<div class="header-boxed">
        <div class="boxed-inner" style="border-color:${c.accent};border-radius:${radius};">
          ${logoLeft ? logoImg : ''}
          <div style="flex:1;">${businessLines}</div>
          ${!logoLeft ? logoImg : ''}
          <div class="boxed-badge" style="background:${c.accent};">${docLabel}</div>
        </div>
      </div>`

  const infoBoxes = c.showContactBoxes
    ? `<div class="header-row">
        <div class="info-row">
          <div class="info-box">
            <div class="label">${docNumberLabel}</div>
            <div class="value">${escapeHtml(doc.number)}</div>
          </div>
          <div class="info-box">
            <div class="label">Date</div>
            <div class="value">${escapeHtml(fmtDate(doc.date))}</div>
          </div>
          ${c.showPayment && doc.paymentMethod ? `<div class="info-box"><div class="label">Payment</div><div class="value">${escapeHtml(doc.paymentMethod)}</div><div class="detail">${escapeHtml(doc.paymentStatus ?? '')}</div></div>` : ''}
          ${extras.extraBox ? `<div class="info-box"><div class="label">${escapeHtml(extras.extraBox.label)}</div><div class="value">${escapeHtml(extras.extraBox.value)}</div></div>` : ''}
        </div>
      </div>`
    : ''

  const supplyLine = interState ? `Inter-state supply · IGST @ ${gstRate}%` : `Intra-state supply · GST @ ${gstRate}%`
  const gstinLine =
    extras.docType !== 'order'
      ? `<div class="meta-line">${c.showGSTIN && doc.businessGstin ? `GSTIN: ${escapeHtml(doc.businessGstin)} · ` : ''}${supplyLine}</div>`
      : `<div class="meta-line">${supplyLine}</div>`

  const watermark = c.watermark
    ? `<div class="watermark" style="color:${c.accent};">${escapeHtml(c.watermark)}</div>`
    : ''

  const signatoryFor = c.signatoryName
    ? `For ${escapeHtml(c.signatoryName)}<br/><span style="font-size:8px;">Authorised Signatory</span>`
    : `For ${escapeHtml(doc.businessName || 'OPAL LINE JEWELS LLP')}<br/><span style="font-size:8px;">Authorised Signatory</span>`

  const qrBlock =
    c.showQr && c.qrDataUrl
      ? `<div class="qr-block">
          <img src="${c.qrDataUrl}" alt="QR" style="width:88px;height:88px;object-fit:contain;border:1px solid #e5e7eb;border-radius:${radius};padding:4px;background:#fff;"/>
          ${c.qrCaption ? `<div class="qr-caption">${escapeHtml(c.qrCaption)}</div>` : ''}
        </div>`
      : ''

  return `<!doctype html><html><head><title>${escapeHtml(doc.number)}</title><style>
      *{margin:0;padding:0;box-sizing:border-box;}
      body{font-family:${FONTS[c.font]};color:#232733;margin:0;padding:${c.margins.top}mm ${c.margins.right}mm ${c.margins.bottom}mm ${c.margins.left}mm;background:${c.paperTint === 'cream' ? '#fdfbf5' : '#fff'};font-size:${(11 * c.fontScale).toFixed(1)}px;max-width:${pageWidth};}
      .header-banner{background:linear-gradient(135deg, ${c.accent2} 0%, #2a2a45 100%);color:#fff;padding:14px 20px;border-radius:${radius};margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:12px;box-shadow:0 1px 3px rgba(15,23,42,.18);}
      .header-banner h1{font-size:${(20 * c.fontScale).toFixed(0)}px;font-weight:800;letter-spacing:.4px;}
      .header-banner .sub{color:#aab3c5;font-size:${(9 * c.fontScale).toFixed(0)}px;margin-top:2px;}
      .header-banner .logo{max-height:46px;max-width:120px;object-fit:contain;background:#fff;border-radius:4px;padding:3px;}
      .badge{display:inline-block;padding:6px 16px;font-size:${(10 * c.fontScale).toFixed(0)}px;font-weight:800;letter-spacing:1.6px;border-radius:${radius};color:#1a1a2e;white-space:nowrap;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35);}
      .header-modern{display:flex;justify-content:space-between;align-items:flex-start;padding:4px 2px 12px;}
      .modern-left{display:flex;align-items:center;gap:14px;}
      .header-modern h1{font-size:${(20 * c.fontScale).toFixed(0)}px;font-weight:800;color:#1a1a2e;}
      .header-modern .sub{color:#6b7280;font-size:${(9 * c.fontScale).toFixed(0)}px;margin-top:2px;}
      .header-modern .logo{max-height:48px;max-width:130px;object-fit:contain;}
      .modern-label{font-size:${(11 * c.fontScale).toFixed(0)}px;font-weight:800;letter-spacing:2.5px;}
      .modern-number{font-size:${(13 * c.fontScale).toFixed(0)}px;font-weight:700;color:#374151;margin-top:3px;}
      .modern-rule{height:3px;border-radius:2px;margin-bottom:18px;}
      .header-minimal{display:flex;justify-content:space-between;align-items:center;padding:6px 0 14px;border-bottom:2px solid #1a1a2e;margin-bottom:18px;}
      .header-minimal h1{font-size:${(18 * c.fontScale).toFixed(0)}px;font-weight:700;color:#1a1a2e;}
      .header-minimal .sub{color:#6b7280;font-size:${(9 * c.fontScale).toFixed(0)}px;margin-top:2px;}
      .header-minimal .logo{max-height:44px;max-width:120px;object-fit:contain;}
      .minimal-badge{font-size:${(10 * c.fontScale).toFixed(0)}px;font-weight:700;letter-spacing:1.5px;border:2px solid;border-radius:${radius};padding:4px 12px;white-space:nowrap;}
      .header-boxed{margin-bottom:18px;}
      .boxed-inner{display:flex;justify-content:space-between;align-items:center;gap:12px;border:2px solid;border-radius:${radius};padding:15px 18px;}
      .header-boxed h1{font-size:${(18 * c.fontScale).toFixed(0)}px;font-weight:700;color:#1a1a2e;}
      .header-boxed .sub{font-size:${(9 * c.fontScale).toFixed(0)}px;margin-top:2px;color:#6b7280;}
      .header-boxed .logo{max-height:42px;max-width:115px;object-fit:contain;}
      .boxed-badge{color:#1a1a2e;font-size:${(10 * c.fontScale).toFixed(0)}px;font-weight:800;letter-spacing:1.5px;border-radius:${radius};padding:6px 16px;white-space:nowrap;}
      .header-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
      .info-row{display:flex;gap:8px;flex:1;}
      .info-box{background:${accentSoft2};border:1px solid ${accentSoft};border-radius:${radius};padding:9px 12px;flex:1;}
      .info-box .label{font-size:7.5px;font-weight:700;color:#8a8fa3;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:4px;}
      .info-box .value{font-size:12px;font-weight:700;color:#1f2937;}
      .info-box .detail{font-size:10px;color:#6b7280;margin-top:2px;text-transform:capitalize;}
      .billto-row{display:flex;gap:12px;margin-bottom:10px;}
      .billto-box{background:${accentSoft2};border:1px solid ${accentSoft};border-radius:${radius};padding:10px 12px;flex:1;}
      .billto-box .label{font-size:7.5px;font-weight:700;color:#8a8fa3;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px;}
      .billto-box .name{font-size:13px;font-weight:700;color:#1f2937;margin-bottom:3px;}
      .billto-box .detail{font-size:10px;color:#6b7280;line-height:1.55;}
      .meta-line{font-size:10px;color:#8a8fa3;margin-bottom:10px;}
      table.items{width:100%;border-collapse:collapse;margin-bottom:12px;border-radius:${radius};overflow:hidden;}
      ${c.borderStyle === 'full' ? `table.items{border:1px solid #e5e7eb;}` : ''}
      table.items thead th{${headBg}padding:8px 10px;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;text-align:left;}
      table.items thead th:last-child{text-align:right;}
      table.items tbody td{padding:7px 10px;font-size:11px;}
      table.items tfoot td{background:#f6f7f9;font-weight:600;}
      .totals-wrap{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px;}
      .totals-box{margin-left:auto;width:280px;background:${accentSoft2};border:1px solid ${accentSoft};border-radius:${radius};padding:12px 14px;}
      .totals-box .row{display:flex;justify-content:space-between;padding:3px 0;font-size:11px;color:#374151;}
      .totals-box .grand{display:flex;justify-content:space-between;padding-top:8px;font-size:14px;font-weight:800;color:#1a1a2e;border-top:2px solid ${c.accent};margin-top:6px;}
      .amount-words{background:#fef7e0;border:1px solid #f3e3b3;border-radius:${radius};padding:8px 12px;font-size:10px;color:#92400e;margin:0 0 12px;}
      .amount-words b{color:#78350f;}
      .footer{border-top:1px solid #e5e7eb;padding-top:8px;margin-top:2px;clear:both;}
      .declaration{font-size:9px;color:#6b7280;line-height:1.65;margin-bottom:${c.showSignature ? '10px' : '4px'};max-width:65%;}
      .signatures{display:flex;justify-content:space-between;margin-top:12px;}
      .sig-block{text-align:center;width:150px;}
      .sig-line{border-top:1px solid #d1d5db;margin-top:28px;padding-top:4px;font-size:9px;color:#6b7280;}
      .gen-footer{text-align:center;font-size:8px;color:#9ca3af;margin-top:10px;padding-top:6px;border-top:1px solid #f3f4f6;}
      .footnote{font-size:9px;color:#6b7280;margin-top:10px;}
      .bank{font-size:9.5px;color:#374151;background:${accentSoft2};border:1px solid ${accentSoft};border-radius:${radius};padding:9px 12px;margin-top:10px;white-space:pre-line;}
      .thanks{font-size:11px;font-weight:700;color:${c.accent2};margin-top:6px;}
      .qr-block{float:left;text-align:center;margin:4px 0 10px;}
      .qr-caption{font-size:8.5px;color:#6b7280;margin-top:3px;}
      .watermark{position:fixed;top:45%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:72px;font-weight:800;opacity:.08;letter-spacing:10px;pointer-events:none;white-space:nowrap;}
      .terms{border-top:1px solid #e5e7eb;padding-top:12px;margin-top:14px;font-size:9px;color:#6b7280;line-height:1.6;max-width:65%;clear:both;}
      .fulfil-note{background:${accentSoft2};border:1px solid ${accentSoft};border-radius:${radius};padding:10px 14px;font-size:10px;color:#374151;margin-bottom:16px;}
      @page{size:${c.pageSize === 'letter' ? 'letter' : 'A4'};margin:0;}
      @media print{
        body{font-size:10px;}
        .header-banner{background:linear-gradient(135deg, ${c.accent2} 0%, #2a2a45 100%) !important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        table.items thead th{${headBg} -webkit-print-color-adjust:exact;print-color-adjust:exact;}
        .badge,.boxed-badge{background:${c.accent} !important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        .info-box,.billto-box,.totals-box,.amount-words,.bank{background:${accentSoft2} !important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        .watermark{display:none;}
      }
    </style></head><body>
      ${watermark}
      ${headerBlock}
      ${infoBoxes}
      <div class="billto-row">
        <div class="billto-box">
          <div class="label">${escapeHtml(extras.billToLabel ?? 'Bill To')}</div>
          <div class="name">${escapeHtml(doc.customer || 'Guest')}</div>
          <div class="detail">${[doc.customerEmail, doc.customerPhone].filter(Boolean).map((v) => escapeHtml(String(v))).join('<br/>')}</div>
          ${doc.customerAddress || doc.customerCity || doc.customerState || doc.customerPincode ? `<div class="detail" style="margin-top:4px;white-space:pre-line;">${escapeHtml([doc.customerAddress, [doc.customerCity, doc.customerState, doc.customerPincode].filter(Boolean).join(', ')].filter(Boolean).join('\n'))}</div>` : ''}
          ${extras.notes ? `<div class="detail" style="margin-top:6px;font-style:italic;">${escapeHtml(extras.notes)}</div>` : ''}
        </div>
        <div class="billto-box">
          <div class="label">Order Details</div>
          <div class="value">${escapeHtml(doc.shopifyOrder ?? '')}</div>
          ${gstinLine}
        </div>
      </div>
      <table class="items">
        <thead><tr>${fulfilmentDoc ? fulfilmentHeadCols : headCols}</tr></thead>
        <tbody>${fulfilmentDoc ? fulfilmentRows : itemRows}</tbody>
        ${fulfilmentDoc ? '' : `<tfoot><tr>${footSpans}</tr></tfoot>`}
      </table>
      ${fulfilmentDoc
        ? `<div class="fulfil-note">${extras.docType === 'pick-list'
            ? `Tick each line as it is collected from stock. ${totalQty} item(s) / ${totalWeight.toFixed(2)} g across ${items.length} line(s).`
            : `Package contents: ${totalQty} item(s) / ${totalWeight.toFixed(2)} g. Invoice is sent separately; do not include prices in the parcel.`}</div>`
        : `<div class="totals-wrap">
        ${qrBlock}
        <div class="totals-box">
          <div class="row"><span>Taxable Value</span><span>₹${fmt(taxable)}</span></div>
          ${gstRate > 0 ? (interState
            ? `<div class="row"><span>IGST @ ${gstRate}%</span><span>₹${fmt(totalTax)}</span></div>`
            : `<div class="row"><span>CGST @ ${gstRate / 2}%</span><span>₹${fmt(halfTax)}</span></div><div class="row"><span>SGST @ ${gstRate / 2}%</span><span>₹${fmt(halfTax)}</span></div><div class="row"><span>Total GST</span><span>₹${fmt(totalTax)}</span></div>`) : ''}
          ${Number(doc.discount) > 0 ? `<div class="row" style="color:#dc2626;"><span>Discount</span><span>- ₹${fmt(doc.discount)}</span></div>` : ''}
          <div class="grand"><span>${escapeHtml(extras.totalLabel ?? 'GRAND TOTAL')}</span><span>₹${fmt(doc.grandTotal)}</span></div>
        </div>
      </div>
      ${c.showAmountWords ? `<div class="amount-words"><b>Amount in Words:</b> ${escapeHtml(numberToIndianWords(Number(doc.grandTotal) || 0))} Rupees Only</div>` : ''}`}
      <div class="footer">
        ${!fulfilmentDoc && c.showDeclaration ? `<div class="declaration"><b>Declaration:</b> ${escapeHtml(c.declaration)}</div>` : ''}
        ${!fulfilmentDoc && extras.terms ? `<div class="terms"><b>Terms &amp; Conditions:</b> ${escapeHtml(extras.terms)}</div>` : ''}
        ${!fulfilmentDoc && c.bankDetails ? `<div class="bank"><b>Bank &amp; Payment Details:</b>\n${escapeHtml(c.bankDetails)}</div>` : ''}
        ${!fulfilmentDoc && c.footerNote ? `<div class="footnote">${escapeHtml(c.footerNote)}</div>` : ''}
        ${c.showSignature || fulfilmentDoc ? `<div class="signatures">
          <div class="sig-block"><div class="sig-line">${fulfilmentDoc ? 'Packed By' : 'Customer Signature'}</div></div>
          <div class="sig-block"><div class="sig-line">${fulfilmentDoc ? 'Checked By' : signatoryFor}</div></div>
        </div>` : ''}
        ${!fulfilmentDoc && c.thankYouNote ? `<div class="thanks">${escapeHtml(c.thankYouNote)}</div>` : ''}
      </div>
      <div class="gen-footer">Generated by ${escapeHtml(doc.businessName || 'Opal Line')} ERP · opalline.in</div>
    </body></html>`
}

/** Result of a desktop print/PDF/preview IPC call (see electron/print.ts). */
export interface PrintBridgeResult {
  ok: boolean
  error?: string
}

export interface PdfBridgeResult extends PrintBridgeResult {
  cancelled?: boolean
  path?: string
}

/** How a print job runs: straight to the OS default printer, or through the
 *  system print dialog (the Ctrl+P-style picker). */
export type PrintMode = 'silent' | 'dialog'
/** What the user picked in the "How do you want to print?" chooser: a print
 *  job, a PDF save, or abort. */
export type PrintModeChoice = PrintMode | 'pdf' | 'cancel'

interface PrintBridge {
  printHtml: (html: string, title?: string, mode?: PrintMode) => Promise<PrintBridgeResult>
  printPage: (mode?: PrintMode) => Promise<PrintBridgeResult>
  choosePrintMode?: () => Promise<PrintModeChoice>
  previewHtml: (html: string, title?: string) => Promise<PrintBridgeResult>
  exportPdf: (html: string, suggestedName?: string) => Promise<PdfBridgeResult>
  exportPdfPage?: (suggestedName?: string) => Promise<PdfBridgeResult>
}

function printBridge(): PrintBridge | undefined {
  return (window as unknown as { electronAPI?: PrintBridge }).electronAPI
}

const POPUP_BLOCKED_ERROR =
  'The print window was blocked by the browser — allow pop-ups for this site, then try again.'

/**
 * Open the built document in a popup that prints itself on load.
 * Returns false when the popup was refused. Callers must surface that: a
 * blocked window used to end in a "Labels saved as PDF" toast with no file
 * written anywhere, which is exactly what "Save as PDF does nothing" looked
 * like from the user's side.
 */
function popupWithPrint(html: string): boolean {
  const w = window.open('', '_blank', 'width=900,height=760')
  if (!w) return false
  w.opener = null
  w.document.write(html + `<script>window.onload=function(){window.focus();window.print();}</script>`)
  w.document.close()
  return true
}

/** Ask how to print: native chooser (Default printer / Save as PDF… /
 *  system print dialog / Cancel). Called once per user action, so a bulk
 *  batch is asked only once. The IPC is fired synchronously on call — callers
 *  kick it off BEFORE building the document so the dialog is already opening
 *  while the HTML renders. Plain browser (dev server / e2e, no bridge): the
 *  popup path there ends in the browser's own print dialog anyway, so answer
 *  'silent' directly. */
export async function choosePrintMode(): Promise<PrintModeChoice> {
  const api = printBridge()
  if (api?.choosePrintMode) {
    try {
      return await api.choosePrintMode()
    } catch (err) {
      console.warn('[print] chooser error:', err)
      return 'cancel'
    }
  }
  return 'silent'
}

/**
 * Send a built document to the printer.
 * *  Desktop app: the main process renders it in a hidden window and calls
 *  webContents.print() — 'silent' spools straight to the OS DEFAULT printer
 *  (no dialog, no app picker); 'dialog' opens the system print dialog (like
 *  Ctrl+P); 'pdf' saves a .pdf via a save dialog. window.open popups are
 *  denied there anyway, which is why printing used to do nothing.
 *
 *  Without an explicit `mode` the user is asked first (the print chooser).
 *  Plain browser (dev server / e2e): falls back to the old print popup.
 */
export async function printHtmlToPrinter(
  html: string,
  title?: string,
  mode?: PrintModeChoice,
): Promise<void> {
  const picked = mode ?? (await choosePrintMode())
  if (picked === 'cancel') return
  if (picked === 'pdf') {
    const res = await exportHtmlPdf(html, title)
    // A failed save must reach the caller — swallowing it is how a blocked
    // popup used to look like a successful export.
    if (!res.ok && !res.cancelled) throw new Error(res.error || 'PDF export failed')
    return
  }
  const api = printBridge()
  if (api?.printHtml) {
    try {
      const res = await api.printHtml(html, title, picked)
      if (!res.ok) console.warn('[print] failed:', res.error)
    } catch (err) {
      console.warn('[print] bridge error:', err)
    }
    return
  }
  if (!popupWithPrint(html)) throw new Error(POPUP_BLOCKED_ERROR)
}

/**
 * Print the CURRENT page (the flows that rely on @media print styling:
 * Dashboard, DayBook, the invoice dialog).
 * Desktop: a silent job on the app window's webContents → the OS default
 * printer, no dialog. Browser: window.print() as before.
 * Resolves when the dialog/job has finished, so callers can clean up
 * print-only state (e.g. the dashboard body class) afterwards.
 */
export async function printCurrentPage(mode?: PrintModeChoice, name?: string): Promise<void> {
  const picked = mode ?? (await choosePrintMode())
  if (picked === 'cancel') return
  if (picked === 'pdf') {
    const api = printBridge()
    if (api?.exportPdfPage) {
      try {
        const res = await api.exportPdfPage(name)
        if (!res.ok && !res.cancelled) console.warn('[print] page pdf failed:', res.error)
      } catch (err) {
        console.warn('[print] bridge error:', err)
      }
      return
    }
    // Plain browser: the browser's own print dialog includes "Save as PDF".
    window.print()
    return
  }
  const api = printBridge()
  if (api?.printPage) {
    try {
      const res = await api.printPage(picked)
      if (!res.ok) console.warn('[print] page print failed:', res.error)
    } catch (err) {
      console.warn('[print] bridge error:', err)
    }
    return
  }
  window.print()
}

/** Open a built document in a window WITHOUT printing (Print Designer preview). */
export async function openHtmlPreview(html: string, title?: string): Promise<void> {
  const api = printBridge()
  if (api?.previewHtml) {
    try {
      const res = await api.previewHtml(html, title)
      if (!res.ok) console.warn('[preview] failed:', res.error)
    } catch (err) {
      console.warn('[preview] bridge error:', err)
    }
    return
  }
  const w = window.open('', '_blank', 'width=900,height=760')
  if (!w) {
    // Preview is a look-only flow, so a blocked popup is reported rather than
    // thrown: the page keeps working and the console explains the silence.
    console.warn('[preview] blocked:', POPUP_BLOCKED_ERROR)
    return
  }
  w.opener = null
  w.document.write(html)
  w.document.close()
}

/**
 * Export a built document as a PDF.
 * Desktop: webContents.printToPDF + save dialog (no printer needed).
 * Browser: the old print popup, where the user picks "Save as PDF".
 */
export async function exportHtmlPdf(
  html: string,
  suggestedName?: string,
): Promise<PdfBridgeResult> {
  const api = printBridge()
  if (api?.exportPdf) {
    try {
      return await api.exportPdf(html, suggestedName)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  // Plain browser: the popup is where the user picks Chrome's own
  // "Save as PDF". If it never opened, no PDF will ever exist — say so
  // instead of reporting a success the user cannot find on disk.
  if (!popupWithPrint(html)) return { ok: false, error: POPUP_BLOCKED_ERROR }
  return { ok: true }
}

/** Print one document (desktop: default printer / save as PDF / system
 *  dialog; browser: popup). Without an explicit `mode` the user is asked
 *  FIRST: the chooser IPC fires before the synchronous HTML build, so the
 *  dialog opens while the document is still being prepared instead of after
 *  (the old build-then-ask order is what made the chooser feel laggy). */
export function printDocument(
  doc: PrintDoc,
  config: PrintDesignerConfig,
  extras: PrintDocExtras,
  mode?: PrintModeChoice,
): void {
  // Kick off the chooser before any work; an explicit mode (batch flows)
  // resolves immediately without a second dialog.
  const pick = mode !== undefined ? Promise.resolve(mode) : choosePrintMode()
  void (async () => {
    const picked = await pick
    if (picked === 'cancel') return
    const html = buildPrintHtml(doc, config, extras)
    if (picked === 'pdf') {
      const res = await exportHtmlPdf(html, `${extras.docType}-${doc.number}`)
      if (!res.ok && !res.cancelled) console.warn('[print] pdf export failed:', res.error)
      return
    }
    await printHtmlToPrinter(html, undefined, picked)
  })().catch((err) => {
    // A blocked popup (or any print-stage failure) must not surface as an
    // unhandled rejection — it is reported like every other print failure.
    console.warn('[print] failed:', err)
  })
}
