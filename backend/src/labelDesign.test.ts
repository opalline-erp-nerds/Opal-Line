import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAP_HEIGHT,
  LABEL_DESIGNS,
  MIN_TEXT_SCALE,
  QR_QUIET_MODULES,
  ZPL_CAP_RATIO,
  ZPL_EM_RATIO,
  designFieldTexts,
  fieldMaxWidthMm,
  fitDesignField,
  fitDesignText,
  labelAttributes,
  labelCode,
  labelDesignFor,
  qrModuleMm,
  qrQuietMm,
  qrTopMm,
  textEmWidth,
  type LabelFieldDesign,
  type LabelFieldKind,
} from './barcodeLabels'
import { renderZpl } from './zpl'

// ─── Recorded reference ZPL coordinates ──────────────────────────────────────
//
// No `.prn` files are present in this checkout. These values preserve the
// previously transcribed ^A0N,h,w and ^FT coordinates at 203 dpi; the reference
// images are useful visual constraints but do not establish printer origins.

interface RefField {
  kind: LabelFieldKind
  x: number
  y: number
  h: number
  w: number
}

interface RefSize {
  label: string
  widthMm: number
  heightMm: number
  fields: RefField[]
  qr: { x: number; y: number; mag: number }
}

const REFERENCES: RefSize[] = [
  {
    label: '50x40',
    widthMm: 50,
    heightMm: 40,
    fields: [
      { kind: 'brand', x: 31, y: 73, h: 53, w: 56 },
      { kind: 'name', x: 27, y: 123, h: 37, w: 13 },
      { kind: 'rate', x: 25, y: 193, h: 50, w: 33 },
      { kind: 'code', x: 27, y: 245, h: 32, w: 38 },
      { kind: 'attr1', x: 27, y: 289, h: 25, w: 46 },
      { kind: 'attr2', x: 161, y: 289, h: 25, w: 46 },
    ],
    qr: { x: 271, y: 284, mag: 6 },
  },
  {
    label: '50x25',
    widthMm: 50,
    heightMm: 25,
    fields: [
      { kind: 'brand', x: 33, y: 39, h: 31, w: 53 },
      { kind: 'name', x: 27, y: 69, h: 24, w: 13 },
      { kind: 'rate', x: 27, y: 107, h: 30, w: 30 },
      { kind: 'code', x: 27, y: 143, h: 24, w: 30 },
      { kind: 'attr1', x: 27, y: 176, h: 21, w: 38 },
      { kind: 'attr2', x: 137, y: 174, h: 19, w: 35 },
    ],
    qr: { x: 278, y: 173, mag: 4 },
  },
  {
    label: '35x22',
    widthMm: 35,
    heightMm: 22,
    fields: [
      { kind: 'brand', x: 23, y: 39, h: 31, w: 35 },
      { kind: 'name', x: 23, y: 72, h: 30, w: 15 },
      { kind: 'rate', x: 23, y: 107, h: 24, w: 23 },
      { kind: 'code', x: 23, y: 135, h: 16, w: 23 },
      { kind: 'attr1', x: 23, y: 159, h: 16, w: 28 },
      { kind: 'attr2', x: 117, y: 159, h: 16, w: 30 },
    ],
    qr: { x: 194, y: 163, mag: 3 },
  },
]

const DOTS = 8 // 203 dpi
const MM_PER_PT = 25.4 / 72
const dotsToPt = (dots: number) => (dots / DOTS / 25.4) * 72
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol
const measure = (text: string, fontSize: number) => textEmWidth(text) * fontSize

/** Point size the PDF uses for one reference field. */
const fieldFontSizePt = (capHeightMm: number) => (capHeightMm / ZPL_EM_RATIO) / MM_PER_PT
/** The condensation the reference's own `w` asks for at that size. */
const fieldBaseScale = (refWidthMm: number, capHeightMm: number) => refWidthMm / (capHeightMm / ZPL_EM_RATIO)

