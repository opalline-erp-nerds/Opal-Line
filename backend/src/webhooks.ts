import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { eq } from 'drizzle-orm'
import type { Request, Response, NextFunction } from 'express'
import { logger } from './logger'
import { decrypt, decryptSecret } from './lib/crypto'
import { getRawClient } from './db/client'

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer
      shopifyWebhook?: {
        topic?: string
        shopDomain?: string
        webhookId?: string
      }
    }
  }
}

/**
 * Both Shopify webhook routes must hash the exact bytes Shopify signed. The
 * parser's `verify` callback sees the buffer before JSON parsing rewrites it,
 * so it is shared here instead of being duplicated per route.
 */
export const WEBHOOK_BODY_PATHS = new Set([
  '/api/v1/webhooks/shopify',
  '/api/v1/shopify/flow-webhook',
])

export function captureWebhookRawBody(
  req: IncomingMessage & { path?: string; rawBody?: Buffer },
  _res: unknown,
  buf: Buffer,
): void {
  if (req.path && WEBHOOK_BODY_PATHS.has(req.path)) {
    // Copy the buffer: body-parser may reuse its scratch buffer after verify.
    req.rawBody = Buffer.from(buf)
  }
}

/**
 * Shared secret resolution for every Shopify webhook route.
 *
 * `loadSecretsFromDb()` copies a UI-saved secret from settings into
 * `process.env.SHOPIFY_WEBHOOK_SECRET` at startup, so the env value (possibly
 * `encV1:`-encrypted) is the normal path. The DB read below is a fallback for
 * deliveries that arrive before that startup step finishes.
 */
export async function resolveWebhookSecret(): Promise<string | null> {
  const fromEnv = decryptSecret(process.env.SHOPIFY_WEBHOOK_SECRET)
  if (fromEnv) return fromEnv

  try {
    const { db, schema } = await import('./db/client')
    if (!db) return null
    const rows = await db
      .select({ secret: schema.settings.webhookSecretEncrypted })
      .from(schema.settings)
      .where(eq(schema.settings.id, 'app'))
      .limit(1)
    const encrypted = rows[0]?.secret
    return encrypted ? decrypt(encrypted) || null : null
  } catch {
    // A DB outage must not turn into an unauthenticated pass-through.
    return null
  }
}

