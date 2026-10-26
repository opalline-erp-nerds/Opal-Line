import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGING_BUCKETS,
  ageInDays,
  agingBucketDefinition,
  agingBucketForDays,
  fifoEntryDate,
} from './stockAging'

/**
 * Stock aging is the FIFO reconstruction of when the units still on hand were
 * bought. These tests pin the two things that quietly go wrong:
 *   1. a restock making an old balance look new (lot consumption off by one), and
 *   2. the 30/60/90/180 boundaries drifting because of an inclusive/exclusive
 *      mistake.
 */

const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

test('ageInDays counts whole days and never goes negative', () => {
  const now = date('2026-03-01')
  assert.equal(ageInDays('2026-02-01T00:00:00.000Z', now), 28)
  assert.equal(ageInDays('2026-02-28T23:59:59.000Z', now), 0)
  assert.equal(ageInDays('2026-03-02T00:00:00.000Z', now), 0, 'future dates clamp to zero')
  assert.equal(ageInDays(null, now), null)
  assert.equal(ageInDays('not-a-date', now), null)
})

test('agingBucketForDays pins the 30/60/90/180 boundaries', () => {
  assert.equal(agingBucketForDays(0), 'd0_30')
  assert.equal(agingBucketForDays(30), 'd0_30')
  assert.equal(agingBucketForDays(31), 'd31_60')
  assert.equal(agingBucketForDays(60), 'd31_60')
  assert.equal(agingBucketForDays(61), 'd61_90')
  assert.equal(agingBucketForDays(90), 'd61_90')
  assert.equal(agingBucketForDays(91), 'd91_180')
  assert.equal(agingBucketForDays(180), 'd91_180')
  assert.equal(agingBucketForDays(181), 'd180_plus')
  assert.equal(agingBucketForDays(-5), 'd0_30', 'garbage clamps to the fresh band')
  assert.equal(agingBucketDefinition('d180_plus').label, '180+ days')
})

test('fifoEntryDate: nothing sold keeps the oldest lot date', () => {
  const entry = fifoEntryDate({
    stock: 10,
    inflows: [
      { date: '2026-01-10T00:00:00.000Z', qty: 4 },
      { date: '2026-01-01T00:00:00.000Z', qty: 6 },
    ],
  })
  assert.equal(entry, '2026-01-01T00:00:00.000Z')
})

test('fifoEntryDate: sales consume the oldest lots first', () => {
  const entry = fifoEntryDate({
    stock: 5,
    inflows: [
      { date: '2026-01-01T00:00:00.000Z', qty: 5 },
      { date: '2026-02-01T00:00:00.000Z', qty: 5 },
    ],
  })
  // 10 in - 5 on hand = 5 consumed, which is exactly the January lot.
  assert.equal(entry, '2026-02-01T00:00:00.000Z')
})

test('fifoEntryDate: a partial sale keeps the partially consumed old lot', () => {
  const entry = fifoEntryDate({
    stock: 8,
    inflows: [
      { date: '2026-01-01T00:00:00.000Z', qty: 5 },
      { date: '2026-02-01T00:00:00.000Z', qty: 5 },
    ],
  })
  // 2 units of the January lot remain, so the oldest stock is still January.
  assert.equal(entry, '2026-01-01T00:00:00.000Z')
})

test('fifoEntryDate: the newest lot can be the only one left', () => {
  const entry = fifoEntryDate({
    stock: 2,
    inflows: [
      { date: '2026-01-01T00:00:00.000Z', qty: 5 },
      { date: '2026-02-01T00:00:00.000Z', qty: 5 },
      { date: '2026-03-01T00:00:00.000Z', qty: 5 },
    ],
  })
  // 15 in - 2 left = 13 consumed: all of Jan and Feb plus 3 of March.
  assert.equal(entry, '2026-03-01T00:00:00.000Z')
})

test('fifoEntryDate accepts the naive timestamp strings Postgres returns', () => {
  const entry = fifoEntryDate({
    stock: 1,
    inflows: [{ date: '2026-01-05 09:30:00', qty: 1 }],
  })
  assert.equal(entry, new Date('2026-01-05 09:30:00').toISOString())
})

test('fifoEntryDate returns null when the ledger cannot explain the balance', () => {
  assert.equal(fifoEntryDate({ stock: 5, inflows: [] }), null, 'pre-ledger stock has no lot')
  assert.equal(
    fifoEntryDate({ stock: 8, inflows: [{ date: '2026-01-01T00:00:00.000Z', qty: 5 }] }),
    null,
    'stock on hand greater than recorded inflows falls back to product.createdAt',
  )
  assert.equal(fifoEntryDate({ stock: 0, inflows: [{ date: '2026-01-01T00:00:00.000Z', qty: 5 }] }), null)
})

test('every bucket has a unique key and contiguous, non-overlapping ranges', () => {
  assert.equal(new Set(AGING_BUCKETS.map((b) => b.key)).size, AGING_BUCKETS.length)
  for (let i = 1; i < AGING_BUCKETS.length; i += 1) {
    assert.equal(AGING_BUCKETS[i].minDays, (AGING_BUCKETS[i - 1].maxDays ?? 0) + 1)
  }
})
