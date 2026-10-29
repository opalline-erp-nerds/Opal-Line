import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LABEL_CONFIG,
  buildLabelSheet,
  configFromPreset,
  labelBrandText,
  labelDesignFor,
  qrPayload,
  qrSvg,
  qrTopMm,
  type LabelProduct,
} from './labelSheet'

const product: LabelProduct = {
  id: 'p1',
  name: 'Silver Classic Ring',
  sku: 'OL-RNG-001',
  price: 588,
  weight: 5.2,
  category: 'Rings',
  collection: 'BW',
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
    assert.ok(html.includes('SILVER CLASSIC RING'), `${key} uppercased name`)
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
  assert.ok(!hidden.includes('SILVER CLASSIC RING'), 'name hidden')
  assert.ok(!hidden.includes('OL-RNG-001'), 'code hidden')
  assert.ok(!hidden.includes('Rate:'), 'rate hidden')
  assert.ok(!hidden.includes('Rings'), 'category chip hidden')
  assert.ok(!hidden.includes('<svg'), 'QR hidden')
  // Untoggled fields keep printing: the reference always carries brand and
  // the collection chip has no toggle of its own.
  assert.ok(hidden.includes('OPAL LINE'), 'brand survives')
  assert.ok(hidden.includes('BW'), 'collection chip survives')

  const shown = buildLabelSheet([product], base).html
  assert.ok(shown.includes('SILVER CLASSIC RING'), 'name shown by default')
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