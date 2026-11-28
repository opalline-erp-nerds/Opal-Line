import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'

/**
 * Database access for e2e setup and cleanup only.
 *
 * The backend keeps its login counters in Postgres — `rate_limit_hits` per IP
 * (30 attempts / 15 min) and `login_attempts` per account (the editable
 * lockout) — precisely so a restart cannot reset them. Tests therefore have to
 * clear them between runs, which means connecting to the same database the
 * backend under test uses.
 *
 * That is the catch: the dev stack's cluster is on 47194 (`backend/.env`)
 * while the installed desktop app's is on 47193. Hardcoding 47193 made every
 * reset silently skip on the dev stack (`ECONNREFUSED 127.0.0.1:47193`), so
 * counters and lockout rows leaked from run to run.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:47195'

/** README §ports: 47192 = installed app API, 47195 = dev UI. */
const INSTALLED_APP_PORT = '47192'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export interface DatabaseUrlSources {
  /** The stack the suite targets (E2E_BASE_URL). */
  baseUrl: string
  /** Explicit DATABASE_URL from the environment — always authoritative. */
  envUrl?: string
  /** DATABASE_URL from the repo's `backend/.env` (dev stack only). */
  envFileUrl?: string
  /** Installed desktop app's bundled cluster (port 47193), when discoverable. */
  desktopUrl?: string
}

/**
 * Order the candidate database URLs for the stack under test.
 *
 * - An explicit `DATABASE_URL` always wins: whoever set it named the database
 *   the backend runs against.
 * - Local dev (the default) may fall back to `backend/.env` and then the
 *   desktop app's cluster.
 * - A run against the installed app (47192) must never touch the dev cluster,
 *   so `backend/.env` is not used there.
 * - A remote `E2E_BASE_URL` only ever uses an explicit `DATABASE_URL`; falling
 *   back to a local cluster would clear a different install's counters.
 */
export function buildDatabaseUrlCandidates(sources: DatabaseUrlSources): string[] {
  const envUrl = sources.envUrl?.trim() ?? ''
  const envFileUrl = sources.envFileUrl?.trim() ?? ''
  const desktopUrl = sources.desktopUrl?.trim() ?? ''

  let local = false
  let installedApp = false
  try {
    const target = new URL(sources.baseUrl)
    local = LOCAL_HOSTS.has(target.hostname)
    installedApp = local && target.port === INSTALLED_APP_PORT
  } catch {
    // Unparseable base URL: trust only an explicit DATABASE_URL.
  }

  if (!local) return unique([envUrl])
  if (installedApp) return unique([envUrl, desktopUrl])
  return unique([envUrl, envFileUrl, desktopUrl])
}

/** `host:port/database` — safe to log, never includes credentials. */
export function describeDatabaseTarget(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`
  } catch {
    return '(unparseable database URL)'
  }
}

export interface CounterResetResult {
  ok: boolean
  /** `host:port/database` that was cleared (absent on failure). */
  target?: string
  /** Rows deleted. */
  cleared?: number
  /** Why every candidate failed (absent on success). */
  error?: string
}

/** Read just the DATABASE_URL line; the file also holds secrets we never touch. */
function databaseUrlFromEnvFile(path: string): string {
  try {
    if (!existsSync(path)) return ''
    const line = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .find((candidate) => /^\s*DATABASE_URL\s*=/.test(candidate))
    if (!line) return ''
    return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')
  } catch {
    return ''
  }
}

/** Installed desktop app: bundled PostgreSQL on 47193, password beside its data. */
function desktopAppDatabaseUrl(): string {
  const appData = process.env.APPDATA
  if (!appData) return ''
  const passwordFile = join(appData, 'Opal Line Billing', '.pg-password')
  try {
    if (!existsSync(passwordFile)) return ''
    const password = readFileSync(passwordFile, 'utf8').trim()
    if (!password) return ''
    return `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:47193/opal_line`
  } catch {
    return ''
  }
}

export function databaseUrlCandidates(): string[] {
  return buildDatabaseUrlCandidates({
    baseUrl: BASE_URL,
    envUrl: process.env.DATABASE_URL,
    envFileUrl: databaseUrlFromEnvFile(join(process.cwd(), 'backend', '.env')),
    desktopUrl: desktopAppDatabaseUrl(),
  })
}

function unique(urls: string[]): string[] {
  return [...new Set(urls.filter((url) => url.length > 0))]
}

async function clearOnTestDatabase(
  run: (sql: postgres.Sql) => Promise<number>,
): Promise<CounterResetResult> {
  const candidates = databaseUrlCandidates()
  if (candidates.length === 0) {
    return {
      ok: false,
      error: 'no database URL available (set DATABASE_URL, or run against the local dev stack)',
    }
  }

  const failures: string[] = []
  for (const url of candidates) {
    const target = describeDatabaseTarget(url)
    let sql: postgres.Sql | undefined
    try {
      sql = postgres(url, { max: 1, connect_timeout: 5 })
      return { ok: true, target, cleared: await run(sql) }
    } catch (err) {
      failures.push(`${target}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await sql?.end({ timeout: 5 }).catch(() => undefined)
    }
  }
  return { ok: false, error: failures.join('; ') }
}

/**
 * Drop the per-IP login budget so a suite run starts with the full 30
 * attempts. Production keeps the same limit — this only removes counters that
 * earlier local runs (or the global setup login) already spent.
 */
export function clearAuthRateLimitCounters(): Promise<CounterResetResult> {
  return clearOnTestDatabase(async (sql) => {
    const rows = await sql`DELETE FROM rate_limit_hits WHERE key LIKE 'auth:%'`
    return rows.count
  })
}

/** Remove an account's lockout counter (`login_attempts` row). */
export function clearLoginAttempts(identifier: string): Promise<CounterResetResult> {
  return clearOnTestDatabase(async (sql) => {
    const rows = await sql`DELETE FROM login_attempts WHERE identifier = ${identifier}`
    return rows.count
  })
}
