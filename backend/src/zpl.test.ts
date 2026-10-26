import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ZPL_DOTS_PER_MM,
  zplDimensionError,
  zplEscape,
  zplLabel,
  renderZpl,
  zplOptionsForPreset,
} from './zpl'

const product = {
  name: 'Diamond Ring',
  sku: 'OL-RNG-001',
  price: 1234.5,
  weight: 3.2,
  category: 'Rings',
}

// 16. Print escaping / injection resistance -----------------------------------

test('zplEscape neutralises the ZPL command introducers', () => {
  assert.equal(zplEscape('Acme ^FS^XZ'), 'Acme \\5EFS\\5EXZ')
  assert.equal(zplEscape('tilde ~JR'), 'tilde \\7EJR')
  assert.equal(zplEscape('back\\slash'), 'back\\5Cslash')
})

test('zplEscape replaces non-ASCII and control characters so the byte stream stays safe', () => {
  assert.equal(zplEscape('Ring·'), 'Ring?')
  assert.equal(zplEscape('a\nb\tc'), 'a?b?c')
  assert.equal(zplEscape(null), '')
})

test('a malicious product name cannot inject a ZPL command', () => {
  const zpl = zplLabel({ ...product, name: 'Evil^FS^XZ^XA' }, { width: 50, height: 40 })
  assert.ok(zpl)
  // The only real ^XZ is the renderer's own closing marker at the very end.
  assert.equal((zpl!.match(/\^XZ/g) ?? []).length, 1)
  assert.equal((zpl!.match(/\^FS/g) ?? []).length, (zpl!.match(/\^FD/g) ?? []).length)
  assert.ok(zpl!.includes('EVIL\\5EFS\\5EXZ\\5EXA'))
})

// 17. Valid, scannable payloads ----------------------------------------------

test('the QR symbol uses the reference ^BQN command and carries the SKU', () => {
  const zpl = zplLabel(product, { width: 50, height: 40 })
  assert.ok(zpl)
  assert.match(zpl!, /\^BQN,2,\d+/)
  assert.ok(zpl!.includes('^FDLA,OL-RNG-001^FS'))
})

test('the QR payload is ONLY the SKU — never the name, price or weight', () => {
  const zpl = zplLabel(product, { width: 50, height: 40 })
  assert.ok(zpl)
  const lines = zpl!.split('\n')
  const bqn = lines.findIndex((line) => line.includes('^BQN'))
  assert.ok(bqn >= 0, 'a QR symbol is emitted')
  // The line right after ^BQN is the data field: ^FH\ ^FDLA,<SKU>^FS
  // ("level L, auto data type" + the payload) — nothing else may appear there.
  const payloadLine = lines[bqn + 1]
  assert.equal(payloadLine, '^FH\\^FDLA,OL-RNG-001^FS')
  assert.ok(!payloadLine.includes('DIAMOND RING'))
  assert.ok(!payloadLine.includes('1234.50'))
  assert.ok(!payloadLine.includes('3.2'))
})

test('no linear barcode (Code 128) is ever emitted — labels are QR-only', () => {
  const zpl = zplLabel(product, { width: 50, height: 40 })
  assert.ok(zpl)
  assert.ok(!zpl!.includes('^BC'), 'Code 128 command must never appear')
})

test('a product without a SKU prints no QR symbol instead of a broken one', () => {
  const zpl = zplLabel({ ...product, sku: '' }, { width: 50, height: 25 })
  assert.ok(zpl)
  assert.ok(!zpl!.includes('^BQN'))
})

// 13/15. Dimensions + printer integration ------------------------------------

test('label width and length commands reflect the physical size at 203 dpi', () => {
  for (const [w, h] of [
    [50, 40],
    [50, 25],
    [50, 10],
    [35, 22],
  ]) {
    const zpl = zplLabel(product, { width: w, height: h })
    assert.ok(zpl)
    assert.ok(zpl!.includes(`^PW${w * ZPL_DOTS_PER_MM}`), `${w}x${h} width`)
    assert.ok(zpl!.includes(`^LL${h * ZPL_DOTS_PER_MM}`), `${w}x${h} length`)
  }
})