test('the design table matches the recorded reference ZPL coordinate fixture', () => {
  for (const ref of REFERENCES) {
    const design = labelDesignFor(ref.widthMm, ref.heightMm)
    assert.ok(design, `no design for ${ref.label}`)
    assert.equal(design!.width, ref.widthMm)
    assert.equal(design!.height, ref.heightMm)

    for (const f of ref.fields) {
      const field: LabelFieldDesign | undefined = design!.fields.find((d) => d.kind === f.kind)
      assert.ok(field, `${ref.label} ${f.kind} missing`)
      assert.ok(near(field!.x * DOTS, f.x), `${ref.label} ${f.kind} x ${field!.x * DOTS} != ${f.x}`)
      assert.ok(near(field!.baseline * DOTS, f.y), `${ref.label} ${f.kind} y ${field!.baseline * DOTS} != ${f.y}`)
      assert.ok(near(field!.capHeight * DOTS, f.h), `${ref.label} ${f.kind} h ${field!.capHeight * DOTS} != ${f.h}`)
      // The reference's `w` is what `refWidth` has to reproduce.
      assert.ok(near(field!.refWidth * DOTS, f.w), `${ref.label} ${f.kind} w ${field!.refWidth * DOTS} != ${f.w}`)
    }

    assert.ok(near(design!.qr.x * DOTS, ref.qr.x), `${ref.label} qr x`)
    assert.ok(near(design!.qr.bottom * DOTS, ref.qr.y), `${ref.label} qr y`)
    assert.equal(design!.qr.magnification, ref.qr.mag, `${ref.label} qr magnification`)
    // `^BQN,2,<mag>` prints 21 modules at error-correction level L for these codes.
    assert.equal(design!.qr.modules, 21)
    assert.ok(near(design!.qr.size, (design!.qr.modules * ref.qr.mag) / DOTS), `${ref.label} qr size`)
  }
})

test('the slim 50x10 sample is mapped into the 50 mm label keeping native heights', () => {
  // `50x10 kand.prn` / `50x10 -loni.prn` are authored on 831-dot media; the
  // baselines and heights are used unchanged, while x is compressed to fit.
  const design = labelDesignFor(50, 10)!
  const stream: Record<string, { x: number; y: number; h: number }> = {
    brand: { x: 123, y: 25, h: 20 },
    name: { x: 118, y: 58, h: 20 },
    rate: { x: 325, y: 62, h: 28 },
  }
  for (const [kind, s] of Object.entries(stream)) {
    const field = design.fields.find((d) => d.kind === kind)
    assert.ok(field, `50x10 ${kind}`)
    // Baselines and cap heights are the stream's own values.
    assert.ok(near(field!.baseline * DOTS, s.y), `50x10 ${kind} baseline`)
    assert.ok(near(field!.capHeight * DOTS, s.h), `50x10 ${kind} height`)
    // x is the sample's x shifted and compressed into the narrower label.
    const mapped = -11.7 + 0.896 * (s.x / DOTS)
    assert.ok(near(field!.x, mapped, 0.2), `50x10 ${kind} x ${field!.x} != ${mapped.toFixed(3)}`)
  }
  // The sample's code line sits 18 dots right of the rate; the design tidies
  // them onto one left edge, so both start at the mapped rate position.
  const code = design.fields.find((d) => d.kind === 'code')!
  const rate = design.fields.find((d) => d.kind === 'rate')!
  assert.ok(near(code.baseline * DOTS, 30), '50x10 code baseline')
  assert.ok(near(code.capHeight * DOTS, 25), '50x10 code height')
  assert.equal(code.x, rate.x, 'the slim label aligns rate and code on one edge')
  // The sample's QR is the same physical symbol, re-anchored on the 50 mm label.
  assert.ok(near(design.qr.x, -11.7 + 0.896 * (474 / DOTS), 0.2), '50x10 qr x')
  assert.ok(near(design.qr.bottom * DOTS, 75, 1), '50x10 qr bottom')
  assert.equal(design.qr.magnification, 3)
})

