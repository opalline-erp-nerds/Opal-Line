import QRCode from 'qrcode'
import PDFDocument from 'pdfkit'
import { getRawClient } from './db/client'
import { logger } from './logger'

 
export interface ProductLabel {
  name: string
  sku: string
  price: number
  weight?: number
  category?: string
  collection?: string
  hsn?: string
  huid?: string
}

interface LabelOptions {
  width: number       // mm
  height: number      // mm
  columns: number
  rows: number
  /** Outer page margin in mm (A4/Letter stock). */
  margin: number
  /** Gap between adjacent labels in mm. */
  gap: number
  showPrice: boolean
  showWeight: boolean
  showQR: boolean
  showBrand: boolean
  brand: string
  copies: number
  codeLength?: number
}

const DEFAULT_OPTIONS: LabelOptions = {
  width: 50,
  height: 40,
  columns: 4,
  rows: 7,
  margin: 5,
  gap: 0,
  showPrice: true,
  showWeight: true,
  showQR: true,
  showBrand: true,
  brand: 'OPAL LINE',
  copies: 1,
}

// ─── Reference designs ───────────────────────────────────────────
// LABEL_DESIGNS retains the recorded Zebra reference geometry (203 dpi = 8
// dots per mm) converted to millimetres. The original `.prn` files are not
// present in this checkout, so coordinate changes must be checked against the
// recorded fixture and reference images rather than inferred from canvas size:
//
//   50×40: ^PW799 ^LL320 → two 400×320-dot labels per row
//   50×25: ^PW799 ^LL200 → two 400×200-dot labels per row
//   35×22: ^PW831 ^LL176 → three 280×176-dot labels per row
//   50×10: ^PW831 ^LL80  → slim strip, artwork mapped to 50×10 mm
//
// ZPL places a text field on its BASELINE using the scalable `^A0` font's
// nominal character height, so each field carries a baseline and a cap height;
// the QR symbol is placed by its left edge and its bottom edge (all four
// reference streams overflow the label if `^BQN` is read as top-anchored, and
// all four fit exactly when read as bottom-anchored).
//
// The recorded 50×10 stream is authored on 104 mm-wide media with its content starting
// at 14.75 mm. That content block (52.4 mm of artwork) is mapped into the real
// 50 mm label — a uniform 0.897× horizontal compression with every height and
// the reference's left-to-right ordering preserved. Its two right-hand lines
// share one left edge because a production SKU (10+ characters) needs more
// than the 7-character sample and would otherwise collide with the QR symbol.

/** Helvetica cap height, as a fraction of the em size (Adobe AFM metrics). */
export const CAP_HEIGHT = 0.718

/**
 * `^A0N,h,w` measures `h` from ascender to descender rather than to the cap
 * line. This ratio is retained from recorded reference measurements, but
 * cannot be independently checked against printer streams in this checkout.
 * The em size used by PDF and preview is `h / 0.925`.
 */
export const ZPL_CAP_RATIO = 0.718 / 0.925
export const ZPL_EM_RATIO = 0.925

/** Clear space the reference leaves around a QR symbol, in modules. */
export const QR_QUIET_MODULES = 3

/**
 * Horizontal compression below which text stops being legible, so a line
 * shrinks instead of condensing further. Shared with the ZPL renderer so the
 * two formats make exactly the same decision.
 */
export const MIN_TEXT_SCALE = 0.34

export type LabelFieldKind = 'brand' | 'name' | 'rate' | 'code' | 'attr1' | 'attr2'

export interface LabelFieldDesign {
  kind: LabelFieldKind
  /** Left edge, mm from the label's left edge. */
  x: number
  /** Baseline, mm from the label's top edge. */
  baseline: number
  /** The `h` of `^A0N,h,w`, mm; printed capitals are `ZPL_CAP_RATIO` of it. */
  capHeight: number
  /** Room before the next block — the QR symbol or the label edge — in mm. */
  maxWidth: number
  /** The reference stream's `w` (nominal character width), in mm. */
  refWidth: number
}

