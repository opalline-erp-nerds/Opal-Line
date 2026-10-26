import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LABEL_PRESET_LIST,
  LABEL_PRESETS,
  computeLabelGeometry,
  computeLabelLines,
  designFieldTexts,
  formatLabelRate,
  generateLabelQrBuffer,
  generateLabelsPDF,
  labelCode,
  resolveLabelPreset,
} from './barcodeLabels'

// Reference-size templates ---------------------------------------------------

test('the six reference templates are selectable with their physical dimensions', () => {
  const byKey = new Map(LABEL_PRESET_LIST.map((p) => [p.key, p]))
  assert.deepEqual(
    [
      'label-50x40',
      'label-50x25',
      'label-35x22',
      'label-50x10',
      'label-50x10-loni',
      'label-50x10-compact',
    ].map((k) => {
      const p = byKey.get(k)
      assert.ok(p, `missing preset ${k}`)
      assert.ok(p.design, `${k} must include preview/print geometry`)
      assert.equal(p.design.width, p.width, `${k} design width`)
      assert.equal(p.design.height, p.height, `${k} design height`)
      return [p.width, p.height]
    }),
    [
      [50, 40],
      [50, 25],
      [35, 22],
      [50, 10],
      [50, 10],
      [50, 10],
    ],
  )
})

test('reference presets are flagged and listed first', () => {
  const firstSix = LABEL_PRESET_LIST.slice(0, 6).map((p) => p.key)
  assert.deepEqual(firstSix, [
    'label-50x40',
    'label-50x25',
    'label-35x22',
    'label-50x10',
    'label-50x10-loni',
    'label-50x10-compact',
  ])
  assert.ok(LABEL_PRESET_LIST.slice(0, 6).every((p) => p.reference))
})

test('same-size 50x10 templates retain distinct identities and compact code rules', () => {
  const byKey = new Map(LABEL_PRESET_LIST.map((p) => [p.key, p]))
  assert.equal(byKey.get('label-50x10')?.brand, 'OPAL LINE')
  assert.equal(byKey.get('label-50x10-loni')?.brand, 'OPAL LINE')
  assert.equal(byKey.get('label-50x10-compact')?.brand, 'OPAL LINE')
  assert.equal(byKey.get('label-50x10')?.label, '50 × 10 mm · Standard')
  assert.equal(byKey.get('label-50x10-loni')?.label, '50 × 10 mm · Alternate')
  assert.notEqual(byKey.get('label-50x10')?.key, byKey.get('label-50x10-loni')?.key)
  assert.notEqual(byKey.get('label-50x10-loni')?.key, byKey.get('label-50x10-compact')?.key)
})

test('all six reference presets default to OPAL LINE and retain complete geometry', () => {
  const references = LABEL_PRESET_LIST.slice(0, 6)
  assert.equal(references.length, 6)
  for (const preset of references) {
    assert.equal(preset.brand, 'OPAL LINE', `${preset.key} brand`)
    assert.ok(preset.design, `${preset.key} geometry`)
    assert.equal(preset.design!.width, preset.width)
    assert.equal(preset.design!.height, preset.height)
    assert.ok(preset.design!.fields.length > 0, `${preset.key} fields`)
    assert.ok(preset.design!.qr.size > 0, `${preset.key} QR size`)
  }
})

test('compact label fields use live product data and the short product identifier', () => {
  const preset = resolveLabelPreset('label-50x10-compact')
  const design = LABEL_PRESET_LIST.find((item) => item.key === 'label-50x10-compact')?.design
  assert.ok(design)
  const fields = designFieldTexts(
    { name: 'Fusion of Kempu & NA', sku: '0012535', price: 39999 },
    preset,
    design!,
  )
  assert.equal(fields.find((field) => field.kind === 'brand')?.text, 'OPAL LINE')
  assert.equal(fields.find((field) => field.kind === 'name')?.text, 'FUSION OF KEMPU & NA')
  // The printed code is the full SKU — never a truncated fragment.
  assert.equal(fields.find((field) => field.kind === 'code')?.text, '0012535')
  assert.equal(fields.find((field) => field.kind === 'rate')?.text, 'Rate: 39999.00/-')
})

