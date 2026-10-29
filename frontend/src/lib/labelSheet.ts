import bwipJs from 'bwip-js'

export interface LabelProduct {
  id: string
  name: string
  sku: string
  price: number
  weight?: number
  purity?: number
  category?: string
  huid?: string
}

export type LabelPageFormat = 'a4' | 'letter'

export interface LabelConfig {
  presetKey: string
  labelType: 'label' | 'tag'
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
  { key: 'jewellery-tag-55x20', label: 'Jewellery Tag 55 × 20 mm', widthMm: 55, heightMm: 20, marginMm: 2, gapMm: 2 },
  { key: 'jewellery-tag-60x25', label: 'Jewellery Tag 60 × 25 mm', widthMm: 60, heightMm: 25, marginMm: 2, gapMm: 2 },
  { key: 'jewellery-tag-40x15', label: 'Jewellery Tag 40 × 15 mm', widthMm: 40, heightMm: 15, marginMm: 2, gapMm: 2 },
  { key: 'jewellery-tag-80x30', label: 'Jewellery Tag 80 × 30 mm', widthMm: 80, heightMm: 30, marginMm: 2, gapMm: 2 },
  { key: 'avery-5160', label: 'Avery 5160', widthMm: 63.5, heightMm: 25.4, marginMm: 5.1, gapMm: 3.2 },
  { key: 'avery-8160', label: 'Avery 8160', widthMm: 38.1, heightMm: 21.2, marginMm: 4.7, gapMm: 2.5 },
  { key: 'dymo-30256', label: 'DYMO 30256', widthMm: 51, heightMm: 25, marginMm: 6, gapMm: 4 },
  { key: 'custom', label: 'Custom size…', widthMm: 50, heightMm: 30, marginMm: 4, gapMm: 0 },
]

