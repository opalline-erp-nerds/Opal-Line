import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { config, isConfigured, loadSecretsFromDb } from './config'
import { decryptSecret } from './lib/crypto'
import {
  getOrderAutoSyncStatus,
  getOrderSyncIntervalSeconds,
  parseOrderSyncIntervalSeconds,
  startOrderAutoSync,
  stopOrderAutoSync,
} from './orderAutoSync'
import { applyPriceSync, applySilverRate, createShopifyDraftOrder, DraftOrderAddressInput, DraftOrderResult, draftOrderInputLines, ensureSynced, getLatestSilverRate, getSilverRateProgress, importShopifyOrders, isDefaultVariantRow, purgeProducts, pushInventoryToShopify, pushProductPriceToShopify, pushProductsToShopify, resolveShopifyVariantTargets, runSync, store, syncProductsToDb, testShopifyConnection, updateShopifyOrder } from './shopify'
import { buildPricedOrder, fixedPieceRateFor, ORDER_GST_RATE, type OrderCatalogueRow, type ValidatedOrderItem } from './orderPricing'
import type { SyncResource } from './types'
import { db, schema, checkDbHealth, getDbStats } from './db/client'
import { deductOrderLineStock, resolveMovementLocation, restoreOrderLineStock } from './stock'
import { authRouter } from './routes/auth'
import { dbRouter } from './routes/db'
import { dashboardRouter } from './routes/dashboard'
import { rbacRouter } from './routes/rbac'
import { backupRouter } from './routes/backup'
import { printTemplatesRouter } from './routes/printTemplates'
import { computeUserPermissions, enforceRbac, requirePermission } from './rbac'
import { csrfCookieOptions, requireAuth, shutdownSessions } from './sessions'
import { systemRouter } from './routes/systemStatus'
import { reportsRouter } from './routes/reports'
import { actorFromRequest, recordActivity } from './activity'
import { validate, createOrderSchema, updateOrderSchema, silverRateSchema, pushProductsSchema, pushInventorySchema, productPriceSchema, syncSchema } from './validation'
import { logger } from './logger'
import { CONSTANTS } from './constants'
import { applyTrustProxy } from './proxyTrust'
import { PgRateLimitStore, pruneExpiredRateLimits } from './pgRateLimitStore'
import { verifyShopifyWebhook, rejectReplayedWebhook, releaseWebhookId } from './webhooks'
import { recountCustomerStats } from './customerStats'
import { startAutoBackup, startDailySummary } from './autoBackup'
import { startOrderEmailIngest, stopOrderEmailIngest, pollOrderMailbox, isEmailIngestConfigured } from './orderEmailIngest'
import { startShopifyOutboundWorker, stopShopifyOutboundWorker, queueCatalogOutbound, flushOutboundShopifyJobs, type OutboundKind } from './shopifyOutbound'
import { isPiiAccessDenied, missingPiiCustomerCount, normalizeShopifyCustomerId } from './shopifyDataEnhance'
import { applyRateSchedule, fetchSilverRateNow, getSchedulerStatus, setAutoRateEnabled, startSilverRateScheduler } from './silverRateScheduler'
import {
  addScheduledRateChange,
  getScheduledRateChanges,
  removeScheduledRateChange,
  startScheduledRateApplier,
  updateScheduledRateChange,
} from './scheduledRateApplier'
import { ensureUploadsDir, UPLOADS_DIR, uploadImageHandler } from './uploads'
import { mountFrontend, resolveFrontendDist } from './frontendStatic'
import { HostedConfigError, isPublicHost, publicHostStartupError } from './hostedMode'
import { routeParam } from './lib/routeParams'
import { dbErrorInfo, describeDbError } from './lib/dbErrors'

const app = express()

// Don't advertise the framework in response headers.
app.disable('x-powered-by')
// Only trust X-Forwarded-* when explicitly deployed behind a reverse proxy.
// Trusting by default lets direct clients spoof X-Forwarded-For to rotate
// rate-limit keys (req.ip) and bypass login throttling.
applyTrustProxy(app, process.env)

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:47195'

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Allowlist: only Shopify's product CDN needs to load remotely.
      imgSrc: ["'self'", 'data:', 'https://cdn.shopify.com'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  xssFilter: true,
  frameguard: { action: 'deny' },
}))

app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
}))

app.use(cookieParser())

app.use((req, res, next) => {
  res.on('finish', () => {
    logger.info({ method: req.method, path: req.originalUrl, status: res.statusCode }, 'HTTP request')
  })
  next()
})

const CSRF_FILE = '.csrf-secret'
function getCsrfSecret(): string {
  const hostedError = publicHostStartupError()
  if (hostedError) {
    logger.error(hostedError)
    process.exit(1)
  }
  if (process.env.CSRF_SECRET) return process.env.CSRF_SECRET
  if (existsSync(CSRF_FILE)) {
    try { return readFileSync(CSRF_FILE, 'utf8').trim() } catch { /* regenerate */ }
  }
  const secret = randomBytes(32).toString('hex')
  try { writeFileSync(CSRF_FILE, secret, { mode: 0o600 }) } catch { /* best effort */ }
  return secret
}
const CSRF_SECRET = getCsrfSecret()
const CSRF_COOKIE = 'XSRF-TOKEN'
const CSRF_HEADER = 'x-csrf-token'

function generateCsrfToken(sessionId: string): string {
  const timestamp = Date.now().toString()
  const payload = `${sessionId}:${timestamp}`
  const signature = createHmac('sha256', CSRF_SECRET).update(payload).digest('hex')
  return Buffer.from(`${payload}:${signature}`).toString('base64')
}

function verifyCsrfToken(token: string): boolean {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8')
    const [storedSessionId, timestamp, signature] = decoded.split(':')
    const payload = `${storedSessionId}:${timestamp}`
    const expectedSignature = createHmac('sha256', CSRF_SECRET).update(payload).digest('hex')
    
    const sigBuf = Buffer.from(signature, 'hex')
    const expBuf = Buffer.from(expectedSignature, 'hex')
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return false
    
    const tokenAge = Date.now() - parseInt(timestamp)
    if (tokenAge > 3600000) return false
    
    return true
  } catch {
    return false
  }
}

app.get('/api/v1/csrf-token', (req, res) => {
  const sessionId = req.cookies?.[CONSTANTS.SESSION_COOKIE_NAME] || 'anonymous'
  const token = generateCsrfToken(sessionId)
  // Same Secure/SameSite policy as the session cookie, and a Max-Age matching
  // the token's 1-hour validity, so the double-submit cookie is actually
  // stored and sent in hosted mode instead of being silently dropped.
  res.cookie(CSRF_COOKIE, token, csrfCookieOptions(60 * 60 * 1000))
  res.json({ csrfToken: token })
})

const PUBLIC_AUTH_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/resend-verification',
  '/api/v1/webhooks/shopify',
  '/api/v1/shopify/flow-webhook',
])

const csrfProtection = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next()
  }
  
  if (PUBLIC_AUTH_PATHS.has(req.path)) {
    return next()
  }
  
  const token = req.headers[CSRF_HEADER] as string || req.body?.csrfToken
  
  if (!token || !verifyCsrfToken(token)) {
    return res.status(403).json({ error: 'Invalid CSRF token' })
  }

  // Double-submit defence: the header token must also match the XSRF-TOKEN cookie,
  // so an attacker on another origin cannot replay a leaked token value.
  const cookieToken = req.cookies?.[CSRF_COOKIE]
  if (cookieToken && cookieToken !== token) {
    return res.status(403).json({ error: 'CSRF token mismatch' })
  }

  next()
}

app.use(csrfProtection)

const jsonBodyParser = express.json({
  limit: CONSTANTS.REQUEST_SIZE_LIMIT,
  verify: (req, _res, buf) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = req as any
    if (r.path === '/api/v1/webhooks/shopify') {
      r.rawBody = buf
    }
  },
})
// Image-upload routes carry up to 25mb data-URL bodies and register their own
// express.json({ limit: '25mb' }); the global 1mb parser must not reject them
// first (it runs before route middleware and would 413 real product photos).
const LARGE_JSON_PATHS = new Set([
  '/api/v1/uploads/image',
  '/api/v1/db/products/bulk-images',
])
app.use((req, res, next) => {
  if (LARGE_JSON_PATHS.has(req.path)) return next()
  return jsonBodyParser(req, res, next)
})
app.use(express.urlencoded({ extended: true, limit: CONSTANTS.REQUEST_SIZE_LIMIT }))

// Per-IP counters live in Postgres so backend restarts don't reset them
// (memory store would let an attacker wait out or trigger a restart to get a
// fresh budget). The account lockout in login_attempts is independent of this.
const authLimiter = rateLimit({
  windowMs: CONSTANTS.RATE_LIMIT_AUTH_WINDOW_MS,
  max: CONSTANTS.RATE_LIMIT_AUTH_MAX,
  message: { error: 'Too many authentication attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore('auth'),
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
})

const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many password reset attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore('pwreset'),
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
})

app.use('/api/v1/auth/login', authLimiter)
app.use('/api/v1/auth/forgot-password', passwordResetLimiter)
app.use('/api/v1/auth/reset-password', passwordResetLimiter)
app.use('/api/v1/auth/resend-verification', passwordResetLimiter)

// Outbound email is a costly, spammable side effect. Throttle the send-heavy
// routes per user so a compromised/rogue session can't turn the server into
// a spam cannon (each send also hits Gmail/SMTP rate limits downstream).
const emailSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: 'Too many email requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  // The IP fallback must go through ipKeyGenerator (IPv6 users would otherwise
  // get a /128 key that rotates per address and bypasses the limit —
  // express-rate-limit ERR_ERL_KEY_GEN_IPV6 fired on every boot).
  keyGenerator: (req) => (req.userId != null ? String(req.userId) : ipKeyGenerator(req.ip ?? 'unknown')),
})
app.use('/api/v1/backup/email', emailSendLimiter)
app.use('/api/v1/backup/email-separate', emailSendLimiter)
app.use('/api/v1/backup/notifications', emailSendLimiter)
app.use('/api/v1/db/dues/email', emailSendLimiter)
app.use('/api/v1/db/notifications/resend', emailSendLimiter)



app.get('/api/v1/health', async (_req, res) => {
  const dbHealth = await checkDbHealth()
  const dbStats = dbHealth.healthy ? await getDbStats() : null
  res.json({
    ok: true,
    service: 'opal-line-server',
    version: '1.0.0',
    shopifyConfigured: isConfigured(),
    database: {
      configured: Boolean(process.env.DATABASE_URL),
      healthy: dbHealth.healthy,
      latencyMs: dbHealth.latencyMs,
      stats: dbStats,
    },
    time: new Date().toISOString(),
  })
})

app.post('/api/v1/webhooks/shopify', verifyShopifyWebhook, rejectReplayedWebhook, async (req, res) => {
  const topic = req.shopifyWebhook?.topic ?? ''
  const webhookId = req.shopifyWebhook?.webhookId
  logger.info({ topic, shopDomain: req.shopifyWebhook?.shopDomain, webhookId }, 'Shopify webhook received')

  // Refunds are recorded BEFORE the acknowledgement. A refund is money: if the
  // write fails we must answer non-2xx so Shopify retries, and the delivery id
  // is released so that retry is not mistaken for a duplicate. The work is a
  // couple of indexed writes, well inside Shopify's 5s budget.
  if (topic.startsWith('refunds/')) {
    try {
      const { syncRefundFromWebhook } = await import('./shopifyRefunds')
      const saved = await syncRefundFromWebhook(req.body as never, { action: 'webhook' })
      if (!saved.ok) throw new Error(saved.reason ?? 'The refund could not be recorded')
      // Loyalty reversal is idempotent per Shopify refund id; a failure here is
      // logged but does not make Shopify resend a refund we already recorded.
      let loyalty: { ok: boolean; reversed: number } | null = null
      try {
        const { handleShopifyRefund } = await import('./shopifyLoyalty')
        loyalty = await handleShopifyRefund(req.body as never)
      } catch (err) {
        logger.error({ err, topic }, 'Loyalty: refund reversal failed (refund itself is recorded)')
      }
      logger.info({ topic, ...saved, loyalty }, 'Refund: recorded from Shopify')
      res.json({ ok: true, refundId: saved.refundId, duplicate: saved.duplicate, loyaltyPointsReversed: loyalty?.reversed ?? 0 })
    } catch (err) {
      if (webhookId) await releaseWebhookId(webhookId)
      logger.error(
        { topic, webhookId, err: { message: err instanceof Error ? err.message : 'Unknown error' } },
        'Refund: could not record Shopify refund — answering 500 so Shopify retries',
      )
      res.status(500).json({ ok: false, error: 'The refund could not be recorded' })
    }
    return
  }

  // Order / fulfillment events are acknowledged IMMEDIATELY. Shopify treats a
  // delivery as failed after ~5s, and this branch can do a FULL order import
  // (paging, invoices, email enrichment) — far too slow to keep the connection
  // open. The background order poll is the backstop for work that fails after
  // the ack; releasing the delivery id below still allows a genuine Shopify
  // retry to process the same payload again.
  const ORDER_EVENT_TOPICS = new Set([
    'orders/create',
    'orders/updated',
    'orders/edited',
    'orders/paid',
    'orders/fulfilled',
    'orders/partially_fulfilled',
    'orders/cancelled',
  ])
  const FULFILLMENT_EVENT_TOPICS = new Set(['fulfillments/create', 'fulfillments/update'])
  if (ORDER_EVENT_TOPICS.has(topic) || FULFILLMENT_EVENT_TOPICS.has(topic)) {
    const payload = req.body
    res.json({ ok: true, accepted: true })
    void (async () => {
      try {
        const pipeline = await import('./shopifyOrderPipeline')
        const orderPayload = payload as { id?: number; name?: string; admin_graphql_api_id?: string; cancelled_at?: string | null } | undefined
        let applied
        if (FULFILLMENT_EVENT_TOPICS.has(topic)) {
          applied = await pipeline.applyFulfillmentWebhook(payload, { actor: 'shopify' })
        } else {
          const shopifyId = orderPayload?.name ? `#${String(orderPayload.name).replace(/^#/, '')}` : null
          applied = await pipeline.applyShopifyOrderPayload(payload, { actor: 'shopify' })
          // A new order can arrive before the scheduled/manual import. Import only
          // when it is not a cancellation, and let the importer own its one-time
          // stock deduction. Existing rows are updated by the diff-only mapper.
          if (!applied.found && topic !== 'orders/cancelled') {
            const imported = await importShopifyOrders()
            applied = await pipeline.applyShopifyOrderPayload(payload, { actor: 'shopify' })
            if (imported.ok) {
              // Redacted API payloads are completed from the notification email
              // (never redacted) and by a targeted GraphQL enrichment. Both were
              // part of the previous order-webhook path and must keep running so
              // new orders do not land with a blank customer.
              const { kickEmailIngest } = await import('./orderEmailIngest')
              kickEmailIngest()
              try {
                const { enrichOrdersFromShopify } = await import('./shopifyDataEnhance')
                const enriched = await enrichOrdersFromShopify()
                logger.info({ enriched: enriched.enriched, failed: enriched.failed }, 'Auto-enrich: orders updated with full customer data')
              } catch (err) {
                logger.error({ err }, 'Auto-enrich after order webhook failed')
              }
            }
          }
          // Restock + loyalty reversal hang off the applied cancellation, not the
          // topic: a cancellation can first surface through `orders/updated` when
          // the `orders/cancelled` subscription was missing for a period.
          if (applied.orderId && applied.changed?.includes('cancelled')) {
            const { cancelLocalOrderOnce } = await import('./shopifyOrderActions')
            const restored = await cancelLocalOrderOnce(applied.orderId)
            if (restored.itemsRestored > 0) logger.info({ topic, orderId: applied.orderId, ...restored }, 'Order Pipeline: stock restored after cancellation')
            if (shopifyId) {
              const { handleShopifyOrderCancelled } = await import('./shopifyLoyalty')
              const loyalty = await handleShopifyOrderCancelled(shopifyId)
              if (loyalty.reversed > 0) logger.info({ topic, shopifyId, ...loyalty }, 'Loyalty: order cancellation reversed points')
            }
          }
          if (topic === 'orders/paid') {
            const { awardLoyaltyForShopifyOrders } = await import('./shopifyLoyalty')
            await awardLoyaltyForShopifyOrders({ limit: 50 })
          }
        }
        if (!applied.ok) throw new Error(applied.error ?? 'Order update could not be applied')
        if (applied.orderId && applied.changed?.includes('became-fulfilled')) {
          const [row] = await db!.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, applied.orderId)).limit(1)
          if (row) {
            const { autoInvoiceFulfilledOrder } = await import('./routes/db')
            const { notifyOrderFulfilled } = await import('./statusNotifications')
            await autoInvoiceFulfilledOrder(row, { userId: 'shopify' })
            const { kickEmailIngest } = await import('./orderEmailIngest')
            kickEmailIngest()
            void notifyOrderFulfilled({ ...row, trackingId: row.trackingNumber, carrier: row.trackingCompany })
          }
        }
        logger.info({ topic, ...applied }, 'Order Pipeline: Shopify event applied')
      } catch (err) {
        if (webhookId) await releaseWebhookId(webhookId)
        logger.error({ topic, webhookId, err: { message: err instanceof Error ? err.message : 'Unknown error' } }, 'Order Pipeline: background webhook processing failed — the order poll will retry')
      }
    })()
    return
  }

  // Everything else is a cache refresh: acknowledge immediately — Shopify
  // considers the delivery failed after 5s and retries, so heavy work (full
  // product/customer reimports) happens after the response.
  res.json({ ok: true })

  try {
    if (topic.startsWith('products/')) {
      const { handleProductWebhook } = await import('./shopifyProductWebhook')
      const result = await handleProductWebhook(topic, req.body)
      logger.info(
        { topic, synced: result.synced, created: result.created, updated: result.updated, removed: result.removed, ok: result.ok },
        'Webhook: product change applied to database',
      )
    } else if (topic.startsWith('customers/')) {
      const { importShopifyCustomers } = await import('./shopify')
      const result = await importShopifyCustomers()
      logger.info(
        { topic, imported: result.imported, updated: result.updated, ok: result.ok },
        'Webhook: customers imported into database',
      )
    } else {
      logger.debug({ topic }, 'Webhook topic ignored (no handler)')
    }
  } catch (err) {
    // A failed refresh should not burn this delivery id: releasing it lets
    // Shopify's retry re-run the import instead of being dropped as a duplicate.
    if (webhookId) await releaseWebhookId(webhookId)
    logger.error(
      { topic, webhookId, err: { message: err instanceof Error ? err.message : 'Unknown error' } },
      'Webhook processing failed',
    )
  }
})

