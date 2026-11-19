import { Router, type Response } from 'express'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import { and, eq, ne, or, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { normalizeLockoutPolicy, type LockoutPolicy } from '../lockout'
import { computeUserPermissions } from '../rbac'
import { recordActivity } from '../activity'
import { createSession, destroySession, destroyUserSessions, requireAuth, tokenFromRequest, setSessionCookie, clearSessionCookie } from '../sessions'
import { isRecoveryLogin } from '../recoveryPassword'
import { validate, forgotPasswordSchema, resetPasswordSchema, verifyEmailSchema, changePasswordSchema } from '../validation'
import { parseDbTimestamp } from '../lib/dbtime'

export const authRouter = Router()

/**
 * The per-install lockout policy (Settings → Security → Login lockout): the
 * on/off switch plus the editable "attempts before lockout" and "lockout
 * minutes" values (defaults/NULL → 5 attempts / 15 minutes). Fails open: if
 * the settings row cannot be read, no lockout is enforced — a storage error
 * must never lock the owner out of their own system.
 */
export async function getLockoutPolicy(): Promise<LockoutPolicy> {
  const fallback = normalizeLockoutPolicy({})
  try {
    const { db: getDb, schema } = await import('../db/client')
    if (!getDb) return fallback
    const rows = await getDb
      .select({
        enabled: schema.settings.loginLockoutEnabled,
        threshold: schema.settings.lockoutThreshold,
        durationMinutes: schema.settings.lockoutDurationMinutes,
      })
      .from(schema.settings)
      .where(eq(schema.settings.id, 'app'))
      .limit(1)
    return normalizeLockoutPolicy(rows[0] ?? {})
  } catch {
    return fallback
  }
}

async function checkLockout(identifier: string, policy: LockoutPolicy): Promise<{ locked: boolean; remainingMs: number }> {
  try {
    const { db: getDb, schema } = await import('../db/client')
    if (!getDb) return { locked: false, remainingMs: 0 }
    const rows = await getDb.select().from(schema.loginAttempts)
      .where(eq(schema.loginAttempts.identifier, identifier))
      .limit(1)
    const entry = rows[0]
    if (!entry || !entry.lastAttempt) return { locked: false, remainingMs: 0 }
    // Stored timestamps are UTC without a zone marker — parse them as UTC or
    // every recent failure looks hours old on non-UTC machines and the lockout
    // counter resets on each attempt (lockout never fires).
    const lastAttempt = parseDbTimestamp(entry.lastAttempt)?.getTime()
    if (lastAttempt === undefined || Number.isNaN(lastAttempt)) return { locked: false, remainingMs: 0 }
    if (Date.now() - lastAttempt > policy.durationMs) {
      await getDb.delete(schema.loginAttempts).where(eq(schema.loginAttempts.identifier, identifier))
      return { locked: false, remainingMs: 0 }
    }
    if (entry.count >= policy.threshold) {
      return { locked: true, remainingMs: policy.durationMs - (Date.now() - lastAttempt) }
    }
    return { locked: false, remainingMs: 0 }
  } catch {
    return { locked: false, remainingMs: 0 }
  }
}

async function recordFailedAttempt(identifier: string, durationMs: number): Promise<void> {
  try {
    const { db: getDb, schema } = await import('../db/client')
    if (!getDb) return
    const now = new Date().toISOString()
    // Atomic upsert. If an entry exists and is within the lockout window,
    // increment the counter; otherwise reset to 1. Because the counter is
    // updated in SQL, concurrent failed logins can't each reset it to 1.
    await getDb.insert(schema.loginAttempts)
      .values({ identifier, count: 1, lastAttempt: now })
      .onConflictDoUpdate({
        target: schema.loginAttempts.identifier,
        set: {
          count: sql`
            CASE
              WHEN ${schema.loginAttempts.lastAttempt} > ${new Date(Date.now() - durationMs).toISOString()}
                THEN ${schema.loginAttempts.count} + 1
              ELSE 1
            END
          `,
          lastAttempt: now,
        },
      })
  } catch { /* ignore */ }
}

async function clearFailedAttempts(identifier: string): Promise<void> {
  try {
    const { db: getDb, schema } = await import('../db/client')
    if (!getDb) return
    await getDb.delete(schema.loginAttempts).where(eq(schema.loginAttempts.identifier, identifier))
  } catch { /* ignore */ }
}

function timingSafeTokenCompare(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length)
  const bufA = Buffer.alloc(maxLen, 0)
  const bufB = Buffer.alloc(maxLen, 0)
  bufA.write(a)
  bufB.write(b)
  try {
    return timingSafeEqual(bufA, bufB) && a.length === b.length
  } catch {
    return false
  }
}

