import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { duplicateScanMessage, inactiveProductMessage, normalizeScanCode, scanCodeError } from './scanCode'

test('normalizeScanCode strips keyboard-wedge CR/LF, spaces and control characters', () => {
  // A QR code encoding "OL-RNG-001" scanned through a wedge scanner arrives
  // with trailing CR/LF; it must normalise to the exact SKU.
  assert.equal(normalizeScanCode('  OL-RNG-001\r\n'), 'OL-RNG-001')
  assert.equal(normalizeScanCode('8901\t2345'), '89012345')
  assert.equal(normalizeScanCode('OL123'), 'OL123')
  assert.equal(normalizeScanCode(null), '')
  assert.equal(normalizeScanCode(undefined), '')
})

test('normalizeScanCode is exact — it never rewrites characters', () => {
  assert.equal(normalizeScanCode('ol-rng-001'), 'ol-rng-001')
  assert.notEqual(normalizeScanCode('OL-RNG-001'), normalizeScanCode('OL-RNG-002'))
})

test('scanCodeError rejects blank and single-character input', () => {
  assert.match(scanCodeError('') ?? '', /required/)
  assert.match(scanCodeError('   ') ?? '', /required/)
  assert.match(scanCodeError('x') ?? '', /too short/)
  assert.equal(scanCodeError('OL-RNG-001'), null)
})

test('scan codes are capped so an over-long paste cannot be used as input', () => {
  assert.equal(normalizeScanCode('9'.repeat(500)).length, 128)
})

test('duplicate and inactive-product messages are actionable', () => {
  assert.match(duplicateScanMessage(), /duplicate SKU/)
  assert.match(inactiveProductMessage('Ring', 'inactive'), /Ring/)
  assert.match(inactiveProductMessage('Ring', 'inactive'), /inactive/)
})