// Product image uploads: authenticated users with inventory edit rights.
// Files are stored on disk and served from /uploads (see static mount below).
app.post('/api/v1/uploads/image', requireAuth, requirePermission('inventory', 'edit'), express.json({ limit: '25mb' }), uploadImageHandler)

app.use('/api/v1/db', requireAuth, enforceRbac)
import { feedRouter } from './notificationFeed'
app.use('/api/v1/db', feedRouter)
import { registerEnvConfigRoutes } from './routes/envConfig'
registerEnvConfigRoutes(app)
import { registerWhatsappInvoiceRoutes } from './routes/whatsappInvoice'
registerWhatsappInvoiceRoutes(app)
import { registerLoyaltyRoutes } from './routes/loyalty'
registerLoyaltyRoutes(app)
import { registerReturnRoutes } from './routes/returns'
registerReturnRoutes(app)
import accountingRouter from './routes/accounting.js'
app.use('/api/v1/accounts', accountingRouter)
app.use('/api/v1/db', dbRouter)
app.use('/api/v1/db', requireAuth, dashboardRouter)

// ─── Sales follow-ups: what needs chasing today ─────────────────────────────
app.get('/api/v1/sales/followups', requireAuth, requirePermission('sales', 'view'), async (req, res) => {
  try {
    const { collectSalesFollowUps, summariseSalesFollowUps } = await import('./salesFollowups')
    const customer = typeof req.query.customer === 'string' && req.query.customer.trim() ? req.query.customer.trim() : null
    const followUps = await collectSalesFollowUps(customer)
    const summary = await summariseSalesFollowUps(followUps)
    res.json({ followUps, summary, customer })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err }, 'Sales follow-ups failed')
    res.status(500).json({ error: message })
  }
})
app.use('/api/v1/rbac', requireAuth, rbacRouter)
app.use('/api/v1/backup', requireAuth, enforceRbac, backupRouter)
app.use('/api/v1/print-templates', requireAuth, enforceRbac, printTemplatesRouter)
app.use('/api/v1/auth', authRouter)
app.use('/api/v1/system', requireAuth, systemRouter)
app.use('/api/v1/reports', requireAuth, reportsRouter)
app.use('/api/v1/silver', requireAuth, enforceRbac)
// Mirror of the silver mount: /gold routes use bare requirePermission, which
// reads req.userId — without this mount gold/rate answered 401 for every
// caller, session or not.
app.use('/api/v1/gold', requireAuth, enforceRbac)

// Shopify Flow webhook — must be BEFORE requireAuth since it's called from Shopify servers (no browser session)
app.post('/api/v1/shopify/flow-webhook', express.json({
  limit: '1mb',
  // Shopify signs the exact bytes it sent. Re-stringifying req.body breaks the
  // signature whenever whitespace/key order differs, so keep the raw payload.
  verify: (req, _res, buf) => { (req as unknown as express.Request).rawBody = buf },
}), async (req, res) => {
  try {
    // ── HMAC signature verification ────────────────────────────────────────
    const SHOPIFY_WEBHOOK_SECRET = decryptSecret(process.env.SHOPIFY_WEBHOOK_SECRET?.trim())
    if (SHOPIFY_WEBHOOK_SECRET) {
      const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string | undefined
      if (!hmacHeader) {
        logger.warn('Flow webhook missing X-Shopify-Hmac-SHA256 header')
        return res.status(401).json({ ok: false, error: 'Unauthorized' })
      }
      const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}))
      const expected = createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest('base64')
      const sigBuf = Buffer.from(hmacHeader, 'base64')
      const expBuf = Buffer.from(expected, 'base64')
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        logger.warn('Flow webhook HMAC mismatch')
        return res.status(401).json({ ok: false, error: 'Unauthorized' })
      }
    } else {
      logger.warn('SHOPIFY_WEBHOOK_SECRET not set — flow-webhook HMAC verification skipped')
    }

    const body = req.body

    // ── Input validation ───────────────────────────────────────────────────
    if (!body || !body.order_name) {
      res.status(400).json({ ok: false, error: 'order_name is required' })
      return
    }

    const customerEmail = body.customer_email || body.email || null
    if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customerEmail))) {
      res.status(400).json({ ok: false, error: 'Invalid email format' })
      return
    }

    const customerPhone = body.customer_phone || body.phone || null
    if (customerPhone && String(customerPhone).replace(/\D/g, '').length > 15) {
      res.status(400).json({ ok: false, error: 'Phone number too long' })
      return
    }

    const { db } = await import('./db/client')
    const schema = await import('./db/schema')
    const { eq } = await import('drizzle-orm')
    if (!db) {
      res.status(503).json({ ok: false, error: 'Database unavailable' })
      return
    }

    const orderName = String(body.order_name).trim()
    const customerName = [body.customer_first_name, body.customer_last_name].filter(Boolean).join(' ').trim()

    const billingAddress = (body.billing_address1 || body.billing_city) ? {
      name: customerName,
      address1: body.billing_address1 || '',
      address2: body.billing_address2 || '',
      city: body.billing_city || '',
      province: body.billing_province || '',
      zip: body.billing_zip || '',
      country: body.billing_country || '',
      phone: customerPhone || '',
    } : null

    const shippingAddress = (body.shipping_address1 || body.shipping_city) ? {
      name: customerName,
      address1: body.shipping_address1 || '',
      address2: body.shipping_address2 || '',
      city: body.shipping_city || '',
      province: body.shipping_province || '',
      zip: body.shipping_zip || '',
      country: body.shipping_country || '',
      phone: customerPhone || '',
    } : null

    const updates: Record<string, any> = {}
    if (customerName) updates.customer = customerName
    if (billingAddress) updates.billingAddress = billingAddress
    if (shippingAddress) updates.shippingAddress = shippingAddress

    if (Object.keys(updates).length > 0) {
      await db
        .update(schema.salesOrders)
        .set({
          ...(updates.customer ? { customer: updates.customer } : {}),
          ...(updates.billingAddress ? { billingAddress: updates.billingAddress } : {}),
          ...(updates.shippingAddress ? { shippingAddress: updates.shippingAddress } : {}),
        })
        .where(eq(schema.salesOrders.shopifyId, orderName))
    }

    if (customerName || customerEmail || customerPhone) {
      const existing = customerEmail
        ? await db.select().from(schema.customers).where(eq(schema.customers.email, customerEmail)).limit(1)
        : customerPhone
          ? await db.select().from(schema.customers).where(eq(schema.customers.phone, customerPhone)).limit(1)
          : []

      if (existing.length > 0) {
        await db
          .update(schema.customers)
          .set({
            name: existing[0].name === 'Guest' || !existing[0].name ? customerName || existing[0].name : existing[0].name,
            email: customerEmail ?? existing[0].email,
            phone: customerPhone ?? existing[0].phone,
            city: billingAddress?.city || existing[0].city,
            province: billingAddress?.province || existing[0].province,
          })
          .where(eq(schema.customers.id, existing[0].id))
      } else if (customerName) {
        await db.insert(schema.customers).values({
          id: `C-flow-${Date.now()}`,
          name: customerName,
          email: customerEmail,
          phone: customerPhone,
          city: billingAddress?.city || null,
          province: billingAddress?.province || null,
          status: 'active',
        }).onConflictDoNothing()
      }
    }

    logger.info({ orderName, customerName }, 'Flow webhook processed')
    res.json({ ok: true, order: orderName, customer: customerName })
  } catch (err) {
    logger.error({ err }, 'Flow webhook failed')
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

app.use('/api/v1/shopify', requireAuth, enforceRbac)

app.get('/api/v1/shopify/status', requireAuth, (_req, res) => {
  const totals = {
    orders: store.orders.length,
    products: store.products.length,
    customers: store.customers.length,
    inventory: store.inventory.length,
    price: store.price.length,
  }
  res.json({
    configured: isConfigured(),
    store: config.shop || null,
    syncing: store.syncing,
    totals,
    lastSync: store.lastSync,
    lastError: store.lastError ?? null,
    logs: [],
  })
})

app.post('/api/v1/shopify/test', requirePermission('shopify', 'view'), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const overrides =
    typeof body.shopifyStoreUrl === 'string' || typeof body.shopifyAccessToken === 'string'
      ? {
          shop: typeof body.shopifyStoreUrl === 'string' ? body.shopifyStoreUrl : undefined,
          accessToken: typeof body.shopifyAccessToken === 'string' ? body.shopifyAccessToken : undefined,
        }
      : undefined
  const result = await testShopifyConnection(overrides)
  res.json(result)
})

app.get('/api/v1/shopify/email-ingest/status', requireAuth, (_req, res) => {
  res.json({
    configured: isEmailIngestConfigured(),
    mailbox: process.env.ORDER_EMAIL_ADDRESS?.trim() || null,
    host: process.env.ORDER_EMAIL_HOST || 'imap.gmail.com',
  })
})

app.post('/api/v1/shopify/email-ingest/poll', requirePermission('shopify', 'create'), async (_req, res) => {
  const result = await pollOrderMailbox()
  res.json(result)
})

// Customer-export CSV watcher: finds the CSV Shopify emails after a
// "Export customers" click and imports it with Shopify customer IDs where
// they can be resolved. Runs alongside the order-email poll.
// PII-gap count for the Customers page banner: how many customer rows are
// still redacted placeholders (no email AND no phone).
app.get('/api/v1/shopify/pii-gap', requirePermission('shopify', 'view'), async (_req, res) => {
  try {
    const { missingPiiCustomerCount } = await import('./shopifyDataEnhance')
    res.json({ missing: await missingPiiCustomerCount() })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'pii-gap failed' })
  }
})

