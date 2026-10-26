import bwipJs from 'bwip-js'

export interface LabelProduct {
  id: string
  name: string
  sku: string
  price: number
  weight?: number
  category?: string
  collection?: string
  huid?: string
}

export type LabelPageFormat = 'a4' | 'letter'

export interface LabelConfig {
  presetKey: string
  widthMm: number
  heightMm: number
  marginMm: number
  gapMm: number
  page: LabelPageFormat
  copies: number
  showName: boolean
  showSku: boolean
  showPrice: boolean
  showWeight: boolean
  showHuid: boolean
  showCategory: boolean
  showCompany: boolean
  showQr: boolean
  showBorder: boolean
  fontScale: number
  companyName: string
}

export interface LabelPreset {
  key: string
  label: string
  widthMm: number
  heightMm: number
  marginMm: number
  gapMm: number
}

export const PAGE_SIZES: Record<LabelPageFormat, { widthMm: number; heightMm: number; label: string }> = {
  a4: { widthMm: 210, heightMm: 297, label: 'A4 (210 × 297 mm)' },
  letter: { widthMm: 215.9, heightMm: 279.4, label: 'US Letter (216 × 279 mm)' },
}

export const LABEL_PRESETS: LabelPreset[] = [
  { key: 'label-50x40', label: '50 × 40 mm', widthMm: 50, heightMm: 40, marginMm: 5, gapMm: 0 },
  { key: 'label-50x25', label: '50 × 25 mm', widthMm: 50, heightMm: 25, marginMm: 5, gapMm: 0 },
  { key: 'label-35x22', label: '35 × 22 mm', widthMm: 35, heightMm: 22, marginMm: 5, gapMm: 0 },
  { key: 'label-50x10', label: '50 × 10 mm · Standard', widthMm: 50, heightMm: 10, marginMm: 5, gapMm: 0 },
  { key: 'label-50x10-loni', label: '50 × 10 mm · Alternate', widthMm: 50, heightMm: 10, marginMm: 5, gapMm: 0 },
  { key: 'label-50x10-compact', label: '50 × 10 mm · Compact', widthMm: 50, heightMm: 10, marginMm: 5, gapMm: 0 },
  { key: 'zlabel-50x30', label: '50 × 30 mm (Standard)', widthMm: 50, heightMm: 30, marginMm: 4, gapMm: 0 },
  { key: 'zlabel-40x25', label: '40 × 25 mm (Compact)', widthMm: 40, heightMm: 25, marginMm: 4, gapMm: 2 },
  { key: 'label-50x22', label: '50 × 22 mm', widthMm: 50, heightMm: 22, marginMm: 4, gapMm: 0 },
  { key: 'avery-5160', label: 'Avery 5160', widthMm: 63.5, heightMm: 25.4, marginMm: 5.1, gapMm: 3.2 },
  { key: 'avery-8160', label: 'Avery 8160', widthMm: 38.1, heightMm: 21.2, marginMm: 4.7, gapMm: 2.5 },
  { key: 'dymo-30256', label: 'DYMO 30256', widthMm: 51, heightMm: 25, marginMm: 6, gapMm: 4 },
  { key: 'custom', label: 'Custom size…', widthMm: 50, heightMm: 30, marginMm: 4, gapMm: 0 },
]