export interface LabelQrDesign {
  /** Left edge, mm. */
  x: number
  /** Bottom edge, mm from the label's top edge. */
  bottom: number
  /** Physical width/height of the symbol, mm. */
  size: number
  /** `^BQN,2,<magnification>` at 203 dpi. */
  magnification: number
  /** Modules per side of the version the reference was authored for. */
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
    width: 50,
    height: 40,
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
    width: 50,
    height: 25,
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
    width: 35,
    height: 22,
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
    width: 50,
    height: 10,
    fields: [
      { kind: 'brand', x: 2.06, baseline: 3.125, capHeight: 2.5, maxWidth: 33.09, refWidth: 3.75 },
      { kind: 'name', x: 1.5, baseline: 7.25, capHeight: 2.5, maxWidth: 23.22, refWidth: 2.25 },
      { kind: 'code', x: 24.72, baseline: 3.75, capHeight: 3.125, maxWidth: 16.71, refWidth: 3.125 },
      { kind: 'rate', x: 24.72, baseline: 7.75, capHeight: 3.5, maxWidth: 16.71, refWidth: 2.5 },
    ],
    qr: { x: 41.43, bottom: 9.375, size: 7.875, magnification: 3, modules: 21 },
  },
]

/** Look up the transcribed reference design for a physical label size. */
export function labelDesignFor(width: number, height: number): LabelDesign | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  const tol = 0.15
  return (
    LABEL_DESIGNS.find((d) => Math.abs(d.width - width) <= tol && Math.abs(d.height - height) <= tol) ?? null
  )
}

/** Width of one QR module, mm (the streams print at 8 dots per mm). */
export function qrModuleMm(design: LabelDesign): number {
  return design.qr.magnification / 8
}

/** Clear space the reference leaves on every side of a QR symbol, mm. */
export function qrQuietMm(design: LabelDesign): number {
  return qrModuleMm(design) * QR_QUIET_MODULES
}

/**
 * Top edge of the printed QR symbol, mm.
 *
 * The `^FT` in the reference streams marks the bottom of a box that includes
 * the quiet zone, while its x marks the symbol's own left edge — measuring all
 * four rasterisations puts the ink at `bottom − (modules + QR_QUIET_MODULES)`,
 * within a dot every time. `LabelDesign.qr.bottom` keeps the transcribed `^FT`
 * value so the provenance stays visible.
 */
export function qrTopMm(design: LabelDesign): number {
  return design.qr.bottom - (design.qr.modules + QR_QUIET_MODULES) * qrModuleMm(design)
}

/**
 * Room a line has before the next block, mm — the label edge, the QR symbol or
 * the attribute chip sitting beside it.
 *
 * Text is kept `QR_QUIET_MODULES` clear of the QR box: the reference does the
 * same, and without it a long product name or rate would run straight into the
 * symbol's quiet zone and stop scanning.
 */
export function fieldMaxWidthMm(
  design: LabelDesign,
  field: LabelFieldDesign,
  showQR: boolean,
): number {
  const quiet = qrQuietMm(design)
  let maxWidth = showQR ? field.maxWidth : design.width - field.x

  // Two attribute chips share a row; leave room between them.
  const sibling = design.fields.find((f) => f.kind === 'attr2')
  if (field.kind === 'attr1' && sibling && sibling.x > field.x) {
    maxWidth = Math.min(maxWidth, sibling.x - field.x - quiet)
  }

  if (!showQR || field.x >= design.qr.x) return Math.max(0, maxWidth)

  // Only lines whose row actually crosses the QR box are pushed left of it.
  const boxTop = qrTopMm(design) - quiet
  const capTop = field.baseline - field.capHeight * ZPL_CAP_RATIO
  const overlap = Math.min(field.baseline, design.qr.bottom) - Math.max(capTop, boxTop)
  if (overlap > field.capHeight * ZPL_CAP_RATIO * 0.25) {
    maxWidth = Math.min(maxWidth, design.qr.x - quiet - field.x)
  }
  return Math.max(0, maxWidth)
}

// Helvetica-Bold advance widths (1000 units per em) for printable ASCII. Used
// to condense text the same way in the ZPL output, where the printer's own
// scalable font does the rendering and there is nothing to measure against.
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