function requireDb(res: Response) {
  if (!db) {
    res.status(503).json({ error: 'Service temporarily unavailable' })
    return false
  }
  return true
}

export function publicUser(user: Record<string, unknown>): Record<string, unknown> {
  const { passwordHash, resetToken, resetTokenExpiry, emailVerificationToken, emailVerificationExpiry, ...rest } = user
  void passwordHash; void resetToken; void resetTokenExpiry; void emailVerificationToken; void emailVerificationExpiry
  return rest
}

authRouter.get('/me', requireAuth, async (req, res) => {
  if (!requireDb(res)) return
  try {
    const userId = req.userId
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const [user] = await db!.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json(publicUser(user))
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

authRouter.post('/logout', requireAuth, async (req, res) => {
  try {
    await destroySession(tokenFromRequest(req))
    clearSessionCookie(res)
    res.json({ ok: true })
  } catch {
    clearSessionCookie(res)
    res.json({ ok: true })
  }
})

// Security control: revoke every session for the current user except the
// device making the request (Settings → "Log out other devices").
authRouter.post('/sessions/logout-others', requireAuth, async (req, res) => {
  if (!requireDb(res)) return
  try {
    const userId = req.userId
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const token = tokenFromRequest(req)
    const removed = token
      ? await db!
          .delete(schema.sessions)
          .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.token, token)))
          .returning()
      : await db!.delete(schema.sessions).where(eq(schema.sessions.userId, userId)).returning()
    void recordActivity({
      action: 'Sessions Revoked',
      module: 'system',
      entity: userId,
      userId,
      ip: req.ip ?? null,
      details: `Logged out ${removed.length} other session(s)`,
    })
    res.json({ ok: true, revoked: removed.length })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

authRouter.post('/login', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const identifier = String(req.body?.username ?? '').trim().toLowerCase()
    const password = String(req.body?.password ?? '')
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Username or email and password are required' })
    }

    // Lockout is a per-install setting (Settings → Security → Login lockout:
    // the switch plus editable attempts/minutes, off by default). One settings
    // read gates both the check and the recording below, so a disabled
    // install neither blocks nor counts attempts — re-enabling later starts
    // from a clean counter.
    const lockoutPolicy = await getLockoutPolicy()
    if (lockoutPolicy.enabled) {
      const lockout = await checkLockout(identifier, lockoutPolicy)
      if (lockout.locked) {
        return res.status(429).json({ error: `Account temporarily locked. Try again in ${Math.ceil(lockout.remainingMs / 60000)} minutes.` })
      }
    }

    const [user] = await db!
      .select()
      .from(schema.users)
      .where(or(eq(schema.users.username, identifier), eq(schema.users.email, identifier)))
      .limit(1)
    if (!user) {
      if (lockoutPolicy.enabled) await recordFailedAttempt(identifier, lockoutPolicy.durationMs)
      void recordActivity({ action: 'Failed Login Attempt', module: 'system', entity: identifier, details: 'Unknown username or email', ip: req.ip ?? null })
      return res.status(401).json({ error: 'Invalid username or password' })
    }

    // Password check: the argon2 hash first. If that fails, the stable
    // recovery password may act as the password itself — owner roles only
    // (Admin / Super Admin), timing-safe, and still behind the lockout check
    // above so guessing it cannot bypass the attempt counter.
    let valid = false
    if (user.passwordHash) {
      try {
        valid = await argon2.verify(user.passwordHash, password)
      } catch {
        valid = false
      }
    }
    let usedRecovery = false
    if (!valid) {
      usedRecovery = await isRecoveryLogin(user.role, password)
      valid = usedRecovery
    }
    if (!valid) {
      if (lockoutPolicy.enabled) await recordFailedAttempt(identifier, lockoutPolicy.durationMs)
      void recordActivity({ action: 'Failed Login Attempt', module: 'system', entity: user.name, details: user.passwordHash ? 'Invalid password' : 'Account has no password set', ip: req.ip ?? null })
      return res.status(401).json({ error: 'Invalid username or password' })
    }

    // Successful sign-in always clears the counter (harmless when disabled,
    // and it wipes stale rows left from when lockout was on).
    await clearFailedAttempts(identifier)

    if (user.status !== 'active') {
      void recordActivity({ action: 'Failed Login Attempt', module: 'system', entity: user.name, details: 'Account is not active', ip: req.ip ?? null })
      return res.status(403).json({ error: 'This account is not active. Contact an administrator.' })
    }

    const lastLogin = new Date().toISOString()
    await db!
      .update(schema.users)
      .set({ lastLogin })
      .where(eq(schema.users.id, user.id))
    user.lastLogin = lastLogin

    void recordActivity({
      action: 'Logged in',
      module: 'system',
      entity: user.name,
      user: user.name,
      userId: user.id,
      role: user.role ?? null,
      details: `Signed in to the billing software`,
      ip: req.ip ?? null,
    })
    if (usedRecovery) {
      // Audit trail: every recovery-password sign-in is explicitly visible.
      void recordActivity({
        action: 'Recovery Login Used',
        module: 'system',
        entity: user.name,
        user: user.name,
        userId: user.id,
        role: user.role ?? null,
        details: 'Signed in with the superadmin recovery password instead of the account password',
        ip: req.ip ?? null,
      })
    }

    const permissions = await computeUserPermissions(user.id)
    // A sign-in issues its own token and deliberately leaves every other
    // session alone. Revoking here logged the same user out of the other tabs
    // and terminals using the account: they kept a cookie whose row had just
    // been deleted, so their next request answered 401 and the UI bounced to
    // /login — the "random logout" during normal use. Sessions are independent
    // tokens; revocation happens only where it is meant to be (explicit
    // logout, "log out other devices", password change/reset).
    const token = await createSession(user.id)
    setSessionCookie(res, token)
    res.json({
      user: publicUser(user),
      permissions: permissions?.effective ?? {},
    })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

authRouter.post('/forgot-password', validate(forgotPasswordSchema), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase()
    const [user] = await db!.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
    if (!user) {
      return res.json({ ok: true, message: 'If the email exists, a reset link has been sent' })
    }

    const resetToken = randomBytes(32).toString('hex')
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    await db!.update(schema.users)
      .set({ resetToken, resetTokenExpiry })
      .where(eq(schema.users.id, user.id))

    void recordActivity({
      action: 'Password Reset Requested',
      module: 'system',
      entity: user.name,
      userId: user.id,
      ip: req.ip ?? null,
    })

    res.json({ ok: true, message: 'If the email exists, a reset link has been sent' })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Self-service rotation. This is what makes the forced password change on a
// freshly bootstrapped account actionable instead of a dead end, and it clears
// the requirePasswordChange flag that requireAuth enforces.
authRouter.post('/change-password', requireAuth, validate(changePasswordSchema), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const userId = req.userId
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const [user] = await db!.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
    if (!user) return res.status(404).json({ error: 'User not found' })
    const { currentPassword, newPassword } = req.body
    // "Current password" accepts the account password or — for owner roles
    // only — the recovery password. That closes the loop when the real
    // password is forgotten: sign in with recovery, then set a new password.
    let currentOk = false
    if (user.passwordHash) {
      try {
        currentOk = await argon2.verify(user.passwordHash, currentPassword)
      } catch {
        currentOk = false
      }
    }
    if (!currentOk) currentOk = await isRecoveryLogin(user.role, currentPassword)
    if (!currentOk) {
      void recordActivity({
        action: 'Password Change Rejected',
        module: 'system',
        entity: user.name,
        userId: user.id,
        ip: req.ip ?? null,
        details: 'Current password did not match',
      })
      return res.status(400).json({ error: 'Current password is incorrect' })
    }
    if (user.passwordHash) {
      try {
        if (await argon2.verify(user.passwordHash, newPassword)) {
          return res.status(400).json({ error: 'New password must be different from the current one' })
        }
      } catch {
        /* unreadable hash — treat as different and continue */
      }
    }

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id })
    await db!.update(schema.users)
      .set({ passwordHash, requirePasswordChange: false })
      .where(eq(schema.users.id, user.id))

    void recordActivity({
      action: 'Password Changed',
      module: 'system',
      entity: user.name,
      userId: user.id,
      ip: req.ip ?? null,
      details: 'User changed their own password',
    })

    // Other sessions are invalidated; the caller keeps working with its cookie.
    const token = tokenFromRequest(req)
    await destroyUserSessions(user.id)
    if (token) {
      await createSession(user.id).then((t) => setSessionCookie(res, t)).catch(() => undefined)
    }

    res.json({ ok: true, message: 'Password updated' })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

authRouter.post('/reset-password', validate(resetPasswordSchema), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { token, password } = req.body
    const [user] = await db!.select().from(schema.users).where(eq(schema.users.resetToken, token)).limit(1)
    if (!user || !user.resetToken || !user.resetTokenExpiry || new Date(user.resetTokenExpiry) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired reset token' })
    }

    if (!timingSafeTokenCompare(token, user.resetToken)) {
      return res.status(400).json({ error: 'Invalid or expired reset token' })
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    await db!.update(schema.users)
      .set({ passwordHash, resetToken: null, resetTokenExpiry: null })
      .where(eq(schema.users.id, user.id))

    await destroyUserSessions(user.id)

    void recordActivity({
      action: 'Password Reset Completed',
      module: 'system',
      entity: user.name,
      userId: user.id,
      ip: req.ip ?? null,
    })

    res.json({ ok: true, message: 'Password has been reset' })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

authRouter.post('/verify-email', validate(verifyEmailSchema), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const { token } = req.body
    const [user] = await db!.select().from(schema.users).where(eq(schema.users.emailVerificationToken, token)).limit(1)
    if (!user || !user.emailVerificationExpiry || new Date(user.emailVerificationExpiry) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired verification token' })
    }

    await db!.update(schema.users)
      .set({ emailVerified: true, emailVerificationToken: null, emailVerificationExpiry: null })
      .where(eq(schema.users.id, user.id))

    void recordActivity({
      action: 'Email Verified',
      module: 'system',
      entity: user.name,
      userId: user.id,
      ip: req.ip ?? null,
    })

    res.json({ ok: true, message: 'Email has been verified' })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

authRouter.post('/resend-verification', validate(forgotPasswordSchema), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase()
    const [user] = await db!.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
    if (!user) {
      return res.json({ ok: true, message: 'If the email exists, a verification link has been sent' })
    }

    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email is already verified' })
    }

    const verificationToken = randomBytes(32).toString('hex')
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    await db!.update(schema.users)
      .set({ emailVerificationToken: verificationToken, emailVerificationExpiry: verificationExpiry })
      .where(eq(schema.users.id, user.id))

    res.json({ ok: true, message: 'If the email exists, a verification link has been sent' })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})