export const DEFAULT_LABEL_CONFIG: LabelConfig = {
  presetKey: 'label-50x40',
  widthMm: 50,
  heightMm: 40,
  marginMm: 5,
  gapMm: 0,
  page: 'a4',
  copies: 1,
  showName: true,
  showSku: true,
  showPrice: true,
  showWeight: true,
  showHuid: true,
  showCategory: false,
  showCompany: true,
  showQr: true,
  showBorder: true,
  fontScale: 1,
  companyName: 'OPAL LINE',
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function presetFor(key: string): LabelPreset | undefined {
  return LABEL_PRESETS.find((p) => p.key === key)
}

export function configFromPreset(key: string): LabelConfig {
  const p = presetFor(key)
  if (!p) return { ...DEFAULT_LABEL_CONFIG }
  return {
    ...DEFAULT_LABEL_CONFIG,
    presetKey: p.key,
    widthMm: p.widthMm,
    heightMm: p.heightMm,
    marginMm: p.marginMm,
    gapMm: p.gapMm,
  }
}

export interface LabelGrid {
  columns: number
  rows: number
  labelsPerPage: number
  /** True when even a 1×1 grid cannot fit the label inside the page margins. */
  overflow: boolean
}

export function computeGrid(cfg: LabelConfig): LabelGrid {
  const page = PAGE_SIZES[cfg.page]
  const w = Math.max(5, cfg.widthMm)
  const h = Math.max(5, cfg.heightMm)
  const margin = clamp(cfg.marginMm, 0, 40)
  const gap = clamp(cfg.gapMm, 0, 20)
  const usableW = page.widthMm - margin * 2
  const usableH = page.heightMm - margin * 2
  const columns = Math.max(1, Math.floor((usableW + gap) / (w + gap)))
  const rows = Math.max(1, Math.floor((usableH + gap) / (h + gap)))
  const overflow = w + margin * 2 > page.widthMm || h + margin * 2 > page.heightMm
  return { columns, rows, labelsPerPage: columns * rows, overflow }
}

export function gridDescription(cfg: LabelConfig): string {
  const g = computeGrid(cfg)
  return `${g.columns} × ${g.rows} per ${cfg.page === 'letter' ? 'Letter' : 'A4'} page`
}

/**
 * What the QR symbol encodes: ONLY the product SKU (e.g. `OL-RNG-001`).
 * Product names, prices and weights are never part of the payload — scanning
 * a printed label must resolve the product through an exact SKU match.
 */
export function qrPayload(p: LabelProduct): string {
  return (p.sku ?? '').trim()
}

// ─── Reference design geometry (mirrors backend barcodeLabels.ts) ─────
export const CAP_HEIGHT = 0.718
export const ZPL_CAP_RATIO = 0.718 / 0.925
export const ZPL_EM_RATIO = 0.925
export const QR_QUIET_MODULES = 3
export const MIN_TEXT_SCALE = 0.34
export const MIN_CAP_RATIO = 0.5
export const CAP_SHRINK = 0.88

export type LabelFieldKind = 'brand' | 'name' | 'rate' | 'code' | 'attr1' | 'attr2'

export interface LabelFieldDesign {
  kind: LabelFieldKind
  x: number
  baseline: number
  capHeight: number
  maxWidth: number
  refWidth: number
}

export interface LabelQrDesign {
  x: number
  bottom: number
  size: number
  magnification: number
  modules: number
}

export interface LabelDesign {
  width: number
  height: number
  fields: LabelFieldDesign[]
  qr: LabelQrDesign
}

export const LABEL_DESIGNS: LabelDesign[] = [
  {
    width: 50, height: 40,
    fields: [
      { kind: 'brand', x: 3.875, baseline: 9.125, capHeight: 6.625, maxWidth: 46.125, refWidth: 7.0 },
      { kind: 'name', x: 3.375, baseline: 15.375, capHeight: 4.625, maxWidth: 46.625, refWidth: 1.625 },
      { kind: 'rate', x: 3.125, baseline: 24.125, capHeight: 6.25, maxWidth: 30.75, refWidth: 4.125 },
      { kind: 'code', x: 3.375, baseline: 30.625, capHeight: 4.0, maxWidth: 30.5, refWidth: 4.75 },
      { kind: 'attr1', x: 3.375, baseline: 36.125, capHeight: 3.125, maxWidth: 16.75, refWidth: 5.75 },
      { kind: 'attr2', x: 20.125, baseline: 36.125, capHeight: 3.125, maxWidth: 13.75, refWidth: 5.75 },
    ],
    qr: { x: 33.875, bottom: 35.5, size: 15.75, magnification: 6, modules: 21 },
  },
  {
    width: 50, height: 25,
    fields: [
      { kind: 'brand', x: 4.125, baseline: 4.875, capHeight: 3.875, maxWidth: 45.875, refWidth: 6.625 },
      { kind: 'name', x: 3.375, baseline: 8.625, capHeight: 3.0, maxWidth: 46.625, refWidth: 1.625 },
      { kind: 'rate', x: 3.375, baseline: 13.375, capHeight: 3.75, maxWidth: 31.375, refWidth: 3.75 },
      { kind: 'code', x: 3.375, baseline: 17.875, capHeight: 3.0, maxWidth: 31.375, refWidth: 3.75 },
      { kind: 'attr1', x: 3.375, baseline: 22.0, capHeight: 2.625, maxWidth: 13.75, refWidth: 4.75 },
      { kind: 'attr2', x: 17.125, baseline: 21.75, capHeight: 2.375, maxWidth: 17.625, refWidth: 4.375 },
    ],
    qr: { x: 34.75, bottom: 21.625, size: 10.5, magnification: 4, modules: 21 },
  },
  {
    width: 35, height: 22,
    fields: [
      { kind: 'brand', x: 2.875, baseline: 4.875, capHeight: 3.875, maxWidth: 32.125, refWidth: 4.375 },
      { kind: 'name', x: 2.875, baseline: 9.0, capHeight: 3.75, maxWidth: 32.125, refWidth: 1.875 },
      { kind: 'rate', x: 2.875, baseline: 13.375, capHeight: 3.0, maxWidth: 21.375, refWidth: 2.875 },
      { kind: 'code', x: 2.875, baseline: 16.875, capHeight: 2.0, maxWidth: 21.375, refWidth: 2.875 },
      { kind: 'attr1', x: 2.875, baseline: 19.875, capHeight: 2.0, maxWidth: 11.75, refWidth: 3.5 },
      { kind: 'attr2', x: 14.625, baseline: 19.875, capHeight: 2.0, maxWidth: 9.625, refWidth: 3.75 },
    ],
    qr: { x: 24.25, bottom: 20.375, size: 7.875, magnification: 3, modules: 21 },
  },
  {
    width: 50, height: 10,
    fields: [
      { kind: 'brand', x: 2.06, baseline: 3.125, capHeight: 2.5, maxWidth: 33.09, refWidth: 3.75 },
      { kind: 'name', x: 1.5, baseline: 7.25, capHeight: 2.5, maxWidth: 23.22, refWidth: 2.25 },
      { kind: 'code', x: 24.72, baseline: 3.75, capHeight: 3.125, maxWidth: 16.71, refWidth: 3.125 },
      { kind: 'rate', x: 24.72, baseline: 7.75, capHeight: 3.5, maxWidth: 16.71, refWidth: 2.5 },
    ],
    qr: { x: 41.43, bottom: 9.375, size: 7.875, magnification: 3, modules: 21 },
  },
]

export function labelDesignFor(width: number, height: number): LabelDesign | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  const tol = 0.15
  return LABEL_DESIGNS.find((d) => Math.abs(d.width - width) <= tol && Math.abs(d.height - height) <= tol) ?? null
}

