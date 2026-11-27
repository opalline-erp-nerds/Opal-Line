import { request } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { clearAuthRateLimitCounters } from './db'

// Keep in sync with playwright.config.ts — dev stack serves the UI on 47195.
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'
export const E2E_USER = process.env.E2E_USER ?? 'admin'
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? 'Opal@2026'

/**
 * Best-effort reset of the Postgres-backed login rate-limit counters
 * (`rate_limit_hits`, key `auth:*` — see docs/CONFIGURATION.md). The counters
 * survive backend restarts by design, so back-to-back suite runs inside the
 * same 15-minute window would otherwise exhaust the per-IP budget and fail
 * global setup with HTTP 429 (the manual documented reset is
 * `DELETE FROM rate_limit_hits`).
 *
 * Never throws: if the database is not reachable from this environment, the
 * login below still reports a clear 429/401 error when something is wrong.
 */
async function clearAuthRateLimit(): Promise<void> {
  const result = await clearAuthRateLimitCounters()
  if (result.ok) {
    console.log(`[global-setup] cleared ${result.cleared} login rate-limit counter(s) from ${result.target}`)
  } else {
    console.warn(`[global-setup] rate-limit reset skipped: ${result.error}`)
  }
}

/**
 * Logs in once and stores the session cookies for every test. The backend
 * rate-limits /auth/login (30 req / 15 min / IP), so tests must NEVER log in
 * individually — reuse this state instead.
 */
export default async function globalSetup(): Promise<void> {
  await clearAuthRateLimit()
  const ctx = await request.newContext({ baseURL: BASE_URL })
  try {
    const res = await ctx.post('/api/v1/auth/login', { data: { username: E2E_USER, password: E2E_PASSWORD } })
    if (res.status() === 429) {
      throw new Error(
        `E2E login was rate-limited (HTTP 429). Wait 15 minutes for the auth rate limit to reset, then re-run.`,
      )
    }
    if (!res.ok()) {
      throw new Error(
        `E2E login failed (HTTP ${res.status()}). Is the installed app running on ${BASE_URL}? ` +
          `Credentials can be overridden with E2E_USER / E2E_PASSWORD.`,
      )
    }
    mkdirSync('e2e/.auth', { recursive: true })
    await ctx.storageState({ path: 'e2e/.auth/state.json' })
  } finally {
    await ctx.dispose()
  }
}
