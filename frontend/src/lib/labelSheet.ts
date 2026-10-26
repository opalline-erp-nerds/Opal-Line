import bwipJs from 'bwip-js'

export interface LabelProduct {
  id: string
  name: string
  sku: string
  price: number
  weight?: number
  category?: string
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
  { key: 'zlabel-50x30', label: '50 × 30 mm (Standard)', widthMm: 50, heightMm: 30, marginMm: 4, gapMm: 0 },
  { key: 'zlabel-40x25', label: '40 × 25 mm (Compact)', widthMm: 40, heightMm: 25, marginMm: 4, gapMm: 2 },
  { key: 'label-50x25', label: '50 × 25 mm', widthMm: 50, heightMm: 25, marginMm: 4, gapMm: 0 },
  { key: 'label-50x22', label: '50 × 22 mm', widthMm: 50, heightMm: 22, marginMm: 4, gapMm: 0 },
  { key: 'label-35x22', label: '35 × 22 mm', widthMm: 35, heightMm: 22, marginMm: 5, gapMm: 0 },
  { key: 'label-50x10', label: '50 × 10 mm', widthMm: 50, heightMm: 10, marginMm: 4, gapMm: 0 },
  { key: 'avery-5160', label: 'Avery 5160', widthMm: 63.5, heightMm: 25.4, marginMm: 5.1, gapMm: 3.2 },
  { key: 'avery-8160', label: 'Avery 8160', widthMm: 38.1, heightMm: 21.2, marginMm: 4.7, gapMm: 2.5 },
  { key: 'dymo-30256', label: 'DYMO 30256', widthMm: 51, heightMm: 25, marginMm: 6, gapMm: 4 },
  { key: 'custom', label: 'Custom size…', widthMm: 50, heightMm: 30, marginMm: 4, gapMm: 0 },
]

export const DEFAULT_LABEL_CONFIG: LabelConfig = {
  presetKey: 'zlabel-50x30',
  widthMm: 50,
  heightMm: 30,
  marginMm: 4,
  gapMm: 0,
  page: 'a4',
  copies: 1,
  showName: true,
  showSku: true,
  showPrice: true,
  showWeight: true,
  showHuid: true,
  showCategory: false,
  showCompany: false,
  showQr: true,
  showBorder: true,
  fontScale: 1,
  companyName: 'OPAL LINE JEWELS LLP',
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
}/**
 * What the QR symbol encodes: ONLY the product SKU (e.g. `OL-RNG-001`).
 * Product names, prices and weights are never part of the payload — scanning
 * a printed label must resolve the product through an exact SKU match.
 */
export function qrPayload(p: LabelProduct): string {
  return (p.sku ?? '').trim()
}

function withFillViewport(svg: string, preserveAspectRatio: string): string {
  return svg.replace(/<svg\s+/, `<svg width="100%" height="100%" preserveAspectRatio="${preserveAspectRatio}" `)
}

// bwip-js passes any option straight to the BWIPP encoder, but its bundled
// types only list a subset — cast so encoder-specific options type-check.
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
        // bwipp's option is spelled `eclevel`; M keeps codes small while
        // tolerating typical label damage.
        eclevel: 'M',
        scale: 1,
        barcolor: '1A1A2E',
        backgroundcolor: 'FFFFFF',
      }),
    )
    // Quiet zone comes from CSS padding; keep the square code undistorted.
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

function buildLabelHtml(p: LabelProduct, cfg: LabelConfig, qrCode: string | null): string {
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
      cells.push(buildLabelHtml(p, cfg, qr))
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
      border-radius:0.8mm;overflow:hidden;background:#fff;position:relative;
      display:flex;flex-direction:column;padding:${padFor(cfg)}mm;
    }
    .lbl .body{display:flex;align-items:stretch;min-height:0;}
    .lbl .qr{flex:none;padding:0.4mm;background:#fff;}
    .lbl .qr svg{display:block;width:100%;height:100%;}
    .lbl .info{flex:1;min-width:0;display:flex;flex-direction:column;}
    .lbl .name{
      font-size:${clamp(cfg.heightMm * 0.115 * cfg.fontScale, 1.5, 4.2)}mm;
      font-weight:700;line-height:1.15;color:#1f2937;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
      word-break:break-word;
    }
    .lbl .meta{
      font-size:${clamp(cfg.heightMm * 0.075 * cfg.fontScale, 1.1, 2.6)}mm;
      color:#6b7280;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .lbl .meta.huid{color:#b45309;font-weight:600;}
    .lbl .meta.cat{color:#9ca3af;}
    .lbl .company{
      font-size:${clamp(cfg.heightMm * 0.065 * cfg.fontScale, 1, 2.2)}mm;
      font-weight:700;color:#374151;letter-spacing:.04em;line-height:1.2;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:uppercase;
    }
    .lbl .bottom{margin-top:auto;display:flex;align-items:baseline;justify-content:space-between;gap:1mm;}
    .lbl .price{
      font-size:${clamp(cfg.heightMm * 0.15 * cfg.fontScale, 1.7, 5)}mm;
      font-weight:800;color:#047857;line-height:1.1;
    }
    .lbl .weight{
      font-size:${clamp(cfg.heightMm * 0.085 * cfg.fontScale, 1.2, 3)}mm;
      color:#6b7280;line-height:1.1;
    }
    @media print{
      body{background:#fff;}
      .page{margin:0;box-shadow:none;}
    }
    ${screenCss}
  </style></head><body>${pages.join('')}</body></html>`

  return { html, totalLabels, totalPages, renderedLabels: rendered.length }
}

function padFor(cfg: LabelConfig): string {
  return clamp(Math.min(cfg.heightMm * 0.07, cfg.widthMm * 0.035), 0.4, 1.6).toFixed(2)
}

export const MM_TO_PX = 96 / 25.4