export function qrModuleMm(design: LabelDesign): number {
  return design.qr.magnification / 8
}

export function qrQuietMm(design: LabelDesign): number {
  return qrModuleMm(design) * QR_QUIET_MODULES
}

export function qrTopMm(design: LabelDesign): number {
  return design.qr.bottom - (design.qr.modules + QR_QUIET_MODULES) * qrModuleMm(design)
}

export function fieldMaxWidthMm(design: LabelDesign, field: LabelFieldDesign, showQR: boolean): number {
  const quiet = qrQuietMm(design)
  let maxWidth = showQR ? field.maxWidth : design.width - field.x
  const sibling = design.fields.find((f) => f.kind === 'attr2')
  if (field.kind === 'attr1' && sibling && sibling.x > field.x) {
    maxWidth = Math.min(maxWidth, sibling.x - field.x - quiet)
  }
  if (!showQR || field.x >= design.qr.x) return Math.max(0, maxWidth)
  const boxTop = qrTopMm(design) - quiet
  const capTop = field.baseline - field.capHeight * ZPL_CAP_RATIO
  const overlap = Math.min(field.baseline, design.qr.bottom) - Math.max(capTop, boxTop)
  if (overlap > field.capHeight * ZPL_CAP_RATIO * 0.25) {
    maxWidth = Math.min(maxWidth, design.qr.x - quiet - field.x)
  }
  return Math.max(0, maxWidth)
}

const HELVETICA_BOLD_WIDTHS: Record<string, number> = {
  ' ': 278, '!': 333, '"': 474, '#': 556, $: 556, '%': 889, '&': 722, "'": 238,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611,
  '@': 975, A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278,
  J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667,
  T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, '[': 333, '\\': 278,
  ']': 333, '^': 584, _: 556, '`': 333, a: 556, b: 611, c: 556, d: 611, e: 556,
  f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889, n: 611, o: 611,
  p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556,
  z: 500, '{': 389, '|': 280, '}': 389, '~': 584,
}

