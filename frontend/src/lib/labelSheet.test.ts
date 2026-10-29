import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLabelSheet,
  computeGrid,
  configFromPreset,
  expandLabels,
  isTagLabel,
  labelCellSize,
  qrPayload,
  qrSvg,
  tagStem,
  type LabelConfig,
  type LabelProduct,
} from './labelSheet'

const product: LabelProduct = {
  id: 'p1',
  name: 'Diamond Ring',
  sku: 'OL-RNG-001',
  price: 12345,
  weight: 3.24,
  purity: 92.5,
  huid: 'HUID123',
}

const otherProduct: LabelProduct = {
  id: 'p2',
  name: 'Silver Bracelet',
  sku: 'OL-BRC-002',
  price: 6780,
  weight: 12.5,
}

function tagConfig(overrides: Partial<LabelConfig> = {}): LabelConfig {
  return { ...configFromPreset('jewellery-tag-55x20'), ...overrides }
}

function plainConfig(overrides: Partial<LabelConfig> = {}): LabelConfig {
  return { ...configFromPreset('zlabel-50x30'), ...overrides }
}

// ─── Stem geometry ─────────────────────────────────────────────────────────

test('tag stem extends from the right edge and stays outside the configured body', () => {
  const cfg = tagConfig()
  const stem = tagStem(cfg)
  assert.ok(stem)
  // Proportions: 18% of the body height across, extending 40% of the body width.
  assert.equal(stem.width, Math.round(20 * 0.18))
  assert.equal(stem.length, Math.round(55 * 0.4))
  // The stem extends RIGHT: overall = (body width + stem) × body height.
  assert.equal(stem.overallW, cfg.widthMm + stem.length)
  assert.equal(stem.overallH, cfg.heightMm, 'stem is thinner than the body — height unchanged')
  assert.ok(stem.width < cfg.heightMm, 'stem neck must stay narrower than the body')
  assert.equal(cfg.widthMm, 55, 'configured body width must not absorb the stem')
  assert.equal(cfg.heightMm, 20, 'configured body height must not absorb the stem')
})

test('custom tag sizes get proportional stems and an exact custom body', () => {
  const cfg = tagConfig({ presetKey: 'custom', widthMm: 70, heightMm: 24 })
  const stem = tagStem(cfg)!
  assert.equal(isTagLabel(cfg), true)
  assert.equal(stem.width, Math.round(24 * 0.18))
  assert.equal(stem.length, Math.round(70 * 0.4))
  assert.equal(stem.overallW, 70 + stem.length)
  assert.equal(stem.overallH, 24)
  assert.deepEqual(labelCellSize(cfg), { widthMm: 70 + stem.length, heightMm: 24 })
})

test('normal labels are never tag-shaped', () => {
  assert.equal(isTagLabel(plainConfig()), false)
  assert.equal(tagStem(plainConfig()), null)
  assert.deepEqual(labelCellSize(plainConfig()), { widthMm: 50, heightMm: 30 })
})

test('a 50 × 10 body keeps exactly 50 × 10 and adds the stem OUTSIDE it', () => {
  // The critical acceptance case: the configured body must stay exactly
  // 50 × 10 mm; the stem extends horizontally from the right edge — the
  // overall tag (70 × 10) is strictly LARGER than the body. NOT a T-shape.
  const cfg = tagConfig({ presetKey: 'custom', widthMm: 50, heightMm: 10 })
  const stem = tagStem(cfg)!
  assert.equal(cfg.widthMm, 50)
  assert.equal(cfg.heightMm, 10)
  assert.equal(stem.width, 4)
  assert.equal(stem.length, 20)
  assert.equal(stem.overallW, 70)
  assert.equal(stem.overallH, 10)
  // Overall dimensions are calculated separately: body + external stem.
  assert.ok(stem.width < cfg.heightMm, 'stem neck must stay narrower than the body')
  assert.ok(stem.overallW > cfg.widthMm, 'overall tag must be larger than the body')
  const sheet = buildLabelSheet([product], cfg, { paper: 'label' })
  // Body renders at exactly the configured size (SVG viewBox 70 × 10)…
  assert.match(sheet.html, /viewBox="0 0 70 10"/)
  // …the outline is one continuous path, not two boxes…
  assert.equal((sheet.html.match(/<svg class="tag-outline"/g) || []).length, 1)
  assert.doesNotMatch(sheet.html, /tag-stem|tag-body/)
  // …and the printed page is the full footprint (70 × 10), not the body.
  assert.match(sheet.html, /@page\{size:70mm 10mm;margin:0;\}/)
})

// ─── Printed sheet HTML geometry ───────────────────────────────────────────

test('the label-mode @page is the full tag footprint including the stem', () => {
  const cfg = tagConfig()
  const stem = tagStem(cfg)!
  const sheet = buildLabelSheet([product], cfg, { paper: 'label' })
  assert.match(
    sheet.html,
    new RegExp(`@page\\{size:${stem.overallW}mm ${stem.overallH}mm;margin:0;\\}`),
  )
})

test('the tag body renders at the exact user-entered dimensions, the stem outside it', () => {
  const cfg = tagConfig({ widthMm: 60, heightMm: 25, presetKey: 'custom' })
  const stem = tagStem(cfg)!
  const sheet = buildLabelSheet([product], cfg, { paper: 'label' })
  // viewBox spans the full footprint; the stem segment reaches right of the body.
  assert.match(sheet.html, new RegExp(`viewBox="0 0 ${stem.overallW} 25"`))
  // The stem's declared length is derived from the body width, not the height.
  assert.equal(stem.length, Math.round(60 * 0.4))
  // One continuous outline element per label.
  assert.equal((sheet.html.match(/<svg class="tag-outline"/g) || []).length, 1)
  const page = sheet.html.match(/viewBox="0 0 ([\d.]+) 25"/)!
  assert.equal(Number(page[1]), stem.overallW)
})