test('every reference field stays inside its physical label', () => {
  for (const design of LABEL_DESIGNS) {
    for (const field of design.fields) {
      const avail = fieldMaxWidthMm(design, field, true)
      assert.ok(field.x >= 0, `${design.width}x${design.height} ${field.kind} x`)
      assert.ok(
        field.x + avail <= design.width + 0.02,
        `${design.width}x${design.height} ${field.kind} runs past the sheet`,
      )
      assert.ok(field.baseline <= design.height, `${design.width}x${design.height} ${field.kind} baseline`)
    }
    assert.ok(design.qr.x + design.qr.size <= design.width + 0.02, `${design.width}x${design.height} qr right`)
    assert.ok(qrTopMm(design) >= 0, `${design.width}x${design.height} qr top`)
  }
})

// ─── Height model ─────────────────────────────────────────────────────────────

test('the printed capitals are a fixed fraction of the reference h', () => {
  // Measured from the rasterised samples: an `h` of 53 dots prints 41 dots of
  // capitals, and Helvetica's cap/(cap+descender) is 718/925.
  assert.ok(near(ZPL_CAP_RATIO, 718 / 925))
  assert.ok(near(CAP_HEIGHT, 0.718))
  assert.ok(near(53 * ZPL_CAP_RATIO, 41.1, 0.2))
  // The em size behind that h is h / 0.925, which is the PDF's font size.
  assert.equal(ZPL_EM_RATIO, 0.925)
})

test('the QR symbol sits exactly where the samples print it', () => {
  // Ink top measured from the rasterised samples, in dots.
  const measured: Record<string, number> = { '50x40': 140, '50x25': 77, '35x22': 91, '50x10': 3 }
  for (const design of LABEL_DESIGNS) {
    const key = `${design.width}x${design.height}`
    const top = qrTopMm(design) * DOTS
    assert.ok(near(top, measured[key], 1.2), `${key} qr top ${top} != ${measured[key]}`)
    // Quiet zone below the symbol, straight from the samples.
    assert.ok(near(design.qr.bottom - qrTopMm(design), design.qr.size + qrQuietMm(design)))
    assert.equal(QR_QUIET_MODULES, 3)
    assert.ok(near(qrModuleMm(design), design.qr.magnification / DOTS))
  }
})

// ─── Column rules ─────────────────────────────────────────────────────────────

test('lines that share the QR row are kept clear of the symbol', () => {
  for (const design of LABEL_DESIGNS) {
    const boxLeft = design.qr.x - qrQuietMm(design)
    const boxTop = qrTopMm(design) - qrQuietMm(design)
    for (const field of design.fields) {
      if (field.x >= design.qr.x) continue
      // Only lines whose whole cap band sits inside the QR box are pushed left;
      // a line that merely grazes the box's top corner is left alone, exactly as
      // the samples do.
      const capTop = field.baseline - field.capHeight * ZPL_CAP_RATIO
      if (capTop < boxTop) continue
      const avail = fieldMaxWidthMm(design, field, true)
      assert.ok(
        field.x + avail <= boxLeft + 0.001,
        `${design.width}x${design.height} ${field.kind} reaches into the QR quiet zone`,
      )
    }
  }
})

test('hiding the QR gives a line the full label width', () => {
  const design = labelDesignFor(50, 40)!
  const rate = design.fields.find((f) => f.kind === 'rate')!
  assert.ok(fieldMaxWidthMm(design, rate, false) > fieldMaxWidthMm(design, rate, true))
  assert.ok(near(fieldMaxWidthMm(design, rate, false), design.width - rate.x))
})

// ─── Fitting ──────────────────────────────────────────────────────────────────

