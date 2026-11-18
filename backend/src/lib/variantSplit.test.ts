import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitQtyAcrossVariants, type VariantWeightEntry } from './variantSplit'

/**
 * The apportionment rule the whole variant model leans on: one quantity in,
 * parts that ALWAYS sum back to it — in the migration (attributing balances
 * that predate variants), in a parent-keyed movement on a multi-variant
 * product, and in adopting a pre-ledger balance.
 */

const entry = (variantId: string, weight: number, key = variantId): VariantWeightEntry => ({
  variantId,
  weight,
  key,
})

test('splits a quantity so the parts sum to the whole', () => {
  const parts = splitQtyAcrossVariants(7, [entry('red', 4, 'RED'), entry('white', 4, 'WHI')])
  assert.equal(
    parts.reduce((sum, p) => sum + p.qty, 0),
    7,
    'the split must never create or lose a unit',
  )
  assert.deepEqual(parts.map((p) => p.qty).sort((a, b) => a - b), [3, 4])
})

test('is deterministic: ties break on the stable key, not input order', () => {
  const byId = (parts: Array<{ variantId: string; qty: number }>) =>
    [...parts].sort((x, y) => (x.variantId < y.variantId ? -1 : 1))
  const a = splitQtyAcrossVariants(1, [entry('r1', 4, 'RED'), entry('w1', 4, 'WHI')])
  const b = splitQtyAcrossVariants(1, [entry('w1', 4, 'WHI'), entry('r1', 4, 'RED')])
  assert.deepEqual(byId(a), byId(b), 'the same inputs must split the same way everywhere')
  assert.equal(a.find((p) => p.variantId === 'r1')?.qty, 1, 'the lower key wins the remainder')
  assert.equal(a.find((p) => p.variantId === 'w1')?.qty, 0)
})

test('keeps every part inside its weight, so nothing rounds negative', () => {
  // The availability check guarantees qty ≤ Σweight; rounding must then never
  // hand a variant more than it actually holds.
  const weights = [entry('r', 1, 'R'), entry('w', 1, 'W')]
  for (let qty = -2; qty <= 2; qty++) {
    for (const part of splitQtyAcrossVariants(qty, weights)) {
      const weight = weights.find((w) => w.variantId === part.variantId)!.weight
      assert.ok(
        Math.abs(part.qty) <= weight,
        `qty ${qty} gave ${part.variantId} ${part.qty} against a weight of ${weight}`,
      )
    }
  }
})

test('negative quantities split as exactly as positive ones', () => {
  const parts = splitQtyAcrossVariants(-5, [entry('r', 6, 'R'), entry('w', 4, 'W')])
  assert.equal(parts.reduce((sum, p) => sum + p.qty, 0), -5)
  assert.deepEqual(parts.map((p) => p.qty).sort((a, b) => a - b), [-3, -2])
})

test('with no recorded weights it distributes evenly instead of dropping the movement', () => {
  const parts = splitQtyAcrossVariants(5, [entry('r', 0, 'R'), entry('w', 0, 'W'), entry('g', 0, 'G')])
  assert.equal(parts.reduce((sum, p) => sum + p.qty, 0), 5)
  assert.deepEqual(parts.map((p) => p.qty).sort((a, b) => a - b), [1, 2, 2])
})

test('single entry takes everything, and no entries take nothing', () => {
  assert.deepEqual(splitQtyAcrossVariants(9, [entry('only', 0, 'O')]), [{ variantId: 'only', qty: 9 }])
  assert.deepEqual(splitQtyAcrossVariants(9, []), [])
  assert.deepEqual(splitQtyAcrossVariants(0, [entry('r', 5, 'R')]), [{ variantId: 'r', qty: 0 }])
})
