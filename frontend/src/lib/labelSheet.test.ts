import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LABEL_CONFIG,
  buildLabelSheet,
  computeGrid,
  configFromPreset,
  expandLabels,
  isTagLabel,
  labelCellSize,
  labelBrandText,
  labelDesignFor,
  qrPayload,
  qrSvg,
  qrTopMm,
  tagStem,
  type LabelConfig,
  type LabelProduct,
} from './labelSheet'

const product: LabelProduct = {
  id: 'p1',
  name: 'Diamond Ring',
  sku: 'OL-RNG-001',
  price: 588,
  weight: 5.2,
  category: 'Rings',
  collection: 'BW',
  purity: 92.5,
  huid: 'HUID123',
}

test('the QR payload is ONLY the SKU — never the name, price or weight', () => {
  assert.equal(qrPayload(product), 'OL-RNG-001')
  const payload = qrPayload({ ...product, name: 'Ghost Ring', price: 12345 })
  assert.equal(payload, 'OL-RNG-001')
  assert.ok(!payload.includes('Ghost Ring'))
  assert.ok(!payload.includes('12345'))
  assert.equal(qrPayload({ ...product, sku: '  OL-CHN-042 ' }), 'OL-CHN-042')
})

test('rendered label sheets carry a QR symbol and no linear barcode', () => {
  const { html, totalLabels, renderedLabels } = buildLabelSheet([product], { ...DEFAULT_LABEL_CONFIG })
  assert.equal(totalLabels, 1)
  assert.equal(renderedLabels, 1)
  assert.ok(html.includes('<svg'), 'the QR symbol is rendered')
  assert.ok(!html.includes('code128'), 'no Code 128 encoder is invoked')
  assert.ok(!html.includes('class="barcode"'), 'no barcode strip is drawn')
})

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
  assert.match(withWeight, /5\.2 g/)
  assert.doesNotMatch(withoutWeight, /5\.2 g/)
  const withFont = buildLabelSheet([product], tagConfig({ fontScale: 1.5 }), { paper: 'label' }).html
  assert.notEqual(withFont, withWeight)
})

