import { decryptSecret } from './lib/crypto'
import { logger } from './logger'

/**
 * Auto-registration of Shopify webhooks. Shopify must be able to reach the
 * backend over the public internet, so PUBLIC_BASE_URL must be set (e.g. an
 * ngrok/Cloudflare tunnel URL or the production domain). Localhost/UNSET is
 * skipped silently — webhooks keep working when registered manually.
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

const WEBHOOK_TOPICS = [
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

function publicBaseUrl(): string | null {
  const raw = process.env.PUBLIC_BASE_URL?.trim()
  if (!raw) return null
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(raw)) return null
  return raw.replace(/\/+$/, '')
}

async function shopifyApi<T>(method: string, resource: string, body?: unknown): Promise<{ status: number; json: T | null }> {
  const shop = decryptSecret(process.env.SHOPIFY_STORE_URL ?? '')
  const token = decryptSecret(process.env.SHOPIFY_ACCESS_TOKEN ?? '')
  const version = process.env.SHOPIFY_API_VERSION ?? '2025-10'
  if (!shop || !token) return { status: 0, json: null }
  const res = await fetch(`https://${shop}.myshopify.com/admin/api/${version}/${resource}`, {
    method,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
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
export async function getWebhookHealth(): Promise<{
  publicBaseUrl: string | null
  expectedAddress: string | null
  entries: WebhookHealthEntry[]
  healthy: boolean
}> {
  const base = publicBaseUrl()
  const expectedAddress = base ? `${base}/api/v1/webhooks/shopify` : null
  const entries: WebhookHealthEntry[] = []
  let existing: ShopifyWebhook[] = []
  try {
    const list = await shopifyApi<{ webhooks: ShopifyWebhook[] }>('GET', 'webhooks.json?limit=250')
    existing = list.json?.webhooks ?? []
  } catch (err) {
    logger.warn({ err }, 'Webhook health: failed to list webhooks')
  }
  for (const topic of WEBHOOK_TOPICS) {
    const match = existing.find((w) => w.topic === topic)
    if (!match) entries.push({ topic, status: 'missing' })
    else if (expectedAddress && match.address !== expectedAddress) entries.push({ topic, status: 'stale', address: match.address, id: match.id })
    else entries.push({ topic, status: 'registered', address: match.address, id: match.id })
  }
  const healthy = entries.every((e) => e.status === 'registered')
  return { publicBaseUrl: base, expectedAddress, entries, healthy }
}

/**
 * Idempotently ensure every topic we handle points at our webhook endpoint.
 * Called once at server startup; failures only log — never block boot.
 */
export async function registerShopifyWebhooks(): Promise<void> {
  try {
    const base = publicBaseUrl()
    if (!base) {
      logger.debug('Webhook registration skipped — PUBLIC_BASE_URL not set (or is localhost)')
      return
    }
    const address = `${base}/api/v1/webhooks/shopify`
    const list = await shopifyApi<{ webhooks: ShopifyWebhook[] }>('GET', 'webhooks.json?limit=250')
    const existing = list.json?.webhooks ?? []
    const registered = new Set(existing.filter((w) => w.address === address).map((w) => w.topic))

    for (const topic of WEBHOOK_TOPICS) {
      if (registered.has(topic)) continue
      // Re-point a stale webhook for the same topic instead of piling up duplicates
      const stale = existing.find((w) => w.topic === topic && w.address !== address)
      if (stale) {
        const upd = await shopifyApi('PUT', `webhooks/${stale.id}.json`, { webhook: { address } })
        logger.info({ topic, status: upd.status }, 'Webhook re-pointed to current PUBLIC_BASE_URL')
        continue
      }
      const created = await shopifyApi('POST', 'webhooks.json', {
        webhook: { topic, address, format: 'json' },
      })
      if (created.status === 201 || created.status === 200) {
        logger.info({ topic, address }, 'Webhook registered with Shopify')
      } else {
        logger.warn({ topic, status: created.status, body: JSON.stringify(created.json)?.slice(0, 200) }, 'Webhook registration failed')
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Webhook registration error (non-fatal)')
  }
}