test('a reference-length name keeps the reference condensation exactly', () => {
  const design = labelDesignFor(50, 40)!
  const name = design.fields.find((f) => f.kind === 'name')!
  const fontSizePt = fieldFontSizePt(name.capHeight)
  const baseScale = fieldBaseScale(name.refWidth, name.capHeight)
  const maxWidthPt = dotsToPt(fieldMaxWidthMm(design, name, true) * DOTS)
  const fitted = fitDesignText(measure, 'FLOWER CRYSTAL ELASTIC LD BELT', fontSizePt, maxWidthPt, baseScale)
  // The sample's own `w` condenses this line to `w / em`; nothing shrinks it.
  assert.equal(fitted.text, 'FLOWER CRYSTAL ELASTIC LD BELT')
  assert.ok(near(fitted.scale, baseScale, 0.01), `scale ${fitted.scale} != ${baseScale}`)
  assert.ok(near(fitted.fontSize, fontSizePt, 0.001))
  // And it lands on the sample's printed width, within the printer font's own
  // advance-width error (it is narrower than Helvetica-Bold).
  const rendered = textEmWidth(fitted.text) * fitted.fontSize * fitted.scale
  const reference = dotsToPt(249)
  assert.ok(Math.abs(rendered - reference) / reference < 0.15, `rendered ${rendered} vs ${reference}`)

  // The same holds for the short strings, and — unlike natural layout — the
  // sample stretches them wider than the font would be on its own.
  const attr = design.fields.find((f) => f.kind === 'attr1')!
  const attrFit = fitDesignText(
    measure,
    'FUY',
    fieldFontSizePt(attr.capHeight),
    dotsToPt(fieldMaxWidthMm(design, attr, true) * DOTS),
    fieldBaseScale(attr.refWidth, attr.capHeight),
  )
  assert.ok(fieldBaseScale(attr.refWidth, attr.capHeight) > 1.5, 'the sample stretches the chip')
  assert.ok(near(attrFit.scale, fieldBaseScale(attr.refWidth, attr.capHeight), 0.001))
})

test('a very long name never crosses its column or the QR symbol', () => {
  const design = labelDesignFor(50, 40)!
  const name = design.fields.find((f) => f.kind === 'name')!
  const fontSizePt = fieldFontSizePt(name.capHeight)
  const maxWidthPt = dotsToPt(fieldMaxWidthMm(design, name, true) * DOTS)
  const long = 'Antique Finish Hand Crafted Temple Design Silver Necklace With Gemstones'
  const fitted = fitDesignText(measure, long, fontSizePt, maxWidthPt, fieldBaseScale(name.refWidth, name.capHeight))
  const rendered = textEmWidth(fitted.text) * fitted.fontSize * fitted.scale
  assert.ok(rendered <= maxWidthPt + 0.5, `rendered ${rendered} > column ${maxWidthPt}`)
  // And the line stays legible: the em size never falls below half the sample's.
  assert.ok(fitted.fontSize >= fontSizePt * 0.5 - 0.001)
})

test('a line that cannot be condensed is shortened rather than allowed to overflow', () => {
  const design = labelDesignFor(35, 22)!
  const name = design.fields.find((f) => f.kind === 'name')!
  const fontSizePt = fieldFontSizePt(name.capHeight)
  const maxWidthPt = dotsToPt(fieldMaxWidthMm(design, name, true) * DOTS)
  const enormous = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(6)
  const fitted = fitDesignText(measure, enormous, fontSizePt, maxWidthPt, fieldBaseScale(name.refWidth, name.capHeight))
  assert.ok(fitted.text.endsWith('\u2026'), `expected an ellipsis, got ${fitted.text.slice(0, 40)}`)
  const rendered = textEmWidth(fitted.text) * fitted.fontSize * fitted.scale
  assert.ok(rendered <= maxWidthPt + 0.5)
  assert.ok(fitted.text.length < enormous.length)
})

test('the ZPL fitter reproduces the reference h,w for sample-length lines', () => {
  const design = labelDesignFor(50, 40)!
  const name = design.fields.find((f) => f.kind === 'name')!
  const maxWidthDots = Math.round(fieldMaxWidthMm(design, name, true) * DOTS)
  for (const text of ['FLOWER CRYSTAL ELASTIC LD BELT', 'RING', 'FUSION OF KEMPU']) {
    const fitted = fitDesignField(text, maxWidthDots, Math.round(name.capHeight * DOTS), Math.round(name.refWidth * DOTS))
    assert.deepEqual(fitted, { h: 37, w: 13 }, `${text} -> ${JSON.stringify(fitted)}`)
  }
})

