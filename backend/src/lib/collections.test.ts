import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  CATEGORY_NAME_MAX,
  CATEGORY_PREFIX_PATTERN,
  COLLECTION_IDS,
  DEFAULT_COLLECTIONS,
  categoryNameError,
  categoryPrefixError,
  categorySeedRows,
  collectionNameError,
  normalizeCategoryName,
  normalizeCategoryPrefix,
  normalizeCollectionName,
} from './collections'
import { CATEGORY_PREFIX } from './productCodes'

test('the two foundation collections have stable ids and their pricing types', () => {
  assert.equal(DEFAULT_COLLECTIONS.length, 2)
  const silver = DEFAULT_COLLECTIONS.find((c) => c.id === COLLECTION_IDS.silverJewels)
  const other = DEFAULT_COLLECTIONS.find((c) => c.id === COLLECTION_IDS.otherProducts)
  assert.ok(silver, 'Silver Jewels collection exists')
  assert.ok(other, 'Other Products collection exists')

  // Silver Jewels keeps the existing silver-rate behaviour and cannot be renamed.
  assert.equal(silver!.name, 'Silver Jewels')
  assert.equal(silver!.pricingType, 'silver')
  assert.equal(silver!.isSystem, true)

  // The independent collection starts as "Other Products" and is fixed-price.
  assert.equal(other!.name, 'Other Products')
  assert.equal(other!.pricingType, 'fixed')
  assert.equal(other!.isSystem, false)

  // Ids are fixed constants, not derived from the editable display name.
  assert.equal(COLLECTION_IDS.silverJewels, 'COL-SILVER-JEWELS')
  assert.equal(COLLECTION_IDS.otherProducts, 'COL-OTHER-PRODUCTS')
})

test('seeded categories cover every established SKU prefix exactly once', () => {
  const rows = categorySeedRows()
  const expected = Object.entries(CATEGORY_PREFIX)
  assert.equal(rows.length, expected.length, 'one category per SKU prefix')

  // Each seeded category stays in Silver Jewels and uses its established code.
  for (const [name, prefix] of expected) {
    const row = rows.find((r) => r.name === name)
    assert.ok(row, `category "${name}" is seeded`)
    assert.equal(row!.prefix, prefix)
    assert.equal(row!.collectionId, COLLECTION_IDS.silverJewels)
    assert.equal(row!.id, `CAT-${prefix}`, 'category ids are stable, prefix-based ids')
  }

  // Explicit spot checks from the SKU convention (Rings → OL-RNG-…).
  assert.deepEqual(
    rows.filter((r) => ['Rings', 'Chains', 'Silver jewels'].includes(r.name)).map((r) => r.prefix).sort(),
    ['CHN', 'RNG', 'SIL'],
  )

  // No duplicate names or prefixes across the seed (the 0011 migration relies
  // on both unique indexes).
  assert.equal(new Set(rows.map((r) => r.name.toLowerCase())).size, rows.length)
  assert.equal(new Set(rows.map((r) => r.prefix)).size, rows.length)
})

test('category names and prefixes normalise to their stored form', () => {
  assert.equal(normalizeCategoryName('  Hand   Bags '), 'Hand Bags')
  assert.equal(normalizeCategoryPrefix(' bag '), 'BAG')
  assert.equal(normalizeCollectionName('  Other   Products '), 'Other Products')
})

test('category name validation requires a name within the limit', () => {
  assert.match(categoryNameError('') ?? '', /required/i)
  assert.match(categoryNameError('   '.trim()) ?? '', /required/i)
  assert.equal(categoryNameError('Bags'), null)
  assert.equal(categoryNameError('x'.repeat(CATEGORY_NAME_MAX)), null)
  assert.match(categoryNameError('x'.repeat(CATEGORY_NAME_MAX + 1)) ?? '', /120|fewer/i)
})

test('SKU prefixes must be 2–5 letters, unique-able and uppercase', () => {
  assert.match(categoryPrefixError('') ?? '', /required/i)
  for (const valid of ['BG', 'BAG', 'HAND', 'BAGS']) {
    assert.match(valid, CATEGORY_PREFIX_PATTERN)
    assert.equal(categoryPrefixError(valid), null)
  }
  for (const invalid of ['B', 'BAGSXY', 'B4G', 'BA-G', '123']) {
    assert.ok(categoryPrefixError(invalid), `${invalid} is rejected`)
  }
})

test('collection names require a display name within the limit', () => {
  assert.match(collectionNameError('') ?? '', /required/i)
  assert.equal(collectionNameError('Other Products'), null)
  assert.match(collectionNameError('x'.repeat(121)) ?? '', /120|fewer/i)
})