test('zplDimensionError rejects impossible sizes', () => {
  assert.match(zplDimensionError(0, 40) ?? '', /positive/)
  assert.match(zplDimensionError(50, -1) ?? '', /positive/)
  assert.match(zplDimensionError(500, 40) ?? '', /200 mm or less/)
  assert.equal(zplDimensionError(50, 40), null)
})

test('an invalid size renders nothing rather than a broken stream', () => {
  assert.equal(zplLabel(product, { width: 0, height: 40 }), null)
  assert.equal(renderZpl([product], { width: 9999, height: 40 }), '')
})

test('copies are delegated to the printer with ^PQ', () => {
  const zpl = zplLabel(product, { width: 50, height: 40, copies: 5 })
  assert.ok(zpl)
  assert.ok(zpl!.includes('^PQ5,0,1,Y'))
})

// 9/10. Individual + bulk printing -------------------------------------------

test('renderZpl emits exactly one label block per product', () => {
  const many = Array.from({ length: 4 }, (_, i) => ({ ...product, sku: `OL-RNG-00${i + 1}` }))
  const zpl = renderZpl(many, { width: 50, height: 25 })
  assert.equal((zpl.match(/\^XA/g) ?? []).length, 4)
  assert.equal((zpl.match(/\^XZ/g) ?? []).length, 4)
})

test('renderZpl returns an empty string when there is nothing to print', () => {
  assert.equal(renderZpl([], { width: 50, height: 40 }), '')
})

test('zplOptionsForPreset resolves physical sizes and rejects unknown template keys', () => {
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(zplOptionsForPreset('label-50x10')),
    { width: 50, height: 10 },
  )
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(zplOptionsForPreset('label-35x22')),
    { width: 35, height: 22 },
  )
  assert.throws(() => zplOptionsForPreset('nope'), /Unknown label preset/)
})

test('all six reference template keys keep their brand and code layout in ZPL', () => {
  const references = [
    { key: 'label-50x40', brand: 'OPAL LINE', width: 50, height: 40 },
    { key: 'label-50x25', brand: 'OPAL LINE', width: 50, height: 25 },
    { key: 'label-35x22', brand: 'OPAL LINE', width: 35, height: 22 },
    { key: 'label-50x10', brand: 'OPAL LINE', width: 50, height: 10 },
    { key: 'label-50x10-loni', brand: 'OPAL LINE', width: 50, height: 10 },
    { key: 'label-50x10-compact', brand: 'OPAL LINE', width: 50, height: 10 },
  ]
  for (const ref of references) {
    const options = zplOptionsForPreset(ref.key, { showPrice: true })
    const zpl = zplLabel(
      { name: 'Fusion of Kempu & NA', sku: '0012535', price: 39999 },
      options,
    )
    assert.ok(zpl, ref.key)
    assert.ok(zpl!.includes(`^PW${ref.width * ZPL_DOTS_PER_MM}`), `${ref.key} width`)
    assert.ok(zpl!.includes(`^LL${ref.height * ZPL_DOTS_PER_MM}`), `${ref.key} length`)
    assert.ok(zpl!.includes(`^FD${ref.brand}^FS`), `${ref.key} brand`)
    assert.ok(zpl!.includes('^FDFUSION OF KEMPU & NA^FS'), `${ref.key} product description`)
    assert.ok(zpl!.includes('^FDRate: 39999.00/-^FS'), `${ref.key} rate`)
    assert.ok(zpl!.includes('^FDLA,0012535^FS'), `${ref.key} QR payload is the SKU`)
    if (ref.key === 'label-50x10-compact') {
      // The slim reference prints the bare, FULL identifier — never a fragment.
      assert.ok(zpl!.includes('^FD0012535^FS'), 'compact full code')
    }
  }
})

test('missing optional fields never produce an empty ZPL field', () => {
  const zpl = zplLabel({ name: '', sku: '', price: 0 }, { width: 50, height: 25, brand: '' })
  assert.ok(zpl)
  // An empty brand is skipped entirely rather than emitting `^FD^FS`, and the
  // name still falls back to a placeholder.
  assert.ok(!zpl!.includes('^FD^FS'))
  assert.ok(zpl!.includes('^FDPRODUCT^FS'))
})
