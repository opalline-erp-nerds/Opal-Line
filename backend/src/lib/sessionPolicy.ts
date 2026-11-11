import { CONSTANTS } from '../constants'

/**
 * Session lifetime rules, kept as a pure function so the sliding-window
 * behaviour is testable without a database.
 *
 * A session has two limits:
 *  - an inactivity window (`idleTtlMs`): each authenticated request moves the
 *    expiry to `now + idleTtlMs`;
 *  - an absolute cap (`absoluteTtlMs`) measured from `createdAt`: activity can
 *    never extend a session beyond it.
 *
 * Before this split, `expiresAt` was written once at login and never touched
 * again, so a user who worked all day was still signed out exactly 24h after
 * signing in.
 */
export interface SessionPolicy {
  idleTtlMs: number
  absoluteTtlMs: number
  /** Refresh only when less than this much lifetime remains. */
  refreshThresholdMs: number
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleTtlMs: CONSTANTS.SESSION_TTL_MS,
  absoluteTtlMs: CONSTANTS.SESSION_ABSOLUTE_TTL_MS,
  refreshThresholdMs: CONSTANTS.SESSION_REFRESH_THRESHOLD_MS,
}

export interface SessionEvaluation {
  /** Whether the session is still usable at `nowMs`. */
  valid: boolean
  /** Effective expiry after applying the absolute cap. */
  expiresAt: number
  /** New expiry to persist, or null when the row does not need a write. */
  extendTo: number | null
}

/**
 * Decide what to do with a session on a single request.
 *
 * `createdAtMs` and `expiresAtMs` come from the stored row. The result never
 * shortens a session: concurrent requests carrying the same token can only
 * move `expiresAt` forward, so no token rotation or locking is required.
 */
export function evaluateSession(
  createdAtMs: number,
  expiresAtMs: number,
  nowMs: number,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): SessionEvaluation {
  const absoluteDeadline = createdAtMs + policy.absoluteTtlMs
  const effectiveExpiresAt = Math.min(expiresAtMs, absoluteDeadline)

  if (!Number.isFinite(effectiveExpiresAt) || nowMs >= effectiveExpiresAt) {
    return { valid: false, expiresAt: effectiveExpiresAt, extendTo: null }
  }

  const remainingMs = effectiveExpiresAt - nowMs
  if (remainingMs > policy.refreshThresholdMs) {
    return { valid: true, expiresAt: effectiveExpiresAt, extendTo: null }
  }

  const extended = Math.min(nowMs + policy.idleTtlMs, absoluteDeadline)
  if (extended <= effectiveExpiresAt) {
    return { valid: true, expiresAt: effectiveExpiresAt, extendTo: null }
  }

  return { valid: true, expiresAt: extended, extendTo: extended }
}
