// Safe ZPL (Zebra Programming Language) label renderer.
//
// The recorded reference labels use Zebra ZPL at 203 dpi (8 dots/mm) and print
// a QR symbol with `^BQN` encoding the product code. This module reproduces that
// command set for the four physical sizes.
//
// Safety properties:
//  - one `^XA … ^XZ` block per physical label, so labels can never be clipped or
//    overlapped the way a hand-written multi-up template can be;
//  - every text field is escaped (`^`, `~`, `\` via `^FH\` hex escapes) so a
//    product name can never inject a ZPL command;
//  - label dimensions are validated (1–200 mm) before any command is emitted;
//  - copies use the printer's own `^PQ` counter rather than repeating blocks.
//
// This renderer only produces text. It is never sent directly to a raw printer
// port — the caller decides how to deliver it (file download for a ZPL-capable
// printer / print server), so a browser can never be asked to open a socket.

import { labelCode, LABEL_PRESETS, labelDesignFor, designFieldTexts, fitDesignField, fieldMaxWidthMm, type LabelDesign, type ProductLabel } from './barcodeLabels'

export const ZPL_DOTS_PER_MM = 8
export const ZPL_MAX_MM = 200

export interface ZplOptions {
  width: number        // mm
  height: number       // mm
  copies?: number
  brand?: string
  showPrice?: boolean
  showWeight?: boolean
  showQR?: boolean
  showBrand?: boolean
  codeLength?: number
}

export interface ZplLabelInput extends ProductLabel {}

/** Reason the requested dimensions cannot be printed, or null when valid. */
export function zplDimensionError(width: number, height: number): string | null {
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isFinite(value) || value <= 0) return `Label ${name} must be a positive number of millimetres`
    if (value > ZPL_MAX_MM) return `Label ${name} must be ${ZPL_MAX_MM} mm or less`
  }
  return null
}

/**
 * Escape a text field for use after `^FH\`. The three characters that can start
 * a ZPL command (`^`, `~`) or the hex-escape introducer itself (`\`) are emitted
 * as `\xx` hex pairs; other non-printable/non-ASCII characters become `?` so the
 * byte stream stays safe with `^CI28` (UTF-8) set.
 */
export function zplEscape(text: unknown): string {
  let out = ''
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\\') { out += '\\5C'; continue }
    if (ch === '^') { out += '\\5E'; continue }
    if (ch === '~') { out += '\\7E'; continue }
    if (code < 0x20 || code > 0x7e) { out += '?'; continue }
    out += ch
  }
  return out
}

function mmToDots(mm: number): number {
  return Math.max(1, Math.round(mm * ZPL_DOTS_PER_MM))
}

function formatRate(price: number): string {
  const value = Number.isFinite(price) ? price : 0
  return `Rate: ${value.toFixed(2)}/-`
}

interface ZplGeometry {
  widthDots: number
  heightDots: number
  pad: number
  qrSize: number
  qrX: number
  qrY: number
  textWidth: number
  brandFont: number
  nameFont: number
  rateFont: number
  codeFont: number
}

function computeGeometry(width: number, height: number): ZplGeometry {
  const widthDots = mmToDots(width)
  const heightDots = mmToDots(height)
  const pad = Math.round(Math.min(widthDots, heightDots) * 0.06)
  const qrSize = Math.min(heightDots - pad * 2, Math.round(widthDots * 0.42))
  return {
    widthDots,
    heightDots,
    pad,
    qrSize,
    qrX: widthDots - pad - qrSize,
    qrY: heightDots - pad - qrSize,
    textWidth: Math.max(widthDots - 2 * pad - (qrSize > 0 ? qrSize + pad : 0), 8),
    brandFont: Math.max(12, Math.round(heightDots * 0.15)),
    nameFont: Math.max(10, Math.round(heightDots * 0.10)),
    rateFont: Math.max(12, Math.round(heightDots * 0.15)),
    codeFont: Math.max(9, Math.round(heightDots * 0.085)),
  }
}

// ─── Reference-design ZPL ────────────────────────────────────────
// Emits the recorded `^FT`/`^A0N`/`^BQ` grid so the PDF and ZPL stay aligned.

/**
 * Fit one line of `^A0N,h,w`.
 *
 * `w` is the nominal character width the reference stream asks for, capped by
 * the room the line actually has so nothing runs under the QR symbol; `h` only
 * drops when a line is so long that no readable size would hold it. The rules
 * live in `barcodeLabels.ts` and are shared with the PDF, which is what keeps
 * the two formats' layouts in step.
 */
function zplFitLine(text: string, maxWidthDots: number, refHeightMm: number, refWidthMm: number): string {
  const fitted = fitDesignField(
    text,
    maxWidthDots,
    Math.round(refHeightMm * ZPL_DOTS_PER_MM),
    Math.round(refWidthMm * ZPL_DOTS_PER_MM),
  )
  return `${fitted.h},${fitted.w}`
}

