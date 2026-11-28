import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

// Security widget: the payload names accounts that failed to log in, so the
// endpoint is Admin / Super Admin only (401 without a session user, 403 for
// any other role), and "locked accounts" must follow the same 15-minute rule
// checkLockout() applies at login — a stale login_attempts row whose window
// has lapsed is NOT a locked account (auth would let that identifier back in
// and lazily delete the row on their next attempt).
//
// Assertions are deltas against a baseline fetched before the marker rows are
// inserted, so leftovers from an earlier crashed run cannot make the test lie.
//
// Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
// the schema applied — the same contract as dashboardPaymentStatus.test.ts.
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

const pad = (n: number) => String(n).padStart(2, '0')

const localNaive = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

test(
  'dashboard security is admin-only and counts lockouts only inside the window',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const { db, schema, getRawClient } = await import('../db/client')
    const { dashboardRouter } = await import('./dashboard')
    assert.ok(db, 'test database client did not initialize')

    const marker = `sec-${Date.now()}`
    const adminId = `${marker}-admin`
    const mgrId = `${marker}-mgr`
    const staleId = `${marker}-stale`
    const freshId = `${marker}-fresh`
    const auditId = `${marker}-audit`
    const activityId = `${marker}-activity`

    let server: Server | null = null
    // Captured before the policy is enabled so the finally block can restore it.
    let priorSettings: { enabled: boolean | null } | undefined
    try {
      await db!.insert(schema.users).values([
        { id: adminId, name: 'Sec Test Admin', email: `${marker}-admin@test.local`, role: 'Admin', status: 'active' },
        { id: mgrId, name: 'Sec Test Viewer', email: `${marker}-mgr@test.local`, role: 'Manager', status: 'active' },
      ])

      // Locked accounts are only counted while the install's lockout policy is
      // enabled (the endpoint reports zero otherwise, exactly like
      // checkLockout() at login), so enable it and remember what was there.
      const { eq } = await import('drizzle-orm')
      const [settingsRow] = await db!
        .select({ enabled: schema.settings.loginLockoutEnabled })
        .from(schema.settings)
        .where(eq(schema.settings.id, 'app'))
        .limit(1)
      priorSettings = settingsRow
      await db!
        .insert(schema.settings)
        .values({ id: 'app', loginLockoutEnabled: true })
        .onConflictDoUpdate({ target: schema.settings.id, set: { loginLockoutEnabled: true } })

      const app = express()
      app.use((req, _res, next) => {
        ;(req as { userId?: string }).userId = req.header('x-test-user') ?? undefined
        next()
      })
      app.use(dashboardRouter)
      server = app.listen(0)
      const port = Number((server.address() as { port: number }).port)
      const get = async (path: string, user?: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, user ? { headers: { 'x-test-user': user } } : {})
        return { status: res.status, body: (await res.json()) as any }
      }

      // ── Admin-only ────────────────────────────────────────────────────────
      // No session user → 401 (requireAuth normally blocks this, but the
      // handler must not read a userId it was never given).
      const anonymous = await get('/dashboard/security?period=today')
      assert.equal(anonymous.status, 401)
      assert.deepEqual(anonymous.body, { error: 'Not authenticated' })

      // A real non-admin user → 403, and no payload leaks through.
      const viewer = await get('/dashboard/security?period=today', mgrId)
      assert.equal(viewer.status, 403, 'non-admin must not read the security snapshot')
      assert.deepEqual(viewer.body, { error: 'Admin access required' })

      // Admin → 200 with the documented shape.
      const before = await get('/dashboard/security?period=today', adminId)
      assert.equal(before.status, 200)
      assert.equal(typeof before.body.failedLogins, 'number')
      assert.equal(typeof before.body.lockedAccounts, 'number')
      assert.ok(Array.isArray(before.body.recent))
      assert.ok(before.body.recent.length <= 5, 'recent failures list is capped at 5')

      // ── Locked counts follow the login window ─────────────────────────────
      // Stale row: threshold exceeded, but the lockout window lapsed 16 min
      // ago — auth would unlock on the next attempt, so it must not count.
      await db!.insert(schema.loginAttempts).values({
        identifier: staleId,
        count: 9,
        lastAttempt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      })
      const afterStale = await get('/dashboard/security?period=today', adminId)
      assert.equal(
        afterStale.body.lockedAccounts,
        before.body.lockedAccounts,
        'a row outside the 15-minute window is not a locked account',
      )

      // Fresh row: threshold reached 30 seconds ago — genuinely locked.
      await db!.insert(schema.loginAttempts).values({
        identifier: freshId,
        count: 5,
        lastAttempt: new Date(Date.now() - 30 * 1000).toISOString(),
      })
      const afterFresh = await get('/dashboard/security?period=today', adminId)
      assert.equal(
        afterFresh.body.lockedAccounts,
        before.body.lockedAccounts + 1,
        'a row inside the 15-minute window counts as locked',
      )

      // ── Failed logins in range ────────────────────────────────────────────
      // Two writers exist: auth's recordActivity (→ activity_logs, the
      // production path) and recordAudit (→ audit_logs). Both must count.
      await db!.insert(schema.activityLogs).values({
        id: activityId,
        timestamp: localNaive(new Date()),
        action: 'Failed Login Attempt',
        module: 'system',
        entity: `${marker}-act`,
        details: 'Invalid password',
      })
      await db!.insert(schema.auditLogs).values({
        id: auditId,
        timestamp: localNaive(new Date()),
        action: 'Failed Login Attempt',
        module: 'system',
        entity: `${marker}-aud`,
        changes: 'Invalid password',
      })
      const afterAudit = await get('/dashboard/security?period=today', adminId)
      assert.equal(
        afterAudit.body.failedLogins,
        before.body.failedLogins + 2,
        'failed logins from both activity_logs and audit_logs count',
      )
      assert.ok(
        afterAudit.body.recent.some((r: { entity: string | null }) => r.entity === `${marker}-act`),
        'the activity_logs failure appears in the recent list',
      )
      assert.ok(
        afterAudit.body.recent.some((r: { entity: string | null }) => r.entity === `${marker}-aud`),
        'the audit_logs failure appears in the recent list',
      )
    } finally {
      const { eq, inArray } = await import('drizzle-orm')
      if (priorSettings) {
        await db!
          .update(schema.settings)
          .set({ loginLockoutEnabled: priorSettings.enabled ?? false })
          .where(eq(schema.settings.id, 'app'))
          .catch(() => undefined)
      } else {
        await db!.delete(schema.settings).where(eq(schema.settings.id, 'app')).catch(() => undefined)
      }
      await db!.delete(schema.users).where(inArray(schema.users.id, [adminId, mgrId]))
      await db!.delete(schema.loginAttempts).where(inArray(schema.loginAttempts.identifier, [staleId, freshId]))
      await db!.delete(schema.auditLogs).where(inArray(schema.auditLogs.id, [auditId]))
      await db!.delete(schema.activityLogs).where(inArray(schema.activityLogs.id, [activityId]))
      server?.close()
      await getRawClient()?.end({ timeout: 5 })
    }
  },
)