test('the ZPL and PDF fitters shrink together and agree within a step', () => {
  const cases = [
    'FUSION OF KEMPU & NA GOLD PLATED ANKLET WITH PEARL',
    'Antique Finish Hand Crafted Temple Design Silver Necklace With Gemstones',
    'SUPERCALIFRAGILISTICEXPIALIDOCIOUS',
  ]
  const refH = 37
  const refW = 13
  const refEmPt = fieldFontSizePt(refH / DOTS)
  for (const text of cases) {
    for (const maxWidthDots of [373, 213]) {
      const fitted = fitDesignField(text, maxWidthDots, refH, refW)
      assert.ok(fitted.h <= refH, `${text} h grew`)
      assert.ok(fitted.h >= Math.round(refH * 0.5), `${text} h=${fitted.h} below the legibility floor`)
      assert.ok(fitted.w <= refW, `${text} w=${fitted.w} past the reference w`)

      const pdf = fitDesignText(measure, text, refEmPt, dotsToPt(maxWidthDots), fieldBaseScale(refW / DOTS, refH / DOTS))
      // Same em size, within one shrink step of each other. The ZPL fitter works
      // in whole dots and floors `w`, so it can step one rung earlier.
      const zplEmPt = (fitted.h / ZPL_EM_RATIO) / DOTS / MM_PER_PT
      assert.ok(
        Math.abs(zplEmPt - pdf.fontSize) <= refEmPt * 0.25,
        `${text} @${maxWidthDots}: zpl em ${zplEmPt.toFixed(2)} vs pdf ${pdf.fontSize.toFixed(2)}`,
      )
      // Neither ever goes past its column or below the legibility floor.
      assert.ok(pdf.fontSize >= refEmPt * 0.5 - 0.001, `${text} pdf em below the floor`)
      const rendered = textEmWidth(pdf.text) * pdf.fontSize * pdf.scale
      assert.ok(rendered <= dotsToPt(maxWidthDots) + 0.5, `${text} pdf line ${rendered} overflows`)
    }
  }
})

test('a line the sample already condenses past the limit is not shrunk further', () => {
  // The 50x40 name is authored at w/em = 0.325, deliberately below the general
  // MIN_TEXT_SCALE limit. The fitter must treat that as the line's floor and
  // leave the sample's own size alone.
  const design = labelDesignFor(50, 40)!
  const name = design.fields.find((f) => f.kind === 'name')!
  const baseScale = fieldBaseScale(name.refWidth, name.capHeight)
  assert.ok(baseScale < MIN_TEXT_SCALE, `sample scale ${baseScale} should be below the limit`)
  const fontSizePt = fieldFontSizePt(name.capHeight)
  const fitted = fitDesignText(
    measure,
    'FLOWER CRYSTAL ELASTIC LD BELT',
    fontSizePt,
    dotsToPt(fieldMaxWidthMm(design, name, true) * DOTS),
    baseScale,
  )
  assert.ok(near(fitted.fontSize, fontSizePt, 0.001), 'a sample-length name must not shrink')
  assert.ok(near(fitted.scale, baseScale, 0.01))
})

// ─── Content: real data only, no sample placeholders ──────────────────────────

test('the sample placeholder values are never printed as production data', () => {
  const design = labelDesignFor(50, 40)!
  const real = { name: 'Diamond Ring', sku: 'SKU-1', price: 1234.5, weight: 3.2, category: 'Rings' }
  const texts = designFieldTexts(
    real,
    { showPrice: true, showWeight: true, showBrand: true, brand: 'OPAL LINE' },
    design,
  )
  const joined = texts.map((t) => t.text).join('\n')
  for (const sample of ['W12345', '0012535', '99999.00', '39999.00', 'FUSION OF KEMPU', 'FLOWER CRYSTAL']) {
    assert.ok(!joined.includes(sample), `placeholder ${sample} leaked into ${joined}`)
  }
  assert.ok(joined.includes('DIAMOND RING'))
  assert.ok(joined.includes('SKU-1'))
  assert.ok(joined.includes('Rings'))
  assert.ok(joined.includes('Rate: 1234.50/-'))
})

