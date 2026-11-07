import { randomBytes } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { NextFunction, Request, Response } from 'express'
import { CONSTANTS } from './constants'
import { logger } from './logger'
import { parseDbTimestamp } from './lib/dbtime'
import { DEFAULT_SESSION_POLICY, evaluateSession } from './lib/sessionPolicy'

export interface Session {
  userId: string
  expiresAt: number
  createdAt: number
}

/** The persisted fields the session resolver needs from one row. */
export interface StoredSession {
  userId: string
  createdAt: string | null
  expiresAt: string | null
}

/** Narrow storage port so the sliding-expiry logic is testable without a DB. */
export interface SessionStore {
  find(token: string): Promise<StoredSession | null>
  remove(token: string): Promise<void>
  /** Persist `expiresAt` only when it moves the expiry forward. */
  extend(token: string, expiresAt: string): Promise<void>
}

export interface SessionResolution {
  userId: string | null
  /** Set when the row was extended and the browser cookie must be re-issued. */
  refreshExpiresAt?: number
}

declare global {
  namespace Express {
    interface Request {
      userId?: string
    }
  }
}

const TTL_MS = CONSTANTS.SESSION_TTL_MS
const COOKIE_NAME = CONSTANTS.SESSION_COOKIE_NAME
let totalCreated = 0

let cleanupInterval: NodeJS.Timeout | null = null

function startCleanupInterval(): void {
  if (cleanupInterval) return
  cleanupInterval = setInterval(async () => {
    try {
      const { db, schema } = await import('./db/client')
      if (!db) return
      const now = new Date().toISOString()
      const result = await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now)).returning()
      if (result.length > 0) {
        logger.debug({ cleaned: result.length }, 'Cleaned up expired sessions from database')
      }
    } catch (err) {
      logger.error({ err }, 'Failed to clean up expired sessions')
    }
  }, 5 * 60 * 1000)
  cleanupInterval.unref()
}

function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
}

export async function createSession(userId: string): Promise<string> {
  if (cleanupInterval === null) {
    startCleanupInterval()
  }
  const { db, schema } = await import('./db/client')
  const token = randomBytes(32).toString('hex')
  const now = new Date()
  const expiresAt = new Date(now.getTime() + TTL_MS)

  if (db) {
    try {
      await db.insert(schema.sessions).values({
        token,
        userId,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      })
    } catch (err) {
      logger.error({ err }, 'Failed to create session in database')
      throw new Error('Failed to create session')
    }
  }
  totalCreated++
  return token
}

/**
 * Resolve a token against a store and apply the sliding-expiry policy.
 *
 * Pure with respect to time (`nowMs` is injected) and storage (`store` is a
 * port), so the regression tests can cover active-session extension, idle
 * expiry, the absolute cap and same-token concurrency without a database.
 */
export async function resolveSession(
  store: SessionStore,
  token: string,
  nowMs: number,
  policy = DEFAULT_SESSION_POLICY,
): Promise<SessionResolution> {
  const session = await store.find(token)
  if (!session) return { userId: null }

  // Stored timestamps are UTC without a zone marker — parse as UTC or the
  // session appears expired hours early on non-UTC machines.
  const expiresAtMs = parseDbTimestamp(session.expiresAt)?.getTime()
  if (!expiresAtMs || Number.isNaN(expiresAtMs)) {
    await store.remove(token)
    return { userId: null }
  }

  // Rows written before createdAt was populated fall back to the old fixed
  // 24h relationship, so the absolute cap still behaves sensibly.
  const createdAtMs = parseDbTimestamp(session.createdAt)?.getTime() ?? expiresAtMs - policy.idleTtlMs
  const decision = evaluateSession(createdAtMs, expiresAtMs, nowMs, policy)

  if (!decision.valid) {
    await store.remove(token)
    return { userId: null }
  }

  if (decision.extendTo === null) return { userId: session.userId }

  try {
    await store.extend(token, new Date(decision.extendTo).toISOString())
    return { userId: session.userId, refreshExpiresAt: decision.extendTo }
  } catch (err) {
    // A failed extension must not reject a request the read already proved is
    // valid; the user simply keeps the existing expiry for this request.
    logger.warn({ err }, 'Failed to extend session expiry')
    return { userId: session.userId }
  }
}

export async function getSessionUserId(
  token: string | undefined,
): Promise<{ userId: string | null; dbError: boolean; refreshExpiresAt?: number }> {
  if (!token) return { userId: null, dbError: false }
  try {
    const { db, schema } = await import('./db/client')
    if (!db) return { userId: null, dbError: true }

    const store: SessionStore = {
      async find(sessionToken) {
        const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.token, sessionToken)).limit(1)
        const row = rows[0]
        return row ? { userId: row.userId, createdAt: row.createdAt, expiresAt: row.expiresAt } : null
      },
      async remove(sessionToken) {
        await db.delete(schema.sessions).where(eq(schema.sessions.token, sessionToken))
      },
      async extend(sessionToken, expiresAt) {
        // Extend-only predicate: concurrent requests with the same token may
        // both run this, but neither can move the expiry backwards.
        await db
          .update(schema.sessions)
          .set({ expiresAt })
          .where(and(eq(schema.sessions.token, sessionToken), lt(schema.sessions.expiresAt, expiresAt)))
      },
    }

    const resolution = await resolveSession(store, token, Date.now())
    return { dbError: false, ...resolution }
  } catch {
    return { userId: null, dbError: true }
  }
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return
  try {
    const { db, schema } = await import('./db/client')
    if (!db) return
    await db.delete(schema.sessions).where(eq(schema.sessions.token, token))
  } catch {
    // ignore
  }
}

