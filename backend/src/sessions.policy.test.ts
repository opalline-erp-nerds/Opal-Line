import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSession, shutdownSessions, type SessionStore, type StoredSession } from './sessions'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 0, 1)

/**
 * Stand-in for the `sessions` table. It mirrors the two properties that make
 * the real store safe: a token identifies exactly one row, and `extend` only
 * moves the expiry forward.
 */
class MemorySessionStore implements SessionStore {
  readonly rows = new Map<string, StoredSession>()
  readonly removed: string[] = []
  writes = 0

  seed(token: string, createdAtMs: number | null, expiresAtMs: number | null, userId = 'user-1'): void {
    this.rows.set(token, {
      userId,
      createdAt: createdAtMs === null ? null : new Date(createdAtMs).toISOString(),
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
    })
  }

  async find(token: string): Promise<StoredSession | null> {
    const row = this.rows.get(token)
    return row ? { ...row } : null
  }

  async remove(token: string): Promise<void> {
    this.removed.push(token)
    this.rows.delete(token)
  }

  async extend(token: string, expiresAt: string): Promise<void> {
    const row = this.rows.get(token)
    if (!row?.expiresAt) return
    if (Date.parse(expiresAt) <= Date.parse(row.expiresAt)) return
    row.expiresAt = expiresAt
    this.writes++
  }
}

test('an active session near expiry is extended and keeps working', async () => {
  const store = new MemorySessionStore()
  const token = 'active-token'
  const now = T0 + 13 * HOUR // 11h left of the 24h window
  store.seed(token, T0, T0 + DAY)

  const result = await resolveSession(store, token, now)

  assert.equal(result.userId, 'user-1')
  assert.equal(result.refreshExpiresAt, now + DAY)
  assert.equal(Date.parse(store.rows.get(token)!.expiresAt!), now + DAY)
  // The absolute cap is measured from creation, so the original row is reused.
  assert.equal(Date.parse(store.rows.get(token)!.createdAt!), T0)
  assert.equal(store.rows.size, 1)
})

test('a session idle past its window expires and its row is removed', async () => {
  const store = new MemorySessionStore()
  const token = 'idle-token'
  store.seed(token, T0, T0 + DAY)

  const result = await resolveSession(store, token, T0 + DAY)

  assert.equal(result.userId, null)
  assert.equal(result.refreshExpiresAt, undefined)
  assert.deepEqual(store.removed, [token])
  assert.equal(store.rows.has(token), false)
})

test('a session far from expiry is not rewritten', async () => {
  const store = new MemorySessionStore()
  const token = 'fresh-token'
  store.seed(token, T0, T0 + DAY)

  const result = await resolveSession(store, token, T0 + 1 * HOUR)

  assert.equal(result.userId, 'user-1')
  assert.equal(result.refreshExpiresAt, undefined)
  assert.equal(store.writes, 0)
})

test('the absolute lifetime survives repeated activity and then expires', async () => {
  const store = new MemorySessionStore()
  const token = 'long-lived-token'
  store.seed(token, T0, T0 + DAY)

  // Keep touching the session every 13h, the way a dashboard poll would.
  for (let now = T0; now < T0 + 6 * DAY + 23 * HOUR; now += 13 * HOUR) {
    const result = await resolveSession(store, token, now)
    assert.equal(result.userId, 'user-1', `active at ${(now - T0) / HOUR}h`)
  }

  const nearCap = await resolveSession(store, token, T0 + 6 * DAY + 23 * HOUR)
  assert.equal(nearCap.userId, 'user-1')
  // The last extension was clamped to creation + 7 days, not now + 24h.
  assert.equal(Date.parse(store.rows.get(token)!.expiresAt!), T0 + 7 * DAY)

  const atCap = await resolveSession(store, token, T0 + 7 * DAY)
  assert.equal(atCap.userId, null)
  assert.equal(store.rows.has(token), false)
})

test('sessions survive a process shutdown because shutdown does not wipe rows', async () => {
  const store = new MemorySessionStore()
  const token = 'persistent-token'
  store.seed(token, T0, T0 + DAY)

  // shutdownSessions() intentionally only stops the cleanup timer. A restart
  // must not invalidate live sessions held in the shared database.
  shutdownSessions()

  const result = await resolveSession(store, token, T0 + 1 * HOUR)
  assert.equal(result.userId, 'user-1')
  assert.equal(store.rows.has(token), true)
})

test('an explicitly revoked token is rejected before it would expire', async () => {
  const store = new MemorySessionStore()
  const token = 'logout-token'
  store.seed(token, T0, T0 + DAY)

  assert.equal((await resolveSession(store, token, T0 + 1 * HOUR)).userId, 'user-1')

  // What POST /auth/logout does through destroySession(): delete the row and
  // drop the cookie. The same token must stop working immediately.
  await store.remove(token)
  const afterLogout = await resolveSession(store, token, T0 + 1 * HOUR)

  assert.equal(afterLogout.userId, null)
  assert.equal(store.rows.has(token), false)
})

test('concurrent requests on one token keep the same session and only extend it', async () => {
  const store = new MemorySessionStore()
  const token = 'concurrent-token'
  const now = T0 + 13 * HOUR
  store.seed(token, T0, T0 + DAY)

  const [first, second] = await Promise.all([
    resolveSession(store, token, now),
    resolveSession(store, token, now + 1000),
  ])

  assert.equal(first.userId, 'user-1')
  assert.equal(second.userId, 'user-1')
  // No token rotation: both requests used the same row and no new rows exist.
  assert.equal(store.rows.size, 1)
  assert.equal(Date.parse(store.rows.get(token)!.expiresAt!), now + 1000 + DAY)
})

test('a legacy row with no createdAt still resolves using the old fixed TTL', async () => {
  const store = new MemorySessionStore()
  const token = 'legacy-token'
  const now = T0 + 13 * HOUR
  store.seed(token, null, T0 + DAY)

  const result = await resolveSession(store, token, now)

  assert.equal(result.userId, 'user-1')
  // The fallback createdAt is expiresAt - 24h, so the cap stays finite.
  assert.equal(result.refreshExpiresAt, now + DAY)
})

test('a row with an unparseable expiry is treated as invalid and removed', async () => {
  const store = new MemorySessionStore()
  const token = 'corrupt-token'
  store.rows.set(token, { userId: 'user-1', createdAt: null, expiresAt: 'not-a-date' })

  const result = await resolveSession(store, token, T0)

  assert.equal(result.userId, null)
  assert.equal(store.rows.has(token), false)
})