test('every line comes from the product, and the code carries the identifier', () => {
  const design = labelDesignFor(50, 25)!
  const product = { name: 'Ring', sku: 'SKU-9', price: 10, category: 'Gold' }
  const texts = designFieldTexts(
    product,
    { showPrice: true, showWeight: true, showBrand: true, brand: 'OPAL LINE' },
    design,
  )
  assert.equal(texts.find((t) => t.kind === 'code')?.text, 'Code: SKU-9')
  assert.equal(texts.find((t) => t.kind === 'attr1')?.text, 'Gold')
  // No weight → no second chip, and never an empty field.
  assert.equal(texts.find((t) => t.kind === 'attr2'), undefined)
  assert.deepEqual(labelAttributes({ ...product, collection: 'Classic' }, { showPrice: true, showWeight: true }), ['Gold', 'Classic'])
  assert.deepEqual(labelAttributes(product, { showPrice: true, showWeight: true }), ['Gold'])
  assert.equal(labelCode(product), 'SKU-9')

  // The slim 10 mm sample prints the bare identifier instead of "Code: …".
  const slimTexts = designFieldTexts(
    product,
    { showPrice: true, showWeight: true, showBrand: true, brand: 'OPAL LINE' },
    labelDesignFor(50, 10)!,
  )
  assert.equal(slimTexts.find((t) => t.kind === 'code')?.text, 'SKU-9')
})

test('a missing brand or price simply drops the line', () => {
  const design = labelDesignFor(35, 22)!
  const texts = designFieldTexts(
    { name: 'Plain', sku: 'S1', price: 0 },
    { showPrice: false, showWeight: true, showBrand: true, brand: '   ' },
    design,
  )
  assert.equal(texts.find((t) => t.kind === 'brand'), undefined)
  assert.equal(texts.find((t) => t.kind === 'rate'), undefined)
  assert.equal(texts.find((t) => t.kind === 'name')?.text, 'PLAIN')
})

test('a design only exists for the four physical reference sizes', () => {
  assert.ok(labelDesignFor(50, 40))
  assert.ok(labelDesignFor(50, 25))
  assert.ok(labelDesignFor(50, 10))
  assert.ok(labelDesignFor(35, 22))
  // Other label stock (and anything else) falls back to the adaptive layout.
  assert.equal(labelDesignFor(50, 22), null)
  assert.equal(labelDesignFor(63.5, 25.4), null)
  assert.equal(labelDesignFor(Number.NaN, 40), null)
  assert.equal(LABEL_DESIGNS.length, 4)
})

// ─── The emitted ZPL stream ───────────────────────────────────────────────────
//
// Feeding the samples' own product data back in must reproduce the sample grid:
// identical `^FT` anchors, identical `^A0N` heights, the same `^BQN,2,<mag>`, and
// a `w` that never exceeds the sample's.

const SAMPLE: Array<{ label: string; product: Record<string, unknown>; nameWidth: number | null }> = [
  {
    label: '50x40',
    product: { name: 'FLOWER CRYSTAL ELASTIC LD BELT', sku: 'S1', barcode: 'W12345', price: 99999, category: 'FUY' },
    nameWidth: 13,
  },
  {
    label: '50x25',
    product: { name: 'FLOWER CRYSTAL ELASTIC LD BELT', sku: 'S1', barcode: 'W12345', price: 99999, category: 'FUY' },
    nameWidth: 13,
  },
  {
    label: '35x22',
    product: { name: 'FLOWER CRYSTAL ELASTIC', sku: 'S1', barcode: 'W12345', price: 99999, category: 'FUY' },
    nameWidth: 15,
  },
  {
    label: '50x10',
    product: { name: 'FUSION OF KEMPU & NA', sku: 'S1', barcode: '9999', price: 39999 },
    nameWidth: null,
  },
]