export async function verifyShopifyWebhook(
  req: Request,
  res: Response,
  next: NextFunction,
  resolveSecret: () => Promise<string | null> = resolveWebhookSecret,
): Promise<void> {
  const secret = await resolveSecret()
  if (!secret) {
    res.status(503).json({ error: 'Webhook secret not configured' })
    return
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256']
  if (!hmacHeader || typeof hmacHeader !== 'string') {
    res.status(401).json({ error: 'Missing HMAC header' })
    return
  }

  const rawBody = req.rawBody
  if (!rawBody) {
    res.status(400).json({ error: 'Missing request body' })
    return
  }

  // Hash the captured bytes directly — converting to a string and back can
  // alter non-UTF-8 bytes and breaks signatures on non-canonical payloads.
  const generatedHmac = createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64')

  let providedHmac: Buffer
  try {
    providedHmac = Buffer.from(hmacHeader, 'base64')
  } catch {
    res.status(400).json({ error: 'Invalid HMAC encoding' })
    return
  }

  // Compare raw digests (bytes), not the base64 strings — a string/Buffer
  // length mix-up here rejects every genuine webhook with 401.
  const generatedBuf = Buffer.from(generatedHmac, 'base64')
  if (providedHmac.length !== generatedBuf.length || !timingSafeEqual(providedHmac, generatedBuf)) {
    res.status(401).json({ error: 'Invalid HMAC signature' })
    return
  }

  const topic = req.headers['x-shopify-topic']
  const shopDomain = req.headers['x-shopify-shop-domain']
  const webhookId = req.headers['x-shopify-webhook-id']

  req.shopifyWebhook = {
    topic: typeof topic === 'string' ? topic : undefined,
    shopDomain: typeof shopDomain === 'string' ? shopDomain : undefined,
    webhookId: typeof webhookId === 'string' ? webhookId : undefined,
  }

  next()
}

// ── Replay / duplicate protection ─────────────────────────────────────────
// HMAC only proves authenticity, not freshness: a captured (validly signed)
// delivery can be re-posted indefinitely, and Shopify itself retries failed
// deliveries. Deliveries are deduped by X-Shopify-Webhook-Id for 3 days —
// first delivery processes, everything after returns 200 without acting.
// Seen-ids live in the DB (survives restarts) with an in-memory fallback for
// DB outages.
export const REPLAY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const seenWebhookIds = new Map<string, number>()
const SEEN_ID_CACHE_LIMIT = 5000

export function isWebhookIdSeen(webhookId: string, nowMs = Date.now()): boolean {
  const seenAt = seenWebhookIds.get(webhookId)
  if (seenAt === undefined) return false
  if (nowMs - seenAt >= REPLAY_WINDOW_MS) {
    seenWebhookIds.delete(webhookId)
    return false
  }
  return true
}

export function rememberWebhookId(webhookId: string, nowMs = Date.now()): void {
  // Bounded cache: drop the oldest entry when full.
  if (seenWebhookIds.size >= SEEN_ID_CACHE_LIMIT) {
    const oldest = seenWebhookIds.keys().next().value
    if (oldest !== undefined) seenWebhookIds.delete(oldest)
  }
  seenWebhookIds.set(webhookId, nowMs)
}

export function resetWebhookDedupe(): void {
  seenWebhookIds.clear()
}

/** Forget a delivery id (memory only) — used when processing failed. */
export function forgetWebhookId(webhookId: string): void {
  seenWebhookIds.delete(webhookId)
}

/**
 * Release a claimed delivery id after a processing failure.
 *
 * A delivery is claimed BEFORE its handler runs (that is what makes two
 * simultaneous copies of the same delivery safe), but Shopify retries a
 * delivery it believes failed. Without releasing the claim, the retry would be
 * answered as a duplicate and the refund would never be recorded. Releasing
 * makes the retry a first delivery again.
 */
export async function releaseWebhookId(webhookId: string): Promise<void> {
  forgetWebhookId(webhookId)
  const client = getRawClient()
  if (!client) return
  try {
    await client`DELETE FROM webhook_deliveries WHERE webhook_id = ${webhookId}`
  } catch (err) {
    // Worst case the retry is skipped until the 3-day window expires; the
    // refund can still be recovered with the Refunds tab's Sync action.
    logger.warn({ err, webhookId }, 'Could not release a failed webhook delivery id')
  }
}

export async function markWebhookIdSeenDb(webhookId: string): Promise<boolean> {
  const client = getRawClient()
  if (!client) {
    // No DB: fall back to memory-only tracking.
    if (isWebhookIdSeen(webhookId)) return false
    rememberWebhookId(webhookId)
    return true
  }
  try {
    // Cleanup + insert atomically: delete expired rows, then claim this id.
    await client`DELETE FROM webhook_deliveries WHERE seen_at < now() - ${`${REPLAY_WINDOW_MS} milliseconds`}::interval`
    const inserted = await client`
      INSERT INTO webhook_deliveries (webhook_id, seen_at)
      VALUES (${webhookId}, now())
      ON CONFLICT (webhook_id) DO NOTHING
      RETURNING webhook_id
    `
    rememberWebhookId(webhookId)
    return inserted.length > 0
  } catch {
    // Table may not exist yet (pre-bootstrap) — degrade to memory tracking.
    if (isWebhookIdSeen(webhookId)) return false
    rememberWebhookId(webhookId)
    return true
  }
}

/** Middleware: reject replayed webhook deliveries with a 200 no-op. */
export function rejectReplayedWebhook(req: Request, res: Response, next: NextFunction): void {
  const webhookId = typeof req.headers['x-shopify-webhook-id'] === 'string' ? req.headers['x-shopify-webhook-id'] : undefined
  if (!webhookId) {
    // No id header: nothing to dedupe on (older deliveries); let it through.
    next()
    return
  }
  void (async () => {
    const firstDelivery = await markWebhookIdSeenDb(webhookId)
    if (!firstDelivery) {
      logger.warn({ webhookId }, 'Duplicate webhook delivery ignored (replay or Shopify retry)')
      res.json({ ok: true, duplicate: true })
      return
    }
    next()
  })()
}