export async function destroyUserSessions(userId: string): Promise<void> {
  try {
    const { db, schema } = await import('./db/client')
    if (!db) return
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId))
  } catch {
    // ignore
  }
}

/** Desktop leaves both unset: Secure stays off (http://localhost drops a Secure
 * cookie) and SameSite stays Strict. Hosted mode opts in with COOKIE_SECURE=true. */
export function sessionCookieOptions(maxAge: number): {
  httpOnly: true
  secure: boolean
  sameSite: 'strict' | 'lax' | 'none'
  maxAge: number
  path: '/'
} {
  const secure = /^(1|true|yes)$/i.test((process.env.COOKIE_SECURE ?? '').trim())
  const raw = (process.env.COOKIE_SAMESITE ?? '').trim().toLowerCase()
  const sameSite = raw === 'lax' || raw === 'none' || raw === 'strict' ? raw : 'strict'
  return { httpOnly: true, secure, sameSite, maxAge, path: '/' }
}

/**
 * `maxAgeMs` defaults to the full inactivity window for a fresh login. Rolling
 * refreshes pass the remaining lifetime instead, which may be shorter when the
 * absolute cap is closer than a full idle window.
 */
export function setSessionCookie(res: Response, token: string, maxAgeMs: number = TTL_MS): void {
  res.cookie(COOKIE_NAME, token, sessionCookieOptions(Math.max(0, Math.floor(maxAgeMs))))
}

export function clearSessionCookie(res: Response): void {
  res.cookie(COOKIE_NAME, '', sessionCookieOptions(0))
}

export function tokenFromRequest(req: Request): string | undefined {
  return req.cookies?.[COOKIE_NAME] as string | undefined
}

/**
 * Endpoints a user with a pending forced password change may still reach. Anything
 * else is refused until they rotate, but these three keep them from being locked
 * out of their own account.
 */
const PASSWORD_CHANGE_ALLOWLIST = new Set([
  '/api/v1/auth/change-password',
  '/api/v1/auth/logout',
  '/api/v1/auth/me',
])

export const PASSWORD_CHANGE_REQUIRED = 'Password change required'

async function userMustChangePassword(userId: string): Promise<boolean> {
  try {
    const { db, schema } = await import('./db/client')
    if (!db) return false
    const rows = await db
      .select({ flag: schema.users.requirePasswordChange })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)
    return rows[0]?.flag === true
  } catch {
    return false
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = tokenFromRequest(req)
  const { userId, dbError, refreshExpiresAt } = await getSessionUserId(token)
  if (dbError) {
    res.status(503).json({ error: 'Database unavailable' })
    return
  }
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }
  // Sliding expiry: the DB row was just extended, so re-issue the cookie with
  // the same token and the new remaining lifetime. Without this the browser
  // would still drop the cookie at the original login time even though the
  // server considers the session active.
  if (token && refreshExpiresAt) {
    setSessionCookie(res, token, refreshExpiresAt - Date.now())
  }
  // Enforce the flag the bootstrap/seed set. It used to be written but never
  // read, so accounts kept working indefinitely on their initial password.
  const path = (req.originalUrl || req.url).split('?')[0]
  if (!PASSWORD_CHANGE_ALLOWLIST.has(path) && (await userMustChangePassword(userId))) {
    res.status(403).json({ error: PASSWORD_CHANGE_REQUIRED, code: 'PASSWORD_CHANGE_REQUIRED' })
    return
  }
  req.userId = userId
  next()
}

export async function getSessionStats(): Promise<{ active: number; totalCreated: number }> {
  let active = 0
  try {
    const { db, schema } = await import('./db/client')
    if (db) {
      const now = new Date().toISOString()
      const rows = await db.select().from(schema.sessions).where(gt(schema.sessions.expiresAt, now))
      active = rows.length
    }
  } catch { /* ignore */ }
  return { active, totalCreated }
}

/**
 * Process-shutdown housekeeping. Deliberately does NOT delete session rows:
 * sessions are database-backed with a TTL precisely so they survive restarts
 * (dev-server restarts, app updates). Wiping the table here logged every user
 * out of every backend instance sharing the database — including the desktop
 * app when the dev server was restarted — because the browser kept a cookie
 * whose row no longer existed. Expired rows are removed by the periodic
 * sweeper above and on-read in getSessionUserId.
 */
export function shutdownSessions(): void {
  stopCleanupInterval()
}