test('normal label paper prints at the configured size with no stem', () => {
  const cfg = plainConfig()
  const sheet = buildLabelSheet([product], cfg, { paper: 'label' })
  assert.match(sheet.html, /@page\{size:50mm 30mm;margin:0;\}/)
  // The stylesheet always defines the tag rules, but the body must not render one.
  assert.ok(!/class="lbl tag"/.test(sheet.html))
})

test('sheet-mode grid cells reserve the stem footprint for tags', () => {
  const cfg = tagConfig()
  const stem = tagStem(cfg)!
  const grid = computeGrid(cfg)
  const sheet = buildLabelSheet([product], cfg, { paper: 'sheet' })
  // The grid tracks must match computeGrid's cell so labels never overlap a stem.
  assert.match(sheet.html, new RegExp(`grid-template-columns:repeat\\(${grid.columns},${stem.overallW}mm\\)`))
  assert.match(sheet.html, new RegExp(`grid-auto-rows:${stem.overallH}mm`))
  // And computeGrid itself counts cells of the overall footprint.
  const a4 = { widthMm: 210, heightMm: 297 }
  assert.equal(grid.columns, Math.floor((a4.widthMm - cfg.marginMm * 2 + cfg.gapMm) / (stem.overallW + cfg.gapMm)))
})

test('the tag container zeroes padding and pins the outline + content layers', () => {
  const sheet = buildLabelSheet([product], tagConfig(), { paper: 'label' })
  assert.match(sheet.html, /\.lbl\.tag\{[^}]*padding:0;[^}]*\}/)
  assert.match(sheet.html, /\.lbl\.tag \.tag-outline\{position:absolute;/)
  assert.match(sheet.html, /\.lbl\.tag \.tag-content\{position:absolute;/)
})

// ─── Preview / print outputs react to all inputs ──────────────────────────

test('changing the label size immediately changes the rendered document', () => {
  const small = buildLabelSheet([product], tagConfig({ widthMm: 55, heightMm: 20 }), { paper: 'label' }).html
  const large = buildLabelSheet([product], tagConfig({ widthMm: 80, heightMm: 30 }), { paper: 'label' }).html
  assert.notEqual(small, large)
  assert.match(small, /width:55mm;height:20mm/)
  assert.match(large, /width:80mm;height:30mm/)
})

test('changing product selection changes which data the document renders', () => {
  const a = buildLabelSheet([product], tagConfig(), { paper: 'label' }).html
  const b = buildLabelSheet([otherProduct], tagConfig(), { paper: 'label' }).html
  assert.match(a, /OL-RNG-001/)
  assert.match(a, /Diamond Ring/)
  assert.match(b, /OL-BRC-002/)
  assert.match(b, /Silver Bracelet/)
  assert.doesNotMatch(b, /OL-RNG-001/)
  assert.notEqual(a, b)
})

test('toggling content settings changes the rendered document', () => {
  const withWeight = buildLabelSheet([product], tagConfig(), { paper: 'label' }).html
  const withoutWeight = buildLabelSheet([product], tagConfig({ showWeight: false }), { paper: 'label' }).html
  assert.match(withWeight, /3\.24/)
  assert.doesNotMatch(withoutWeight, /3\.24/)
  const withFont = buildLabelSheet([product], tagConfig({ fontScale: 1.5 }), { paper: 'label' }).html
  assert.notEqual(withFont, withWeight)
})

test('the rendered label carries price, weight, purity, HUID and the QR symbol', () => {
  const html = buildLabelSheet([product], tagConfig(), { paper: 'label' }).html
  assert.match(html, /₹12,345/)
  assert.match(html, /3\.24 g/)
  assert.match(html, /92\.5/)
  assert.match(html, /HUID123/)
  assert.match(html, /<svg[\s>]/)
})

// ─── QR payload & renderer ────────────────────────────────────────────────

test('the QR encodes exactly the SKU — never names, prices or weights', () => {
  assert.equal(qrPayload(product), 'OL-RNG-001')
  assert.equal(qrPayload({ ...product, sku: '  OL-CHN-9  ' }), 'OL-CHN-9')
  assert.equal(qrPayload({ ...product, sku: '' }), '')
})

test('qrSvg produces an undistorted square symbol for a valid payload', () => {
  const svg = qrSvg('OL-RNG-001')
  assert.ok(svg, 'expected an SVG symbol')
  assert.match(svg!, /<svg/)
  assert.match(svg!, /preserveAspectRatio="xMidYMid meet"/)
})

test('qrSvg rejects empty payloads instead of throwing', () => {
  assert.equal(qrSvg(''), null)
})

// ─── Copies ───────────────────────────────────────────────────────────────

test('expandLabels repeats each product once per copy', () => {
  const cfg = tagConfig({ copies: 3 })
  assert.equal(expandLabels([product, otherProduct], cfg).length, 6)
  assert.equal(expandLabels([product], { ...cfg, copies: 1 }).length, 1)
})

test('buildLabelSheet reports the expanded label count', () => {
  const sheet = buildLabelSheet([product, otherProduct], tagConfig({ copies: 2 }), { paper: 'sheet' })
  assert.equal(sheet.totalLabels, 4)
  assert.ok(sheet.renderedLabels >= 1)
})