export const DEFAULT_LABEL_CONFIG: LabelConfig = {
  presetKey: 'jewellery-tag-55x20',
  labelType: 'tag',
  widthMm: 55,
  heightMm: 20,
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
    labelType: /tag/i.test(p.key) ? 'tag' : 'label',
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
  const margin = clamp(cfg.marginMm, 0, 40)
  const gap = clamp(cfg.gapMm, 0, 20)
  // A tag's cell includes its stem — the grid must never let an adjacent
  // label overlap the stem that hangs outside the body footprint.
  const cell = labelCellSize(cfg)
  const w = Math.max(5, cell.widthMm)
  const h = Math.max(5, cell.heightMm)
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

export function isTagLabel(cfg: LabelConfig): boolean {
  return cfg.labelType === 'tag'
}

export interface TagStem {
  /** Stem thickness across (vertical), mm — narrow neck relative to the body height. */
  width: number
  /** Stem length extending horizontally to the RIGHT of the body, mm. */
  length: number
  /** Total tag footprint including the stem — what the printer must print. */
  overallW: number
  overallH: number
}

/**
 * The single derivation of the jewellery-tag stem.
 *
 * `widthMm`/`heightMm` in the config are ALWAYS the body itself; the stem is
 * attached at the vertical centre of the body's RIGHT EDGE and extends
 * horizontally to the right — a narrow neck with a rounded outer tip, part
 * of the same outline as the body. The stem is strictly narrower than the
 * body height (18% of the body height across) and extends 40% of the body
 * width beyond the right edge, so it adds WIDTH to the footprint and never
 * height: a custom 70×24 tag and a preset tag produce proportionally
 * identical stems. Every consumer (grid, label HTML, sheet CSS, preview
 * frame and the printed @page size) reads these numbers from here so they
 * can never drift apart again.
 */
export function tagStem(cfg: LabelConfig): TagStem | null {
  if (!isTagLabel(cfg)) return null
  const width = Math.max(4, Math.round(cfg.heightMm * 0.18))
  const length = Math.max(8, Math.round(cfg.widthMm * 0.4))
  return {
    width,
    length,
    overallW: cfg.widthMm + length,
    overallH: cfg.heightMm,
  }
}

/** The physical footprint ONE label occupies on any paper (body, or body + stem for tags). */
export function labelCellSize(cfg: LabelConfig): { widthMm: number; heightMm: number } {
  const stem = tagStem(cfg)
  if (!stem) return { widthMm: cfg.widthMm, heightMm: cfg.heightMm }
  return { widthMm: stem.overallW, heightMm: stem.overallH }
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
        barcolor: '000000',
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

interface TagRowSpec {
  cls: 'brand' | 'name' | 'code' | 'price' | 'weight' | 'purity' | 'huid'
  /** Font size as a fraction of the body height (the reference ratios). */
  ratio: number
  min: number
  max: number
  text: string
}

/**
 * Fit the tag's enabled text rows to the REAL inner body height.
 *
 * The body's mm size is exact and fixed by the user, so the fonts adapt to
 * the number of enabled fields: desired sizes come from the reference ratios
 * of the body height (× the user's text-scale), and when the stack would
 * overflow it first shrinks proportionally, then drops the lowest-priority
 * rows — while the product name and price are ALWAYS kept.
 */
function fitTagRows(
  specs: TagRowSpec[],
  innerH: number,
  gapY: number,
  em: number,
): Array<{ cls: TagRowSpec['cls']; text: string; size: number }> {
  const droppable = ['purity', 'huid', 'code', 'weight', 'brand']
  const usable = Math.max(2, innerH)
  const stack = (current: TagRowSpec[]): Array<{ cls: TagRowSpec['cls']; text: string; size: number }> => {
    const sizes = current.map((r) => clamp(em * r.ratio, r.min, r.max))
    const fontTotal = sizes.reduce((a, b) => a + b, 0)
    const gaps = gapY * (current.length - 1)
    if (fontTotal + gaps <= usable || current.length <= 2) {
      // Fits as desired — or only the protected rows remain: scale to fit.
      const k = fontTotal > 0 ? Math.min(1, (usable - gaps) / fontTotal) : 1
      return current.map((r, i) => ({ cls: r.cls, text: r.text, size: Math.max(sizes[i] * k, 0.9) }))
    }
    const k = (usable - gaps) / fontTotal
    if (Math.min(...sizes) * k >= 1 || !droppable.some((cls) => current.some((r) => r.cls === cls))) {
      return current.map((r, i) => ({ cls: r.cls, text: r.text, size: Math.max(sizes[i] * k, 0.9) }))
    }
    // A line would fall below legibility — drop the lowest-priority row and retry.
    const lowest = droppable.find((cls) => current.some((r) => r.cls === cls))!
    return stack(current.filter((r) => r.cls !== lowest))
  }
  return stack(specs)
}

function buildLabelHtml(p: LabelProduct, cfg: LabelConfig, qrCode: string | null): string {
  if (isTagLabel(cfg)) {
    const stem = tagStem(cfg)!
    const w = cfg.widthMm // body only — the stem extends to its RIGHT
    const h = cfg.heightMm
    // The whole tag is ONE continuous outline drawn in mm coordinates: a
    // body with slightly rounded corners and a narrow stem attached at the
    // vertical centre of its right edge — smooth curved shoulders into a
    // straight narrow neck and a fully rounded (semicircular) tip, like a
    // physical earring tag lying horizontally. Never a separate box, a
    // vertical divider or a full-height right-side extension. viewBox is
    // 1 unit = 1 mm so stroke widths stay physical.
    const r = Math.min(1.2, w / 4, h / 4) // body corner radius
    const hsw = stem.width / 2 // stem neck half-thickness
    const shoulder = Math.min(hsw * 0.45, 2.2, Math.max(0.2, h / 2 - hsw - r)) // shoulder fillet extents
    const cy = h / 2 // stem centreline on the body's right edge
    const p2 = (n: number) => String(Math.round(n * 100) / 100)
    const outline =
      `M ${p2(r)} 0 H ${p2(w - r)}` +
      ` A ${p2(r)} ${p2(r)} 0 0 1 ${p2(w)} ${p2(r)}` + // top-right corner
      ` V ${p2(cy - hsw - shoulder)}` + // right edge down to the top shoulder
      ` Q ${p2(w)} ${p2(cy - hsw)} ${p2(w + shoulder)} ${p2(cy - hsw)}` + // top shoulder fillet
      ` H ${p2(w + stem.length - hsw)}` + // straight narrow top of the neck
      ` A ${p2(hsw)} ${p2(hsw)} 0 0 1 ${p2(w + stem.length - hsw)} ${p2(cy + hsw)}` + // rounded tip
      ` H ${p2(w + shoulder)}` + // straight narrow bottom of the neck
      ` Q ${p2(w)} ${p2(cy + hsw)} ${p2(w)} ${p2(cy + hsw + shoulder)}` + // bottom shoulder fillet
      ` V ${p2(h - r)}` + // right edge down to the bottom-right corner
      ` A ${p2(r)} ${p2(r)} 0 0 1 ${p2(w - r)} ${p2(h)}` + // bottom-right corner
      ` H ${p2(r)}` +
      ` A ${p2(r)} ${p2(r)} 0 0 1 0 ${p2(h - r)}` + // bottom-left corner
      ` V ${p2(r)}` +
      ` A ${p2(r)} ${p2(r)} 0 0 1 ${p2(r)} 0 Z` // top-left corner

    // Content must stay inside the BODY, and the tag is always horizontal:
    // text rows on the left, QR on the right, stem area left empty.
    const padY = 1.2
    const qrSize = qrCode ? clamp(Math.min(h * 0.62, w * 0.22), 4, 12) : 0
    const showQr = !!qrCode && qrSize >= 3
    const gapY = 0.6
    const borderY = cfg.showBorder ? 0.25 * 2 : 0
    const innerH = h - padY * 2 - borderY
    const allRows: TagRowSpec[] = [
      { cls: 'brand', text: cfg.showCompany && cfg.companyName ? escapeHtml(cfg.companyName) : '', ratio: 0.2, min: 1.6, max: 4 },
      { cls: 'name', text: cfg.showName && p.name ? escapeHtml(p.name) : '', ratio: 0.24, min: 1.8, max: 4.8 },
      { cls: 'code', text: cfg.showSku && p.sku ? escapeHtml(p.sku) : '', ratio: 0.18, min: 1.5, max: 3.6 },
      { cls: 'price', text: cfg.showPrice ? formatPrice(p.price) : '', ratio: 0.26, min: 2, max: 5.2 },
      { cls: 'weight', text: cfg.showWeight && p.weight ? `${p.weight} g` : '', ratio: 0.22, min: 1.5, max: 4.4 },
      { cls: 'purity', text: p.purity ? `${p.purity}` : '', ratio: 0.13, min: 1.2, max: 2.6 },
      { cls: 'huid', text: cfg.showHuid && p.huid ? escapeHtml(p.huid) : '', ratio: 0.12, min: 1.1, max: 2.4 },
    ]
    const specs = allRows.filter((row) => row.text !== '')
    // Reference metric = the smaller body side so fonts stay sane for every
    // custom shape; square-ish bodies keep exactly the sizes they had before.
    const rows = fitTagRows(specs, innerH, gapY, Math.min(w, h) * cfg.fontScale)
    const rowHtml = rows
      .map((row) => `<div class="${row.cls}" style="font-size:${row.size.toFixed(2)}mm">${row.text}</div>`)
      .join('\n            ')

    return `
      <div class="lbl tag">
        <svg class="tag-outline" viewBox="0 0 ${stem.overallW} ${h}" xmlns="http://www.w3.org/2000/svg">
          <path d="${outline}" fill="#fff" ${cfg.showBorder ? 'stroke="#000" stroke-width="0.25"' : ''}/>
        </svg>
        <div class="tag-content" style="width:${w}mm;height:${h}mm">
          <div class="info">
            ${rowHtml}
          </div>
          ${showQr ? `<div class="qr" style="width:${qrSize}mm;height:${qrSize}mm">${qrCode}</div>` : ''}
        </div>
      </div>`
  }

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
  paper?: 'sheet' | 'label'
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
  const paper = opts.paper ?? 'sheet'
  const sheetPage = PAGE_SIZES[cfg.page]
  // ONE source for the stem and the physical footprint of a label:
  // body-only for normal labels, body + stem for tags.
  const stem = tagStem(cfg)
  const cell = labelCellSize(cfg)
  const tagOverallW = stem ? stem.overallW : cfg.widthMm
  const tagOverallH = stem ? stem.overallH : cfg.heightMm
  const page = paper === 'label'
    ? { widthMm: tagOverallW, heightMm: tagOverallH, label: 'Label' }
    : sheetPage
  const grid = paper === 'label'
    ? { columns: 1, rows: 1, labelsPerPage: 1, overflow: false }
    : computeGrid(cfg)
  const pagePadding = paper === 'label' ? 0 : cfg.marginMm
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
    /* The printed page is ALWAYS the physical footprint of one label:
       for a jewellery tag that INCLUDES the stem, so the stem never falls off
       the printed page even though it stays outside the configured label size. */
    @page{size:${page.widthMm}mm ${page.heightMm}mm;margin:0;}
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{background:#fff;color:#111827;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    body{font-family:"Segoe UI",Arial,Helvetica,sans-serif;}
    .page{
       width:${page.widthMm}mm;height:${page.heightMm}mm;padding:${pagePadding}mm;
      display:grid;grid-template-columns:repeat(${grid.columns},${cell.widthMm}mm);
      grid-auto-rows:${cell.heightMm}mm;gap:${cfg.gapMm}mm;
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
    .lbl.tag{position:relative;background:transparent;border:none;border-radius:0;overflow:visible;padding:0;flex:none;width:${tagOverallW}mm;height:${tagOverallH}mm;}
    /* The container spans the FULL footprint (body + right-side stem) so the
       1:1 mm viewBox SVG never rescales. The content layer is pinned to the
       body rectangle at its left; the stem area stays empty. */
    .lbl.tag .tag-outline{position:absolute;left:0;top:0;display:block;width:100%;height:100%;}
    .lbl.tag .tag-content{position:absolute;left:0;top:0;box-sizing:border-box;padding:1.4mm;
      display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:1.2mm;
    }
    .lbl.tag .info{flex:1;min-width:0;display:flex;flex-direction:column;gap:0.6mm;justify-content:center;}
    .lbl.tag .brand{font-size:${clamp(cfg.heightMm * 0.2 * cfg.fontScale, 2, 4)}mm;font-weight:700;color:#111827;text-transform:uppercase;letter-spacing:.05em;line-height:1.1;}
    .lbl.tag .code{font-size:${clamp(cfg.heightMm * 0.18 * cfg.fontScale, 1.8, 3.6)}mm;font-weight:600;color:#111827;line-height:1.1;word-break:break-all;}
    .lbl.tag .name{font-size:${clamp(cfg.heightMm * 0.24 * cfg.fontScale, 2.4, 4.8)}mm;font-weight:700;color:#111827;line-height:1.15;word-break:break-word;}
    .lbl.tag .price{font-size:${clamp(cfg.heightMm * 0.26 * cfg.fontScale, 2.6, 5.2)}mm;font-weight:800;color:#111827;line-height:1.1;}
    .lbl.tag .weight{font-size:${clamp(cfg.heightMm * 0.22 * cfg.fontScale, 2.2, 4.4)}mm;font-weight:700;color:#111827;line-height:1.1;}
    .lbl.tag .purity{font-size:${clamp(cfg.heightMm * 0.13 * cfg.fontScale, 1.3, 2.6)}mm;font-weight:500;color:#111827;line-height:1.1;}
    .lbl.tag .huid{font-size:${clamp(cfg.heightMm * 0.12 * cfg.fontScale, 1.2, 2.4)}mm;font-weight:500;color:#111827;line-height:1.1;}
    .lbl.tag .qr{background:#fff;padding:0.3mm;margin-left:auto;}
    .lbl.tag .qr svg{display:block;width:100%;height:100%;}
    @media print{
      body{background:#fff;}
      .page{margin:0;box-shadow:none;}
    }
    ${screenCss}
    /* Embedded preview (the in-app iframe is sized exactly to the page): the
       screen chrome above must vanish in that context, or the iframe
       permanently clips the same 6mm off every label — which made every
       setting change look like "the same incorrect design". */
    body.embedded{background:#fff;padding:0;}
    body.embedded .page{margin:0;box-shadow:none;}
  </style></head><body${mode === 'preview' ? ' class="embedded"' : ''}>${pages.join('')}</body></html>`

  return { html, totalLabels, totalPages, renderedLabels: rendered.length }
}

function padFor(cfg: LabelConfig): string {
  return clamp(Math.min(cfg.heightMm * 0.07, cfg.widthMm * 0.035), 0.4, 1.6).toFixed(2)
}

export const MM_TO_PX = 96 / 25.4
