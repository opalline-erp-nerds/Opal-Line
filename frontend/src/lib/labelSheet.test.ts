import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LABEL_CONFIG, buildLabelSheet, qrPayload, type LabelProduct } from './labelSheet'

const product: LabelProduct = {
  id: 'p1',
  name: 'Silver Classic Ring',
  sku: 'OL-RNG-001',
  price: 588,
  weight: 5.2,
  category: 'Rings',
}

test('the QR payload is ONLY the SKU — never the name, price or weight', () => {
  assert.equal(qrPayload(product), 'OL-RNG-001')
  // Extra product data never leaks into the payload.
  const payload = qrPayload({ ...product, name: 'Ghost Ring', price: 12345 })
  assert.equal(payload, 'OL-RNG-001')
  assert.ok(!payload.includes('Ghost Ring'))
  assert.ok(!payload.includes('12345'))
  // Scanners hand back the code with incidental whitespace sometimes; the
  // payload is stored trimmed so lookup stays an exact match.
  assert.equal(qrPayload({ ...product, sku: '  OL-CHN-042 ' }), 'OL-CHN-042')
})

test('rendered label sheets carry a QR symbol and no linear barcode', () => {
  const { html, totalLabels, renderedLabels } = buildLabelSheet([product], { ...DEFAULT_LABEL_CONFIG })
  assert.equal(totalLabels, 1)
  assert.equal(renderedLabels, 1)
  assert.ok(html.includes('<svg'), 'the QR symbol is rendered')
  assert.ok(html.includes('class="qr"'), 'the QR sits in its own slot')
  // Code128 barcodes were removed from the whole product workflow.
  assert.ok(!html.includes('code128'), 'no Code 128 encoder is invoked')
  assert.ok(!html.includes('class="barcode"'), 'no barcode strip is drawn')
})