export function textEmWidth(text: string): number {
  let sum = 0
  let counted = 0
  for (const ch of text) {
    const w = HELVETICA_BOLD_WIDTHS[ch]
    if (w === undefined) continue
    sum += w
    counted++
  }
  return counted === 0 ? text.length * 0.556 : sum / 1000
}

export function labelAttributes(product: { category?: string; collection?: string; weight?: number }, opts: { showWeight?: boolean }): string[] {
  const out: string[] = []
  if (product.category) out.push(String(product.category))
  if (product.collection) out.push(String(product.collection))
  else if (opts.showWeight !== false && product.weight) out.push(`${product.weight}g`)
  return out
}

export interface DesignFieldText {
  kind: LabelFieldKind
  text: string
}

export function designFieldTexts(
  product: LabelProduct,
  opts: { showPrice?: boolean; showWeight?: boolean; showBrand?: boolean; brand?: string; codeLength?: number },
  design: LabelDesign,
): DesignFieldText[] {
  const out: DesignFieldText[] = []
  const attrs = labelAttributes(product, { showWeight: opts.showWeight })
  for (const field of design.fields) {
    switch (field.kind) {
      case 'brand': {
        const brand = (opts.brand ?? '').trim()
        if (opts.showBrand !== false && brand) out.push({ kind: 'brand', text: brand.toLocaleUpperCase() })
        break
      }
      case 'name': {
        const name = (String(product.name ?? '').trim() || 'Product').toLocaleUpperCase()
        out.push({ kind: 'name', text: name })
        break
      }
      case 'rate':
        if (opts.showPrice !== false) out.push({ kind: 'rate', text: formatLabelRate(product.price) })
        break
      case 'code': {
        const rawCode = (product.sku ?? '').trim()
        const code = opts.codeLength ? rawCode.slice(0, opts.codeLength) : rawCode
        if (code) out.push({ kind: 'code', text: design.height <= 12 ? code : `Code: ${code}` })
        break
      }
      case 'attr1':
        if (attrs[0]) out.push({ kind: 'attr1', text: attrs[0] })
        break
      case 'attr2':
        if (attrs[1]) out.push({ kind: 'attr2', text: attrs[1] })
        break
    }
  }
  return out
}

export function formatLabelRate(price: number): string {
  const value = Number.isFinite(price) ? price : 0
  return `Rate: ${value.toFixed(2)}/-`
}

export interface FittedDesignText {
  text: string
  scale: number
  fontSize: number
}

export function fitDesignText(
  measure: (text: string, fontSize: number) => number,
  text: string,
  fontSizePt: number,
  maxWidthPt: number,
  baseScale: number,
): FittedDesignText {
  const floor = Math.min(MIN_TEXT_SCALE, baseScale)
  const shrinkFloor = fontSizePt * MIN_CAP_RATIO
  for (let fs = fontSizePt, i = 0; i < 12; fs *= CAP_SHRINK, i++) {
    const natural = measure(text, fs)
    if (natural <= 0 || maxWidthPt / natural >= floor) {
      return { text, scale: natural > 0 ? Math.min(baseScale, maxWidthPt / natural) : baseScale, fontSize: fs }
    }
    if (fs <= shrinkFloor) break
  }
  const fontSize = shrinkFloor
  const ellipsis = '\u2026'
  const fits = (candidate: string): boolean => {
    const natural = measure(candidate, fontSize)
    return natural <= 0 || maxWidthPt / natural >= floor
  }
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(text.slice(0, mid).trimEnd() + ellipsis)) lo = mid
    else hi = mid - 1
  }
  const trimmed = lo > 0 ? text.slice(0, lo).trimEnd() + ellipsis : text.slice(0, 1)
  const natural = measure(trimmed, fontSize)
  return {
    text: trimmed,
    scale: natural > 0 ? Math.min(baseScale, maxWidthPt / natural) : baseScale,
    fontSize,
  }
}

function withFillViewport(svg: string, preserveAspectRatio: string): string {
  return svg.replace(/<svg\s+/, `<svg width="100%" height="100%" preserveAspectRatio="${preserveAspectRatio}" `)
}

type BwipSvgOptions = Parameters<typeof bwipJs.toSVG>[0]
function encoderOptions(options: Record<string, unknown>): BwipSvgOptions {
  return options as unknown as BwipSvgOptions
}

