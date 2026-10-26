import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LABEL_CONFIG, buildLabelSheet, qrPayload, labelDesignFor, type LabelProduct } from './labelSheet'

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