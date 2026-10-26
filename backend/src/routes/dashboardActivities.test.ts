import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// The Recent Activities feed merges both log tables: recordActivity writes
// (auth, sales, system, backup and RBAC operations → activity_logs) plus
// recordAudit writes (Shopify sync + legacy seeded rows → audit_logs), newest
// first, with out-of-period rows excluded. Before the fix the endpoint read
// audit_logs alone, so every business and auth event was invisible on both the
// dashboard widget and the header activity dropdown.
//
// Assertions check presence, ordering and range by marker entity — no count
// deltas, so leftovers from an earlier crashed run cannot make the test lie.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardSecurity.test.ts.
// (Separate file on purpose: each test file runs in its own process, and a
// test that closes the pool in its finally would break a second test in the
// same file.)
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')

const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

test(
  'dashboard activities feed merges activity_logs and audit_logs newest-first',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `act-${Date.now()}`
    const activityId = `${marker}-activity`
    const auditId = `${marker}-audit`
    const oldId = `${marker}-old`

    let server: Server | null = null
    try {
      const app = express()
      app.use(dashboardRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        return { status: res.status, body: (await res.json()) as any }
      }

      // activity row (newest) + audit row (1 min older) + out-of-range audit row.
      await db!.insert(schema.activityLogs).values({
        id: activityId,
        timestamp: localNaive(new Date()),
        action: 'Widget Feed Marker',
        module: 'system',
        entity: `${marker}-act`,
        details: 'from activity_logs',
      })
      await db!.insert(schema.auditLogs).values({
        id: auditId,
        timestamp: localNaive(new Date(Date.now() - 60 * 1000)),
        action: 'Widget Feed Marker',
        module: 'Shopify',
        entity: `${marker}-aud`,
        changes: 'from audit_logs',
      })
      await db!.insert(schema.auditLogs).values({
        id: oldId,
        timestamp: localNaive(new Date(Date.now() - 24 * 60 * 60 * 1000)),
        action: 'Widget Feed Marker',
        module: 'Shopify',
        entity: `${marker}-old`,
        changes: 'out of period',
      })

      const res = await get('/dashboard/activities?period=today')
      assert.equal(res.status, 200)
      const body = Array.isArray(res.body) ? res.body : res.body?.items
      assert.ok(Array.isArray(body), 'returns an array')
      const titles: string[] = body.map((r: { title: string }) => String(r.title))
      const idx = (needle: string) => titles.findIndex((t) => t.includes(needle))
      assert.ok(idx(`${marker}-act`) >= 0, 'the activity_logs row is present')
      assert.ok(idx(`${marker}-aud`) >= 0, 'the audit_logs row is present')
      assert.equal(idx(`${marker}-old`), -1, 'rows outside the period are excluded')
      assert.ok(
        idx(`${marker}-act`) < idx(`${marker}-aud`),
        'merged feed is newest-first across both tables',
      )
      const actRow = body[idx(`${marker}-act`)]
      assert.equal(actRow.actor, 'System')
      assert.equal(actRow.detail, 'from activity_logs')
      const audRow = body[idx(`${marker}-aud`)]
      assert.equal(audRow.detail, 'from audit_logs')

      // The dashboard widget asks for scope=latest: the date filter is ignored
      // there, so an older row is still in the feed (the activity page keeps
      // its range filter).
      const latestRes = await get('/dashboard/activities?period=today&scope=latest')
      assert.equal(latestRes.status, 200)
      const latestBody = Array.isArray(latestRes.body) ? latestRes.body : latestRes.body?.items
      const latestTitles: string[] = latestBody.map((r: { title: string }) => String(r.title))
      assert.ok(latestTitles.some((t) => t.includes(`${marker}-old`)), 'scope=latest ignores the date filter')
    } finally {
      const { inArray } = await import('drizzle-orm')
      await db!.delete(schema.activityLogs).where(inArray(schema.activityLogs.id, [activityId]))
      await db!.delete(schema.auditLogs).where(inArray(schema.auditLogs.id, [auditId, oldId]))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