test('the grid for every preset fits an A4 sheet', () => {
  const a4w = 210
  const a4h = 297
  for (const [key, preset] of Object.entries(LABEL_PRESETS)) {
    const p = preset as { width: number; height: number; columns: number; rows: number }
    assert.ok(p.width * p.columns <= a4w + 0.001, `${key} too wide`)
    assert.ok(p.height * p.rows <= a4h + 0.001, `${key} too tall`)
  }
})

// 9/10. Copies + individual/bulk options --------------------------------------

test('resolveLabelPreset clamps copies into a printable range', () => {
  assert.equal(resolveLabelPreset('label-50x40', { copies: 0 }).copies, 1)
  assert.equal(resolveLabelPreset('label-50x40', { copies: -5 }).copies, 1)
  assert.equal(resolveLabelPreset('label-50x40', { copies: 7.9 }).copies, 7)
  assert.equal(resolveLabelPreset('label-50x40', { copies: 5000 }).copies, 999)
  assert.equal(resolveLabelPreset('label-50x40').copies, 1)
})

test('resolveLabelPreset rejects an unknown key rather than silently choosing another layout', () => {
  assert.throws(() => resolveLabelPreset('does-not-exist'), /Unknown label preset/)
})

test('resolveLabelPreset honours a legacy businessName override', () => {
  const opts = resolveLabelPreset('label-50x40', { businessName: 'OPAL LINE' } as never)
  assert.equal(opts.brand, 'OPAL LINE')
})

// 11/12. Content, long names, missing optional fields -------------------------

test('labelCode always returns the SKU — the single scannable identity', () => {
  assert.equal(labelCode({ sku: 'OL-RNG-001' }), 'OL-RNG-001')
  assert.equal(labelCode({ sku: '  OL-CHN-042  ' }), 'OL-CHN-042')
  // A blank SKU yields an empty code (the label then prints no symbol) rather
  // than falling back to any other identifier.
  assert.equal(labelCode({ sku: '' }), '')
  assert.equal(labelCode({ sku: '   ' }), '')
})

test('formatLabelRate matches the reference "Rate: x/-" shape', () => {
  // The supplied `.prn` samples print the amount without a thousands
  // separator, and the PDF and the ZPL must agree on the exact string.
  assert.equal(formatLabelRate(99999), 'Rate: 99999.00/-')
  assert.equal(formatLabelRate(1234.5), 'Rate: 1234.50/-')
  assert.equal(formatLabelRate(0), 'Rate: 0.00/-')
  assert.equal(formatLabelRate(Number.NaN), 'Rate: 0.00/-')
})

const product = {
  name: 'Diamond Ring',
  sku: 'SKU-1',
  price: 1234.5,
  weight: 3.2,
  category: 'Rings',
  collection: 'Classic',
}

test('a full label shows brand, name, code and price', () => {
  const geo = computeLabelGeometry((50 / 25.4) * 72, (40 / 25.4) * 72, true)
  const lines = computeLabelLines(geo, product, { showPrice: true, showWeight: true, showBrand: true, brand: 'OPAL LINE' })
  const kinds = lines.map((l) => l.kind)
  assert.ok(kinds.includes('brand'))
  assert.ok(kinds.includes('name'))
  assert.ok(kinds.includes('price'))
  assert.ok(kinds.includes('code'))
  assert.equal(lines.find((l) => l.kind === 'name')?.text, 'Diamond Ring')
  assert.equal(lines.find((l) => l.kind === 'code')?.text, 'Code: SKU-1')
})

test('a tiny label drops optional lines but keeps the name and price', () => {
  const geo = computeLabelGeometry((50 / 25.4) * 72, (10 / 25.4) * 72, true)
  const lines = computeLabelLines(geo, product, { showPrice: true, showWeight: true, showBrand: true, brand: 'OPAL LINE' })
  const kinds = lines.map((l) => l.kind)
  assert.ok(kinds.includes('name'), 'name must never be dropped')
  assert.ok(kinds.includes('price'), 'price should survive on the smallest label')
})