test('the ZPL stream reproduces the sample ^FT/^A0N/^BQ grid', () => {
  for (const sample of SAMPLE) {
    const [w, h] = sample.label.split('x').map(Number)
    const design = labelDesignFor(w, h)!
    const zpl = renderZpl([sample.product as never], {
      width: w,
      height: h,
      copies: 1,
      brand: 'OPAL LINE',
      showPrice: true,
      showWeight: true,
      showQR: true,
    })

    const fields = new Map<string, { x: number; y: number; h: number; w: number; text: string }>()
    for (const m of zpl.matchAll(/\^FT(\d+),(\d+)\^A0N,(\d+),(\d+)\^FH\\\^FD(.*?)\^FS/g)) {
      // Match text back to its design slot by anchor.
      const field = design.fields.find((f) => Math.round(f.x * DOTS) === +m[1] && Math.round(f.baseline * DOTS) === +m[2])
      assert.ok(field, `${sample.label}: no design field at ${m[1]},${m[2]}`)
      fields.set(field!.kind, { x: +m[1], y: +m[2], h: +m[3], w: +m[4], text: m[5] })
    }

    // Exactly the lines the product calls for — the sample's own text.
    const expected = designFieldTexts(
      sample.product as never,
      { showPrice: true, showWeight: true, showBrand: true, brand: 'OPAL LINE' },
      design,
    )
    assert.deepEqual(
      [...fields.keys()].sort(),
      expected.map((e) => e.kind).sort(),
      `${sample.label} emitted a different set of lines`,
    )

    for (const field of design.fields) {
      const emitted = fields.get(field.kind)
      if (!emitted) continue
      assert.equal(emitted.x, Math.round(field.x * DOTS), `${sample.label} ${field.kind} x`)
      assert.equal(emitted.y, Math.round(field.baseline * DOTS), `${sample.label} ${field.kind} y`)
      // The printed height is the sample's `h`; only a pathologically long line
      // is ever allowed to shrink it.
      assert.equal(emitted.h, Math.round(field.capHeight * DOTS), `${sample.label} ${field.kind} h`)
      // `w` never exceeds the sample's nominal width.
      assert.ok(emitted.w <= Math.round(field.refWidth * DOTS), `${sample.label} ${field.kind} w too wide`)
      assert.ok(emitted.w >= 4, `${sample.label} ${field.kind} w too narrow`)
      // And the line's printed extent stays inside the label.
      const extentDots = field.x * DOTS + emitted.w * textEmWidth(emitted.text)
      assert.ok(extentDots <= w * DOTS + 1, `${sample.label} ${field.kind} runs past ^PW`)
    }
    // The reference's own strings really are what came out.
    assert.equal(fields.get('name')!.text, sample.product.name, `${sample.label} name text`)
    assert.equal(fields.get('brand')!.text, 'OPAL LINE', `${sample.label} brand text`)

    // The QR carries the sample's command, magnification and anchor.
    assert.match(
      zpl,
      new RegExp(`\\^FT${Math.round(design.qr.x * DOTS)},${Math.round(design.qr.bottom * DOTS)}\\^BQN,2,${design.qr.magnification}`),
    )

    if (sample.nameWidth != null) {
      assert.equal(fields.get('name')!.w, sample.nameWidth, `${sample.label} name must match the sample`)
    }
  }
})

test('the ZPL stream never contains the sample placeholders for real products', () => {
  const zpl = renderZpl(
    [{ name: 'Diamond Ring', sku: 'SKU-1', price: 1234.5, weight: 3.2, category: 'Rings' } as never],
    { width: 50, height: 40, copies: 1, brand: 'OPAL LINE', showPrice: true, showWeight: true, showQR: true },
  )
  for (const sample of ['W12345', '0012535', '99999.00', '39999.00']) {
    assert.ok(!zpl.includes(sample), `placeholder ${sample} leaked into the ZPL`)
  }
  assert.ok(zpl.includes('^FDCode: SKU-1^FS'))
  assert.ok(zpl.includes('^FDRate: 1234.50/-^FS'))
  // The QR encodes exactly the SKU — the product's single identity.
  assert.ok(zpl.includes('^FDLA,SKU-1^FS'))
})
