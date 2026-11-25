import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { logger } from './logger'
import { decryptSecret } from './lib/crypto'

export function normalizeShopDomain(value: string): string {
  let v = value.trim().toLowerCase()
  v = v.replace(/^https?:\/\//, '')
  v = v.replace(/^www\./, '')
  v = v.replace(/\.myshopify\.com.*$/, '')
  v = v.replace(/\/+$/, '')
  return v
}

// Credentials end up in HTTP header values, which must be Latin-1 safe. A
// value containing • or U+FFFD means a masked/mangled form value was saved by
// mistake — treat it as unset so the app reports “not configured” instead of
// crashing every request with an obscure ByteString header error.
export function asCredential(v: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matches the Latin-1 range to reject unmaskable header values
  return /^[\x00-\xFF]*$/.test(v) ? v : ''
}

export const config = {
  shop: asCredential(normalizeShopDomain(decryptSecret(process.env.SHOPIFY_STORE_URL ?? ''))),
  accessToken: asCredential(decryptSecret((process.env.SHOPIFY_ACCESS_TOKEN ?? '').trim())),
  apiVersion: (process.env.SHOPIFY_API_VERSION ?? '2025-10').trim(),
  // 47191 belongs to Opal Line's dedicated port block (47191-47198) so the
  // software never collides with other apps' default ports on end-user PCs.
  port: Number(process.env.PORT ?? 47191),
  // Bind to loopback by default. The desktop app only ever loads the UI from
  // http://localhost:<port>, so listening on every interface just exposed the
  // whole authenticated API (including /auth/login) to the local network.
  // Container deployments that publish the port must opt in with HOST=0.0.0.0.
  host: (process.env.HOST ?? '127.0.0.1').trim() || '127.0.0.1',
}

const envShop = config.shop
const envAccessToken = config.accessToken

export const isConfigured = () => Boolean(config.shop && config.accessToken)

export async function loadSecretsFromDb() {
  try {
    const { db, reconnect } = await import('./db/client')
    const { decrypt } = await import('./lib/crypto')
    const schema = await import('./db/schema')

    if (db) {
      const rows = await db.select().from(schema.settings).where(eq(schema.settings.id, 'app')).limit(1)
      const row = rows[0]
      if (row) {
        if (row.shopifyStoreUrlEncrypted) {
          try {
            const decrypted = decrypt(row.shopifyStoreUrlEncrypted)
            if (decrypted) config.shop = normalizeShopDomain(decrypted)
          } catch { /* keep env value */ }
        }
        if (row.shopifyAccessTokenEncrypted) {
          try {
            const decrypted = decrypt(row.shopifyAccessTokenEncrypted)
            if (decrypted) config.accessToken = decrypted
          } catch { /* keep env value */ }
        }
        if (row.shopifyApiVersion) {
          config.apiVersion = row.shopifyApiVersion
        }
        // Webhook HMAC middleware reads process.env directly (and Shopify's
        // secret is NOT part of `config`). Connections saves it encrypted in
        // this row and also to .env, but on Render .env is read-only: without
        // this assignment a UI-saved secret never reaches the verifier and
        // every webhook is rejected until a manual env-var change + restart.
        if (row.webhookSecretEncrypted) {
          try {
            const secret = decrypt(row.webhookSecretEncrypted)
            if (secret) process.env.SHOPIFY_WEBHOOK_SECRET = secret
          } catch { /* keep the env value */ }
        }

        if (row.dbHostEncrypted && row.dbPasswordEncrypted && row.dbUserEncrypted) {
          try {
            const host = decrypt(row.dbHostEncrypted)
            const port = row.dbPortEncrypted ? decrypt(row.dbPortEncrypted) : '5432'
            const database = row.dbDatabaseEncrypted ? decrypt(row.dbDatabaseEncrypted) : 'opal_line'
            const user = decrypt(row.dbUserEncrypted)
            const password = decrypt(row.dbPasswordEncrypted)
            const storedUrl = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`
            if (storedUrl !== process.env.DATABASE_URL) {
              const result = await reconnect(storedUrl)
              if (result.ok) {
                logger.info('Database reconnected using stored credentials')
              } else {
                logger.warn({ error: result.error }, 'Stored DB credentials failed, keeping .env connection')
              }
            }
          } catch {
            logger.debug('Could not decrypt stored DB credentials')
          }
        }
      }

      if (!config.shop || !config.accessToken) {
        if (envShop && envAccessToken) {
          config.shop = envShop
          config.accessToken = envAccessToken
        }
      }

      if (config.shop && config.accessToken) {
        logger.info({ source: config.shop === envShop ? 'environment' : 'database' }, 'Shopify configuration loaded')
      } else {
        logger.warn('Shopify not configured — set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in .env or via Settings')
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load secrets from database, using .env values')
  }
}
