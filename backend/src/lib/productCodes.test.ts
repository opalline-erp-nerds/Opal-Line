import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DEFAULT_SKU_FORMAT,
  MIN_SKU_SEQ_LENGTH,
  categoryCode,
  generateSku,
  generateVariantSku,
  maxSequence,
  normalizedCodeSettings,
  renderSku,
} from './productCodes'

test('defaults render the house style OL-RNG-001', () => {
  assert.equal(DEFAULT_SKU_FORMAT, '{PREFIX}-{CATEGORY}-{SEQ}')
  assert.equal(MIN_SKU_SEQ_LENGTH, 3)
  assert.equal(generateSku([], 'Rings'), 'OL-RNG-001')
  assert.equal(renderSku(null, 'Rings', 7), 'OL-RNG-007')
  // Three-digit minimum sequence: OL-RNG-042, never OL-RNG-42.
  assert.equal(renderSku(null, 'Rings', 42), 'OL-RNG-042')
  assert.equal(renderSku(null, 'Rings', 1234), 'OL-RNG-1234')
})

test('every spec category maps to its documented code', () => {
  const spec: Array<[string, string]> = [
    ['Rings', 'RNG'],
    ['Chains', 'CHN'],
    ['Earrings', 'EAR'],
    ['Necklaces', 'NCK'],
    ['Bracelets', 'BRC'],
    ['Bangles', 'BNG'],
    ['Pendants', 'PND'],
    ['Anklets', 'ANK'],
  ]
  for (const [category, code] of spec) {
    assert.equal(categoryCode(category), code, category)
    assert.equal(generateSku([], category), `OL-${code}-001`, category)
  }
})

test('other categories map explicitly, then fall back to their first three letters', () => {
  assert.equal(categoryCode('Mangalsutra'), 'MNG')
  assert.equal(categoryCode('Toe Rings'), 'TRG')
  assert.equal(categoryCode('Nose Pins'), 'NSP')
  assert.equal(categoryCode('Accessories'), 'CUF')
  // The business default still mints a real category code — new generic
  // OL-GEN-* SKUs are never created.
  assert.equal(categoryCode('Silver jewels'), 'SIL')
  assert.equal(generateSku([], 'Silver jewels'), 'OL-SIL-001')
  // Case-insensitive: "rings" and "Rings" mint the same code.
  assert.equal(categoryCode('rings'), 'RNG')
  assert.equal(categoryCode('toe rings'), 'TRG')
  // Unmapped categories use their first three letters…
  assert.equal(categoryCode('Pashmina Shawls'), 'PAS')
  // …and only a category with no letters at all falls back to generic GEN.
  assert.equal(categoryCode('123'), 'GEN')
  assert.equal(categoryCode(''), 'GEN')
})

test('sequences run independently per category', () => {
  const existing = ['OL-RNG-001', 'OL-RNG-002', 'OL-CHN-001']
  assert.equal(generateSku(existing, 'Rings'), 'OL-RNG-003')
  assert.equal(generateSku(existing, 'Chains'), 'OL-CHN-002')
  assert.equal(generateSku(existing, 'Earrings'), 'OL-EAR-001')
})

test('generation never collides with an existing code', () => {
  assert.equal(generateSku(['OL-RNG-001', 'OL-RNG-002', 'OL-RNG-004'], 'Rings'), 'OL-RNG-005')
  // Case-insensitive collisions count too.
  assert.equal(generateSku(['ol-rng-003'], 'Rings'), 'OL-RNG-004')
  // A legacy fixed-format code continues its category's sequence instead of
  // restarting from 1: SLV-RNG-00021 → OL-RNG-022.
  assert.equal(generateSku(['SLV-RNG-00021'], 'Rings'), 'OL-RNG-022')
})

test('maxSequence reads the configured format, legacy house style and category scope', () => {
  assert.equal(maxSequence([]), 0)
  // No category given → every category's sequence is visible.
  assert.equal(maxSequence(['OL-RNG-009', 'OL-CHN-050']), 50)
  // A category scopes the scan: Rings never sees the Chain sequence.
  assert.equal(maxSequence(['OL-RNG-009', 'OL-CHN-050'], null, 'Rings'), 9)
  // Legacy house style still advances the count.
  assert.equal(maxSequence(['SLV-GEN-00099']), 99)
  assert.equal(maxSequence(['SLV-RNG-00021'], null, 'Rings'), 21)
  assert.equal(maxSequence(['junk', '', null, undefined]), 0)
})

test('configured prefix, suffix and sequence length drive the format', () => {
  const cfg = {
    skuPrefix: 'opal',
    skuSuffix: 'in',
    skuFormat: '{PREFIX}-{CATEGORY}-{SEQ}{SUFFIX}',
    skuSeqLength: 4,
  }
  assert.equal(renderSku(cfg, 'Rings', 42), 'OPAL-RNG-0042IN')
  // A format without {SEQ} falls back to the default template.
  assert.equal(normalizedCodeSettings({ skuFormat: 'whatever' }).skuFormat, DEFAULT_SKU_FORMAT)
  assert.equal(renderSku({ skuPrefix: 'abc', skuFormat: '{PREFIX}-{SEQ}' }, 'Chains', 9), 'ABC-009')
  // The sequence can never be configured below the three-digit spec minimum.
  assert.equal(normalizedCodeSettings({ skuSeqLength: 1 }).skuSeqLength, 3)
  assert.equal(renderSku({ skuSeqLength: 1 }, 'Rings', 7), 'OL-RNG-007')
})

test('variant SKUs join the parent SKU with per-value codes and de-duplicate', () => {
  assert.equal(generateVariantSku('OL-RNG-001', ['Small', 'Red'], []), 'OL-RNG-001-SMA-RED')
  // Duplicate of an existing code bumps a numeric tail.
  assert.equal(
    generateVariantSku('OL-RNG-001', ['Small', 'Red'], ['OL-RNG-001-SMA-RED']),
    'OL-RNG-001-SMA-RED-2',
  )
})