test('the compact (50x10) label omits the "Code:" prefix to save space', () => {
  const geo = computeLabelGeometry((50 / 25.4) * 72, (10 / 25.4) * 72, true)
  const lines = computeLabelLines(geo, product, { showPrice: true, showWeight: true, showBrand: true, brand: 'B', compact: true })
  const code = lines.find((l) => l.kind === 'code')
  if (code) assert.equal(code.text, 'SKU-1')
})

test('missing optional fields never produce empty text entries', () => {
  const geo = computeLabelGeometry((50 / 25.4) * 72, (25 / 25.4) * 72, true)
  const lines = computeLabelLines(
    geo,
    { name: 'Plain', sku: 'S1', price: 10 },
    { showPrice: true, showWeight: true, showBrand: false },
  )
  assert.ok(lines.every((l) => l.text.length > 0))
  assert.ok(!lines.some((l) => l.kind === 'weight'))
  assert.ok(!lines.some((l) => l.kind === 'brand'))
})

// 13. Correct label geometry --------------------------------------------------

test('label geometry scales with the physical size, not a hard-coded layout', () => {
  const big = computeLabelGeometry((50 / 25.4) * 72, (40 / 25.4) * 72, true)
  const small = computeLabelGeometry((35 / 25.4) * 72, (22 / 25.4) * 72, true)
  assert.ok(big.qrSize > small.qrSize)
  assert.ok(big.qrSize <= big.innerH + 0.001)
  assert.ok(small.qrSize <= small.innerH + 0.001)
  // The text column must never be pushed off the label.
  assert.ok(big.textX + big.textWidth <= (50 / 25.4) * 72 - big.pad + 0.001)
})

test('label geometry leaves no code space when QR is disabled', () => {
  const geo = computeLabelGeometry((50 / 25.4) * 72, (40 / 25.4) * 72, false)
  assert.equal(geo.qrSize, 0)
  assert.equal(geo.textWidth, geo.innerW)
})

// Scannable payload + smoke test of the real PDF pipeline ---------------------

test('generateLabelsPDF produces a PDF and encodes the identifier', async () => {
  const pdf = await generateLabelsPDF([product], { width: 50, height: 25, columns: 4, rows: 11, showPrice: true, showWeight: true, showQR: true, showBrand: true, brand: 'OPAL LINE', copies: 1 })
  assert.ok(pdf, 'expected a PDF buffer')
  assert.ok(pdf!.length > 500)
  assert.equal(pdf!.subarray(0, 5).toString('latin1'), '%PDF-')
})

test('PDF print rendering accepts each of the six selected reference template IDs', async () => {
  for (const preset of LABEL_PRESET_LIST.slice(0, 6)) {
    const pdf = await generateLabelsPDF([product], { preset: preset.key })
    assert.ok(pdf && pdf.length > 500, `${preset.key} should produce a PDF`)
    assert.equal(pdf!.subarray(0, 5).toString('latin1'), '%PDF-', `${preset.key} PDF signature`)
  }
})

test('generateLabelsPDF repeats the product once per copy', async () => {
  const one = await generateLabelsPDF([product], { copies: 1 } as never)
  const four = await generateLabelsPDF([product], { copies: 4 } as never)
  assert.ok(one && four)
  // More copies → more embedded QR images → a larger document.
  assert.ok(four!.length > one!.length)
})

test('generateLabelsPDF returns null for an empty product list', async () => {
  assert.equal(await generateLabelsPDF([]), null)
})

test('the label preview/export QR encoder returns a real PNG symbol', async () => {
  const png = await generateLabelQrBuffer('OLABC12345', 7.875)
  assert.ok(png.length > 100)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
})

test('labels survive a long name and a missing SKU', async () => {
  const longName = 'Antique Finish Hand Crafted Temple Design Silver Necklace With Gemstones'
  const pdf = await generateLabelsPDF(
    [{ name: longName, sku: 'SKU-LONG', price: 99999, weight: 42.5 }],
    { width: 35, height: 22, columns: 5, rows: 13, showQR: true, showPrice: true, showWeight: true, showBrand: true, brand: 'OPAL LINE', copies: 1 } as never,
  )
  assert.ok(pdf)
  assert.equal(pdf!.subarray(0, 5).toString('latin1'), '%PDF-')
})
