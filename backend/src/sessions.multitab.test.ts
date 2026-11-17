import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSession, type SessionStore, type StoredSession } from './sessions'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 0, 1)

/**
 * Mirrors the real store: a token identifies exactly one row and `extend` only
 * moves the expiry forward. Used here to pin the multi-session guarantee the
 * login route relies on — signing in again ADDS a row instead of replacing the
 * sessions other tabs and terminals are using.
 */
class MemorySessionStore implements SessionStore {
  readonly rows = new Map<string, StoredSession>()

  async find(token: string): Promise<StoredSession | null> {
    const row = this.rows.get(token)
    return row ? { ...row } : null
  }

  async remove(token: string): Promise<void> {
    this.rows.delete(token)
  }

  async extend(token: string, expiresAt: string): Promise<void> {
    const row = this.rows.get(token)
    if (!row?.expiresAt) return
    if (Date.parse(expiresAt) <= Date.parse(row.expiresAt)) return
    row.expiresAt = expiresAt
  }

  signIn(token: string, userId = 'user-1', nowMs = T0): void {
    this.rows.set(token, {
      userId,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + DAY).toISOString(),
    })
  }
}

test('a second sign-in keeps the session the first tab is using', async () => {
  const store = new MemorySessionStore()
  store.signIn('tab-a-token')
  store.signIn('tab-b-token')

  assert.equal((await resolveSession(store, 'tab-a-token', T0 + HOUR)).userId, 'user-1')
  assert.equal((await resolveSession(store, 'tab-b-token', T0 + HOUR)).userId, 'user-1')
  assert.equal(store.rows.size, 2)
})

test('signing out in one tab only revokes the token that was presented', async () => {
  const store = new MemorySessionStore()
  store.signIn('tab-a-token')
  store.signIn('tab-b-token')

  // destroySession() deletes exactly the cookie value it was given.
  await store.remove('tab-a-token')

  assert.equal((await resolveSession(store, 'tab-a-token', T0 + HOUR)).userId, null)
  assert.equal((await resolveSession(store, 'tab-b-token', T0 + HOUR)).userId, 'user-1')
})

test('an expired token is rejected without touching a live session', async () => {
  const store = new MemorySessionStore()
  store.signIn('expired-token')
  store.signIn('live-token')

  assert.equal((await resolveSession(store, 'expired-token', T0 + DAY)).userId, null)
  assert.equal(store.rows.has('expired-token'), false)
  assert.equal((await resolveSession(store, 'live-token', T0 + DAY - HOUR)).userId, 'user-1')
})

test('a revoked token is rejected even though another session is live', async () => {
  const store = new MemorySessionStore()
  store.signIn('revoked-token')
  store.signIn('live-token')

  // Administrator revocation / password reset deletes rows by user.
  store.rows.delete('revoked-token')

  assert.equal((await resolveSession(store, 'revoked-token', T0 + HOUR)).userId, null)
  assert.equal((await resolveSession(store, 'live-token', T0 + HOUR)).userId, 'user-1')
})
