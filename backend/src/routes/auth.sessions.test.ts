import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'

/**
 * Root-cause regression test for the "random logout" report: signing in on a
 * second tab/terminal used to run destroyUserSessions() and delete the rows of
 * every other signed-in tab for that account, so their next request answered
 * 401 and the UI bounced to /login.
 *
 * Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
 * the schema applied — the same contract as the other DB-gated suites.
 */
const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()

function sessionCookie(res: Response): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] }
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [res.headers.get('set-cookie') ?? '']
  const raw = all.find((cookie) => cookie.startsWith('opal.session='))
  assert.ok(raw, 'login did not set the session cookie')
  return raw.split(';')[0] as string
}

test(
  'a second sign-in keeps the earlier session and logout revokes only its own',
  { skip: testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set' },
  async () => {
    process.env.DATABASE_URL = testUrl as string

    const express = (await import('express')).default
    const cookieParser = (await import('cookie-parser')).default
    const argon2 = (await import('argon2')).default
    const { eq } = await import('drizzle-orm')
    const { db, schema } = await import('../db/client')
    const { authRouter } = await import('./auth')
    assert.ok(db, 'test database client did not initialize')

    const marker = `auth-sessions-${Date.now()}`
    const userId = `${marker}-user`
    const password = 'Opal@Test123'
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })

    const app = express()
    app.use(cookieParser())
    app.use(express.json())
    app.use('/api/v1/auth', authRouter)

    let server: Server | null = null
    try {
      await db!.insert(schema.users).values({
        id: userId,
        name: 'Auth Sessions Test',
        email: `${marker}@test.local`,
        username: marker,
        passwordHash,
        role: 'Super Admin',
        status: 'active',
      })

      server = app.listen(0, '127.0.0.1')
      await new Promise<void>((resolve, reject) => {
        server!.once('listening', () => resolve())
        server!.once('error', reject)
      })
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

      const login = async (): Promise<string> => {
        const res = await fetch(`${base}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: marker, password }),
        })
        assert.equal(res.status, 200)
        return sessionCookie(res)
      }

      const me = (cookie: string) => fetch(`${base}/api/v1/auth/me`, { headers: { cookie } })

      const first = await login()
      const second = await login()
      assert.notEqual(first, second, 'each sign-in must get its own opaque token')

      const rows = await db!.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))
      assert.equal(rows.length, 2, 'the second sign-in must add a session, not replace the first')

      assert.equal((await me(first)).status, 200, 'the earlier tab must still be signed in')
      assert.equal((await me(second)).status, 200)

      // Explicit logout must still work — and only for the caller's token.
      const out = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: first } })
      assert.equal(out.status, 200)
      assert.equal((await me(first)).status, 401)
      assert.equal((await me(second)).status, 200, 'signing out in one tab must not sign out the others')
    } finally {
      if (server) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())))
      }
      await db!.delete(schema.sessions).where(eq(schema.sessions.userId, userId))
      await db!.delete(schema.loginAttempts).where(eq(schema.loginAttempts.identifier, marker))
      await db!.delete(schema.users).where(eq(schema.users.id, userId))
    }
  },
)
