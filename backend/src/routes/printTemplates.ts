import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { actorFromRequest, recordActivity } from '../activity'
import { logger } from '../logger'
import { buildUpiQrDataUrl } from '../upiQr'
import { requirePermission } from '../rbac'
import { routeParam } from '../lib/routeParams'

/**
 * Saved designs for printable documents. One design can be marked default per
 * doc type; the print flows (invoice detail, quotations, …) merge the default
 * config over their built-in layout so a saved design changes every printout
 * without code changes.
 */

export const printTemplatesRouter = Router()

export const PRINT_DOC_TYPES = ['invoice', 'quotation', 'order', 'packing-slip', 'pick-list', 'barcode-label'] as const
export type PrintDocType = (typeof PRINT_DOC_TYPES)[number]

const MAX_CONFIG_BYTES = 128 * 1024
const MAX_LOGO_DATAURL_BYTES = 300 * 1024

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
  /** Custom label width in mm (labelPreset === 'custom'). */
  labelWidthMm: number
  /** Custom label height in mm (labelPreset === 'custom'). */
  labelHeightMm: number
  labelShowFront: boolean
  labelShowBack: boolean
  labelFrontCompany: boolean
  labelFrontName: boolean
  labelFrontRate: boolean
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

export function defaultPrintConfig(_docType: PrintDocType): PrintDesignerConfig {
  return {
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
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/** Clamp/validate incoming config values; unknown keys are dropped. */
export function sanitizePrintConfig(input: unknown): { config: PrintDesignerConfig; error?: string } {
  if (typeof input !== 'object' || input === null) {
    return { config: defaultPrintConfig('invoice'), error: 'config must be an object' }
  }
  if (JSON.stringify(input).length > MAX_CONFIG_BYTES) {
    return { config: defaultPrintConfig('invoice'), error: 'config too large' }
  }
  const raw = input as Record<string, unknown>
  const d = defaultPrintConfig('invoice')
  const clampNum = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  const clampStr = (v: unknown, maxLen: number, fallback: string): string =>
    typeof v === 'string' ? v.slice(0, maxLen) : fallback

  const margins = (typeof raw.margins === 'object' && raw.margins !== null ? raw.margins : {}) as Record<string, unknown>
  const imageOr = (v: unknown): string | null =>
    typeof v === 'string' && v.startsWith('data:image/') && v.length <= MAX_LOGO_DATAURL_BYTES ? v : null
  const config: PrintDesignerConfig = {
    accent: typeof raw.accent === 'string' && HEX_RE.test(raw.accent.trim()) ? raw.accent.trim() : d.accent,
    accent2: typeof raw.accent2 === 'string' && HEX_RE.test(raw.accent2.trim()) ? raw.accent2.trim() : d.accent2,
    headerStyle: ['minimal', 'boxed', 'modern'].includes(String(raw.headerStyle))
      ? (raw.headerStyle as PrintDesignerConfig['headerStyle'])
      : 'banner',
    font: ['georgia', 'arial'].includes(String(raw.font)) ? (raw.font as PrintDesignerConfig['font']) : 'inter',
    fontScale: clampNum(raw.fontScale, 0.8, 1.3, 1),
    pageSize: raw.pageSize === 'letter' ? 'letter' : 'a4',
    margins: {
      top: clampNum(margins.top, 0, 40, 12),
      right: clampNum(margins.right, 0, 40, 12),
      bottom: clampNum(margins.bottom, 0, 40, 12),
      left: clampNum(margins.left, 0, 40, 12),
    },
    cornerRadius: clampNum(raw.cornerRadius, 0, 16, 6),
    paperTint: raw.paperTint === 'cream' ? 'cream' : 'white',
    tableHeaderStyle:
      raw.tableHeaderStyle === 'accent' || raw.tableHeaderStyle === 'light'
        ? (raw.tableHeaderStyle as PrintDesignerConfig['tableHeaderStyle'])
        : 'dark',
    borderStyle: raw.borderStyle === 'full' || raw.borderStyle === 'none' ? (raw.borderStyle as PrintDesignerConfig['borderStyle']) : 'rows',
    tableZebra: raw.tableZebra !== false,
    showLogo: raw.showLogo === true && imageOr(raw.logoDataUrl) !== null,
    logoAlign: raw.logoAlign === 'center' ? 'center' : 'left',
    logoDataUrl: imageOr(raw.logoDataUrl),
    showTagline: raw.showTagline !== false,
    showGSTIN: raw.showGSTIN !== false,
    showContactBoxes: raw.showContactBoxes !== false,
    showPayment: raw.showPayment !== false,
    showQr: raw.showQr === true && imageOr(raw.qrDataUrl) !== null,
    qrDataUrl: imageOr(raw.qrDataUrl),
    qrCaption: clampStr(raw.qrCaption, 120, d.qrCaption),
    showAmountWords: raw.showAmountWords !== false,
    showSignature: raw.showSignature !== false,
    showDeclaration: raw.showDeclaration !== false,
    showHsn: raw.showHsn !== false,
    showWeight: raw.showWeight !== false,
    showRate: raw.showRate !== false,
    showTax: raw.showTax !== false,
    signatoryName: clampStr(raw.signatoryName, 120, ''),
    bankDetails: clampStr(raw.bankDetails, 600, ''),
    footerNote: clampStr(raw.footerNote, 500, ''),
    thankYouNote: clampStr(raw.thankYouNote, 300, d.thankYouNote),
    declaration: clampStr(raw.declaration, 1000, d.declaration),
    watermark: typeof raw.watermark === 'string' && raw.watermark.trim() !== '' ? raw.watermark.trim().slice(0, 40) : null,
    labelPreset: ['50x22', '35x22', '50x10', 'custom'].includes(String(raw.labelPreset))
      ? (raw.labelPreset as PrintDesignerConfig['labelPreset'])
      : '50x25',
    labelWidthMm: clampNum(raw.labelWidthMm, 15, 130, 50),
    labelHeightMm: clampNum(raw.labelHeightMm, 8, 60, 25),
    labelShowFront: raw.labelShowFront !== false,
    labelShowBack: raw.labelShowBack !== false,
    labelFrontCompany: raw.labelFrontCompany !== false,
    labelFrontName: raw.labelFrontName !== false,
    labelFrontRate: raw.labelFrontRate !== false,
    labelBackSku: raw.labelBackSku !== false,
    labelBackName: raw.labelBackName === true,
    labelFrontSku: raw.labelFrontSku !== false,
    labelBackCompany: raw.labelBackCompany !== false,
    labelBackProduct: raw.labelBackProduct !== false,
    labelFrontFontSizeMm: clampNum(raw.labelFrontFontSizeMm, 0, 10, 0),
    labelFrontFontAlign: ['center', 'right'].includes(String(raw.labelFrontFontAlign))
      ? (raw.labelFrontFontAlign as PrintDesignerConfig['labelFrontFontAlign'])
      : 'right',
    labelFrontTextPosition: ['center', 'top'].includes(String(raw.labelFrontTextPosition))
      ? (raw.labelFrontTextPosition as PrintDesignerConfig['labelFrontTextPosition'])
      : 'bottom',
    labelBackFontSizeMm: clampNum(raw.labelBackFontSizeMm, 0, 10, 0),
    labelBackFontAlign: ['center', 'right'].includes(String(raw.labelBackFontAlign))
      ? (raw.labelBackFontAlign as PrintDesignerConfig['labelBackFontAlign'])
      : 'left',
    labelBackTextPosition: ['center', 'bottom'].includes(String(raw.labelBackTextPosition))
      ? (raw.labelBackTextPosition as PrintDesignerConfig['labelBackTextPosition'])
      : 'top',
    labelBorder: raw.labelBorder !== false,
    labelBackgroundColor: typeof raw.labelBackgroundColor === 'string' && HEX_RE.test(raw.labelBackgroundColor.trim())
      ? raw.labelBackgroundColor.trim()
      : '#ffffff',
    labelRadiusMm: clampNum(raw.labelRadiusMm, 0, 5, 1),
  }
  return { config }
}

function isDocType(v: unknown): v is PrintDocType {
  return typeof v === 'string' && (PRINT_DOC_TYPES as readonly string[]).includes(v)
}

/** Realistic sample document so the designer preview looks like a real printout. */
export function sampleDocument(docType: PrintDocType): Record<string, unknown> {
  const base = {
    number: docType === 'invoice' ? 'SI-2026-00123' : docType === 'quotation' ? 'QT-2026-00045' : 'SO-2026-00789',
    shopifyOrder: '#10233',
    customer: 'Meera Nair',
    customerEmail: 'meera.nair@example.com',
    customerPhone: '+91 98450 01111',
    customerAddress: '105 Victoria St',
    customerCity: 'Mumbai',
    customerState: 'Maharashtra',
    customerPincode: '400001',
    businessName: 'OPAL LINE JEWELS LLP',
    gst: 3,
    gstAmount: 771.3,
    discount: 500,
    subtotal: 25710,
    grandTotal: 26281.3,
    paymentMethod: 'Razorpay',
    paymentStatus: 'paid',
    date: new Date().toISOString(),
    items: [
      { product: 'Rajwadi Necklace Set', sku: 'OL-RN-001', hsn: '7113', qty: 1, weight: 42.5, silverRate: 92, makingCharge: 4500, tax: 3, amount: 8410 },
      { product: 'Temple Jhumka Earrings', sku: 'OL-TE-014', hsn: '7113', qty: 2, weight: 18.75, silverRate: 92, makingCharge: 2200, tax: 3, amount: 3865 },
      { product: 'Oxidised Anklet Pair', sku: 'OA-AK-022', hsn: '7113', qty: 1, weight: 26.4, silverRate: 92, makingCharge: 1800, tax: 3, amount: 4228.8 },
    ],
  }
  if (docType === 'quotation') {
    return { ...base, number: 'QT-2026-00045', validUntil: new Date(Date.now() + 15 * 86400000).toISOString(), status: 'sent', notes: 'Prices valid for 15 days. Silver rate as on date.' }
  }
  if (docType === 'order') {
    return { ...base, number: 'SO-2026-00789', status: 'confirmed', fulfillment: 'unfulfilled', tags: 'manual-order' }
  }
  if (docType === 'packing-slip') {
    return { ...base, number: 'SO-2026-00789', status: 'confirmed' }
  }
  if (docType === 'pick-list') {
    return { ...base, number: 'SO-2026-00789', status: 'confirmed' }
  }
  if (docType === 'barcode-label') {
    return {
      ...base,
      number: 'SO-2026-00789',
      status: 'confirmed',
      items: [
        {
          product: '92.5 Sterling Silver Pendant',
          sku: 'OL-PND-001',
          qty: 10,
          weight: 2.8,
          sellingPrice: 3250.5,
        },
        {
          product: '92.5 Sterling Silver Ring',
          sku: 'OL-RNG-001',
          qty: 8,
          weight: 1.95,
          sellingPrice: 2450.0,
        },
      ],
    }
  }
  return base
}

function jsonError(res: Response, status: number, error: string) {
  res.status(status).json({ error })
}

printTemplatesRouter.get('/', async (req: Request, res: Response) => {
  if (!db) return jsonError(res, 503, 'Database unavailable')
  try {
    const docType = req.query.docType
    const rows = isDocType(docType)
      ? await db.select().from(schema.printTemplates).where(eq(schema.printTemplates.docType, docType))
      : await db.select().from(schema.printTemplates)
    res.json({ templates: rows })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown' }, 'print templates list failed')
    jsonError(res, 500, 'Could not load print templates')
  }
})

printTemplatesRouter.get('/default/:docType', async (req: Request, res: Response) => {
  if (!db) return jsonError(res, 503, 'Database unavailable')
  const docType = routeParam(req.params.docType)
  if (!isDocType(docType)) return jsonError(res, 400, `docType must be one of: ${PRINT_DOC_TYPES.join(', ')}`)
  try {
    const [row] = await db
      .select()
      .from(schema.printTemplates)
      .where(and(eq(schema.printTemplates.docType, docType), eq(schema.printTemplates.isDefault, true)))
      .limit(1)
    res.json({ config: (row?.config as PrintDesignerConfig) ?? defaultPrintConfig(docType), name: row?.name ?? null, id: row?.id ?? null })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown' }, 'print template default failed')
    jsonError(res, 500, 'Could not load default print template')
  }
})

// Validate an imported design file's config without saving it. Returns the
// clamped, allowlisted config so the designer can apply it safely.
printTemplatesRouter.post('/sanitize', requirePermission('system', 'edit'), (req: Request, res: Response) => {
  const { config, error } = sanitizePrintConfig(req.body?.config)
  if (error) return jsonError(res, 400, error)
  res.json({ config })
})

printTemplatesRouter.get('/sample/:docType', (req: Request, res: Response) => {
  const docType = routeParam(req.params.docType)
  if (!isDocType(docType)) return jsonError(res, 400, `docType must be one of: ${PRINT_DOC_TYPES.join(', ')}`)
  res.json({ doc: sampleDocument(docType) })
})

// UPI payment QR for printables. Auth-only (requireAuth already applied at
// mount); accepts a payload of { total, businessName? } and returns a PNG
// data URL built from the Settings UPI ID — or { enabled: false } when no
// UPI ID is configured so the UI can hide the slot.
printTemplatesRouter.get('/upi-qr', async (req: Request, res: Response) => {
  try {
    const total = Number(req.query.total ?? 0)
    if (!Number.isFinite(total) || total <= 0) return jsonError(res, 400, 'total must be a positive number')
    const name = typeof req.query.businessName === 'string' ? req.query.businessName : undefined
    const dataUrl = await buildUpiQrDataUrl(total, name)
    res.json({ enabled: dataUrl !== null, dataUrl })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown' }, 'upi qr generation failed')
    jsonError(res, 500, 'Could not generate UPI QR')
  }
})

const unsetDefaultFor = async (docType: PrintDocType) => {
  if (!db) return
  await db
    .update(schema.printTemplates)
    .set({ isDefault: false })
    .where(eq(schema.printTemplates.docType, docType))
}

printTemplatesRouter.post('/', async (req: Request, res: Response) => {
  if (!db) return jsonError(res, 503, 'Database unavailable')
  try {
    const { docType, name, setDefault } = req.body ?? {}
    if (!isDocType(docType)) return jsonError(res, 400, `docType must be one of: ${PRINT_DOC_TYPES.join(', ')}`)
    const trimmedName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : 'My design'
    const { config, error } = sanitizePrintConfig(req.body?.config)
    if (error) return jsonError(res, 400, error)

    const makeDefault = setDefault !== false
    if (makeDefault) await unsetDefaultFor(docType)

    const id = `pt-${randomUUID()}`
    await db.insert(schema.printTemplates).values({
      id,
      docType,
      name: trimmedName,
      config,
      isDefault: makeDefault,
      updatedAt: new Date().toISOString(),
    })
    void recordActivity({
      action: 'Saved Print Design',
      module: 'system',
      entity: `Print Template (${trimmedName})`,
      details: `${docType} · default=${makeDefault}`,
      userId: actorFromRequest(req).userId,
      ip: actorFromRequest(req).ip,
    })
    res.status(201).json({ ok: true, id, config })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown' }, 'print template save failed')
    jsonError(res, 500, 'Could not save print template')
  }
})

printTemplatesRouter.patch('/:id', async (req: Request, res: Response) => {
  if (!db) return jsonError(res, 503, 'Database unavailable')
  try {
    const id = routeParam(req.params.id)
    const [row] = await db.select().from(schema.printTemplates).where(eq(schema.printTemplates.id, id)).limit(1)
    if (!row) return jsonError(res, 404, 'Template not found')

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (typeof req.body?.name === 'string' && req.body.name.trim()) updates.name = req.body.name.trim().slice(0, 80)
    if (req.body?.config !== undefined) {
      const { config, error } = sanitizePrintConfig(req.body.config)
      if (error) return jsonError(res, 400, error)
      updates.config = config
    }
    if (req.body?.setDefault === true && !row.isDefault) {
      await unsetDefaultFor(row.docType as PrintDocType)
      updates.isDefault = true
    }
    await db.update(schema.printTemplates).set(updates).where(eq(schema.printTemplates.id, id))
    res.json({ ok: true })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown' }, 'print template update failed')
    jsonError(res, 500, 'Could not update print template')
  }
})

printTemplatesRouter.post('/:id/default', async (req: Request, res: Response) => {
  if (!db) return jsonError(res, 503, 'Database unavailable')
  try {
    const [row] = await db.select().from(schema.printTemplates).where(eq(schema.printTemplates.id, routeParam(req.params.id))).limit(1)
    if (!row) return jsonError(res, 404, 'Template not found')
    await unsetDefaultFor(row.docType as PrintDocType)
    await db.update(schema.printTemplates).set({ isDefault: true }).where(eq(schema.printTemplates.id, row.id))
    res.json({ ok: true })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown' }, 'print template set-default failed')
    jsonError(res, 500, 'Could not set default print template')
  }
})

printTemplatesRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!db) return jsonError(res, 503, 'Database unavailable')
  try {
    await db.delete(schema.printTemplates).where(eq(schema.printTemplates.id, routeParam(req.params.id)))
    res.json({ ok: true })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'Unknown' }, 'print template delete failed')
    jsonError(res, 500, 'Could not delete print template')
  }
})
