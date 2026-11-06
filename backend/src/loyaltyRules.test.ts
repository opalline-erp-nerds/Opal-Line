// Pure loyalty rule tests — no database, no module that opens a connection.
//
// Kept in its own file (rather than alongside the scratch-DB integration test)
// because importing the loyalty engine creates the shared DB client, and doing
// that before DATABASE_URL is pointed at a scratch database would make the
// integration test talk to the app database.
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('loyalty rules (pure)', async () => {
  const {
    earnedPointsFor,
    reversalTargetPoints,
    loyaltyTier,
    remainingByLot,
    expirablePoints,
    normalizeOrderRef,
    configFromSettings,
  } = await import('./loyalty')

  // Earning: floor of full hundreds, minimum order honoured, no negatives.
  assert.equal(earnedPointsFor(999, { pointsPer: 100 }), 9)
  assert.equal(earnedPointsFor(100, { pointsPer: 100 }), 1)
  assert.equal(earnedPointsFor(99, { pointsPer: 100 }), 0)
  assert.equal(earnedPointsFor(-500, { pointsPer: 100 }), 0)
  assert.equal(earnedPointsFor(4999, { pointsPer: 1000 }), 4)
  assert.equal(earnedPointsFor(4999, { pointsPer: 1000, minOrderValue: 5000 }), 0, 'minimum order blocks earning')
  assert.equal(earnedPointsFor(5000, { pointsPer: 1000, minOrderValue: 5000 }), 5)

  // Refund proration is cumulative and never goes backwards.
  assert.equal(reversalTargetPoints({ earned: 100, alreadyReversedPoints: 0, totalValue: 10000, cumulativeReversedValue: 4000 }), 40)
  assert.equal(
    reversalTargetPoints({ earned: 100, alreadyReversedPoints: 40, totalValue: 10000, cumulativeReversedValue: 4000 }),
    40,
    'same refund again targets the same total',
  )
  assert.equal(
    reversalTargetPoints({ earned: 100, alreadyReversedPoints: 40, totalValue: 10000, cumulativeReversedValue: 10000 }),
    100,
    'completing a full refund reverses the remainder',
  )
  assert.equal(
    reversalTargetPoints({ earned: 100, alreadyReversedPoints: 0, totalValue: 10000, cumulativeReversedValue: 20000 }),
    100,
    'over-refund never exceeds the award',
  )
  assert.equal(
    reversalTargetPoints({ earned: 70, alreadyReversedPoints: 67, totalValue: 0, cumulativeReversedValue: 0 }),
    70,
    'unknown value reverses the outstanding award',
  )

  // Tiers
  assert.equal(loyaltyTier(0), 'Bronze')
  assert.equal(loyaltyTier(99), 'Bronze')
  assert.equal(loyaltyTier(100), 'Silver')
  assert.equal(loyaltyTier(500), 'Gold')
  assert.equal(loyaltyTier(1000), 'Platinum')

  // FIFO allocation: the oldest points are spent first.
  const lots = [
    { id: 'lot-1', points: 10, date: '2026-01-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z' },
    { id: 'lot-2', points: 10, date: '2026-02-01T00:00:00.000Z', expiresAt: '2026-03-01T00:00:00.000Z' },
  ]
  const movements = [{ id: 'm1', type: 'redeem', points: -15, date: '2026-02-10T00:00:00.000Z' }]
  const remaining = remainingByLot(lots, movements)
  assert.equal(remaining.get('lot-1'), 0, 'oldest lot fully consumed')
  assert.equal(remaining.get('lot-2'), 5, 'newer lot keeps the remainder')

  // Only lots past their expiry date, and only what is left in them.
  assert.deepEqual(expirablePoints(lots, remaining, '2026-02-15T00:00:00.000Z'), [], 'nothing due yet')
  assert.deepEqual(expirablePoints(lots, remaining, '2026-03-02T00:00:00.000Z'), [{ id: 'lot-2', points: 5 }])

  // Order references normalise to the `#name` form used across the ERP.
  assert.equal(normalizeOrderRef('1027'), '#1027')
  assert.equal(normalizeOrderRef('#1027'), '#1027')
  assert.equal(normalizeOrderRef(''), '')

  // Settings merge: NULL columns keep the shipped defaults.
  const merged = configFromSettings(
    { loyaltyPointsPer: 250, loyaltyPointValue: null, loyaltyExpiryMonths: 6, loyaltyShopifySync: true },
    {
      enabled: true,
      pointsPer: 100,
      pointValue: 1,
      minOrderValue: 0,
      expiryMonths: null,
      shopifySync: false,
      metafieldNamespace: 'opal_line',
      metafieldKey: 'loyalty_points',
    },
  )
  assert.equal(merged.pointsPer, 250)
  assert.equal(merged.pointValue, 1, 'NULL point value keeps the default')
  assert.equal(merged.expiryMonths, 6)
  assert.equal(merged.shopifySync, true)
})