/** Width of `text` in em units for Helvetica-Bold. Unknown glyphs use the average. */
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

/**
 * The optional chips the reference prints in its bottom row ("FUY"/"BW" in the
 * samples). They are filled from real product data only — a missing value
 * simply leaves the slot empty, so no placeholder is ever printed.
 */
export function labelAttributes(product: LabelLineInput, opts: LabelLineOptions): string[] {
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

/** Resolve which strings each reference field should print for one product. */
export function designFieldTexts(
  product: LabelLineInput,
  opts: LabelLineOptions,
  design: LabelDesign,
): DesignFieldText[] {
  const out: DesignFieldText[] = []
  const attrs = labelAttributes(product, opts)
  for (const field of design.fields) {
    switch (field.kind) {
      case 'brand': {
        const brand = (opts.brand ?? '').trim()
        if (opts.showBrand !== false && brand) out.push({ kind: 'brand', text: brand.toLocaleUpperCase() })
        break
      }
      case 'name': {
        // Every reference size prints a name line; a product without one still
        // gets the placeholder rather than an empty field.
        const name = (String(product.name ?? '').trim() || 'Product').toLocaleUpperCase()
        out.push({ kind: 'name', text: name })
        break
      }
      case 'rate':
        if (opts.showPrice !== false) out.push({ kind: 'rate', text: formatLabelRate(product.price) })
        break
      case 'code': {
        // The printed code IS the SKU (the same value the QR encodes). It is
        // never truncated: `codeLength` only applies when a caller explicitly
        // asks for a shortened rendering.
        const rawCode = labelCode(product)
        const code = opts.codeLength ? rawCode.slice(0, opts.codeLength) : rawCode
        // The slim 50×10 reference prints the bare identifier; every other size
        // prefixes it with "Code:" exactly like the samples.
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

// ─── Label presets ────────────────────────────────────────────────
// `columns`/`rows` describe how many labels are laid out per A4 sheet; they are
// derived from the physical label size so the grid always fits the page.
//
// The six reference templates cover four physical sizes; the three 50×10
// templates share the recorded geometry but retain their own brand/code rules.
// Remaining entries stay available for backwards compatibility.
interface LabelPresetOptions extends Partial<LabelOptions> {
  label?: string
  reference?: boolean
}

export const LABEL_PRESETS: Record<string, LabelPresetOptions> = {
  // Requested reference sizes
  'label-50x40': { width: 50, height: 40, columns: 4, rows: 7, brand: 'OPAL LINE', reference: true },
  'label-50x25': { width: 50, height: 25, columns: 4, rows: 11, brand: 'OPAL LINE', reference: true },
  'label-35x22': { width: 35, height: 22, columns: 5, rows: 13, brand: 'OPAL LINE', reference: true },
  'label-50x10': {
    width: 50,
    height: 10,
    columns: 4,
    rows: 28,
    label: '50 × 10 mm · Standard',
    brand: 'OPAL LINE',
    reference: true,
  },
  'label-50x10-loni': {
    width: 50,
    height: 10,
    columns: 4,
    rows: 28,
    label: '50 × 10 mm · Alternate',
    brand: 'OPAL LINE',
    reference: true,
  },
  'label-50x10-compact': {
    width: 50,
    height: 10,
    columns: 4,
    rows: 28,
    label: '50 × 10 mm · Compact',
    brand: 'OPAL LINE',
    reference: true,
  },
  // Existing sizes (kept for backwards compatibility)
  'label-50x22': { width: 50, height: 22, columns: 4, rows: 13 },
  'avery-5160': { width: 63.5, height: 25.4, columns: 3, rows: 10 },
  'avery-8160': { width: 38.1, height: 21.2, columns: 4, rows: 12 },
  'dymo-30256': { width: 51, height: 25, columns: 3, rows: 8 },
  'zlabel-50x30': { width: 50, height: 30, columns: 4, rows: 7 },
  'zlabel-40x25': { width: 40, height: 25, columns: 4, rows: 8 },
}

export interface LabelPresetMeta {
  key: string
  label: string
  width: number
  height: number
  columns: number
  rows: number
  /** A template supplied as a physical design reference. */
  reference: boolean
  brand?: string
  codeLength?: number
  /**
   * The transcribed reference geometry (millimetres), when this preset is one
   * of the supplied templates. The print UI uses it to draw a preview that
   * matches the printed label exactly instead of an approximation.
   */
  design?: LabelDesign
}

/** Ordered preset list (reference sizes first) for the print UI. */
export const LABEL_PRESET_LIST: LabelPresetMeta[] = Object.entries(LABEL_PRESETS).map(([key, val]) => {
  const v = val as LabelPresetOptions
  const width = v.width ?? DEFAULT_OPTIONS.width
  const height = v.height ?? DEFAULT_OPTIONS.height
  return {
    key,
    label: v.label ?? `${width} × ${height} mm`,
    width,
    height,
    columns: v.columns ?? DEFAULT_OPTIONS.columns,
    rows: v.rows ?? DEFAULT_OPTIONS.rows,
    reference: v.reference ?? false,
    ...(v.brand ? { brand: v.brand } : {}),
    ...(v.codeLength ? { codeLength: v.codeLength } : {}),
    design: labelDesignFor(width, height) ?? undefined,
  }
})

export const DEFAULT_PRESET = 'label-50x40'

/** Resolve a preset key to a full options object, defaulting unknown keys. */
export function resolveLabelPreset(preset: string | undefined, overrides: Partial<LabelOptions> = {}): LabelOptions {
  const key = preset || DEFAULT_PRESET
  const base = LABEL_PRESETS[key]
  if (!base) throw new Error(`Unknown label preset: ${key}`)
  const merged: LabelOptions = { ...DEFAULT_OPTIONS, ...base, ...overrides }
  // `brand` may arrive as `businessName` from older callers.
  const businessName = (overrides as { businessName?: string }).businessName
  if (businessName && !overrides.brand) merged.brand = businessName
  merged.copies = Math.min(Math.max(Math.floor(Number(merged.copies) || 1), 1), 999)
  return merged
}

function mapRow(p: any): ProductLabel {
  return {
    name: p.name || 'Product',
    sku: p.sku || '',
    price: Number(p.selling_price || 0),
    weight: Number(p.net_weight || 0),
    category: p.category || undefined,
    collection: p.collection || undefined,
    hsn: p.hsn || '7113',
    huid: p.huid || undefined,
  }
}

export async function fetchProductLabels(productIds: string[]): Promise<ProductLabel[]> {
  const client = getRawClient()
  if (!client || productIds.length === 0) return []
  try {
    const products = await client.unsafe(
      `SELECT name, sku, selling_price, net_weight, category, collection, hsn, huid FROM products WHERE id = ANY($1)`,
      [productIds]
    )
    // Preserve the caller's order — the printed sheet should match the order the
    // operator selected, not whatever order the database returns.
    const byId = new Map<string, ProductLabel>()
    for (const p of products) byId.set(p.id, mapRow(p))
    return productIds.map((id) => byId.get(id)).filter((p): p is ProductLabel => Boolean(p))
  } catch (err) {
    logger.error({ err }, 'Failed to fetch product labels')
    return []
  }
}

export async function fetchAllProductLabels(): Promise<ProductLabel[]> {
  const client = getRawClient()
  if (!client) return []
  try {
    const products = await client.unsafe(
      `SELECT name, sku, selling_price, net_weight, category, collection, hsn, huid FROM products ORDER BY name`
    )
    return products.map(mapRow)
  } catch (err) {
    logger.error({ err }, 'Failed to fetch all product labels')
    return []
  }
}

function mmToPt(mm: number): number {
  return (mm / 25.4) * 72
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * The identifier a label encodes. QR labels ALWAYS encode the product's SKU
 * (e.g. `OL-RNG-001`) — barcodes were removed from the product workflow, so
 * the SKU is the single scannable identity and scanning one resolves the
 * product through an exact SKU match.
 */
export function labelCode(product: Pick<ProductLabel, 'sku'>): string {
  return (product.sku ?? '').trim()
}

/**
 * Render the scannable symbol to a PNG sized so that one QR module is a whole
 * number of pixels. The reference streams encode at error-correction level L
 * (`^FDLA,<data>` means "level L, auto data type"), and keeping the module count
 * whole is what stops a tiny label's code from being blurred by resampling.
 */
export async function generateLabelQrBuffer(data: string, sizeMm: number): Promise<Buffer> {
  const qr = await QRCode.create(data, { errorCorrectionLevel: 'L' })
  const modules = qr.modules.size
  // ~12 device pixels per point keeps the symbol crisp on a high-res print.
  const targetPx = mmToPt(sizeMm) * 12
  const px = Math.max(modules, Math.round(targetPx / modules) * modules)
  return QRCode.toBuffer(data, {
    width: px,
    margin: 0,
    errorCorrectionLevel: 'L',
    color: { dark: '#000000', light: '#ffffff' },
  })
}

// ─── Adaptive label layout ────────────────────────────────────────
// All measurements are PDF points relative to the label's own top-left corner.
// Deriving everything from the real label width/height (instead of hard-coded
// offsets) is what lets one renderer fill 50×40, 50×25, 35×22 and 50×10 without
// clipping, overflow or scaling artifacts.
//
// The scannable code sits on the RIGHT and the text column on the LEFT, matching
// the supplied ZPL reference labels.

export interface LabelGeometry {
  pad: number
  innerW: number
  innerH: number
  qrSize: number
  qrGap: number
  qrX: number       // left offset of the code, from the label's left edge
  textX: number
  textWidth: number
}

export function computeLabelGeometry(labelW: number, labelH: number, showQR: boolean): LabelGeometry {
  const pad = clamp(Math.min(labelH * 0.08, labelW * 0.035), 2.5, 5)
  const innerW = labelW - pad * 2
  const innerH = labelH - pad * 2

  let qrSize = 0
  let qrGap = 0
  if (showQR && innerH >= 8) {
    // Never taller than the label, never wider than ~45% of it (so the text
    // keeps its room), capped at 50pt to preserve the look on large labels.
    qrSize = Math.min(innerH, innerW * 0.45, 50)
    qrGap = Math.max(3, pad * 0.6)
  }
  const textX = pad
  const textWidth = Math.max(innerW - (qrSize > 0 ? qrSize + qrGap : 0), 8)
  const qrX = qrSize > 0 ? pad + innerW - qrSize : 0

  return { pad, innerW, innerH, qrSize, qrGap, qrX, textX, textWidth }
}

export type LabelLineKind = 'brand' | 'name' | 'code' | 'category' | 'price' | 'weight'

export interface LabelLine {
  kind: LabelLineKind
  text: string
  fontSize: number
  y: number       // top offset from the label's top edge, in points
  height: number  // line box height, in points
  align: 'left' | 'right'
}

export interface LabelLineInput {
  name: string
  sku: string
  price: number
  weight?: number
  category?: string
  collection?: string
}

export interface LabelLineOptions {
  showPrice: boolean
  showWeight: boolean
  showBrand?: boolean
  brand?: string
  /** On very short labels the "Code:" prefix wastes room — drop it. */
  compact?: boolean
  codeLength?: number
}

const LINE_HEIGHT = 1.15

/**
 * Format the reference "Rate: 99999.00/-" string from a numeric price.
 *
 * The supplied samples print the amount without a thousands separator, and the
 * PDF and the ZPL must agree byte-for-byte, so this is the single source.
 */
export function formatLabelRate(price: number): string {
  const value = Number.isFinite(price) ? price : 0
  return `Rate: ${value.toFixed(2)}/-`
}

export function computeLabelLines(
  geometry: LabelGeometry,
  product: LabelLineInput,
  opts: LabelLineOptions,
): LabelLine[] {
  const { pad, innerH } = geometry

  // Font sizes scale with the label height, so text stays proportional on every
  // size and is clamped so it never becomes illegibly small or oversized.
  const metaSize = clamp(innerH * 0.15, 3, 5.5)
  const nameSize = clamp(innerH * 0.20, 3.5, 7)
  const brandSize = clamp(innerH * 0.24, 3.8, 8.5)
  const priceSize = clamp(innerH * 0.26, 4.5, 9)
  const categorySize = Math.max(metaSize * 0.9, 2.8)

  const priceH = priceSize * LINE_HEIGHT
  const weightSize = metaSize
  const weightH = weightSize * LINE_HEIGHT
  const hasWeight = opts.showWeight && !!product.weight
  const bottomH = Math.max(opts.showPrice ? priceH : 0, hasWeight ? weightH : 0)
  const gap = Math.max(1.5, pad * 0.5)
  const topAvail = Math.max(innerH - bottomH - gap, 0)

  const code = labelCode(product)
  const showBrand = opts.showBrand !== false && !!opts.brand && !opts.compact

  // Top stack, in reference order: brand, name, code, category. `name` is
  // protected — the optional lines are dropped from the *bottom* of this list
  // until the block fits, so a tiny label keeps brand + name + price.
  const stack: Array<{ kind: LabelLineKind; text: string; size: number }> = []
  if (showBrand) stack.push({ kind: 'brand', text: opts.brand as string, size: brandSize })
  if (product.name) stack.push({ kind: 'name', text: product.name, size: nameSize })
  if (code) {
    stack.push({ kind: 'code', text: opts.compact ? code : `Code: ${code}`, size: metaSize })
  }
  if (product.category && !opts.compact) {
    stack.push({ kind: 'category', text: product.category, size: categorySize })
  }

  const droppable = new Set<LabelLineKind>(['brand', 'code', 'category'])
  const total = () => stack.reduce((sum, c) => sum + c.size * LINE_HEIGHT, 0)
  while (total() > topAvail) {
    let idx = -1
    for (let i = stack.length - 1; i >= 0; i--) {
      if (droppable.has(stack[i].kind)) { idx = i; break }
    }
    if (idx === -1) break
    stack.splice(idx, 1)
  }

  const lines: LabelLine[] = []
  let y = pad
  for (const c of stack) {
    const height = c.size * LINE_HEIGHT
    lines.push({ kind: c.kind, text: c.text, fontSize: c.size, y, height, align: 'left' })
    y += height
  }

  // Price pinned to the bottom-left, weight to the bottom-right, on one baseline.
  if (opts.showPrice) {
    lines.push({
      kind: 'price',
      text: formatLabelRate(product.price),
      fontSize: priceSize,
      y: pad + innerH - priceH,
      height: priceH,
      align: 'left',
    })
  }
  if (hasWeight) {
    lines.push({
      kind: 'weight',
      text: `${product.weight}g`,
      fontSize: weightSize,
      y: pad + innerH - weightH,
      height: weightH,
      align: 'right',
    })
  }

  return lines
}

const LINE_STYLE: Record<LabelLineKind, { font: 'Helvetica' | 'Helvetica-Bold'; color: string }> = {
  brand: { font: 'Helvetica-Bold', color: '#111827' },
  name: { font: 'Helvetica-Bold', color: '#1f2937' },
  code: { font: 'Helvetica', color: '#6b728b' },
  category: { font: 'Helvetica', color: '#9ca3af' },
  price: { font: 'Helvetica-Bold', color: '#059669' },
  weight: { font: 'Helvetica', color: '#6b728b' },
}

// Truncate with an ellipsis to the exact pixel width of the active font, so a
// long name/SKU can never spill outside its label.
function fitText(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (maxWidth <= 0 || doc.widthOfString(text) <= maxWidth) return text
  const ellipsis = '\u2026'
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (doc.widthOfString(text.slice(0, mid) + ellipsis) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + ellipsis
}

function drawLabel(
  doc: PDFKit.PDFDocument,
  product: ProductLabel,
  actualX: number,
  actualY: number,
  geometry: LabelGeometry,
  opts: LabelOptions,
  qrBuffer: Buffer | null,
): void {
  // Scannable code on the right, vertically centred (legacy adaptive layout).
  if (opts.showQR && qrBuffer && geometry.qrSize > 0) {
    const qrY = actualY + geometry.pad + Math.max((geometry.innerH - geometry.qrSize) / 2, 0)
    doc.image(qrBuffer, actualX + geometry.qrX, qrY, {
      width: geometry.qrSize,
      height: geometry.qrSize,
    })
  }

  // Text on the left, laid out from the computed geometry so it always stays
  // inside the label for any of the supported sizes.
  const lines = computeLabelLines(
    geometry,
    {
      name: product.name,
      sku: product.sku,
      price: product.price,
      weight: product.weight,
      category: product.category,
    },
    {
      showPrice: opts.showPrice,
      showWeight: opts.showWeight,
      showBrand: opts.showBrand,
      brand: opts.brand,
      compact: opts.height <= 12,
    },
  )

  const x = actualX + geometry.textX
  for (const line of lines) {
    const style = LINE_STYLE[line.kind]
    doc.font(style.font).fontSize(line.fontSize).fillColor(style.color)
    const text = fitText(doc, line.text, geometry.textWidth)
    doc.text(text, x, actualY + line.y, {
      width: geometry.textWidth,
      height: line.height,
      align: line.align,
      lineBreak: false,
      ellipsis: true,
    })
  }
}

// ─── Reference-design rendering ──────────────────────────────────
// Black on white, bold condensed type, tight spacing — the same look the
// supplied print streams produce. No borders, cards or tinted text: the
// samples are plain white labels and any decoration would show up on paper.

const LABEL_INK = '#000000'

export interface FittedDesignText {
  text: string
  /** Horizontal compression applied so the line stays inside its column. */
  scale: number
  /** PDF font size in points — the em size behind the line's height. */
  fontSize: number
}

/** How much of its reference em size a line may give up before it is shortened. */
const MIN_CAP_RATIO = 0.5
const CAP_SHRINK = 0.88

/**
 * Condense a line the way the reference's narrow scalable font does, while
 * keeping the reference's height wherever possible.
 *
 * Two things limit the line: the width the reference's own `w` parameter asks
 * for (`baseScale`, the condensation its design intends) and the column it has
 * to live in. Whichever is tighter wins, so a line matches the sample for
 * ordinary product names and can never run under the QR symbol. A line that
 * still will not fit is first given a slightly smaller em size — what a label
 * designer would do — and only shortened with an ellipsis as a last resort, so
 * it is never clipped and never overlaps its neighbours.
 */
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

  // Last resort: shorten the line until it condenses within tolerance.
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

/**
 * The same decision as {@link fitDesignText}, expressed in the printer's units:
 * returns the `h` and `w` of `^A0N,h,w` for one line. Exported so the ZPL
 * renderer condenses text by exactly the rules the PDF uses.
 */
export function fitDesignField(
  text: string,
  maxWidthDots: number,
  refHeightDots: number,
  refWidthDots: number,
): { h: number; w: number } {
  const em = textEmWidth(text)
  // Condensation `w` produces at this height — the PDF's `baseScale`.
  const baseScale = refWidthDots / (refHeightDots / ZPL_EM_RATIO)
  const floor = Math.min(MIN_TEXT_SCALE, baseScale)
  const shrinkFloor = Math.max(4, Math.round(refHeightDots * MIN_CAP_RATIO))
  const fitWidth = (): number =>
    em > 0 ? Math.max(4, Math.min(refWidthDots, Math.floor(maxWidthDots / em))) : refWidthDots

  for (let h = refHeightDots; ; h = Math.max(shrinkFloor, Math.round(h * CAP_SHRINK))) {
    const w = fitWidth()
    if (em <= 0 || w / (h / ZPL_EM_RATIO) >= floor) return { h, w }
    if (h <= shrinkFloor) return { h, w }
  }
}

/** Draw one label following a transcribed reference design. */
function drawDesignLabel(
  doc: PDFKit.PDFDocument,
  product: ProductLabel,
  design: LabelDesign,
  originX: number,
  originY: number,
  opts: LabelOptions,
  qrBuffer: Buffer | null,
): void {
  const texts = designFieldTexts(product, opts, design)
  const fields = new Map(design.fields.map((f) => [f.kind, f]))
  const measure = (text: string, fontSize: number): number => {
    doc.font('Helvetica-Bold').fontSize(fontSize)
    return doc.widthOfString(text)
  }

  for (const entry of texts) {
    const field = fields.get(entry.kind)
    if (!field) continue
    // The reference's `h` spans ascender to descender: the em size behind it is
    // `h / 0.925`, and `w` over that em size is the condensation it asks for.
    const fontSizeMm = field.capHeight / ZPL_EM_RATIO
    const baseScale = field.refWidth / fontSizeMm
    const maxWidthMm = fieldMaxWidthMm(design, field, opts.showQR !== false)
    const fitted = fitDesignText(measure, entry.text, mmToPt(fontSizeMm), mmToPt(maxWidthMm), baseScale)
    doc.save()
    // PDFKit positions the top of the ascender; the reference positions the
    // baseline, so the box top sits one printed cap height above it.
    const capDrawnPt = fitted.fontSize * CAP_HEIGHT
    doc.translate(originX + mmToPt(field.x), originY + mmToPt(field.baseline) - capDrawnPt)
    doc.scale(fitted.scale, 1)
    doc.font('Helvetica-Bold').fontSize(fitted.fontSize).fillColor(LABEL_INK)
    doc.text(fitted.text, 0, 0, { lineBreak: false })
    doc.restore()
  }

  if (opts.showQR !== false && qrBuffer) {
    doc.image(
      qrBuffer,
      originX + mmToPt(design.qr.x),
      originY + mmToPt(qrTopMm(design)),
      { width: mmToPt(design.qr.size), height: mmToPt(design.qr.size) },
    )
  }
}

export async function generateLabelsPDF(
  products: ProductLabel[],
  options: Partial<LabelOptions> & { preset?: string } = {}
): Promise<Buffer | null> {
  if (products.length === 0) return null

  const resolved = resolveLabelPreset(options.preset, options)

  const labelW = mmToPt(resolved.width)
  const labelH = mmToPt(resolved.height)
  // The four supplied sizes print from their transcribed reference design; any
  // other (legacy) size keeps the adaptive layout it has always used.
  const design = labelDesignFor(resolved.width, resolved.height)
  const geometry = computeLabelGeometry(labelW, labelH, resolved.showQR)

  const copies = Math.min(Math.max(Math.floor(resolved.copies) || 1, 1), 999)
  const expanded: ProductLabel[] = []
  for (const product of products) for (let i = 0; i < copies; i++) expanded.push(product)

  // Pre-generate all QR codes at the exact size the layout will draw them.
  // `geometry.qrSize` is in points, so convert it before sharing one path.
  const qrSizeMm = design ? design.qr.size : (geometry.qrSize * 25.4) / 72
  const qrBuffers: (Buffer | null)[] = []
  if (resolved.showQR && qrSizeMm > 0) {
    for (const product of expanded) {
      const code = labelCode(product)
      qrBuffers.push(code ? await generateLabelQrBuffer(code, qrSizeMm) : null)
    }
  }

  return new Promise((resolve) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 20, bottom: 20, left: 20, right: 20 },
    })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const startX = mmToPt(clamp(resolved.margin, 0, 40))
    const startY = mmToPt(clamp(resolved.margin, 0, 40))
    const gapPt = mmToPt(clamp(resolved.gap, 0, 20))
    const stepX = labelW + gapPt
    const stepY = labelH + gapPt
    const columns = Math.max(1, Math.floor(resolved.columns))
    const rows = Math.max(1, Math.floor(resolved.rows))
    let col = 0
    let row = 0

    for (let i = 0; i < expanded.length; i++) {
      const product = expanded[i]

      // Check if we need a new page
      if (row >= rows) {
        doc.addPage()
        col = 0
        row = 0
      }

      const actualY = startY + row * stepY
      const actualX = startX + col * stepX

      if (design) {
        drawDesignLabel(doc, product, design, actualX, actualY, resolved, qrBuffers[i] ?? null)
      } else {
        drawLabel(doc, product, actualX, actualY, geometry, resolved, qrBuffers[i] ?? null)
      }

      // Advance position
      col++
      if (col >= columns) {
        col = 0
        row++
      }
    }

    doc.end()
  }) as any
}
