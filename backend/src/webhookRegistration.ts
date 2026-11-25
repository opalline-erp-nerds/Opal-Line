import { config, normalizeShopDomain } from './config'
import { logger } from './logger'

/**
 * Auto-registration of Shopify webhooks. Shopify must be able to reach the
 * backend over the public internet, so PUBLIC_BASE_URL must be set (e.g. an
 * ngrok/Cloudflare tunnel URL or the production domain). Localhost/UNSET is
 * skipped — the desktop app is unreachable from Shopify, and its order feed
 * comes from the background order poll instead (`orderAutoSync.ts`).
 *
 * Topics handled by /api/v1/webhooks/shopify:
 *   orders/create, orders/updated, orders/edited, orders/paid,
 *   orders/cancelled, orders/fulfilled, fulfillments/create, fulfillments/update,
 *   refunds/create, products/update, customers/create
 *
 * There is no `fulfillments/cancelled` topic in Shopify's API; a cancelled
 * fulfillment arrives as `fulfillments/update` and as `orders/updated`.
 *
 * `orders/paid` and `refunds/create` drive loyalty points: a paid order earns,
 * a refund reverses proportionally, a cancellation reverses in full. Both are
 * idempotent, so Shopify retries are harmless.
 */

export const WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/edited',
  'orders/paid',
  'orders/cancelled',
  'orders/fulfilled',
  'fulfillments/create',
  'fulfillments/update',
  'refunds/create',
  'products/update',
  'customers/create',
] as const

interface ShopifyWebhook {
  id: number
  topic: string
  address: string
}

/** Backoff between attempts. A cold Render instance often fails the first call. */
export const WEBHOOK_RETRY_DELAYS_MS = [500, 2000, 5000] as const

/**
 * The public base URL Shopify may call, or null when this instance cannot be
 * reached from the internet (desktop app on localhost, or unconfigured).
 */
export function resolvePublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PUBLIC_BASE_URL?.trim()
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  // Shopify only delivers to public HTTPS endpoints.
  if (parsed.protocol !== 'https:') return null
  // Match the HOSTNAME, not the whole string: a tunnel domain with a path must
  // still work, while any localhost/loopback variant (with or without a path)
  // is correctly skipped on the desktop app.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return null
  return raw.replace(/\/+$/, '') || null
}

/** Shopify's public hostname for the configured store. */
export function shopifyAdminHost(shop: string): string {
  return `${normalizeShopDomain(shop)}.myshopify.com`
}

/** The one-line reason a fetch blew up, with undici's hidden cause restored. */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: { code?: string; message?: string } }).cause
  const detail = cause?.code ?? cause?.message
  return detail ? `${err.message} (${detail})` : err.message
}

export interface WebhookRegistrationDeps {
  /** Test seam: avoids real network calls. */
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  sleep?: (ms: number) => Promise<void>
  shop?: string
  token?: string
  apiVersion?: string
}

