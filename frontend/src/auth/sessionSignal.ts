/**
 * "The server says our session is gone" signal, shared by the API client and
 * the auth provider.
 *
 * A 401 is the only response that proves a session is invalid, but it can
 * still belong to the past: a request that was already in flight when the user
 * signed in again carries the previous cookie, and its 401 must not tear down
 * the new session. Every session gets an epoch; a request remembers the epoch
 * it started in, and its 401 is ignored if the epoch has moved on since.
 *
 * The signal also coalesces bursts. A page normally fires several requests at
 * once, and once the session is really gone they all fail together.
 */
type SessionLostListener = () => void

const listeners = new Set<SessionLostListener>()
const BURST_WINDOW_MS = 1500

let epoch = 0
let lastNotifiedAt = 0

/** Record that the browser holds a verified session (login or a successful probe). */
export function markSessionEstablished(): void {
  epoch++
  // A burst belongs to the session that produced it; a new session starts with
  // a clean slate so a genuine immediate 401 is still reported.
  lastNotifiedAt = 0
}

/** Record that the session was cleared on purpose (confirmed loss or logout). */
export function markSessionCleared(): void {
  epoch++
  lastNotifiedAt = 0
}

/** The epoch a request must capture before it starts. */
export function sessionEpoch(): number {
  return epoch
}

export function onSessionLost(listener: SessionLostListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Report a 401 for a request that started in `requestEpoch`.
 *
 * Returns true when the loss was accepted and listeners were notified; false
 * for a stale request or a repeat inside the burst window. Callers use the
 * result to skip redundant per-request cleanup.
 */
export function notifyUnauthorized(requestEpoch: number, now = Date.now()): boolean {
  if (requestEpoch !== epoch) return false
  if (lastNotifiedAt !== 0 && now - lastNotifiedAt < BURST_WINDOW_MS) return false
  lastNotifiedAt = now
  for (const listener of [...listeners]) listener()
  return true
}
