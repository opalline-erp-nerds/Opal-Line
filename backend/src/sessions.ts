import { randomBytes } from 'node:crypto'
import { eq, gt, lt } from 'drizzle-orm'
import type { NextFunction, Request, Response } from 'express'
import { CONSTANTS } from './constants'
import { logger } from './logger'
import { parseDbTimestamp } from './lib/dbtime'

export interface Session {
  userId: string
  expiresAt: number
  createdAt: number
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

export async function getSessionUserId(token: string | undefined): Promise<{ userId: string | null; dbError: boolean }> {
  if (!token) return { userId: null, dbError: false }
  try {
    const { db, schema } = await import('./db/client')
    if (!db) return { userId: null, dbError: true }

    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.token, token)).limit(1)
    const session = rows[0]
    if (!session) return { userId: null, dbError: false }

    // expiresAt is stored as UTC without a zone marker — parse as UTC or the
    // session appears expired hours early on non-UTC machines.
    const expiresAt = parseDbTimestamp(session.expiresAt)
    if (!expiresAt || new Date() > expiresAt) {
      await db.delete(schema.sessions).where(eq(schema.sessions.token, token))
      return { userId: null, dbError: false }
    }
    return { userId: session.userId, dbError: false }
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

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, sessionCookieOptions(TTL_MS))
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
  const { userId, dbError } = await getSessionUserId(token)
  if (dbError) {
    res.status(503).json({ error: 'Database unavailable' })
    return
  }
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' })
    return
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
