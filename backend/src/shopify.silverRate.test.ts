import test from 'node:test'
import assert from 'node:assert/strict'

const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

test(
  'applySilverRate persists the previous global rate across a 200 -> 300 change',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const { db, schema, getRawClient } = await import('./db/client')
    const { inArray } = await import('drizzle-orm')
    const { applySilverRate, getLatestSilverRate } = await import('./shopify')

    assert.ok(db, 'test database client did not initialize')

    const beforeRows = await db!.select({ id: schema.silverRates.id }).from(schema.silverRates)
    const beforeIds = new Set(beforeRows.map((r) => r.id))
    assert.equal(beforeRows.length, 0, 'scratch silver_rates must be empty')

    try {
      const first = await applySilverRate(200)
      assert.equal(first.ok, true, first.message ?? 'first rate change failed')

      const second = await applySilverRate(300)
      assert.equal(second.ok, true, second.message ?? 'second rate change failed')
      assert.equal(second.previousRate, 200, 'the second change must carry forward the first rate')

      const latest = await getLatestSilverRate()
      assert.ok(latest, 'latest silver rate must be readable after the change')
      assert.equal(latest!.rate, 300, 'current rate must be the newly applied value')
      assert.equal(latest!.previousRate, 200, 'previous rate must be persisted in silver_rates')
    } finally {
      const afterRows = await db!.select({ id: schema.silverRates.id }).from(schema.silverRates)
      const newIds = afterRows.map((r) => r.id).filter((id) => !beforeIds.has(id))
      if (newIds.length > 0) {
        await db!.delete(schema.silverRates).where(inArray(schema.silverRates.id, newIds))
      }
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
