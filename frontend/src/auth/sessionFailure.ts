import { ApiError } from '@/lib/api/core'

/**
 * A 401 is the only response that proves the session is gone. Network failures
 * and 5xx/503 responses (Render cold starts, a brief database outage) happen
 * while the session cookie is still perfectly valid, so they must not clear
 * the signed-in user or bounce an active dashboard to /login.
 */
export function isConfirmedSessionLoss(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401
}
