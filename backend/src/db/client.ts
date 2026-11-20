import 'dotenv/config'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { logger } from '../logger'

let client: ReturnType<typeof postgres> | null = null
let _db: PostgresJsDatabase<typeof schema> | null = null

function createClient(url: string) {
  return postgres(url, {
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 30,
    onnotice: (notice) => logger.debug({ notice }, 'PostgreSQL notice'),
    transform: { undefined: null },
  })
}

const initialUrl = process.env.DATABASE_URL
if (initialUrl) {
  client = createClient(initialUrl)
  _db = drizzle(client, { schema, logger: { logQuery: (query, params) => logger.debug({ query, params }, 'SQL Query') } })
  logger.info('Database client initialized')
} else {
  logger.warn('DATABASE_URL is not set. DB endpoints will return 503 until configured.')
}

export { _db as db }
export { schema }
export function getRawClient() {
  return client
}

export function getDbUrl(): string | null {
  return process.env.DATABASE_URL ?? null
}

export function isDbConnected(): boolean {
  return _db !== null
}

export async function reconnect(newUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const testClient = createClient(newUrl)
    await testClient`SELECT 1`
    if (client) {
      try { await client.end({ timeout: 5 }) } catch { /* ignore */ }
    }
    client = testClient
    _db = drizzle(client, { schema, logger: { logQuery: (query, params) => logger.debug({ query, params }, 'SQL Query') } })
    process.env.DATABASE_URL = newUrl
    logger.info({ url: newUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@') }, 'Database reconnected')
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err: message }, 'Database reconnection failed')
    return { ok: false, error: message }
  }
}

export async function checkDbHealth(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
  if (!client) {
    return { healthy: false, error: 'Database client not initialized' }
  }
  try {
    const start = Date.now()
    await client`SELECT 1`
    const latencyMs = Date.now() - start
    return { healthy: true, latencyMs }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err: message }, 'Database health check failed')
    return { healthy: false, error: message }
  }
}

export async function getDbStats(): Promise<{ totalConnections: number; idleConnections: number; waitingCount: number } | null> {
  if (!client) return null
  try {
    const result = await client`
      SELECT
        count(*) as total_connections,
        count(*) FILTER (WHERE state = 'idle') as idle_connections,
        count(*) FILTER (WHERE state = 'active') as active_connections
      FROM pg_stat_activity
      WHERE datname = current_database()
    `
    return {
      totalConnections: Number(result[0]?.total_connections ?? 0),
      idleConnections: Number(result[0]?.idle_connections ?? 0),
      waitingCount: Number(result[0]?.active_connections ?? 0),
    }
  } catch {
    return null
  }
}