function zplDesignLabel(product: ZplLabelInput, options: ZplOptions, design: LabelDesign): string | null {
  const copies = Math.min(Math.max(Math.floor(options.copies ?? 1) || 1, 1), 999)
  const showQR = options.showQR !== false

  const fieldTexts = designFieldTexts(
    product,
    {
      showPrice: options.showPrice !== false,
      showWeight: options.showWeight !== false,
      showBrand: options.showBrand !== false,
      brand: options.brand ?? '',
      codeLength: options.codeLength,
    },
    design,
  )
  const fields = new Map(design.fields.map((f) => [f.kind, f]))

  const lines: string[] = []
  lines.push('^XA')
  lines.push('^CI28')
  lines.push(`^PW${mmToDots(design.width)}`)
  lines.push(`^LL${mmToDots(design.height)}`)
  lines.push('^MMT')
  lines.push('^LS0')
  lines.push('^LH0,0')

  for (const entry of fieldTexts) {
    const field = fields.get(entry.kind)
    if (!field) continue
    const maxWidthMm = fieldMaxWidthMm(design, field, showQR)
    const hw = zplFitLine(entry.text, mmToDots(maxWidthMm), field.capHeight, field.refWidth)
    lines.push(
      `^FT${mmToDots(field.x)},${mmToDots(field.baseline)}^A0N,${hw}^FH\\^FD${zplEscape(entry.text)}^FS`,
    )
  }

  const code = labelCode(product)
  if (showQR && code) {
    // `^FT` + `^BQN` are emitted verbatim from the reference stream: the
    // printer applies its own quiet-zone anchoring, which is exactly what the
    // supplied samples show, so ZPL output lands where the reference does.
    // The symbol ALWAYS encodes the SKU — barcodes were removed from the
    // product workflow.
    lines.push(
      `^FT${mmToDots(design.qr.x)},${mmToDots(design.qr.bottom)}^BQN,2,${design.qr.magnification}`,
    )
    lines.push(`^FH\\^FDLA,${code}^FS`)
  }

  lines.push(`^PQ${copies},0,1,Y`)
  lines.push('^XZ')
  return lines.join('\n')
}

/** Content for a single ZPL label block. Exported for tests. */
export function zplLabel(product: ZplLabelInput, options: ZplOptions): string | null {
  const error = zplDimensionError(options.width, options.height)
  if (error) return null

  const design = labelDesignFor(options.width, options.height)
  if (design) return zplDesignLabel(product, options, design)

  const g = computeGeometry(options.width, options.height)
  const copies = Math.min(Math.max(Math.floor(options.copies ?? 1) || 1, 1), 999)
  const code = zplEscape(labelCode(product))
  const brand = options.showBrand === false ? '' : zplEscape((options.brand ?? 'Opal Line').trim())
  const name = zplEscape(product.name || 'Product')

  const lines: string[] = []
  lines.push('^XA')
  lines.push('^CI28')
  lines.push(`^PW${g.widthDots}`)
  lines.push(`^LL${g.heightDots}`)
  lines.push('^LH0,0')

  // Text stack on the left, mirroring the reference order.
  let y = g.pad + g.brandFont
  if (brand) lines.push(`^FT${g.pad},${y}^A0N,${g.brandFont},${g.brandFont}^FH\\^FD${brand}^FS`)
  y += Math.round(g.nameFont * 1.4) + Math.round(g.brandFont * 0.3)
  lines.push(`^FT${g.pad},${y}^A0N,${g.nameFont},${g.nameFont}^FH\\^FD${name}^FS`)
  if (options.showPrice !== false) {
    y += Math.round(g.rateFont * 1.5)
    lines.push(`^FT${g.pad},${y}^A0N,${g.rateFont},${g.rateFont}^FH\\^FD${zplEscape(formatRate(product.price))}^FS`)
  }
  if (code) {
    y += Math.round(g.codeFont * 1.7)
    const label = options.height <= 12 ? code : `Code: ${code}`
    lines.push(`^FT${g.pad},${y}^A0N,${g.codeFont},${g.codeFont}^FH\\^FD${label}^FS`)
  }

  // Scannable symbol, bottom-right (reference placement). Always a QR code
  // carrying the SKU.
  if (code) {
    const mag = Math.min(10, Math.max(2, Math.floor(g.qrSize / 30)))
    lines.push(`^FT${g.qrX},${g.qrY + g.qrSize}^BQN,2,${mag}`)
    lines.push(`^FH\\^FDLA,${code}^FS`)
  }

  lines.push(`^PQ${copies},0,1,Y`)
  lines.push('^XZ')
  return lines.join('\n')
}

/** Render one ZPL block per label. Returns '' when nothing can be rendered. */
export function renderZpl(products: ZplLabelInput[], options: ZplOptions): string {
  if (products.length === 0) return ''
  if (zplDimensionError(options.width, options.height)) return ''
  const blocks: string[] = []
  for (const product of products) {
    const block = zplLabel(product, options)
    if (block) blocks.push(block)
  }
  return blocks.join('\n')
}

/** Build options from a preset key, so callers share one source of dimensions. */
export function zplOptionsForPreset(preset: string | undefined, overrides: Partial<ZplOptions> = {}): ZplOptions {
  const key = preset || 'label-50x40'
  const base = LABEL_PRESETS[key]
  if (!base) throw new Error(`Unknown label preset: ${key}`)
  return {
    width: (overrides.width ?? (base as { width?: number }).width ?? 50),
    height: (overrides.height ?? (base as { height?: number }).height ?? 40),
    copies: overrides.copies ?? 1,
    brand: overrides.brand ?? base.brand ?? 'Opal Line',
    showPrice: overrides.showPrice ?? true,
    showWeight: overrides.showWeight ?? true,
    showQR: overrides.showQR ?? true,
    showBrand: overrides.showBrand ?? true,
    ...(overrides.codeLength ?? base.codeLength ? { codeLength: overrides.codeLength ?? base.codeLength } : {}),
  }
}
