import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Silver Rate History widget: silver_rates only stores *changes*, but the
// chart needs one point per IST calendar day. The endpoint must:
//   - return exactly the requested window (7 | 30 | 90 days, default 7),
//   - forward-fill days with no update (and carry rates from before the
//     window into it), so the line is continuous,
//   - never invent points for days before the first recorded rate,
//   - keep the latest update of a given IST day (same-day supersede),
//   - ignore rows with a null updated_at,
//   - reject any other `days` value with 400.
//
// Timestamps are inserted at 12:00Z of a target IST day (17:30 IST, same
// calendar day), so the bucketing assertions hold regardless of the
// session/server time zone. The scratch database must start with an empty
// silver_rates table — assertions are absolute, and no other test writes it.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardBuckets.test.ts.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const istDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const istDayKey = (d: Date) => istDayFormatter.format(d)

const shiftDay = (dayKey: string, deltaDays: number) => {
  const d = new Date(`${dayKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}


test(
  'silver history backfills one point per IST day across the 7/30/90 windows',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `silver-${Date.now()}`
    const today = istDayKey(new Date())
    const tenDaysAgo = shiftDay(today, -10)
    const twoDaysAgo = shiftDay(today, -2)
    // Noon UTC of a calendar day = 17:30 IST the same day.
    const noonUtc = (dayKey: string) => `${dayKey}T12:00:00.000Z`
    const rows = [
      // First-ever rate, well before every window: the carry-in source.
      { id: `${marker}-old`, rate: 91, updatedAt: noonUtc(tenDaysAgo) },
      // Superseded twice: earlier and later updates of the same IST day.
      { id: `${marker}-new`, rate: 98, updatedAt: `${twoDaysAgo}T10:00:00.000Z` },
      { id: `${marker}-newer`, rate: 99, updatedAt: `${twoDaysAgo}T15:00:00.000Z` },
      // Null updated_at must be ignored entirely.
      { id: `${marker}-null`, rate: 5, updatedAt: null },
    ]

    let server: Server | null = null
    try {
      const app = express()
      app.use(dashboardRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        assert.equal(res.status, 200, `${path} responded ${res.status}`)
        return (await res.json()) as { days: number; points: Array<{ date: string; rate: number }> }
      }
      const before = await get('/dashboard/silver-history?days=90')
      assert.equal(
        before.points.length,
        0,
        'scratch silver_rates must be empty: these assertions are absolute',
      )

      await db!.insert(schema.silverRates).values(rows)

      // ── 7 days: exactly the window, carry-in from ten days ago ──────────
      const d7 = await get('/dashboard/silver-history?days=7')
      assert.equal(d7.days, 7)
      assert.deepEqual(
        d7.points.map((p) => p.rate),
        [98, 99],
        'days=7 must return only actual saved rates inside the window',
      )

      // ── 30 days: window starts ten days back, values fully determined ───
      const d30 = await get('/dashboard/silver-history?days=30')
      assert.equal(d30.days, 30)
      assert.deepEqual(
        d30.points.map((p) => p.rate),
        [91, 98, 99],
        'days=30 must return every actual saved rate in the window',
      )

      // ── 90 days behaves like 30 when nothing older exists ───────────────
      const d90 = await get('/dashboard/silver-history?days=90')
      assert.deepEqual(d90, { days: 90, points: d30.points })

      // ── No `days` argument defaults to the 7-day window ─────────────────
      const dDefault = await get('/dashboard/silver-history')
      assert.deepEqual(dDefault, { days: 7, points: d7.points })

      // ── Anything outside {7, 30, 90} is rejected ─────────────────────────
      for (const bad of ['10', '0', '-7', '7.5', 'abc']) {
        const res = await fetch(`http://127.0.0.1:${port}/dashboard/silver-history?days=${bad}`)
        assert.equal(res.status, 400, `days=${bad} must be rejected`)
        const body = (await res.json()) as { error?: string }
        assert.equal(body.error, 'days must be one of 7, 30, 90')
      }
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.silverRates).where(inArray(schema.silverRates.id, rows.map((r) => r.id)))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