app.post('/api/v1/shopify/customer-export/poll', requirePermission('shopify', 'create'), async (req, res) => {
  try {
    const { pollCustomerExport } = await import('./orderEmailIngest')
    const result = await pollCustomerExport()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Imported Shopify Customer Export',
      module: 'shopify',
      entity: 'Customers',
      details: `attachments: ${result.attachmentsFound}, imported: ${result.imported}, updated: ${result.updated}${result.errors.length ? `, errors: ${result.errors.length}` : ''}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json(result)
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Customer export poll failed' })
  }
})

// Open the Shopify admin customers page (for the "Sync Customers" button —
// the user clicks Export there and Shopify emails the CSV to the mailbox).
app.get('/api/v1/shopify/customers-export-url', requirePermission('shopify', 'view'), (_req, res) => {
  const shop = process.env.SHOPIFY_STORE_URL?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!shop) return res.status(503).json({ error: 'Shopify is not configured' })
  res.json({ url: `https://${shop}/admin/customers` })
})

app.post('/api/v1/shopify/sync', requirePermission('shopify', 'create'), validate(syncSchema), async (req, res) => {
    const { resources } = req.body
    const allowed: SyncResource[] = ['orders', 'products', 'customers', 'inventory', 'price']
    const selected = resources?.filter((r: SyncResource) => allowed.includes(r)) ?? allowed
    const result = await runSync(selected)
    const actor = actorFromRequest(req)
    const results = result.ok && 'results' in result ? result.results : undefined
    const summary = results
      ? Object.entries(results)
          .filter(([, r]) => 'ok' in r && r.ok)
          .map(([k, r]) => `${k}:${r.count}`)
          .join(', ')
      : result.message ?? 'failed'

    let dbResults: Record<string, string> = {}
    if (results && db && isConfigured()) {
      if (selected.includes('products') && results.products.ok) {
        try {
          const dbRes = await syncProductsToDb()
          dbResults.products = dbRes.ok ? `${dbRes.synced} (${dbRes.created} created, ${dbRes.updated} updated)` : dbRes.errors?.join('; ') ?? 'failed'
        } catch (e) {
          dbResults.products = e instanceof Error ? e.message : 'failed'
        }
      }
      if (selected.includes('orders') && results.orders.ok) {
        try {
          const dbRes = await importShopifyOrders()
          dbResults.orders = dbRes.ok ? `${dbRes.imported} imported, ${dbRes.updated} updated` : dbRes.errors?.join('; ') ?? 'failed'
        } catch (e) {
          dbResults.orders = e instanceof Error ? e.message : 'failed'
        }
        // The API response is redacted for protected customer data — poll the
        // order mailbox right away so the notification emails (never redacted)
        // fill in the real customer data for the orders just synced.
        if (selected.includes('orders') && isEmailIngestConfigured()) {
          try {
            const emailRes = await pollOrderMailbox()
            dbResults.emailIngest = `scanned: ${emailRes.scanned}, updated: ${emailRes.updated}, created: ${emailRes.created}`
          } catch (e) {
            logger.error({ err: e instanceof Error ? e.message : e }, 'Post-sync email ingest failed')
          }
        }
      }
      // Auto-enrich after sync: fetch full customer data for incomplete records
      try {
        const { enrichOrdersFromShopify, enrichCustomersFromShopify } = await import('./shopifyDataEnhance')
        const enrichOrders = await enrichOrdersFromShopify()
        const enrichCust = await enrichCustomersFromShopify()
        dbResults.enrichment = `orders: ${enrichOrders.enriched} enriched, customers: ${enrichCust.enriched} enriched`
      } catch (e) {
        logger.error({ err: e }, 'Post-sync enrichment failed')
      }
      // ERP owns the catalogue, so "Sync Now" finishes by sending ERP values to
      // the store: the pull above only discovers listings and refreshes links.
      // Orders and customers keep the opposite direction — they are imported
      // from Shopify, which is where they originate.
      const catalogue = selected.includes('products') || selected.includes('inventory') || selected.includes('price')
      if (catalogue) {
        try {
          const kinds: OutboundKind[] = []
          if (selected.includes('products')) kinds.push('product', 'price', 'inventory')
          if (selected.includes('price') && !kinds.includes('price')) kinds.push('price')
          if (selected.includes('inventory') && !kinds.includes('inventory')) kinds.push('inventory')
          const queued = await queueCatalogOutbound(kinds)
          const flushed = await flushOutboundShopifyJobs()
          dbResults.push =
            `${queued.queued} queued, ${flushed.processed} pushed` +
            (flushed.failed > 0 ? `, ${flushed.failed} failed` : '') +
            (queued.skipped > 0 ? ` (${queued.skipped} not on Shopify)` : '')
        } catch (e) {
          dbResults.push = e instanceof Error ? e.message : 'failed'
          logger.error({ err: e }, 'Sync Now: catalogue push failed')
        }
      }
    }

    void recordActivity({
      action: 'Synced Shopify Data',
      module: 'shopify',
      entity: selected.join(', '),
      details:
        result.ok
          ? `Synced — ${summary}${Object.keys(dbResults).length ? ` | DB: ${Object.entries(dbResults).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`
          : `Sync failed: ${result.message ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json(results ? { ...result, db: dbResults } : result)
  })

function cachedHandler(resource: SyncResource) {
  return async (_req: express.Request, res: express.Response) => {
    try {
      if (!isConfigured()) {
        return res.status(503).json({ error: 'Shopify is not configured. See server/.env' })
      }
      await ensureSynced(resource)
      const data = store[resource]
      res.json({ syncedAt: store.lastSync[resource] ?? null, data })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(502).json({ error: message })
    }
  }
}

app.get('/api/v1/shopify/orders', requirePermission('shopify', 'view'), cachedHandler('orders'))
app.get('/api/v1/shopify/products', requirePermission('shopify', 'view'), cachedHandler('products'))
app.get('/api/v1/shopify/customers', requirePermission('shopify', 'view'), cachedHandler('customers'))
app.get('/api/v1/shopify/inventory', requirePermission('shopify', 'view'), cachedHandler('inventory'))
app.get('/api/v1/shopify/price', requirePermission('shopify', 'view'), cachedHandler('price'))

app.post('/api/v1/shopify/price/apply', requirePermission('shopify', 'edit'), async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Service temporarily unavailable' })
    }
    const result = await applyPriceSync()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Applied Price Sync',
      module: 'shopify',
      entity: 'Products',
      details: result.ok ? `Pushed ${result.updated ?? 0} price(s) to Shopify` : `Price sync failed: ${result.errors?.join('; ') ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.post('/api/v1/shopify/products/push', requirePermission('shopify', 'create'), validate(pushProductsSchema), async (req, res) => {
  try {
    const { ids } = req.body
    const result = await pushProductsToShopify(ids)
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Pushed Products',
      module: 'shopify',
      entity: ids && ids.length ? ids.join(', ') : 'All products',
      details: result.ok ? `${result.created ?? 0} created, ${result.skipped ?? 0} skipped on Shopify` : `Push failed: ${result.errors?.join('; ') ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.post('/api/v1/shopify/products/price', requirePermission('shopify', 'edit'), validate(productPriceSchema), async (req, res) => {
  try {
    const { id } = req.body
    const result = await pushProductPriceToShopify(id)
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Updated Product Price',
      module: 'shopify',
      entity: `Product ${id}`,
      details: result.ok ? `${result.updated ?? 0} price(s) pushed to Shopify` : `Price push failed: ${result.errors?.join('; ') ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.post('/api/v1/shopify/inventory/push', requirePermission('shopify', 'edit'), validate(pushInventorySchema), async (req, res) => {
  try {
    const { ids } = req.body
    const result = await pushInventoryToShopify(ids)
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Pushed Inventory',
      module: 'shopify',
      entity: ids && ids.length ? ids.join(', ') : 'All products',
      details: result.ok ? `${result.updated ?? 0} updated, ${result.skipped ?? 0} skipped on Shopify` : `Inventory push failed: ${result.errors?.join('; ') ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.post('/api/v1/shopify/products/purge', requirePermission('shopify', 'delete'), async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Service temporarily unavailable' })
    }
    const result = await purgeProducts()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Purged Shopify Products',
      module: 'shopify',
      entity: 'Products',
      details: result.ok ? `${result.shopifyDeleted ?? 0} deleted from Shopify, ${result.localDeleted ?? 0} removed locally` : `Purge failed: ${result.errors?.join('; ') ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.get('/api/v1/shopify/products/sync-stock-preview', requirePermission('shopify', 'view'), async (_req, res) => {
  try {
    const { previewStockChangesToShopify } = await import('./shopifyProductSyncPreview')
    res.json(await previewStockChangesToShopify())
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ ok: false, error: message })
  }
})

app.post('/api/v1/shopify/products/sync-db', requirePermission('shopify', 'create'), async (req, res) => {
  try {
    const allowRemovals = req.body?.allowRemovals === true
    // ERP is authoritative for the catalogue: this pull discovers new listings
    // and refreshes links, and never writes the store's copy over an ERP row.
    // What it will not do is import stock — the push below sends ERP stock to
    // Shopify instead.
    const result = await syncProductsToDb({
      mode: 'full',
      allowRemovals,
      mergeVariants: true,
    })
    // The pull discovers listings and refreshes links; ERP-owned values travel
    // the other way. Same queue, same retries and Sync Logs entries as the
    // worker uses for an ordinary edit.
    let push: string | undefined
    try {
      const queued = await queueCatalogOutbound(['product', 'price', 'inventory'], 'Full Sync Now')
      const flushed = await flushOutboundShopifyJobs()
      push = `${queued.queued} queued, ${flushed.processed} pushed${flushed.failed > 0 ? `, ${flushed.failed} failed` : ''}`
    } catch (err) {
      logger.error({ err }, 'Full sync: catalogue push failed')
      push = 'push failed'
    }
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Synced Products',
      module: 'shopify',
      entity: 'Products',
      details: result.ok ? `${result.synced ?? 0} synced (${result.created ?? 0} created, ${result.updated ?? 0} updated)` : `Product sync failed: ${result.errors?.join('; ') ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(result.ok ? 200 : 502).json({ ...result, push })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

// Product sync comparison: local DB vs live Shopify catalog (read-only)
app.get('/api/v1/shopify/products/compare', requirePermission('shopify', 'view'), async (_req, res) => {
  try {
    const { compareProductsWithShopify } = await import('./syncCompare')
    const result = await compareProductsWithShopify()
    res.status(result.ok ? 200 : 503).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

// Force-pull a single product from Shopify into the local DB (by local product id)
app.post('/api/v1/shopify/products/:id/pull', requirePermission('shopify', 'edit'), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: 'Shopify is not configured' })
    const localId = String(routeParam(req.params.id) ?? '').trim()
    const [dbMod, shopifyMod] = await Promise.all([import('./db/client'), import('./shopify')])
    const dbh = dbMod.db
    if (!dbh) return res.status(503).json({ error: 'Database is not configured' })
    const [local] = await dbh.select().from(dbMod.schema.products).where(eq(dbMod.schema.products.id, localId)).limit(1)
    if (!local) return res.status(404).json({ error: 'Product not found locally' })
    if (!local.shopifyId) return res.status(400).json({ error: 'Product is not linked to Shopify' })

    await shopifyMod.ensureSynced('products')
    const shop = shopifyMod.store.products.find((p: { id: number }) => String(p.id) === String(local.shopifyId))
    if (!shop) return res.status(404).json({ error: 'Product not found on Shopify' })

    const price = Number(shop.price)
    await dbh.update(dbMod.schema.products).set({
      // Shopify's `price` is the FINAL first-variant price — ERP base + the
      // variant's "Add to price" delta. It must never overwrite the ERP BASE:
      // doing so compounded the add-on on every pull (618+200 → base 818 →
      // display 1018 → …). Piece-rate products were already protected; this
      // protects every variant product the same way. The base is ERP-owned.
      // Stock is deliberately NOT written here: only the difference to what
      // the ledger already holds is posted below, so per-location and
      // per-variant balances stay intact instead of being overwritten by one
      // product-wide number.
      name: shop.title || local.name,
      image: shop.image ?? local.image,
    }).where(eq(dbMod.schema.products.id, localId))

    // The store's number is a TARGET reached through the ledger. `shopify_sync`
    // marks it as an inbound pull, which also keeps it from being echoed back
    // to Shopify (the outbound worker skips those movements).
    const pulledStock = Number(shop.inventoryQuantity)
    let stock: number | null = local.stock
    if (Number.isFinite(pulledStock)) {
      const { setStockTotalTo } = await import('./stock')
      stock = await setStockTotalTo({
        sku: String(local.sku ?? ''),
        target: pulledStock,
        type: 'shopify_sync',
        refType: 'shopify_pull',
        note: `stock pulled from Shopify (was ${Number(local.stock ?? 0)})`,
        createdBy: actorFromRequest(req).userId ?? 'system',
      })
    }

    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Synced Products',
      module: 'shopify',
      entity: `Product ${local.sku ?? localId}`,
      details: `Pulled from Shopify: price ₹${price}, stock ${shop.inventoryQuantity}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, pulled: { price, stock: stock ?? shop.inventoryQuantity, title: shop.title } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.get('/api/v1/silver/rate', requirePermission('silver-rate', 'view'), async (_req, res) => {
  try {
    const latest = await getLatestSilverRate()
    res.json({ rate: latest?.rate ?? 92.8, purity: latest?.purity ?? 92.5, previousRate: latest?.previousRate ?? 90.0, updatedAt: latest?.updatedAt ?? null, currency: '₹' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

// Auth-only, by design: `gold-rate` was never a real RBAC module (MODULES has
// no such key), so requirePermission('gold-rate', …) answered 401/403 for
// every caller and the endpoint was unreachable. The same data is already
// readable by any logged-in user through GET /db/gold-rates (no module check),
// so this mirrors that exposure exactly. When gold rates get their own module
// + UI, re-add requirePermission('gold-rate', 'view') here.
app.get('/api/v1/gold/rate', async (_req, res) => {
  try {
    if (!db) return res.json({ rate: 0, purity: 99.9, updatedAt: null, currency: 'INR', source: null })
    const rows = await db.select().from(schema.goldRates).orderBy(desc(schema.goldRates.updatedAt)).limit(1)
    const latest = rows[0] ?? null
    res.json({ rate: latest?.rate ?? 0, purity: latest?.purity ?? 99.9, updatedAt: latest?.updatedAt ?? null, currency: latest?.currency ?? 'INR', source: latest?.source ?? null })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

// Legacy entry point kept for older clients. It runs through the same
// approval gate as /silver/requests (see handleSilverRateChange) so it can
// never be used to apply a rate change without Admin approval.
app.post('/api/v1/silver/update', requirePermission('silver-rate', 'edit'), validate(silverRateSchema), async (req, res) => {
  try {
    const userId = req.userId!
    const perms = await computeUserPermissions(userId)
    if (!perms) return res.status(401).json({ error: 'User not found' })
    const outcome = await handleSilverRateChange(userId, perms.role, Number(req.body.rate), req.body.syncFirst === true, actorFromRequest(req))
    res.status(outcome.status).json(outcome.body)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

// Live progress of an in-flight silver-rate apply — the Silver Rate page
// polls this while its update request is running, so the wizard shows which
// phase (sync → reprice → match → push) is running instead of a frozen spinner.
app.get('/api/v1/silver/update/progress', requirePermission('silver-rate', 'view'), (_req, res) => {
  res.json(getSilverRateProgress())
})

// ─── Silver rate approval workflow: staff submit, Admin/Super Admin decide ───
const SILVER_APPROVER_ROLES = ['Admin', 'Super Admin']


async function userNameById(userId: string): Promise<string> {
  if (!db) return 'Unknown'
  const [row] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  return row?.name ?? 'Unknown'
}

async function isSilverApprover(userId: string): Promise<boolean> {
  const perms = await computeUserPermissions(userId)
  return !!perms && SILVER_APPROVER_ROLES.includes(perms.role)
}

type RateActor = { userId: string | null; ip: string | null }

// Single gate for every silver rate change. Admin / Super Admin apply the
// rate immediately; every other role gets a pending request that an approver
// must accept or reject. Approval is mandatory for staff — it cannot be
// switched off from settings.
async function handleSilverRateChange(
  userId: string,
  role: string,
  rate: number,
  syncFirst: boolean,
  actor: RateActor,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!db) return { status: 503, body: { error: 'Database unavailable' } }

  if (SILVER_APPROVER_ROLES.includes(role)) {
    const result = await applySilverRate(rate, { syncFirst, source: 'manual', actorName: await userNameById(userId) })
    void recordActivity({
      action: 'Updated Silver Rate',
      module: 'silver-rate',
      entity: 'Silver Rate',
      details: `Silver rate changed to Rs${rate}/gm${syncFirst ? ' (products synced from Shopify first)' : ''}. ${result.ok ? `${result.affected ?? 0} product(s) repriced` : `Failed: ${result.errors?.join('; ') ?? 'unknown'}`}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    // "Applied" means the rate row was written and products were repriced.
    // The only thing that can still fail after that is the follow-up Shopify
    // price push (ok stays false, errors/steps carry the detail, and the rate
    // row records syncStatus: 'failed' for a retry) — the approval route below
    // already judges the outcome that way, so mapping a push failure to a 502
    // here made an update that did land look like a rejected request.
    const rateSaved = (result.steps ?? []).some((s) => s.key === 'rate' && s.status === 'done')
    const applied = result.ok || rateSaved || (result.affected ?? 0) > 0
    return { status: applied ? 200 : 502, body: { ...result, direct: true } }
  }

  // Staff member → queue a pending request for Admin / Super Admin approval.
  const [pending] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.silverRateRequests)
    .where(and(eq(schema.silverRateRequests.status, 'pending'), eq(schema.silverRateRequests.requestedById, userId)))
  if (Number(pending?.n ?? 0) >= 5) {
    return { status: 429, body: { error: 'You already have 5 pending rate requests awaiting approval' } }
  }
  const latest = await getLatestSilverRate()
  const [row] = await db
    .insert(schema.silverRateRequests)
    .values({
      id: randomUUID(),
      rate,
      previousRate: latest?.rate ?? null,
      status: 'pending',
      syncFirst,
      requestedBy: await userNameById(userId),
      requestedById: userId,
      requestedByRole: role,
      requestedAt: new Date().toISOString(),
    })
    .returning()
  void recordActivity({
    action: 'Requested Silver Rate Change',
    module: 'silver-rate',
    entity: `Silver Rate ₹${rate}/gm`,
    details: `Submitted by ${role} — awaiting Admin approval (current rate ₹${(latest?.rate ?? 0).toFixed(2)}/gm)`,
    userId: actor.userId,
    ip: actor.ip,
  })
  return { status: 201, body: { direct: false, ok: true, request: row, message: 'Request submitted — awaiting Admin approval' } }
}

// Pending + recent rate-change requests. Approvers see everything; other
// users only see their own requests.
app.get('/api/v1/silver/requests', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' })
  try {
    const userId = req.userId!
    const isApprover = await isSilverApprover(userId)
    const status = String(req.query.status ?? 'all')
    const conditions = []
    if (status !== 'all') conditions.push(eq(schema.silverRateRequests.status, status))
    if (!isApprover) conditions.push(eq(schema.silverRateRequests.requestedById, userId))
    const rows = await db
      .select()
      .from(schema.silverRateRequests)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.silverRateRequests.requestedAt))
      .limit(50)
    res.json({ isApprover, requests: rows })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

// Submit a rate change. Admin/Super Admin apply immediately; other staff get a
// pending request that an approver must action.
app.post('/api/v1/silver/requests', requireAuth, validate(silverRateSchema), async (req, res) => {
  try {
    const userId = req.userId!
    const perms = await computeUserPermissions(userId)
    if (!perms) return res.status(401).json({ error: 'User not found' })
    const outcome = await handleSilverRateChange(
      userId,
      perms.role,
      Number(req.body.rate),
      req.body.syncFirst === true,
      actorFromRequest(req),
    )
    res.status(outcome.status).json(outcome.body)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

// Approve a pending request: applies the rate with the approver's name.
app.post('/api/v1/silver/requests/:id/approve', requirePermission('silver-rate', 'edit'), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' })
  try {
    const userId = req.userId!
    if (!(await isSilverApprover(userId))) return res.status(403).json({ error: 'Only Admin or Super Admin can approve rate changes' })
    const [request] = await db.select().from(schema.silverRateRequests).where(eq(schema.silverRateRequests.id, routeParam(req.params.id))).limit(1)
    if (!request) return res.status(404).json({ error: 'Request not found' })
    if (request.status !== 'pending') return res.status(409).json({ error: `Request already ${request.status}` })

    const approverName = await userNameById(userId)
    const result = await applySilverRate(Number(request.rate), {
      syncFirst: request.syncFirst === true,
      source: 'approval',
      actorName: approverName,
    })
    // If the rate row was written (reprice ran) the change counts as applied
    // even if the Shopify push failed — otherwise keep it pending for retry.
    const applied = result.ok || (result.affected ?? 0) > 0
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 500) : null
    const [updated] = await db
      .update(schema.silverRateRequests)
      .set({
        status: applied ? 'approved' : 'pending',
        decidedBy: approverName,
        decidedById: userId,
        decidedAt: new Date().toISOString(),
        decisionNote: note,
        resultNote: result.ok
          ? `Applied by ${approverName}: ${result.affected ?? 0} repriced, ${result.updated ?? 0} pushed to Shopify`
          : `Apply failed: ${result.errors.join('; ') || 'unknown error'}`,
      })
      .where(eq(schema.silverRateRequests.id, request.id))
      .returning()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Approved Silver Rate Change',
      module: 'silver-rate',
      entity: `Silver Rate ₹${Number(request.rate).toFixed(2)}/gm`,
      details: `Requested by ${request.requestedBy ?? 'unknown'} — approved by ${approverName}. ${result.ok ? `${result.affected ?? 0} repriced` : `Errors: ${result.errors.join('; ') || 'unknown'}`}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: applied, request: updated, result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

// Reject a pending request (optional note recorded).
app.post('/api/v1/silver/requests/:id/reject', requirePermission('silver-rate', 'edit'), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' })
  try {
    const userId = req.userId!
    if (!(await isSilverApprover(userId))) return res.status(403).json({ error: 'Only Admin or Super Admin can reject rate changes' })
    const [request] = await db.select().from(schema.silverRateRequests).where(eq(schema.silverRateRequests.id, routeParam(req.params.id))).limit(1)
    if (!request) return res.status(404).json({ error: 'Request not found' })
    if (request.status !== 'pending') return res.status(409).json({ error: `Request already ${request.status}` })

    const approverName = await userNameById(userId)
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 500) : null
    const [updated] = await db
      .update(schema.silverRateRequests)
      .set({
        status: 'rejected',
        decidedBy: approverName,
        decidedById: userId,
        decidedAt: new Date().toISOString(),
        decisionNote: note,
        resultNote: null,
      })
      .where(eq(schema.silverRateRequests.id, request.id))
      .returning()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Rejected Silver Rate Change',
      module: 'silver-rate',
      entity: `Silver Rate ₹${Number(request.rate).toFixed(2)}/gm`,
      details: `Requested by ${request.requestedBy ?? 'unknown'} — rejected by ${approverName}${note ? `: ${note}` : ''}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, request: updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

// ─── Auto silver rate: status, manual fetch, runtime toggle ──────────────────
app.get('/api/v1/silver/auto-rate/status', requirePermission('silver-rate', 'view'), async (req, res) => {
  try {
    // Approval for staff rate changes is mandatory, so approvalRequired is
    // always true. isApprover tells the UI who may apply a change directly.
    const isApprover = await isSilverApprover(req.userId!)
    res.json({
      // Rides along as { days, time } — the Silver Rate page renders it and
      // offers the Edit-schedule dialog that PUTs back to /auto-rate/schedule.
      ...getSchedulerStatus(),
      apiUrlConfigured: Boolean(process.env.SILVER_RATE_API_URL?.trim()),
      approvalRequired: true,
      isApprover,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.post('/api/v1/silver/auto-rate/fetch-now', requirePermission('silver-rate', 'edit'), async (req, res) => {
  try {
    // Fetching applies the live spot rate and reprices products, so it counts
    // as a rate change — approvers only.
    if (!(await isSilverApprover(req.userId!))) {
      return res.status(403).json({ error: 'Only Admin or Super Admin can fetch and apply the live silver rate' })
    }
    const result = await fetchSilverRateNow()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Fetched Silver Spot Rate',
      module: 'silver-rate',
      entity: 'Auto Rate',
      details: result.ok ? `Fetched ₹${result.rate}/gm — ${result.repriced ?? 0} repriced, ${result.pushed ?? 0} pushed to Shopify` : `Failed: ${result.error ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

// Run schedule for the auto silver-rate update: which days (weekends
// included — plenty of shops want Saturday/Sunday updates too) and at what
// time, Asia/Kolkata. Invalid input is normalised server-side, and the
// timer is re-armed immediately so the new schedule applies at once.
app.put('/api/v1/silver/auto-rate/schedule', requirePermission('system', 'edit'), async (req, res) => {
  try {
    const schedule = await applyRateSchedule({ days: req.body?.days, time: req.body?.time })
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Silver Rate Schedule Changed',
      module: 'silver-rate',
      entity: 'Auto Rate',
      details: `Update schedule set to ${schedule.days.join(',')} at ${schedule.time} IST`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, schedule })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

// ─── One-off scheduled rate changes (Silver Rate page) ───────────────────────
// Queue one specific rate for one specific date/time; applied automatically
// then (reprices products, pushes to Shopify, audited) — the weekend-rate
// workflow: schedule it on Friday, it lands Saturday morning.
app.get('/api/v1/silver/scheduled-changes', requirePermission('silver-rate', 'view'), async (_req, res) => {
  res.json({ changes: getScheduledRateChanges() })
})

app.post('/api/v1/silver/scheduled-changes', requirePermission('silver-rate', 'edit'), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' })
  try {
    // Scheduling IS pre-approving the change — approvers only (like fetch-now).
    if (!(await isSilverApprover(req.userId!))) {
      return res.status(403).json({ error: 'Only Admin or Super Admin can schedule a rate change' })
    }
    const [user] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, req.userId!)).limit(1)
    const { change, changes } = await addScheduledRateChange({
      rate: req.body?.rate,
      applyAt: req.body?.applyAt,
      note: req.body?.note,
      requestedBy: user?.name ?? null,
    })
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Silver Rate Change Scheduled',
      module: 'silver-rate',
      entity: `Silver Rate ₹${change.rate.toFixed(2)}/gm`,
      details: `Will apply automatically at ${change.applyAt}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(201).json({ ok: true, change, changes })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    // addScheduledRateChange throws user-facing validation messages; anything
    // else is unexpected and stays a 500.
    const validation = /must|At most/.test(message)
    res.status(validation ? 400 : 500).json({ error: message })
  }
})

// Edit a queued change in place (rate / time / note) — same validation and
// approver gate as scheduling; the audit trail records both sides.
app.patch('/api/v1/silver/scheduled-changes/:id', requirePermission('silver-rate', 'edit'), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' })
  try {
    if (!(await isSilverApprover(req.userId!))) {
      return res.status(403).json({ error: 'Only Admin or Super Admin can edit a scheduled rate change' })
    }
    const { change, changes } = await updateScheduledRateChange(String(req.params.id), {
      rate: req.body?.rate,
      applyAt: req.body?.applyAt,
      note: req.body?.note,
    })
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Silver Rate Change Edited',
      module: 'silver-rate',
      entity: `Silver Rate ₹${change.rate.toFixed(2)}/gm`,
      details: `Now applies at ${change.applyAt}${change.note ? ` — "${change.note}"` : ''}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, change, changes })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    // "not found" means the change already fired or was cancelled.
    if (/not found/i.test(message)) return res.status(404).json({ error: message })
    const validation = /must|At most/.test(message)
    res.status(validation ? 400 : 500).json({ error: message })
  }
})

app.delete('/api/v1/silver/scheduled-changes/:id', requirePermission('silver-rate', 'edit'), async (req, res) => {
  try {
    if (!(await isSilverApprover(req.userId!))) {
      return res.status(403).json({ error: 'Only Admin or Super Admin can cancel a scheduled rate change' })
    }
    const id = String(req.params.id)
    const changes = await removeScheduledRateChange(id)
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Silver Rate Change Cancelled',
      module: 'silver-rate',
      entity: `Scheduled change ${id.slice(0, 8)}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, changes })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

app.post('/api/v1/silver/auto-rate/toggle', requirePermission('system', 'edit'), async (req, res) => {
  try {
    const enabled = req.body?.enabled === true
    await setAutoRateEnabled(enabled)
    const actor = actorFromRequest(req)
    void recordActivity({
      action: enabled ? 'Enabled Auto Silver Rate' : 'Disabled Auto Silver Rate',
      module: 'silver-rate',
      entity: 'Auto Rate',
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, enabled })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.post('/api/v1/shopify/orders/sync', requirePermission('shopify', 'create'), async (req, res) => {
  try {
    const result = await importShopifyOrders()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Imported Shopify Orders',
      module: 'shopify',
      entity: 'Orders',
      details: result.ok
        ? `${result.imported ?? 0} imported, ${result.updated ?? 0} updated${result.piiRedacted ? `, ${result.piiRedacted.count} order(s) with redacted customer PII (approve Protected Customer Data in the Shopify admin)` : ''}`
        : `Order sync failed: ${result.errors?.join('; ') ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ ok: false, imported: 0, updated: 0, errors: [message], message: 'Shopify order sync failed' })
  }
})

// Re-fetch a single order from Shopify and update the local copy
app.post('/api/v1/shopify/orders/:id/refresh', requirePermission('shopify', 'create'), async (req, res) => {
  try {
    const { refreshShopifyOrder } = await import('./shopify')
    const result = await refreshShopifyOrder(String(routeParam(req.params.id) ?? '').trim())
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Imported Shopify Orders',
      module: 'shopify',
      entity: `Order ${routeParam(req.params.id)}`,
      details: result.ok ? 'Order refreshed from Shopify' : `Refresh failed: ${result.message ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ ok: false, message })
  }
})

// Order Pipeline: Shopify status, reconciliation, fulfilment, tracking,
// cancellation and archive actions. Unlike the /db router, these routes are
// mounted directly on the app, so authenticate the session before permission
// middleware reads req.userId. Mutation endpoints are authorized by Sales.
app.use('/api/v1/orders/pipeline', requireAuth)
app.get('/api/v1/orders/pipeline/status', requirePermission('sales', 'view'), async (_req, res) => {
  try {
    const { getOrderSyncStatus } = await import('./shopifyOrderPipeline')
    res.json(await getOrderSyncStatus())
  } catch (err) {
    logger.error({ err }, 'Order Pipeline status failed')
    res.status(500).json({ error: 'Could not load order sync status' })
  }
})

app.post('/api/v1/orders/pipeline/reconcile', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { reconcileShopifyOrders } = await import('./shopifyOrderPipeline')
    const days = req.body?.days == null ? undefined : Number(req.body.days)
    const limit = req.body?.limit == null ? undefined : Number(req.body.limit)
    if ((days != null && (!Number.isInteger(days) || days < 1 || days > 365)) || (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 250))) {
      return res.status(400).json({ error: 'days must be 1–365 and limit must be 1–250' })
    }
    const result = await reconcileShopifyOrders({ days, limit })
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Order reconciliation failed' })
  }
})

app.post('/api/v1/orders/pipeline/:id/refresh', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const result = await refreshPipelineOrder(String(routeParam(req.params.id) ?? '').trim(), req)
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Order refresh failed' })
  }
})

app.get('/api/v1/orders/pipeline/:id/shopify-state', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const { getOrderFulfillmentPlan } = await import('./shopifyOrderActions')
    const result = await getOrderFulfillmentPlan(String(routeParam(req.params.id) ?? '').trim())
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Could not read Shopify order state' })
  }
})

app.post('/api/v1/orders/pipeline/:id/fulfill', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const items = req.body?.items
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) return res.status(400).json({ error: 'Select one or more items to fulfill' })
    const parsed = items.map((item: any) => ({ sku: String(item?.sku ?? '').trim(), quantity: Number(item?.quantity) }))
    if (parsed.some((item: { sku: string; quantity: number }) => !item.sku || !Number.isInteger(item.quantity) || item.quantity < 1)) {
      return res.status(400).json({ error: 'Each selected line needs a SKU and a positive whole quantity' })
    }
    const { createOrderFulfillment } = await import('./shopifyOrderActions')
    const result = await createOrderFulfillment(String(routeParam(req.params.id) ?? '').trim(), {
      items: parsed,
      trackingNumber: req.body?.trackingNumber == null ? null : String(req.body.trackingNumber).slice(0, 200),
      trackingCompany: req.body?.trackingCompany == null ? null : String(req.body.trackingCompany).slice(0, 100),
      trackingUrl: req.body?.trackingUrl == null ? null : String(req.body.trackingUrl).slice(0, 1000),
      notifyCustomer: req.body?.notifyCustomer === true,
    })
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Shopify fulfillment failed' })
  }
})

app.patch('/api/v1/orders/pipeline/:id/tracking', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { updateOrderTracking } = await import('./shopifyOrderActions')
    const result = await updateOrderTracking(String(routeParam(req.params.id) ?? '').trim(), {
      trackingNumber: String(req.body?.trackingNumber ?? '').slice(0, 200),
      trackingCompany: req.body?.trackingCompany == null ? null : String(req.body.trackingCompany).slice(0, 100),
      trackingUrl: req.body?.trackingUrl == null ? null : String(req.body.trackingUrl).slice(0, 1000),
      notifyCustomer: req.body?.notifyCustomer === true,
    })
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Shopify tracking update failed' })
  }
})

app.post('/api/v1/orders/pipeline/:id/cancel', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { cancelOrderInShopify, isCancelReason, CANCEL_REASONS } = await import('./shopifyOrderActions')
    const reason = String(req.body?.reason ?? 'OTHER').trim().toUpperCase()
    if (!isCancelReason(reason)) {
      return res.status(400).json({ ok: false, error: `reason must be one of: ${CANCEL_REASONS.join(', ')}` })
    }
    if (req.body?.restock !== undefined && typeof req.body.restock !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'restock must be a boolean' })
    }
    const result = await cancelOrderInShopify(String(routeParam(req.params.id) ?? '').trim(), {
      reason,
      restock: req.body?.restock === true,
      refund: req.body?.refund === true,
      notifyCustomer: req.body?.notifyCustomer === true,
      note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined,
    })
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Shopify cancellation failed' })
  }
})

app.post('/api/v1/orders/pipeline/:id/archive', requirePermission('sales', 'edit'), async (req, res) => {
  try {
    const { archiveOrderInShopify } = await import('./shopifyOrderActions')
    const result = await archiveOrderInShopify(String(routeParam(req.params.id) ?? '').trim())
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Shopify archive failed' })
  }
})

async function refreshPipelineOrder(orderId: string, req: express.Request) {
  const { refreshOrderFromShopify } = await import('./shopifyOrderPipeline')
  const result = await refreshOrderFromShopify(orderId, { actor: actorFromRequest(req).userId ?? 'user' })
  const actor = actorFromRequest(req)
  void recordActivity({
    action: 'Refreshed Shopify Order',
    module: 'shopify',
    entity: `Order ${orderId}`,
    details: result.ok ? (result.updated ? `Updated ${result.changed.join(', ')}` : 'Order is already current') : `Refresh failed: ${result.error}`,
    userId: actor.userId,
    ip: actor.ip,
  })
  return result
}

// Manual trigger for the product auto-sync scheduler
app.post('/api/v1/shopify/products/auto-sync', requirePermission('shopify', 'create'), async (req, res) => {
  try {
    const { runManualProductAutoSync } = await import('./productAutoSync')
    const allowRemovals = req.body?.allowRemovals === true
    const result = await runManualProductAutoSync(allowRemovals)
    res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ ok: false, message })
  }
})

app.get('/api/v1/shopify/products/auto-sync/status', requirePermission('shopify', 'view'), async (_req, res) => {
  try {
    const { getAutoSyncStatus, getAutoSyncHistory } = await import('./productAutoSync')
    res.json({ ...(await getAutoSyncStatus()), history: getAutoSyncHistory() })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

// WhatsApp connection status + test message
app.get('/api/v1/settings/whatsapp-status', requireAuth, requirePermission('system', 'view'), (_req, res) => {
  const { isWhatsAppConfigured } = require('./whatsapp') as typeof import('./whatsapp')
  res.json({
    configured: isWhatsAppConfigured(),
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || null,
  })
})

app.post('/api/v1/settings/test-whatsapp', requireAuth, requirePermission('system', 'edit'), async (req, res) => {
  try {
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : ''
    if (!to.replace(/\D/g, '')) return res.status(400).json({ ok: false, error: 'Provide a phone number "to"' })
    const { sendWhatsAppMessage, isWhatsAppConfigured } = await import('./whatsapp')
    if (!isWhatsAppConfigured()) return res.json({ ok: false, error: 'WhatsApp not configured — set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env' })
    const result = await sendWhatsAppMessage(to, '✅ Test message from your Opal Line ERP — WhatsApp is working.')
    res.json({ ok: result !== null, error: result ? undefined : 'Send failed (check token/phone number id / server logs)' })
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : 'WhatsApp test failed' })
  }
})

// Verify the order-ingest mailbox credentials (IMAP or mail.tm) without scanning
app.post('/api/v1/settings/test-mailbox', requireAuth, requirePermission('system', 'edit'), async (_req, res) => {
  try {
    const { testEmailIngestConnection } = await import('./orderEmailIngest')
    res.json(await testEmailIngestConnection())
  } catch (err) {
    res.json({ ok: false, provider: 'imap', mailbox: null, error: err instanceof Error ? err.message : 'Mailbox test failed' })
  }
})

// Verify Razorpay credentials by fetching the payment pages count (read-only)
app.post('/api/v1/settings/test-razorpay', requireAuth, requirePermission('system', 'edit'), async (_req, res) => {
  try {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim()
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim()
    if (!keyId || !keySecret) {
      return res.json({ ok: false, error: 'Not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET' })
    }
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64')
    const r = await fetch('https://api.razorpay.com/v1/payments?count=1', {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (r.ok) {
      const data = await r.json() as { count?: number; items?: unknown[] }
      const total = typeof data.count === 'number' ? data.count : (data.items?.length ?? 0)
      return res.json({ ok: true, mode: keyId.startsWith('rzp_test') ? 'test' : 'live', message: `Credentials valid — account reachable (${total} payment(s) on record)` })
    }
    if (r.status === 401) return res.json({ ok: false, error: 'Authentication failed — key ID or secret is wrong' })
    const body = await r.json().catch(() => ({})) as { error?: { description?: string } }
    return res.json({ ok: false, error: body.error?.description ?? `Razorpay API error (${r.status})` })
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : 'Razorpay test failed' })
  }
})

// Validate the WhatsApp Cloud API token (GET /me) — no message sent
app.post('/api/v1/settings/test-whatsapp-config', requireAuth, requirePermission('system', 'edit'), async (_req, res) => {
  try {
    const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim()
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim()
    if (!token || !phoneId) {
      return res.json({ ok: false, error: 'Not configured — set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID' })
    }
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}?access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (r.ok) {
      const data = await r.json() as { display_phone_number?: string; verified_name?: string; name?: string }
      const label = data.display_phone_number ?? data.verified_name ?? data.name ?? 'number'
      return res.json({ ok: true, message: `Token valid — WhatsApp business number: ${label}` })
    }
    if (r.status === 401 || r.status === 400) {
      const body = await r.json().catch(() => ({})) as { error?: { message?: string } }
      return res.json({ ok: false, error: body.error?.message ?? 'Token invalid or expired — generate a new access token in Meta Business' })
    }
    return res.json({ ok: false, error: `Meta API error (${r.status})` })
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : 'WhatsApp config test failed' })
  }
})

// Webhook health: what Shopify has registered vs what we expect
app.get('/api/v1/settings/webhook-health', requireAuth, requirePermission('system', 'view'), async (_req, res) => {
  try {
    const { getWebhookHealth } = await import('./webhookRegistration')
    res.json(await getWebhookHealth())
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Webhook health check failed' })
  }
})

app.post('/api/v1/settings/webhook-health/repair', requireAuth, requirePermission('system', 'edit'), async (_req, res) => {
  try {
    const { registerShopifyWebhooks } = await import('./webhookRegistration')
    await registerShopifyWebhooks()
    const { getWebhookHealth } = await import('./webhookRegistration')
    res.json(await getWebhookHealth())
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Webhook repair failed' })
  }
})

// Off-site backup: status + test + manual sync
app.get('/api/v1/settings/offsite-backup', requireAuth, requirePermission('system', 'view'), (_req, res) => {
  const { isOffsiteConfigured } = require('./offsiteBackup') as typeof import('./offsiteBackup')
  res.json({
    configured: isOffsiteConfigured(),
    bucket: process.env.BACKUP_OFFSITE_BUCKET?.trim() ?? null,
    endpoint: process.env.BACKUP_OFFSITE_ENDPOINT?.trim() ?? null,
  })
})

// Encrypted auto-backup toggle + integrity verification
app.get('/api/v1/settings/auto-backup', requireAuth, requirePermission('system', 'view'), async (_req, res) => {
  const { isAutoBackupEncrypted } = await import('./autoBackup')
  res.json({ encrypted: await isAutoBackupEncrypted() })
})

app.post('/api/v1/settings/auto-backup/encrypted', requireAuth, requirePermission('system', 'edit'), async (req, res) => {
  const { setAutoBackupEncrypted } = await import('./autoBackup')
  const value = req.body?.encrypted === true
  await setAutoBackupEncrypted(value)
  res.json({ ok: true, encrypted: value })
})

app.post('/api/v1/backup/verify-all', requireAuth, requirePermission('system', 'edit'), async (_req, res) => {
  const { verifyAllBackups } = await import('./autoBackup')
  res.json(await verifyAllBackups())
})

app.post('/api/v1/settings/offsite-backup/test', requireAuth, requirePermission('system', 'edit'), async (_req, res) => {
  const { testOffsiteConnection } = await import('./offsiteBackup')
  res.json(await testOffsiteConnection())
})

app.post('/api/v1/settings/offsite-backup/sync', requireAuth, requirePermission('system', 'edit'), async (_req, res) => {
  const { syncBackupsOffsite } = await import('./offsiteBackup')
  res.json(await syncBackupsOffsite())
})

// Read/update product auto-sync interval (seconds; 0 = disabled). Also accepts value + unit or legacy intervalHours.
app.get('/api/v1/shopify/products/auto-sync/interval', requirePermission('shopify', 'view'), async (_req, res) => {
  try {
    const { getAutoSyncIntervalSeconds, getAutoSyncIntervalHours, formatAutoSyncInterval } = await import('./productAutoSync')
    const intervalSeconds = await getAutoSyncIntervalSeconds()
    res.json({
      intervalSeconds,
      intervalHours: await getAutoSyncIntervalHours(),
      intervalLabel: formatAutoSyncInterval(intervalSeconds),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.post('/api/v1/shopify/products/auto-sync/interval', requirePermission('shopify', 'edit'), async (req, res) => {
  try {
    const { resolveAutoSyncIntervalSeconds, setAutoSyncIntervalSeconds, getAutoSyncIntervalSeconds, formatAutoSyncInterval } = await import('./productAutoSync')
    const resolved = resolveAutoSyncIntervalSeconds((req.body ?? {}) as Record<string, unknown>)
    if (typeof resolved === 'object' && 'error' in resolved) {
      return res.status(400).json({ error: resolved.error })
    }
    await setAutoSyncIntervalSeconds(resolved)
    const { stopProductAutoSync, startProductAutoSync } = await import('./productAutoSync')
    stopProductAutoSync()
    startProductAutoSync()
    const intervalSeconds = await getAutoSyncIntervalSeconds()
    res.json({ ok: true, intervalSeconds, intervalLabel: formatAutoSyncInterval(intervalSeconds) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

// Order auto-sync: how fresh the Sales Orders feed is, and the interval knob.
app.get('/api/v1/shopify/orders/auto-sync', requirePermission('shopify', 'view'), async (_req, res) => {
  try {
    const intervalSeconds = await getOrderSyncIntervalSeconds()
    res.json({ ...getOrderAutoSyncStatus(), intervalSeconds, enabled: intervalSeconds > 0 })
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

app.post('/api/v1/shopify/orders/auto-sync', requirePermission('shopify', 'edit'), async (req, res) => {
  try {
    const raw = (req.body ?? {}).intervalSeconds
    if (raw === undefined || raw === null || raw === '') {
      return res.status(400).json({ error: 'intervalSeconds is required (0 disables)' })
    }
    const intervalSeconds = parseOrderSyncIntervalSeconds(raw)
    const { db } = await import('./db/client')
    const schemaMod = await import('./db/schema')
    const { eq } = await import('drizzle-orm')
    if (!db) return res.status(503).json({ error: 'Database unavailable' })
    const [row] = await db.select({ notificationSettings: schemaMod.settings.notificationSettings }).from(schemaMod.settings).where(eq(schemaMod.settings.id, 'app')).limit(1)
    const current = (row?.notificationSettings ?? {}) as Record<string, unknown>
    await db.update(schemaMod.settings).set({ notificationSettings: { ...current, orderAutoSyncIntervalSeconds: intervalSeconds } }).where(eq(schemaMod.settings.id, 'app'))
    stopOrderAutoSync()
    if (intervalSeconds > 0) startOrderAutoSync()
    res.json({ ok: true, intervalSeconds: await getOrderSyncIntervalSeconds(), ...getOrderAutoSyncStatus() })
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// Email (SMTP) connection test
app.post('/api/v1/settings/test-email', requireAuth, requirePermission('system', 'edit'), async (req, res) => {
  try {
    const to = typeof req.body?.to === 'string' && req.body.to.includes('@') ? req.body.to.trim() : process.env.NOTIFICATION_EMAIL?.trim()
    if (!to) return res.status(400).json({ ok: false, error: 'No recipient: provide "to" or set NOTIFICATION_EMAIL in .env' })
    const { sendEmail } = await import('./notifications')
    const sent = await sendEmail({
      to,
      subject: 'Opal Line — test email',
      html: '<p>This is a test email from your Opal Line ERP. If you received this, email sending is working.</p>',
    })
    res.json({ ok: sent, to, error: sent ? undefined : 'Send failed — check RESEND_API_KEY or NOTIFICATION_SMTP_* env vars / server logs' })
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : 'SMTP test failed' })
  }
})

app.post('/api/v1/shopify/customers/sync', requirePermission('shopify', 'create'), async (req, res) => {
  try {
    const { importShopifyCustomers } = await import('./shopify')
    const result = await importShopifyCustomers()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Imported Shopify Customers',
      module: 'shopify',
      entity: 'Customers',
      details: result.ok ? `${result.imported ?? 0} imported, ${result.updated ?? 0} updated` : `Customer sync failed: ${result.errors?.join('; ') ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ ok: false, imported: 0, updated: 0, errors: [message], message: 'Shopify customer sync failed' })
  }
})

// PII recovery: run the full fallback chain on demand.
// 1) poll the order-notification mailbox (emails are never redacted),
// 2) retry Admin API enrichment (works once PII access is approved),
// 3) report the residue that only the Shopify customers CSV export can fill.
app.post('/api/v1/shopify/recover-pii', requirePermission('shopify', 'create'), async (req, res) => {
  try {
    const result: Record<string, unknown> = {}
    if (isEmailIngestConfigured()) {
      result.email = await pollOrderMailbox()
    } else {
      result.email = { ok: false, skipped: true, reason: 'Email ingestion not configured (ORDER_EMAIL_ADDRESS / ORDER_EMAIL_PASSWORD)' }
    }
    const { enrichOrdersFromShopify, enrichCustomersFromShopify, missingPiiCustomerCount } = await import('./shopifyDataEnhance')
    if (!isPiiAccessDenied()) {
      result.api = {
        orders: await enrichOrdersFromShopify(),
        customers: await enrichCustomersFromShopify(),
      }
    } else {
      result.api = { skipped: true, reason: 'Shopify denies Customer PII over the API (plan-gated) — approve access in the Shopify admin or use the CSV export' }
    }
    // Also check whether the customer-export CSV has arrived in the mailbox.
    try {
      const { pollCustomerExport } = await import('./orderEmailIngest')
      result.customerExport = await pollCustomerExport()
    } catch (err) {
      result.customerExport = { ok: false, errors: [err instanceof Error ? err.message : 'export poll failed'] }
    }
    result.remainingWithoutPii = await missingPiiCustomerCount()
    result.csvFallback = {
      message: 'Export customers from Shopify Admin → Customers → Export and import the CSV on this page (Shopify → Data Import).',
    }
    void recordActivity({
      action: 'Recovered Shopify Customer PII',
      module: 'shopify',
      entity: 'Customers',
      details: `email: ${JSON.stringify(result.email).slice(0, 200)} | remaining without PII: ${result.remainingWithoutPii}`,
      userId: actorFromRequest(req).userId,
      ip: actorFromRequest(req).ip,
    })
    res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.post('/api/v1/shopify/enrich', requirePermission('shopify', 'view'), async (req, res) => {
  try {
    const { enrichAllIncompleteOrders } = await import('./shopifyDataEnhance')
    const result = await enrichAllIncompleteOrders()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Enriched Shopify Orders',
      module: 'shopify',
      entity: 'Orders',
      details: `${result.enriched} enriched, ${result.failed} failed, ${result.skipped} skipped`,
      userId: actor.userId,
      ip: actor.ip,
    })
    // ACCESS_DENIED is a blocked batch, not a successful one — say so.
    res.json({ ok: !result.piiAccessDenied, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ ok: false, enriched: 0, failed: 0, skipped: 0, errors: [message], message: 'Enrichment failed' })
  }
})

/**
 * Attach a Shopify order to its local sales_orders row.
 *
 * `sales_orders.shopify_id` is UNIQUE and imported Shopify orders already own
 * their display name (`#1019`, …). Claiming a name another row holds is exactly
 * what made `insert into "sales_orders"` fail with 23505, so the name is only
 * written when it is free. The gid is always recorded: it is the identity every
 * Admin GraphQL action uses and the marker that stops a sync retry from
 * creating a second Shopify order.
 */
async function linkShopifyOrderToRow(input: {
  orderId: string
  result: Pick<DraftOrderResult, 'name' | 'orderGid'>
}): Promise<{ order: Record<string, unknown> | null; warning: string | null }> {
  if (!db) return { order: null, warning: null }
  const name = input.result.name?.trim()
  let takenByAnotherRow = false
  if (name) {
    const [clash] = await db
      .select({ id: schema.salesOrders.id })
      .from(schema.salesOrders)
      .where(and(eq(schema.salesOrders.shopifyId, name), ne(schema.salesOrders.id, input.orderId)))
      .limit(1)
    takenByAnotherRow = Boolean(clash)
  }

  const write = async (claimName: boolean) => {
    const [row] = await db!
      .update(schema.salesOrders)
      .set({
        ...(claimName && name ? { shopifyId: name } : {}),
        ...(input.result.orderGid ? { shopifyGid: input.result.orderGid } : {}),
        shopifySyncedAt: new Date().toISOString(),
      })
      .where(eq(schema.salesOrders.id, input.orderId))
      .returning()
    return (row ?? null) as Record<string, unknown> | null
  }

  try {
    const order = await write(!takenByAnotherRow)
    return {
      order,
      warning: takenByAnotherRow
        ? `Shopify named the order "${name}", but another local order already uses that reference; this order keeps its ERP reference (its Shopify gid is stored).`
        : null,
    }
  } catch (err) {
    // A concurrent Shopify import can claim the name between the check and the
    // write. The sale is already saved and the Shopify order exists, so keep the
    // ERP reference instead of failing the request.
    const info = dbErrorInfo(err)
    logger.warn(
      { err: { code: info.code, constraint: info.constraint, message: info.message }, orderId: input.orderId },
      'Could not claim the Shopify order name; keeping the ERP reference',
    )
    const order = await write(false)
    return {
      order,
      warning: `Shopify named the order "${name ?? 'unknown'}", but that reference is already used locally; this order keeps its ERP reference.`,
    }
  }
}

/**
 * Catalogue inputs for order lines, answered for WHATEVER code a line carries.
 *
 * A variant line sends its parent SKU as `productSku` — and a scan path may
 * send only the variant's own code — so both are answered from the parent row:
 * net weight, making charge, and the piece-rate flag a fixed-price line must
 * bill from. The result carries one entry per code it answers (parent SKU and
 * every matched variant SKU), which is exactly what `buildPricedOrder`'s
 * sku map looks up.
 */
async function loadOrderProductData(codes: Array<string | null | undefined>): Promise<OrderCatalogueRow[]> {
  const skus = [...new Set(codes.map((c) => String(c ?? '').trim()).filter(Boolean))]
  if (skus.length === 0 || !db) return []
  const variantRows = await db
    .select({
      sku: schema.productVariants.sku,
      productId: schema.productVariants.productId,
      title: schema.productVariants.title,
      optionValues: schema.productVariants.optionValues,
      priceAdjustment: schema.productVariants.priceAdjustment,
      sellingPrice: schema.productVariants.sellingPrice,
    })
    .from(schema.productVariants)
    .where(inArray(schema.productVariants.sku, skus))
  const parentIds = [...new Set(variantRows.map((v) => v.productId))]
  const rows = await db
    .select({
      id: schema.products.id,
      sku: schema.products.sku,
      netWeight: schema.products.netWeight,
      makingCharge: schema.products.makingCharge,
      pieceRateProduct: schema.products.pieceRateProduct,
      fixedPieceRate: schema.products.fixedPieceRate,
      sellingPrice: schema.products.sellingPrice,
    })
    .from(schema.products)
    .where(
      parentIds.length > 0
        ? or(inArray(schema.products.sku, skus), inArray(schema.products.id, parentIds))
        : inArray(schema.products.sku, skus),
    )
  const toRow = (r: (typeof rows)[number]): OrderCatalogueRow => ({
    sku: r.sku,
    netWeight: r.netWeight,
    makingCharge: r.makingCharge,
    pieceRateProduct: r.pieceRateProduct,
    fixedPieceRate: r.fixedPieceRate,
    sellingPrice: r.sellingPrice,
  })
  const out = rows.map(toRow)
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const v of variantRows) {
    const parent = byId.get(v.productId)
    // The variant's own code answers with the parent's pricing inputs: a
    // variant carries no weight/charge/flag columns of its own. Its ADD-ON is
    // the one exception, and travels with the alias so a scan (which sends
    // only the variant SKU) still prices at base + add-on.
    if (parent) {
      const legacyAddOn = isDefaultVariantRow(v.title, v.optionValues) ? 0 : v.sellingPrice
      out.push({
        ...toRow(parent),
        sku: v.sku,
        priceAdjustment: v.priceAdjustment ?? legacyAddOn,
      })
    }
  }
  return out
}

/**
 * Order lines shaped for the Shopify draft: a line that billed a variant must
 * target THAT Shopify variant (`product_variants.shopify_variant_id`), never
 * the local row id — wrapping a local UUID in `gid://shopify/ProductVariant/…`
 * names a variant the shop does not have. A variant with no Shopify id falls
 * back to the historic title/sku/price line instead of a bogus gid.
 */
async function shopifyDraftLines(lines: ReadonlyArray<unknown> | null | undefined): Promise<ReturnType<typeof draftOrderInputLines>> {
  if (!Array.isArray(lines)) return []
  const localIds = [
    ...new Set(
      lines
        .map((li) => String((li as { variantId?: unknown } | null)?.variantId ?? '').trim())
        .filter(Boolean),
    ),
  ]
  const shopifyIds = new Map<string, string>()
  if (localIds.length > 0 && db) {
    const rows = await db
      .select({ id: schema.productVariants.id, shopifyVariantId: schema.productVariants.shopifyVariantId })
      .from(schema.productVariants)
      .where(inArray(schema.productVariants.id, localIds))
    for (const r of rows) {
      const gid = String(r.shopifyVariantId ?? '').trim()
      if (gid) shopifyIds.set(r.id, gid)
    }
  }
  return draftOrderInputLines(resolveShopifyVariantTargets(lines, shopifyIds))
}

// Shopify Flow webhook — receives full order + customer data from a Shopify Flow
// This bypasses the Admin API PII limitations on development stores.
// The Flow sends: order name, customer name, email, phone, billing/shipping addresses
app.post('/api/v1/shopify/orders/create', requirePermission('shopify', 'create'), validate(createOrderSchema), async (req, res) => {
  const { customer, email, phone, payment: rawPayment, fulfillment: rawFulfillment, status, date, note, items, billingAddress, shippingAddress, syncToShopify, locationId: reqLocation } = req.body

  // Normalize payment and fulfillment values to handle non-standard values from Shopify/webhooks
  const payment = rawPayment === 'Online' || rawPayment === 'online' ? 'paid' : (rawPayment ?? 'pending')
  const fulfillment = rawFulfillment === 'pending' ? 'unfulfilled' : (rawFulfillment ?? 'unfulfilled')

  // Get the current applied silver rate from Silver Rate Management
  const latestRate = await getLatestSilverRate()
  if (!latestRate || !latestRate.rate || latestRate.rate <= 0) {
    return res.status(400).json({ error: 'Current silver rate is not available. Please update the rate in Silver Rate Management before creating orders.' })
  }
  const silverRate = latestRate.rate

  if (!db) {
    return res.status(503).json({ error: 'Database unavailable' })
  }

  // Calculate item prices using the current silver rate and product data.
  // The catalogue rows answer for the parent SKU AND any variant code the
  // lines carry, so a variant line prices (and piece-rates) like its parent.
  const productData = await loadOrderProductData(
    items.map((li: { sku?: string; productSku?: string }) => li.productSku ?? li.sku),
  )
  // Price the lines with the authoritative silver rate — canonical invoice
  // formula, extracted so the per-unit convention is unit-testable. Each
  // line's stored price is PER-UNIT and GST-inclusive: every consumer (the
  // edit dialog's subtotal, the print doc, the update handler's value)
  // multiplies it by quantity exactly once. Piece Rate lines take their fixed
  // ₹/pc instead (see buildPricedOrder).
  const priced = buildPricedOrder(items as ValidatedOrderItem[], productData, silverRate)
  const itemsWithCalculatedPrice = priced.lines
  const value = priced.grandTotal
  const itemCount = priced.itemCount

  const now = new Date()
  const internalId = `MO-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${now.getTime().toString().slice(-6)}`

  // For Shopify draft order, the ERP line price is already PER-UNIT and
  // GST-inclusive — exactly what a draft line's originalUnitPrice expects.
  // (Remapping it to the full line total amount × 1.03 made Shopify bill that
  // total per unit, so a qty-3 manual order arrived on Shopify at ~3× its value.)
  // A variant line resolves to the shop's own variant id here.
  const shopifyLineItems = await shopifyDraftLines(itemsWithCalculatedPrice)

  if (!db) {
    return res.status(503).json({ error: 'Service temporarily unavailable' })
  }

  const customerCity = billingAddress?.city ? String(billingAddress.city).trim() : undefined

  let order: Record<string, unknown> | null = null
  // Which customer row this order belongs to, so the Shopify customer id from
  // the (now post-save) sync can still be recorded against it.
  let orderCustomerId: string | null = null
  const affectedProductIds: string[] = []
  try {
    await db.transaction(async (tx) => {
      // Where this order was rung up. Absent means the default store, which is
      // where such orders already went before locations existed.
      const locationId = await resolveMovementLocation(reqLocation as string | undefined, tx as never)
      for (const li of itemsWithCalculatedPrice) {
        // Resolves variant SKUs through product_variants (their stock is a
        // counter the parent rollup mirrors), checks availability AT this
        // location and rejects unknown SKUs instead of silently skipping them.
        const deducted = await deductOrderLineStock({
          tx,
          locationId,
          sku: String(li.sku ?? ''),
          qty: Number(li.quantity ?? 0),
        })
        if (deducted) affectedProductIds.push(deducted.productId)
      }

      const [row] = await tx
        .insert(schema.salesOrders)
        .values({
          id: randomUUID(),
          // The ERP row is saved under its own MO-… reference. The Shopify
          // order (draft completion) is synced afterwards, when this order is
          // already safely stored: a Shopify-assigned name that is already used
          // locally can no longer abort the sale, and a failed save can no
          // longer leave an orphan Shopify order that a retry duplicates.
          shopifyId: internalId,
          internalId,
          customer,
          value: Math.round(value * 100) / 100,
          payment: payment ?? 'pending',
          fulfillment: fulfillment ?? 'unfulfilled',
          invoice: null,
          status: String(status ?? '').trim() || 'confirmed',
          date: date ? new Date(date).toISOString() : now.toISOString(),
          items: itemCount,
          tags: 'manual-order',
          currency: 'INR',
          discount: 0,
          lineItems: itemsWithCalculatedPrice,
          billingAddress: billingAddress ?? null,
          shippingAddress: shippingAddress ?? null,
          locationId,
          // Keep the order's own contact row filled even when the customer
          // record lookup above matches nothing — the invoice generator and
          // the PII repair both read these columns.
          ...(email ? { customerEmail: String(email).trim() } : {}),
          ...(phone ? { customerPhone: String(phone).trim() } : {}),
        })
        .returning()
      order = row

      // Customer matching: identity keys only (email/phone/shopifyId).
      // Never match on name — two different customers can share a name, and
      // merging them corrupts orders/totalSpent stats.
      // Accept any id form (bare numeric or gid://shopify/Customer/…) and
      // store/match only the bare numeric form — mixed formats defeat the
      // shopifyId identity match and duplicate customers.
      const identityConditions = []
      if (email) identityConditions.push(eq(schema.customers.email, email))
      if (phone) identityConditions.push(eq(schema.customers.phone, phone))
      const [existing] = identityConditions.length
        ? await tx.select().from(schema.customers).where(or(...identityConditions)).limit(1)
        : []
      if (existing) {
        orderCustomerId = existing.id
        await tx
          .update(schema.customers)
          .set({
            name: customer,
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            ...(customerCity ? { city: customerCity } : {}),
            status: existing.status ?? 'active',
          })
          .where(eq(schema.customers.id, existing.id))
      } else {
        orderCustomerId = randomUUID()
        await tx.insert(schema.customers).values({
          id: orderCustomerId,
          name: customer,
          email: email ?? null,
          phone: phone ?? null,
          city: customerCity ?? null,
          shopifyId: null,
          orders: 0,
          totalSpent: 0,
          status: 'active',
          joined: now.toISOString().slice(0, 10),
        })
      }
    })
  } catch (err) {
    // Log the driver error whole (code, constraint, column, detail) and give the
    // operator the cause instead of Drizzle's "Failed query: insert into …"
    // wrapper. A database error must never be hidden.
    const info = dbErrorInfo(err)
    logger.error(
      { err: { code: info.code, constraint: info.constraint, column: info.column, table: info.table, detail: info.detail, message: info.message, stack: err instanceof Error ? err.stack : undefined }, internalId },
      'Manual order save failed',
    )
    return res.status(400).json({ error: `Could not save the order: ${describeDbError(err)}` })
  }

  // A manual order explicitly created as cancelled never becomes a Shopify
  // order. Its stock was deducted a moment ago, so release it exactly once and
  // stamp the cancellation instead of leaving an unmarked cancelled row.
  const cancelledOnCreate = String((order as Record<string, unknown> | null)?.status ?? '').toLowerCase() === 'cancelled'
  if (cancelledOnCreate) {
    const id = String((order as Record<string, unknown> | null)?.id ?? '')
    if (id) {
      const { cancelLocalOrderOnce } = await import('./shopifyOrderActions')
      await cancelLocalOrderOnce(id, { restoreEvenIfCancelled: true })
      const [fresh] = await db.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, id)).limit(1)
      if (fresh) order = fresh as unknown as Record<string, unknown>
    }
  }

  // ── Shopify sync (after the order is stored) ────────────────────────────
  // The local order is the source of truth. Only once it exists do we push it
  // to Shopify with the payment mode the operator picked (`payment` drives
  // draftOrderComplete's paymentPending), then record the Shopify identity on
  // the row. A sync failure is reported, never rolled back over the sale.
  let shopifySync: DraftOrderResult | null = null
  if (syncToShopify && !cancelledOnCreate) {
    const draft = await createShopifyDraftOrder({
      customerName: customer,
      customerEmail: email,
      customerPhone: phone,
      payment,
      billingAddress,
      shippingAddress,
      note: note ?? `Manual order created from Opal Line ERP (${internalId})`,
      tags: 'manual-order',
      lineItems: shopifyLineItems,
    })
    shopifySync = draft
    // (the transaction callback above is invisible to control-flow analysis, so
    // the row is read through an explicit cast rather than narrowed to null)
    const savedOrder = order as Record<string, unknown> | null
    if (draft.ok && savedOrder?.id) {
      const link = await linkShopifyOrderToRow({ orderId: String(savedOrder.id), result: draft })
      if (link.order) order = link.order
      if (link.warning) {
        shopifySync = {
          ...draft,
          message: [draft.message, link.warning].filter(Boolean).join(' '),
        }
      }
    }
    // The draft order resolved (or created) a Shopify customer. Store its id on
    // the local customer row, normalised to the bare numeric form the identity
    // match expects. Best-effort: the order is already saved.
    const linkedCustomerId = draft.customerId ? normalizeShopifyCustomerId(draft.customerId) : null
    if (linkedCustomerId && orderCustomerId) {
      try {
        await db
          .update(schema.customers)
          .set({ shopifyId: linkedCustomerId })
          .where(eq(schema.customers.id, orderCustomerId))
      } catch (err) {
        logger.warn({ err: { message: err instanceof Error ? err.message : String(err) }, orderCustomerId }, 'Could not store the Shopify customer id after order sync')
      }
    }
  }

  // The ERP sale owns its invoice: raise it in the same request through the
  // same idempotent pipeline the Shopify import uses. Stock was already
  // deducted above, so the invoice must not move it a second time. A cancelled
  // (or booking) order is never invoiced; the order itself stays at the stage
  // the operator chose.
  let autoInvoice: string | null = null
  let autoInvoiceError: string | null = null
  {
    const savedRow = order as typeof schema.salesOrders.$inferSelect | null
    if (savedRow && String(savedRow.status ?? '').toLowerCase() !== 'cancelled' && !savedRow.isBooking) {
      try {
        if (savedRow.invoice) {
          autoInvoice = savedRow.invoice
        } else {
          const { createInvoiceForOrderRow } = await import('./orderEmailIngest')
          autoInvoice = await createInvoiceForOrderRow(savedRow, { deductStock: false })
        }
        if (autoInvoice) {
          const [fresh] = await db
            .select()
            .from(schema.salesOrders)
            .where(eq(schema.salesOrders.id, savedRow.id))
            .limit(1)
          if (fresh) order = fresh as unknown as Record<string, unknown>
        }
      } catch (err) {
        autoInvoiceError = err instanceof Error ? err.message : 'Invoice generation failed'
        logger.error({ err, orderId: savedRow.id }, 'ERP order auto-invoice failed')
      }
    }
  }

  // Stats are derived, never accumulated: recount from real orders so the
  // numbers can never drift from the underlying data.
  try {
    await recountCustomerStats('orders')
  } catch (err) {
    logger.warn({ err }, 'Customer stats recount failed after order create')
  }

  if (affectedProductIds.length > 0) {
    void pushInventoryToShopify(affectedProductIds).catch((err) => {
      logger.error({ err: { message: err.message }, ids: affectedProductIds }, 'Failed to push inventory to Shopify after order')
    })
  }

  const actor = actorFromRequest(req)
  void recordActivity({
    action: 'Created Sales Order',
    module: 'sales',
    entity: `Sales Order ${String(order?.shopifyId ?? internalId)}`,
    details: `${customer} - ${itemCount} item(s), Rs${value.toFixed(2)}${syncToShopify ? ' (synced to Shopify)' : ''}`,
    userId: actor.userId,
    ip: actor.ip,
  })

  res.status(201).json({ order, shopifySync, autoInvoice, autoInvoiceError })
})

app.patch('/api/v1/shopify/orders/:id', requirePermission('shopify', 'edit'), validate(updateOrderSchema), async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Service temporarily unavailable' })
  }

  try {
    const [existing] = await db
      .select()
      .from(schema.salesOrders)
      .where(eq(schema.salesOrders.id, routeParam(req.params.id)))
      .limit(1)
    if (!existing) return res.status(404).json({ error: 'Order not found' })

    const { customer, email, phone, payment: rawPayment, fulfillment: rawFulfillment, status, date, note, items, billingAddress, shippingAddress, syncToShopify } = req.body

    // Normalize payment and fulfillment values
    const payment = rawPayment === 'Online' || rawPayment === 'online' ? 'paid' : rawPayment
    const fulfillment = rawFulfillment === 'pending' ? 'unfulfilled' : rawFulfillment
    const requestedStatus = status === undefined ? null : String(status).trim().toLowerCase()
    const cancelling = requestedStatus === 'cancelled'
    const wasCancelled = String(existing.status ?? '').toLowerCase() === 'cancelled'

    // The edit dialog used to write status='cancelled' straight to the row:
    // no Shopify cancellation, no stock restore and no cancelled_at. Route the
    // transition through the same lifecycle as the dedicated Cancel action.
    if (cancelling && !wasCancelled) {
      const { cancelOrderLifecycle } = await import('./shopifyOrderActions')
      const cancelled = await cancelOrderLifecycle(existing.id)
      if (!cancelled.ok) return res.status(502).json({ error: cancelled.error ?? 'Order could not be cancelled' })
    }

    let value = Number(existing.value ?? 0)
    let itemCount = Number(existing.items ?? 0)
    let mappedLineItems: Array<Record<string, unknown>> | null = null
    // A cancellation restores the existing lines exactly once. Applying edited
    // lines first would deduct the new basket and then restock it, leaving the
    // cancelled order's stock wrong.
    if (items && !cancelling) {
      // Lines carry their weight & pricing snapshot — the order→invoice
      // generator reads weight/silverValue/makingValue/amount straight off
      // manual orders, so an edit must keep that snapshot coherent instead of
      // stripping it to {title, sku, qty, price} and invoicing ₹0 later.
      // The catalogue rows answer for the parent SKU and any variant code, so
      // a variant line keeps its parent's piece-rate flag through an edit.
      const productRows = await loadOrderProductData(items.map((li: any) => li.productSku ?? li.sku))
      const productMap = new Map(productRows.map((p) => [String(p.sku ?? '').trim(), p]))
      const latestRate = await getLatestSilverRate()
      const currentRate = latestRate && latestRate.rate && latestRate.rate > 0 ? latestRate.rate : 0

      const mapped = items
        .map((li: any) => {
          const title = String(li.title ?? li.name ?? '').trim()
          const sku = String(li.sku ?? '')
          const quantity = Math.max(0, Math.floor(Number(li.quantity ?? li.qty ?? 0)) || 0)
          const price = Number(li.price ?? 0)
          // Same weight rules as create: the form's value wins, the catalogue
          // fills in when the form sent none, total = qty × weight per piece.
          const product: OrderCatalogueRow = productMap.get(String(li.productSku ?? sku).trim()) ?? { sku: null, netWeight: 0, makingCharge: 0 }
          const formWeightPerPiece = Number(li.netWeight ?? 0)
          const netWeight = formWeightPerPiece > 0 ? formWeightPerPiece : Number(product.netWeight ?? 0)
          const isPieceRate = fixedPieceRateFor(product) != null
          const addOn = Math.round((Number(li.priceAdjustment ?? product.priceAdjustment ?? 0) || 0) * 100) / 100
          const makingCharge =
            li.makingCharge === undefined || li.makingCharge === null
              ? Number(product.makingCharge ?? 0)
              : Number(li.makingCharge)
          const formTotalWeight = Number(li.weight ?? 0)
          const weight =
            formTotalWeight > 0
              ? Math.round(formTotalWeight * 1000) / 1000
              : netWeight > 0
                ? Math.round(netWeight * quantity * 1000) / 1000
                : 0
          // Snapshot derived from the stored per-unit price so invoicing an
          // edited order reproduces its order value exactly (amount is the
          // ex-GST half of price × qty; the silver/making split follows the
          // current rate — identical to create's split while the rate holds).
          // A Piece Rate line has no silver/making split to follow: its whole
          // taxable amount sits in silverValue, exactly as create stores it.
          const lineTotal = Math.round(price * quantity * 100) / 100
          const amount = Math.round((lineTotal / (1 + ORDER_GST_RATE / 100)) * 100) / 100
          const splitBase = currentRate + Math.max(makingCharge, 0)
          const splitByRate = weight > 0 && currentRate > 0 && splitBase > 0
          const silverValue = isPieceRate || !splitByRate
            ? amount
            : Math.round(amount * (currentRate / splitBase) * 100) / 100
          const makingValue = isPieceRate ? 0 : Math.round((amount - silverValue) * 100) / 100
          return {
            title,
            sku,
            quantity,
            price,
            priceAdjustment: addOn,
            makingCharge: isPieceRate ? 0 : makingCharge,
            ...(netWeight > 0 ? { netWeight } : {}),
            ...(weight > 0 ? { weight, silverRate: isPieceRate ? 0 : currentRate } : { silverRate: 0 }),
            ...(weight > 0 ? { silverValue, makingValue } : { silverValue: amount, makingValue: 0 }),
            amount,
            ...(li.variantId !== undefined && li.variantId !== null ? { variantId: li.variantId } : {}),
            ...(li.productSku ? { productSku: String(li.productSku) } : {}),
          }
        })
        .filter((li: any) => li.title && li.quantity > 0)
      if (mapped.length > 0) {
        value = Math.round(mapped.reduce((s: number, li: any) => s + li.price * li.quantity, 0) * 100) / 100
        itemCount = mapped.reduce((s: number, li: any) => s + li.quantity, 0)
        mappedLineItems = mapped
      }
    }

    const updates: Record<string, unknown> = {
      customer: customer !== undefined ? String(customer).trim() || existing.customer : existing.customer,
      payment: payment !== undefined ? String(payment) : existing.payment,
      fulfillment: fulfillment !== undefined ? String(fulfillment) : existing.fulfillment,
      status: status !== undefined ? String(status) : existing.status,
      value,
      items: itemCount,
      ...(mappedLineItems ? { lineItems: mappedLineItems } : {}),
      ...(cancelling
        ? { cancelledAt: new Date().toISOString() }
        : wasCancelled
          ? { cancelledAt: null }
          : {}),
    }
    if (date) updates.date = new Date(String(date)).toISOString()
    // Contact & address edits made in the order dialog must survive the save
    // (they previously only fed the Shopify sync and were dropped from the row).
    if (billingAddress !== undefined) updates.billingAddress = billingAddress
    if (shippingAddress !== undefined) updates.shippingAddress = shippingAddress
    if (email !== undefined) updates.customerEmail = String(email).trim() || null
    if (phone !== undefined) updates.customerPhone = String(phone).trim() || null

    // If line items changed, rebalance product stock: restore the previous
    // items' stock, then deduct stock for the new items (mirroring the create
    // flow). Done atomically so a partial change can't leave inventory wrong.
    const affectedProductIds: string[] = []
    let updated = null
    if (mappedLineItems) {
      const oldItems: Array<{ sku?: string | null; quantity?: number | null }> = Array.isArray(existing.lineItems)
        ? (existing.lineItems as Array<{ sku?: string | null; quantity?: number | null }>)
        : []
      updated = await db.transaction(async (tx) => {
        // Reversals go back to the location the order was rung up at, never to
        // the default store — otherwise editing a branch order would silently
        // restock the wrong shop. NULL means the order predates locations,
        // which is exactly where its movements already went.
        const locationId = await resolveMovementLocation(existing.locationId as string | null, tx as never)
        for (const oi of oldItems) {
          // Restore resolves variant SKUs too, so editing a variant line gives
          // its stock back instead of deducting the new line on top of an
          // unrestored old one (the silent double deduction).
          await restoreOrderLineStock({
            tx,
            locationId,
            sku: String(oi?.sku ?? ''),
            qty: Number(oi?.quantity ?? 0),
          })
        }
        for (const li of mappedLineItems) {
          const deducted = await deductOrderLineStock({
            tx,
            locationId,
            sku: String(li.sku ?? ''),
            qty: Number(li.quantity ?? 0),
          })
          if (deducted) affectedProductIds.push(deducted.productId)
        }
        const [u] = await tx
          .update(schema.salesOrders)
          .set(updates)
          .where(eq(schema.salesOrders.id, routeParam(req.params.id)))
          .returning()
        return u
      })
    } else {
      const [u] = await db
        .update(schema.salesOrders)
        .set(updates)
        .where(eq(schema.salesOrders.id, routeParam(req.params.id)))
        .returning()
      updated = u
    }

    let shopifySync: DraftOrderResult | null = null
    if (syncToShopify && !cancelling) {
      const storedShopifyId = typeof updated.shopifyId === 'string' ? updated.shopifyId : ''
      if (storedShopifyId.startsWith('#')) {
        const result = await updateShopifyOrder({
          orderName: storedShopifyId,
          email: email ? String(email).trim() : undefined,
          note: note ? String(note).trim() : undefined,
          tags: 'manual-order',
          shippingAddress,
        })
        shopifySync = result
        if (result.ok) {
          const [fresh] = await db
            .update(schema.salesOrders)
            .set({ shopifySyncedAt: new Date().toISOString() })
            .where(eq(schema.salesOrders.id, routeParam(req.params.id)))
            .returning()
          if (fresh) updated = fresh
        }
      } else if (updated.shopifyGid) {
        // Already on Shopify, but under a gid whose display name belongs to
        // another local order. Creating a draft here would put a second order
        // on Shopify, so say what is already there instead.
        shopifySync = {
          ok: true,
          errors: [],
          message: `This order is already linked to Shopify (${String(updated.shopifyGid)}); no new Shopify order was created.`,
        }
      } else if (storedShopifyId) {
        // First-time sync retry: an ERP-native order (shopifyId is the internal
        // "MO-…" reference) that was saved while Shopify was down, unconfigured,
        // or when its first draft attempt failed. The old code only updated '#'
        // orders, so such an order could never reach Shopify — creating the draft
        // now from the stored order; its returned identity is recorded on the row
        // (the display name only when no other local order already owns it).
        const draft = await createShopifyDraftOrder({
          customerName: String(updated.customer ?? '').trim() || undefined,
          customerEmail: email ? String(email).trim() : (updated.customerEmail ?? undefined) || undefined,
          customerPhone: phone ? String(phone).trim() : (updated.customerPhone ?? undefined) || undefined,
          payment: String(updated.payment ?? 'pending'),
          billingAddress: (updated.billingAddress as DraftOrderAddressInput | null | undefined) ?? undefined,
          shippingAddress: ((shippingAddress ?? updated.shippingAddress) as DraftOrderAddressInput | null | undefined) ?? undefined,
          note: note ? String(note).trim() : undefined,
          tags: 'manual-order',
          lineItems: await shopifyDraftLines(updated.lineItems as ReadonlyArray<unknown> | null),
        })
        shopifySync = draft
        if (draft.ok) {
          const link = await linkShopifyOrderToRow({ orderId: routeParam(req.params.id), result: draft })
          if (link.order) updated = link.order
          if (link.warning) {
            shopifySync = { ...draft, message: [draft.message, link.warning].filter(Boolean).join(' ') }
          }
        }
      }
    }

    if (affectedProductIds.length > 0) {
      void pushInventoryToShopify(affectedProductIds).catch((err) => {
        logger.error({ err: { message: err.message }, ids: affectedProductIds }, 'Failed to push inventory to Shopify after order update')
      })
    }

    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Updated Sales Order',
      module: 'sales',
      entity: `Sales Order ${String(updated.shopifyId ?? routeParam(req.params.id))}`,
      details: `Status: ${String(updated.status ?? '')}, payment: ${String(updated.payment ?? '')}, fulfillment: ${String(updated.fulfillment ?? '')}, Rs${Number(updated.value ?? 0).toFixed(2)}`,
      userId: actor.userId,
      ip: actor.ip,
    })

    res.json({ order: updated, shopifySync })
  } catch (err) {
    // Keep the transaction's own message (e.g. the per-SKU insufficient-stock
    // detail) so the modal can show it under the offending line; unpack Drizzle's
    // query wrapper so a real database error is never hidden.
    const info = dbErrorInfo(err)
    const isDbError = Boolean(info.code)
    if (isDbError) {
      logger.error(
        { err: { code: info.code, constraint: info.constraint, column: info.column, table: info.table, detail: info.detail, message: info.message }, orderId: routeParam(req.params.id) },
        'Sales order update failed',
      )
    }
    const msg = isDbError ? `Could not update the order: ${describeDbError(err)}` : err instanceof Error ? err.message : 'Failed to update order'
    res.status(400).json({ error: msg })
  }
})

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const isProd = process.env.NODE_ENV === 'production'
  const errData: Record<string, unknown> = { message: err.message, name: err.name }
  if (!isProd) errData.stack = err.stack
  logger.error({ err: errData }, 'Unhandled error')
  if (err instanceof SyntaxError || (err as any).type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request body' })
  }
  if ((err as any).statusCode === 413) {
    return res.status(413).json({ error: 'Request entity too large' })
  }
  res.status(500).json({ error: 'Internal server error' })
})

// In production (Electron), serve the frontend dist as static files. This
// must be registered BEFORE the catch-all 404 handler below, otherwise every
// request would be swallowed by the 404 handler before reaching express.static.
const _resourcesPath = (process as any).resourcesPath
const frontendDist = resolveFrontendDist([
  process.env.FRONTEND_DIST,
  typeof _resourcesPath === 'string' ? join(_resourcesPath, 'app', 'frontend', 'dist') : null,
  typeof _resourcesPath === 'string' ? join(_resourcesPath, 'frontend', 'dist') : null,
  join(__dirname, '..', '..', 'frontend', 'dist'),
])
// Serve uploaded product images (public, read-only).
try {
  app.use('/uploads', express.static(UPLOADS_DIR(), { fallthrough: false, maxAge: '30d' }))
  ensureUploadsDir()
} catch (err) {
  logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not mount /uploads static handler')
}

// SPA fallback: serve index.html for any non-API route.
// Express 5 uses path-to-regexp v8, which removed the bare '*' wildcard - a
// wildcard must now be NAMED. The name is arbitrary and unused; only the
// shape of the match matters.
//
// The braces matter, and the exact form was verified against express 5.2.1
// rather than assumed: v8 wildcards match ONE OR MORE segments, so a plain
// '/*splat' 404s on '/' - the app's own root. Wrapping as '/{*splat}' makes
// the leading slash part of the optional group and matches '/', '/products'
// and '/a/b/c' alike. ('/{/*splat}' compiles but only matches '/', so it is
// NOT equivalent.)
mountFrontend(app, frontendDist)

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

process.on('unhandledRejection', (reason, _promise) => {
  logger.error({ reason }, 'Unhandled rejection')
})

process.on('uncaughtException', (err) => {
  logger.error({ err: { message: err.message, stack: err.stack } }, 'Uncaught exception')
  process.exit(1)
})

const requiredEnvVars = ['DATABASE_URL']
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    logger.warn(`Missing required env var: ${key}. Some features may not work.`)
  }
}
if (!config.port || config.port < 1 || config.port > 65535) {   logger.error({ port: config.port }, 'Invalid PORT, defaulting to 47191')
  config.port = 47191
}

// First-run database bootstrap: creates schema + seeds roles/admin on a fresh
// DB so a clean machine install works without any manual SQL. Idempotent.
// Runs BEFORE the server starts listening so no 503s race on first boot.
async function startServer() {
  try {
    const { bootstrapDatabase } = await import('./db/bootstrap')
    const boot = await bootstrapDatabase()
    if (boot.ran) logger.info({ tablesCreated: boot.tablesCreated }, 'Database bootstrap complete')
  } catch (err) {
    if (err instanceof HostedConfigError) {
      logger.error(err.message)
      process.exit(1)
    }
    logger.error({ err }, 'Database bootstrap failed — continuing with startup')
  }

  const server = app.listen(config.port, config.host, async () => {
    logger.info({ port: config.port, host: config.host, shopifyConfigured: isConfigured(), frontendOrigin: FRONTEND_ORIGIN }, 'Server started')
    if (isPublicHost() && FRONTEND_ORIGIN === 'http://localhost:47195') {
      logger.warn(
        { frontendOrigin: FRONTEND_ORIGIN },
        'FRONTEND_ORIGIN is still the desktop dev default. Leave it unset while this server serves the UI, and set it when the pages move to another site.',
      )
    }
    const { supabaseStorageConfig } = await import('./uploads')
    if (isPublicHost() && !supabaseStorageConfig()) {
      logger.warn('Product images are still stored on local disk. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY so uploads survive a restart.')
    }
    await loadSecretsFromDb()
    // Schedule the daily automated backup (7:00 PM local time).
    startAutoBackup()
    void import('./autoBackup').then((m) => m.startBackupVerification())
    // Periodic Shopify product pull (interval from settings; 0 = disabled).
    void import('./productAutoSync').then((m) => m.startProductAutoSync())
    // Periodic Shopify order pull: webhooks cannot reach the desktop app, and a
    // sleeping/deploying server misses deliveries. This is the backstop.
    startOrderAutoSync()
    // Durable ERP → Shopify queue: drains product/price/stock pushes recorded by
    // ERP writes, with retries, so an edit is never waiting on a UI button.
    startShopifyOutboundWorker()
    // Daily business summary email (9:00 AM IST).
    startDailySummary()
    // Hourly sweep of expired per-IP rate-limit rows.
    const rateLimitPruneTimer = setInterval(() => void pruneExpiredRateLimits(), 60 * 60 * 1000)
    rateLimitPruneTimer.unref()
    // Monthly customer statements (1st, 08:30) and due-date reminders (daily 09:15).
    void import('./monthlyStatements').then((m) => m.startMonthlyStatements())
    // Arm the durable post-commit side-effect recovery next to the other
  // schedulers: an invoice whose loyalty/journal/IRN failed AFTER the commit
  // is repaired here within one interval instead of being lost forever.
  void import('./invoiceSideEffects').then((m) => m.startSideEffectRecovery())
  void import('./dueReminders').then((d) => d.startDueReminders())
    // Daily sales follow-up sweep (10:05): lapses quotations, logs what to chase.
    void import('./salesFollowups').then((f) => f.startSalesFollowUps())
    // Daily supplier payables summary (09:20): one email, never per-supplier.
    void import('./supplierPayables').then((p) => p.startSupplierPayables())
    // Daily loyalty points expiry (03:00) — only writes when expiry is configured.
    void import('./loyaltyScheduler').then((m) => m.startLoyaltyExpiryScheduler())
    // Weekly owner insights (Monday 08:00).
    void import('./ownerWeekly').then((w) => w.startWeeklyOwnerReport())
    startSilverRateScheduler()
    // One-off rate changes scheduled from the Silver Rate page.
    startScheduledRateApplier()
    // Poll the order-notification mailbox so redacted Shopify PII still reaches the ERP
    startOrderEmailIngest()
    // Register Shopify webhooks when a public base URL is configured (non-fatal)
    void import('./webhookRegistration').then((m) => m.registerShopifyWebhooks())

    // PII recovery chain on startup (background, non-blocking).
    //
    // Shopify dev/preview stores redact Protected Customer Data over the API,
    // which used to leave "Shopify Customer #<id>" placeholder rows with no
    // email/phone. Recovery order, cheapest and most reliable first:
    //   1. Order-notification mailbox — the emails are never redacted.
    //   2. Admin API enrichment retry — works once PII access is approved.
    //   3. If both leave gaps, surface the direct Shopify CSV export as the
    //      manual fallback (System → Shopify → Data Import); no API call can
    //      fix those rows, so nothing is attempted here.
    if (isConfigured()) {
      setTimeout(async () => {
        try {
          const { enrichOrdersFromShopify, enrichCustomersFromShopify } = await import('./shopifyDataEnhance')
          const orderResult = await enrichOrdersFromShopify()
          const custResult = await enrichCustomersFromShopify()
          logger.info({
            ordersEnriched: orderResult.enriched, ordersFailed: orderResult.failed,
            customersEnriched: custResult.enriched, customersFailed: custResult.failed,
          }, 'Startup auto-enrich complete')
        } catch (err) {
          logger.error({ err }, 'Startup auto-enrich failed')
        }
        // Step 1 of the chain — after the API retry, so the email pass fills
        // only what the API legitimately could not.
        if (isEmailIngestConfigured()) {
          try {
            const res = await pollOrderMailbox()
            logger.info(
              { scanned: res.scanned, parsed: res.parsed, updated: res.updated, created: res.created, errors: res.errors.length },
              'Startup PII recovery: order mailbox polled',
            )
          } catch (err) {
            logger.error({ err }, 'Startup PII recovery: mailbox poll failed')
          }
        }
        // Step 3 — report what the automatic chain could not fix so the user
        // knows the CSV export is the remaining path.
        try {
          const remaining = await missingPiiCustomerCount()
          if (remaining > 0) {
            logger.warn(
              { remaining },
              'Startup PII recovery: some customers still lack contact data — use the Shopify customers CSV export (Shopify → Data Import) to fill them',
            )
          }
        } catch { /* reporting only */ }
      }, 5000) // 5s delay to let server fully start
    }
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      const msg = `Port ${config.port} is already in use (EADDRINUSE) — another instance of Opal Line Billing, or the dev server (npm run dev), is already running. Close it and start the app again.`
      logger.error({ port: config.port }, msg)
      // Also print plainly: the desktop app watches stderr for this message.
      console.error(`[server] ${msg}`)
      process.exit(1)
    }
    logger.error({ err }, 'Server error')
  })

  function gracefulShutdown(signal: string) {
    logger.info({ signal }, 'Shutting down gracefully')
    stopOrderEmailIngest()
    stopShopifyOutboundWorker()
    stopOrderAutoSync()
    server.close(() => {
      shutdownSessions()
      logger.info('Server closed')
      process.exit(0)
    })
    setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit')
      process.exit(1)
    }, 10000)
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
}

startServer()