export interface WebhookRegistrationReport {
  /** Topics newly created or re-pointed during this call. */
  registered: string[]
  /** Topics already pointing at the current address. */
  unchanged: string[]
  failed: Array<{ topic: string; status: number }>
  /** Set when nothing was attempted, with the reason. */
  skipped: 'not-configured' | 'no-public-base-url' | null
  /** Set when the whole run could not complete (network/API failure). */
  error?: string
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * One Admin API call with retries on transport errors, 429 and 5xx.
 * 4xx answers are Shopify's verdict and are returned immediately.
 */
async function shopifyApi<T>(
  method: string,
  resource: string,
  body: unknown,
  deps: WebhookRegistrationDeps,
): Promise<{ status: number; json: T | null }> {
  const shop = deps.shop ?? config.shop
  const token = deps.token ?? config.accessToken
  const version = deps.apiVersion ?? config.apiVersion
  if (!shop || !token) return { status: 0, json: null }

  const url = `https://${shopifyAdminHost(shop)}/admin/api/${version}/${resource}`
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? sleepMs
  let lastError: unknown = null

  for (let attempt = 0; attempt <= WEBHOOK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const json = (await res.json().catch(() => null)) as T | null
      if (isTransientStatus(res.status) && attempt < WEBHOOK_RETRY_DELAYS_MS.length) {
        lastError = new Error(`Shopify API ${method} ${resource} answered HTTP ${res.status}`)
        await sleep(WEBHOOK_RETRY_DELAYS_MS[attempt])
        continue
      }
      return { status: res.status, json }
    } catch (err) {
      lastError = err
      if (attempt >= WEBHOOK_RETRY_DELAYS_MS.length) break
      logger.debug(
        { attempt: attempt + 1, method, resource, error: describeFetchError(err) },
        'Webhook registration request failed — retrying',
      )
      await sleep(WEBHOOK_RETRY_DELAYS_MS[attempt])
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Webhook request failed'))
}

export interface WebhookHealthEntry {
  topic: string
  status: 'registered' | 'missing' | 'stale'
  address?: string
  id?: number
}

/**
 * Compare Shopify's registered webhooks against the topics we handle.
 * 'stale' = topic registered but pointing at an old URL.
 */
export async function getWebhookHealth(deps: WebhookRegistrationDeps = {}): Promise<{
  publicBaseUrl: string | null
  expectedAddress: string | null
  entries: WebhookHealthEntry[]
  healthy: boolean
}> {
  const base = resolvePublicBaseUrl(deps.env ?? process.env)
  const expectedAddress = base ? `${base}/api/v1/webhooks/shopify` : null
  const entries: WebhookHealthEntry[] = []
  let existing: ShopifyWebhook[] = []
  try {
    const list = await shopifyApi<{ webhooks: ShopifyWebhook[] }>('GET', 'webhooks.json?limit=250', undefined, deps)
    existing = list.json?.webhooks ?? []
  } catch (err) {
    logger.warn({ error: describeFetchError(err) }, 'Webhook health: failed to list webhooks')
  }
  for (const topic of WEBHOOK_TOPICS) {
    const match = existing.find((w) => w.topic === topic)
    if (!match) entries.push({ topic, status: 'missing' })
    else if (expectedAddress && match.address !== expectedAddress) entries.push({ topic, status: 'stale', address: match.address, id: match.id })
    else entries.push({ topic, status: 'registered', address: match.address, id: match.id })
  }
  // Without a public address there is nothing Shopify could be registered to;
  // a row pointing at some old URL must NOT be reported as healthy.
  const healthy = Boolean(expectedAddress) && entries.every((e) => e.status === 'registered')
  return { publicBaseUrl: base, expectedAddress, entries, healthy }
}

/**
 * Idempotently ensure every topic we handle points at our webhook endpoint.
 * Called once at server startup; failures only log — never block boot.
 */
export async function registerShopifyWebhooks(deps: WebhookRegistrationDeps = {}): Promise<WebhookRegistrationReport> {
  const report: WebhookRegistrationReport = { registered: [], unchanged: [], failed: [], skipped: null }
  const shop = deps.shop ?? config.shop
  const token = deps.token ?? config.accessToken

  if (!(shop && token)) {
    report.skipped = 'not-configured'
    logger.debug('Webhook registration skipped — Shopify is not configured')
    return report
  }

  const base = resolvePublicBaseUrl(deps.env ?? process.env)
  if (!base) {
    report.skipped = 'no-public-base-url'
    // Expected on the desktop app: Shopify can never reach localhost. Order
    // polling covers it, so this is information, not a warning.
    logger.info('Shopify webhooks not registered — no public HTTPS base URL on this instance; order auto-sync keeps Sales Orders current')
    return report
  }

  try {
    const address = `${base}/api/v1/webhooks/shopify`
    const list = await shopifyApi<{ webhooks: ShopifyWebhook[] }>('GET', 'webhooks.json?limit=250', undefined, deps)
    const existing = list.json?.webhooks ?? []
    const registered = new Set(existing.filter((w) => w.address === address).map((w) => w.topic))
    report.unchanged = WEBHOOK_TOPICS.filter((t) => registered.has(t))

    for (const topic of WEBHOOK_TOPICS) {
      if (registered.has(topic)) continue
      // Re-point a stale webhook for the same topic instead of piling up duplicates
      const stale = existing.find((w) => w.topic === topic && w.address !== address)
      if (stale) {
        const upd = await shopifyApi('PUT', `webhooks/${stale.id}.json`, { webhook: { address } }, deps)
        if (upd.status === 200 || upd.status === 201) {
          report.registered.push(topic)
          logger.info({ topic, address }, 'Webhook re-pointed to current PUBLIC_BASE_URL')
        } else {
          report.failed.push({ topic, status: upd.status })
          logger.warn({ topic, status: upd.status, body: JSON.stringify(upd.json)?.slice(0, 200) }, 'Webhook re-point failed')
        }
        continue
      }
      const created = await shopifyApi('POST', 'webhooks.json', { webhook: { topic, address, format: 'json' } }, deps)
      if (created.status === 201 || created.status === 200) {
        report.registered.push(topic)
        logger.info({ topic, address }, 'Webhook registered with Shopify')
      } else {
        report.failed.push({ topic, status: created.status })
        logger.warn({ topic, status: created.status, body: JSON.stringify(created.json)?.slice(0, 200) }, 'Webhook registration failed')
      }
    }
  } catch (err) {
    // Transport-level failure (DNS/connect/TLS) after every retry. The cause
    // used to be swallowed — undici hides it behind "fetch failed".
    report.error = describeFetchError(err)
    logger.warn({ error: report.error }, 'Webhook registration error (non-fatal) — order auto-sync still runs')
  }
  return report
}