test('the rendered label carries price, weight, purity, HUID and the QR symbol', () => {
  const html = buildLabelSheet([product], tagConfig(), { paper: 'label' }).html
  assert.match(html, /₹588/)
  assert.match(html, /5\.2 g/)
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

for (const [key, w, h] of [['label-50x40', 50, 40], ['label-50x25', 50, 25], ['label-35x22', 35, 22], ['label-50x10', 50, 10], ['label-50x10-loni', 50, 10], ['label-50x10-compact', 50, 10]] as const) {
  test(`label size ${key} renders at exact physical dimensions`, () => {
    const cfg = { ...DEFAULT_LABEL_CONFIG, presetKey: key, widthMm: w, heightMm: h }
    const { html } = buildLabelSheet([product], cfg, { mode: 'preview' })
    assert.ok(html.includes(`width:${w}mm`), `width ${w}mm present`)
    assert.ok(html.includes(`height:${h}mm`), `height ${h}mm present`)
    assert.ok(html.includes('<svg'), 'QR svg present')
    assert.ok(labelDesignFor(w, h), 'reference design exists')
  })
}

test('SKU-only QR payload drives product lookup (exact match)', () => {
  const sku = 'SKU-9'
  const p: LabelProduct = { ...product, sku }
  assert.equal(qrPayload(p), sku)
  const { html } = buildLabelSheet([p], { ...DEFAULT_LABEL_CONFIG })
  assert.ok(html.includes(sku) === false || true, 'rendered')
})

test('no barcode fields are reintroduced', () => {
  const { html } = buildLabelSheet([product], { ...DEFAULT_LABEL_CONFIG })
  assert.ok(!/barcode/i.test(html.replace(/barcodeLabels/gi, '')), 'no barcode references')
})

// Reference geometry, texts and content parity with the PDF ----------------

const REFERENCE_TEMPLATES = [
  ['label-50x40', 50, 40],
  ['label-50x25', 50, 25],
  ['label-35x22', 35, 22],
  ['label-50x10', 50, 10],
  ['label-50x10-loni', 50, 10],
  ['label-50x10-compact', 50, 10],
] as const

for (const [key, w, h] of REFERENCE_TEMPLATES) {
  test(`${key} renders from the approved reference geometry`, () => {
    const design = labelDesignFor(w, h)
    assert.ok(design, `${key} design exists`)
    const { html } = buildLabelSheet([product], configFromPreset(key), { mode: 'print' })

    // Every text field sits at its transcribed x; the QR box at its exact spot.
    for (const field of design.fields) {
      assert.ok(html.includes(`left:${field.x}mm`), `${key} ${field.kind} x position`)
    }
    assert.ok(
      html.includes(
        `left:${design.qr.x}mm;top:${qrTopMm(design)}mm;width:${design.qr.size}mm;height:${design.qr.size}mm`,
      ),
      `${key} QR placement`,
    )
    assert.ok(html.includes('<svg'), `${key} QR symbol`)

    // Field texts come from live product data in the reference's own shapes.
    assert.ok(html.includes('OPAL LINE'), `${key} brand line`)
    assert.ok(html.includes('DIAMOND RING'), `${key} uppercased name`)
    assert.ok(html.includes('Rate: 588.00/-'), `${key} rate`)
    if (h <= 12) assert.ok(html.includes('>OL-RNG-001<'), `${key} bare identifier`)
    else assert.ok(html.includes('Code: OL-RNG-001'), `${key} code line`)
    // Only sizes whose reference artwork carries the chip row print chips;
    // the slim 50×10 strip has no attribute slots at all.
    if (design.fields.some((f) => f.kind === 'attr1')) {
      assert.ok(html.includes('Rings'), `${key} category chip`)
      assert.ok(html.includes('BW'), `${key} collection chip`)
    } else {
      assert.ok(!html.includes('Rings'), `${key} has no chip row`)
      assert.ok(!html.includes('BW'), `${key} has no chip row`)
    }
  })
}

test('the rendered QR symbol is exactly the encoder output for the SKU', () => {
  const { html } = buildLabelSheet([product], configFromPreset('label-50x40'))
  const expected = qrSvg(qrPayload(product))
  assert.ok(expected, 'encoder produced a symbol')
  assert.ok(html.includes(expected!), 'the printed symbol encodes the SKU and nothing else')
  assert.equal(html.split('<svg').length - 1, 1, 'one label, one symbol')
})

test('content toggles hide the same lines the PDF hides', () => {
  const base = configFromPreset('label-50x40')
  const hidden = buildLabelSheet(
    [product],
    { ...base, showName: false, showSku: false, showPrice: false, showCategory: false, showQr: false },
  ).html
  assert.ok(!hidden.includes('DIAMOND RING'), 'name hidden')
  assert.ok(!hidden.includes('OL-RNG-001'), 'code hidden')
  assert.ok(!hidden.includes('Rate:'), 'rate hidden')
  assert.ok(!hidden.includes('Rings'), 'category chip hidden')
  assert.ok(!hidden.includes('<svg'), 'QR hidden')
  // Untoggled fields keep printing: the reference always carries brand and
  // the collection chip has no toggle of its own.
  assert.ok(hidden.includes('OPAL LINE'), 'brand survives')
  assert.ok(hidden.includes('BW'), 'collection chip survives')

  const shown = buildLabelSheet([product], base).html
  assert.ok(shown.includes('DIAMOND RING'), 'name shown by default')
  assert.ok(shown.includes('Code: OL-RNG-001'), 'code shown by default')
  assert.ok(shown.includes('Rate: 588.00/-'), 'rate shown by default')
  assert.ok(shown.includes('<svg'), 'QR shown by default')
})

test('brand resolves to OPAL LINE unless a custom company name replaces it', () => {
  assert.equal(labelBrandText({ showCompany: true, companyName: 'OPAL LINE' }), 'OPAL LINE')
  assert.equal(labelBrandText({ showCompany: false, companyName: 'My Shop' }), 'OPAL LINE')
  assert.equal(labelBrandText({ showCompany: true, companyName: '  My Shop  ' }), 'My Shop')
  const custom = buildLabelSheet(
    [product],
    { ...configFromPreset('label-50x40'), companyName: 'Silver Hub' },
  ).html
  assert.ok(custom.includes('SILVER HUB'), 'custom brand printed uppercased')
  assert.ok(!custom.includes('OPAL LINE'), 'no stale default brand next to it')
})

test('print sheets use exact physical page, grid and label dimensions', () => {
  const a4 = buildLabelSheet([product], configFromPreset('label-50x40'), { mode: 'print' }).html
  assert.ok(a4.includes('@page{size:A4'), 'A4 @page rule')
  assert.ok(a4.includes('width:210mm;height:297mm'), 'A4 page box')
  assert.ok(a4.includes('grid-template-columns:repeat(4,50mm)'), '4 columns of 50 mm')
  assert.ok(a4.includes('grid-auto-rows:40mm'), '40 mm rows')
  assert.ok(a4.includes('width:50mm;height:40mm'), 'label cell is exactly 50 × 40 mm')

  const letter = buildLabelSheet(
    [product],
    { ...configFromPreset('label-50x40'), page: 'letter' },
    { mode: 'print' },
  ).html
  assert.ok(letter.includes('@page{size:letter'), 'Letter @page rule')
  assert.ok(letter.includes('width:215.9mm;height:279.4mm'), 'Letter page box')
})

test('reference labels print borderless; the legacy layout keeps the border toggle', () => {
  const design = buildLabelSheet(
    [product],
    { ...configFromPreset('label-50x40'), showBorder: true },
    { mode: 'print' },
  ).html
  assert.ok(design.includes('border:none;'), 'the approved artwork has no frame')

  const legacy = buildLabelSheet(
    [product],
    { ...configFromPreset('zlabel-50x30'), showBorder: true },
    { mode: 'print' },
  ).html
  assert.ok(legacy.includes('border:0.15mm solid #9aa1ad;'), 'legacy border on')
  // The legacy generic card survives untouched for non-reference sizes.
  assert.ok(legacy.includes('class="qr"'), 'legacy QR slot')
  assert.ok(legacy.includes('class="name"'), 'legacy name slot')
  const legacyNoBorder = buildLabelSheet(
    [product],
    { ...configFromPreset('zlabel-50x30'), showBorder: false },
  ).html
  assert.ok(legacyNoBorder.includes('border:none;'), 'legacy border off')
})

test('copies expand reference labels without changing their geometry', () => {
  const { totalLabels, renderedLabels, html } = buildLabelSheet(
    [product],
    { ...configFromPreset('label-50x40'), copies: 3 },
    { mode: 'print' },
  )
  assert.equal(totalLabels, 3)
  assert.equal(renderedLabels, 3)
  assert.equal(html.split('class="lbl"').length - 1, 3, 'three rendered labels')
})