export function qrSvg(text: string): string | null {
  if (!text) return null
  try {
    const svg = bwipJs.toSVG(
      encoderOptions({
        bcid: 'qrcode',
        text,
        eclevel: 'L',
        scale: 1,
        barcolor: '000000',
        backgroundcolor: 'FFFFFF',
      }),
    )
    return withFillViewport(svg, 'xMidYMid meet')
  } catch {
    return null
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatPrice(value: number): string {
  return `₹${Math.round(value || 0).toLocaleString('en-IN')}`
}

function buildAdaptiveLabelHtml(p: LabelProduct, cfg: LabelConfig, qrCode: string | null): string {
  const w = cfg.widthMm
  const h = cfg.heightMm
  const pad = clamp(Math.min(h * 0.07, w * 0.035), 0.4, 1.6)
  const innerW = w - pad * 2
  const innerH = h - pad * 2

  const bodyH = Math.max(1.5, innerH)
  const qrSize = qrCode ? clamp(Math.min(bodyH, innerW * 0.38), 0, 16) : 0
  const showQr = !!qrCode && qrSize >= 3
  const qrGap = showQr ? clamp(w * 0.03, 0.4, 1.4) : 0

  const metaLines: string[] = []
  if (cfg.showCompany && cfg.companyName) metaLines.push(`<div class="company">${escapeHtml(cfg.companyName)}</div>`)
  if (cfg.showSku && p.sku) metaLines.push(`<div class="meta sku">${escapeHtml(p.sku)}</div>`)
  if (cfg.showHuid && p.huid) metaLines.push(`<div class="meta huid">HUID: ${escapeHtml(p.huid)}</div>`)
  if (cfg.showCategory && p.category) metaLines.push(`<div class="meta cat">${escapeHtml(p.category)}</div>`)

  const bottom: string[] = []
  if (cfg.showPrice) bottom.push(`<div class="price">${formatPrice(p.price)}</div>`)
  if (cfg.showWeight && p.weight) bottom.push(`<div class="weight">${p.weight}g</div>`)

  return `
    <div class="lbl">
      <div class="body" style="height:${bodyH}mm">
        ${showQr ? `<div class="qr" style="width:${qrSize}mm;height:${qrSize}mm;margin-right:${qrGap}mm">${qrCode}</div>` : ''}
        <div class="info">
          ${cfg.showName && p.name ? `<div class="name">${escapeHtml(p.name)}</div>` : ''}
          ${metaLines.join('')}
          ${bottom.length ? `<div class="bottom">${bottom.join('')}</div>` : ''}
        </div>
      </div>
    </div>`
}

function buildDesignLabelHtml(p: LabelProduct, cfg: LabelConfig, qrCode: string | null, design: LabelDesign): string {
  const showQR = cfg.showQr && !!qrCode
  const brand = cfg.showCompany ? (cfg.companyName.trim() || 'OPAL LINE') : 'OPAL LINE'
  const opts = {
    showPrice: cfg.showPrice,
    showWeight: cfg.showWeight,
    showBrand: true,
    brand,
    codeLength: undefined as number | undefined,
    showQr: showQR,
  }
  const texts = designFieldTexts(p, opts, design)
  const fields = new Map(design.fields.map((f) => [f.kind, f]))

  const measure = (text: string, fontSize: number) => textEmWidth(text) * fontSize

  const lines: string[] = []
  for (const entry of texts) {
    const field = fields.get(entry.kind)
    if (!field) continue
    const fontSizeMm = field.capHeight / ZPL_EM_RATIO
    const baseScale = field.refWidth / fontSizeMm
    const maxWidthMm = fieldMaxWidthMm(design, field, showQR)
    const fitted = fitDesignText(
      measure,
      entry.text,
      fontSizeMm * (72 / 25.4),
      maxWidthMm * (72 / 25.4),
      baseScale,
    )
    const capDrawnMm = (fitted.fontSize * CAP_HEIGHT * 25.4) / 72
    const topMm = field.baseline - capDrawnMm
    const fontSizeCss = (fitted.fontSize * 25.4) / 72
    lines.push(
      `<div style="position:absolute;left:${field.x}mm;top:${topMm}mm;font-size:${fontSizeCss}mm;font-weight:700;color:#000;white-space:nowrap;transform:scaleX(${fitted.scale});transform-origin:left top;line-height:1;">${escapeHtml(fitted.text)}</div>`,
    )
  }

  const qrHtml = showQR && qrCode
    ? `<div style="position:absolute;left:${design.qr.x}mm;top:${qrTopMm(design)}mm;width:${design.qr.size}mm;height:${design.qr.size}mm;">${qrCode}</div>`
    : ''

  return `<div class="lbl">${lines.join('')}${qrHtml}</div>`
}

export interface LabelSheetOptions {
  mode?: 'print' | 'preview'
  /** Cap rendered labels (preview only) so huge selections stay responsive. */
  maxLabels?: number
}

export interface LabelSheetResult {
  html: string
  totalLabels: number
  totalPages: number
  renderedLabels: number
}

export function expandLabels(products: LabelProduct[], cfg: LabelConfig): LabelProduct[] {
  const copies = clamp(Math.round(cfg.copies) || 1, 1, 99)
  if (copies === 1) return products
  const out: LabelProduct[] = []
  for (const p of products) for (let i = 0; i < copies; i++) out.push(p)
  return out
}

export function buildLabelSheet(products: LabelProduct[], cfg: LabelConfig, opts: LabelSheetOptions = {}): LabelSheetResult {
  const mode = opts.mode ?? 'print'
  const grid = computeGrid(cfg)
  const page = PAGE_SIZES[cfg.page]
  const expanded = expandLabels(products, cfg)
  const totalLabels = expanded.length
  const totalPages = Math.max(1, Math.ceil(totalLabels / grid.labelsPerPage))
  const cap = mode === 'preview' ? Math.min(totalLabels, opts.maxLabels ?? grid.labelsPerPage * 2) : totalLabels
  const rendered = expanded.slice(0, cap)
  const renderedPages = Math.max(1, Math.ceil(rendered.length / grid.labelsPerPage))

  const design = labelDesignFor(cfg.widthMm, cfg.heightMm)

  const qrCache = new Map<string, string | null>()

  const pages: string[] = []
  for (let pageIdx = 0; pageIdx < renderedPages; pageIdx++) {
    const slice = rendered.slice(pageIdx * grid.labelsPerPage, (pageIdx + 1) * grid.labelsPerPage)
    const cells: string[] = []
    for (const p of slice) {
      let qr: string | null = null
      if (cfg.showQr) {
        const key = qrPayload(p)
        if (key && !qrCache.has(key)) qrCache.set(key, qrSvg(key))
        qr = (key && qrCache.get(key)) || null
      }
      cells.push(design ? buildDesignLabelHtml(p, cfg, qr, design) : buildAdaptiveLabelHtml(p, cfg, qr))
    }
    pages.push(`<div class="page">${cells.join('')}</div>`)
  }

  const borderCss = cfg.showBorder ? 'border:0.15mm solid #9aa1ad;' : 'border:none;'

  const screenCss = `@media screen{
      body{background:#e8ebf0;padding:6mm;}
      .page{margin:0 auto 6mm;box-shadow:0 1px 6px rgba(15,23,42,.18);background:#fff;}
    }`

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Product Labels</title><style>
    @page{size:${cfg.page === 'letter' ? 'letter' : 'A4'};margin:0;}
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{background:#fff;color:#111827;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    body{font-family:"Segoe UI",Arial,Helvetica,sans-serif;}
    .page{
      width:${page.widthMm}mm;height:${page.heightMm}mm;padding:${cfg.marginMm}mm;
      display:grid;grid-template-columns:repeat(${grid.columns},${cfg.widthMm}mm);
      grid-auto-rows:${cfg.heightMm}mm;gap:${cfg.gapMm}mm;
      align-content:start;justify-content:center;
      page-break-after:always;break-after:page;overflow:hidden;background:#fff;
    }
    .page:last-child{page-break-after:auto;break-after:auto;}
    .lbl{
      width:${cfg.widthMm}mm;height:${cfg.heightMm}mm;${borderCss}
      border-radius:0;overflow:hidden;background:#fff;position:relative;
      font-family:Helvetica,Arial,sans-serif;
    }
    .lbl .qr svg{display:block;width:100%;height:100%;}
    @media print{
      body{background:#fff;}
      .page{margin:0;box-shadow:none;}
    }
    ${screenCss}
  </style></head><body>${pages.join('')}</body></html>`

  return { html, totalLabels, totalPages, renderedLabels: rendered.length }
}

export const MM_TO_PX = 96 / 25.4