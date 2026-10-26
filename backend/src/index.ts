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
import { applyPriceSync, applySilverRate, createShopifyDraftOrder, ensureSynced, getLatestSilverRate, getSilverRateProgress, importShopifyOrders, purgeProducts, pushInventoryToShopify, pushProductPriceToShopify, pushProductsToShopify, runSync, store, syncProductsToDb, testShopifyConnection, updateShopifyOrder } from './shopify'
import { round2 } from './routes/db'
import { buildPricedOrder, type ValidatedOrderItem } from './orderPricing'
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
import { requireAuth, shutdownSessions } from './sessions'
import { systemRouter } from './routes/systemStatus'
import { reportsRouter } from './routes/reports'
import { actorFromRequest, recordActivity } from './activity'
import { validate, createOrderSchema, updateOrderSchema, silverRateSchema, pushProductsSchema, pushInventorySchema, productPriceSchema, syncSchema } from './validation'
import { logger } from './logger'
import { CONSTANTS } from './constants'
import { applyTrustProxy } from './proxyTrust'
import { PgRateLimitStore, pruneExpiredRateLimits } from './pgRateLimitStore'
import { verifyShopifyWebhook, rejectReplayedWebhook } from './webhooks'
import { recountCustomerStats } from './customerStats'
import { startAutoBackup, startDailySummary } from './autoBackup'
import { startOrderEmailIngest, stopOrderEmailIngest, pollOrderMailbox, isEmailIngestConfigured, kickEmailIngest } from './orderEmailIngest'
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
import { routeParam } from './lib/routeParams'

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
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  })
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
const LARGE_JSON_PATHS = new Set(['/api/v1/uploads/image', '/api/v1/db/products/bulk-images'])
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
  logger.info({ topic, shopDomain: req.shopifyWebhook?.shopDomain, webhookId: req.shopifyWebhook?.webhookId }, 'Shopify webhook received')

  // Acknowledge immediately — Shopify considers the delivery failed after 5s
  // and retries, so any real processing must happen after the response.
  res.json({ ok: true })

  try {
    if (topic.startsWith('products/')) {
      const result = await syncProductsToDb()
      logger.info(
        { topic, synced: result.synced, created: result.created, updated: result.updated, ok: result.ok },
        'Webhook: products resynced into database',
      )
    } else if (topic === 'orders/cancelled') {
      // Targeted cancel: reflect the cancelled status immediately from the
      // webhook payload and give back any stock the import had deducted.
      const order = req.body as { id?: number; name?: string } | undefined
      const orderNumber = order?.name ? String(order.name).replace(/^#/, '') : order?.id != null ? String(order.id) : ''
      const shopifyId = orderNumber ? `#${orderNumber}` : null
      if (shopifyId && db) {
        try {
          const restored = await db.transaction(async (tx) => {
            const [local] = await tx
              .select({ id: schema.salesOrders.id, status: schema.salesOrders.status, lineItems: schema.salesOrders.lineItems, locationId: schema.salesOrders.locationId })
              .from(schema.salesOrders)
              .where(eq(schema.salesOrders.shopifyId, shopifyId))
              .limit(1)
            if (!local || local.status === 'cancelled') return { skipped: true, items: 0 }
            const items = Array.isArray(local.lineItems) ? (local.lineItems as Array<{ sku?: string; quantity?: number }>) : []
            // Cancelling puts the goods back where the sale actually left them.
            const locationId = await resolveMovementLocation(local.locationId as string | null, tx as never)
            let itemsRestored = 0
            for (const li of items) {
              const sku = String(li.sku ?? '').trim()
              const qty = Math.max(0, Math.floor(Number(li.quantity ?? 0)))
              if (!sku || qty <= 0) continue
              // Resolves variant SKUs through product_variants; an unresolvable
              // SKU (product deleted since the sale) restores nothing, as before.
              const restored = await restoreOrderLineStock({ tx, locationId, sku, qty })
              if (restored) itemsRestored += qty
            }
            await tx
              .update(schema.salesOrders)
              .set({ status: 'cancelled' })
              .where(eq(schema.salesOrders.shopifyId, shopifyId))
            return { skipped: false, items: itemsRestored }
          })
          logger.info({ topic, shopifyId, ...restored }, 'Webhook: order cancelled locally')
        } catch (err) {
          logger.error({ topic, shopifyId, err: { message: err instanceof Error ? err.message : 'Unknown error' } }, 'Webhook: cancel handling failed')
        }
      } else {
        logger.warn({ topic }, 'Webhook: orders/cancelled without an identifiable order')
      }
    } else if (topic === 'orders/fulfilled') {
      // Targeted fulfillment: mark the local order fulfilled immediately and
      // record it on the order timeline — no full reimport needed.
      const order = req.body as {
        id?: number
        name?: string
        fulfillments?: Array<{ tracking_number?: string | null; tracking_company?: string | null; tracking_url?: string | null }>
      } | undefined
      const orderNumber = order?.name ? String(order.name).replace(/^#/, '') : order?.id != null ? String(order.id) : ''
      const shopifyId = orderNumber ? `#${orderNumber}` : null
      const f = order?.fulfillments?.find((x) => x?.tracking_number)
      const trackingId = f?.tracking_number?.trim() || null
      const carrier = f?.tracking_company?.trim() || null
      if (shopifyId && db) {
        try {
          const [local] = await db
            .update(schema.salesOrders)
            .set({ status: 'fulfilled' })
            .where(and(eq(schema.salesOrders.shopifyId, shopifyId), ne(schema.salesOrders.status, 'cancelled')))
            .returning({ id: schema.salesOrders.id })
          if (local) {
            const { insertOrderEvent } = await import('./routes/db')
            const { notifyOrderFulfilled } = await import('./statusNotifications')
            await insertOrderEvent(
              local.id,
              'Fulfilled',
              trackingId
                ? `Order fulfilled via Shopify webhook (${shopifyId}) — tracking ${trackingId}${carrier ? ` (${carrier})` : ''}`
                : `Order marked fulfilled via Shopify webhook (${shopifyId})`,
              'shopify',
            )
            const [row] = await db.select().from(schema.salesOrders).where(eq(schema.salesOrders.id, local.id)).limit(1)
            if (row) {
              // PII redaction: the API customer object can be blanked, so the
              // notification email (which carries full customer data) is the
              // source of truth. Pull it in BEFORE notifying so the customer
              // row and order details are complete when the message is built.
              const { kickEmailIngest } = await import('./orderEmailIngest')
              kickEmailIngest()
              void notifyOrderFulfilled({ ...row, trackingId, carrier })
            }
            logger.info({ topic, shopifyId, trackingId }, 'Webhook: order marked fulfilled locally')
          } else {
            // Fulfillment arrived before the order was ever imported — import now,
            // then record the timeline event and notify on the imported row.
            const { importShopifyOrders } = await import('./shopify')
            await importShopifyOrders()
            const [row] = await db.select().from(schema.salesOrders).where(eq(schema.salesOrders.shopifyId, shopifyId)).limit(1)
            if (row) {
              const { insertOrderEvent } = await import('./routes/db')
              const { notifyOrderFulfilled } = await import('./statusNotifications')
              // The webhook is authoritative that fulfillment happened — the fresh
              // import may still carry the pre-fulfillment state (timing race).
              if (row.status !== 'fulfilled' && row.status !== 'cancelled') {
                await db.update(schema.salesOrders).set({ status: 'fulfilled' }).where(eq(schema.salesOrders.id, row.id))
              }
              await insertOrderEvent(
                row.id,
                'Fulfilled',
                trackingId
                  ? `Order fulfilled via Shopify webhook (${shopifyId}) — tracking ${trackingId}${carrier ? ` (${carrier})` : ''}`
                  : `Order marked fulfilled via Shopify webhook (${shopifyId})`,
                'shopify',
              )
              const { kickEmailIngest } = await import('./orderEmailIngest')
              kickEmailIngest()
              void notifyOrderFulfilled({ ...row, trackingId, carrier })
              logger.info({ topic, shopifyId, trackingId }, 'Webhook: order imported + marked fulfilled')
            } else {
              logger.warn({ topic, shopifyId }, 'Webhook: orders/fulfilled matched no local order and import found none')
            }
          }
        } catch (err) {
          logger.error({ topic, shopifyId, err: { message: err instanceof Error ? err.message : 'Unknown error' } }, 'Webhook: fulfilled handling failed')
        }
      }
    } else if (topic.startsWith('orders/')) {
      // Instant sync: the webhook is the instant signal, the notification email
      // carries the full (non-redacted) customer data — poll the mailbox now.
      kickEmailIngest()
      const result = await importShopifyOrders()
      logger.info(
        { topic, imported: result.imported, updated: result.updated, ok: result.ok },
        'Webhook: orders reimported into database',
      )
      // Auto-enrich: fetch full customer data via GraphQL for any incomplete orders
      try {
        const { enrichOrdersFromShopify } = await import('./shopifyDataEnhance')
        const enriched = await enrichOrdersFromShopify()
        logger.info({ enriched: enriched.enriched, failed: enriched.failed }, 'Auto-enrich: orders updated with full customer data')
      } catch (err) {
        logger.error({ err }, 'Auto-enrich after order webhook failed')
      }
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
    logger.error(
      { topic, err: { message: err instanceof Error ? err.message : 'Unknown error' } },
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
app.post('/api/v1/shopify/flow-webhook', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    // ── HMAC signature verification ────────────────────────────────────────
    const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET?.trim()
    if (SHOPIFY_WEBHOOK_SECRET) {
      const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string | undefined
      if (!hmacHeader) {
        logger.warn('Flow webhook missing X-Shopify-Hmac-SHA256 header')
        return res.status(401).json({ ok: false, error: 'Unauthorized' })
      }
      const rawBody = JSON.stringify(req.body)
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

app.post('/api/v1/shopify/products/sync-db', requirePermission('shopify', 'create'), async (req, res) => {
  try {
    const result = await syncProductsToDb()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Synced Products',
      module: 'shopify',
      entity: 'Products',
      details: result.ok ? `${result.synced ?? 0} synced (${result.created ?? 0} created, ${result.updated ?? 0} updated)` : `Product sync failed: ${result.errors?.join('; ') ?? 'unknown error'}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.status(result.ok ? 200 : 502).json(result)
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
      sellingPrice: Number.isFinite(price) ? price : local.sellingPrice,
      stock: Number.isFinite(shop.inventoryQuantity) ? shop.inventoryQuantity : local.stock,
      name: shop.title || local.name,
      image: shop.image ?? local.image,
    }).where(eq(dbMod.schema.products.id, localId))

    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Synced Products',
      module: 'shopify',
      entity: `Product ${local.sku ?? localId}`,
      details: `Pulled from Shopify: price ₹${price}, stock ${shop.inventoryQuantity}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, pulled: { price, stock: shop.inventoryQuantity, title: shop.title } })
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
    return { status: result.ok ? 200 : 502, body: { ...result, direct: true } }
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
      details: result.ok ? `${result.imported ?? 0} imported, ${result.updated ?? 0} updated` : `Order sync failed: ${result.errors?.join('; ') ?? 'unknown error'}`,
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

// Manual trigger for the product auto-sync scheduler
app.post('/api/v1/shopify/products/auto-sync', requirePermission('shopify', 'create'), async (req, res) => {
  try {
    const { runProductAutoSync } = await import('./productAutoSync')
    const result = await runProductAutoSync()
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

// Read/update the auto-sync interval (hours; 0 = disabled)
app.get('/api/v1/shopify/products/auto-sync/interval', requirePermission('shopify', 'view'), async (_req, res) => {
  try {
    const { getAutoSyncIntervalHours } = await import('./productAutoSync')
    res.json({ intervalHours: await getAutoSyncIntervalHours() })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
  }
})

app.post('/api/v1/shopify/products/auto-sync/interval', requirePermission('shopify', 'edit'), async (req, res) => {
  try {
    const hours = Number(req.body?.intervalHours)
    if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
      return res.status(400).json({ error: 'intervalHours must be between 0 and 168' })
    }
    const { setAutoSyncIntervalHours, getAutoSyncIntervalHours } = await import('./productAutoSync')
    await setAutoSyncIntervalHours(hours)
    // Restart the schedule loop so the new interval applies immediately
    const { stopProductAutoSync, startProductAutoSync } = await import('./productAutoSync')
    stopProductAutoSync()
    startProductAutoSync()
    res.json({ ok: true, intervalHours: await getAutoSyncIntervalHours() })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ error: message })
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
    res.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ ok: false, enriched: 0, failed: 0, skipped: 0, errors: [message], message: 'Enrichment failed' })
  }
})

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

  // Calculate item prices using the current silver rate and product data
  // Load product data (netWeight, makingCharge) keyed by SKU
  const productData = await db
    .select({
      sku: schema.products.sku,
      netWeight: schema.products.netWeight,
      makingCharge: schema.products.makingCharge,
    })
    .from(schema.products)
    .where(inArray(schema.products.sku, items.map((li: { sku?: string; productSku?: string }) => String(li.productSku ?? li.sku ?? '')).filter(Boolean)))
  // Price the lines with the authoritative silver rate — canonical invoice
  // formula, extracted so the per-unit convention is unit-testable. Each
  // line's stored price is PER-UNIT and GST-inclusive: every consumer (the
  // edit dialog's subtotal, the print doc, the update handler's value)
  // multiplies it by quantity exactly once.
  const priced = buildPricedOrder(items as ValidatedOrderItem[], productData, silverRate)
  const itemsWithCalculatedPrice = priced.lines
  const value = priced.grandTotal
  const itemCount = priced.itemCount

  const now = new Date()
  const internalId = `MO-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${now.getTime().toString().slice(-6)}`

  // For Shopify draft order, we need GST-inclusive prices
  const shopifyLineItems = itemsWithCalculatedPrice.map((li: typeof itemsWithCalculatedPrice[0]) => ({
    ...li,
    price: round2(li.amount * 1.03), // Convert line subtotal to GST-inclusive price
  }))

  let draft: { ok: boolean; draftId?: string; name?: string; customerId?: string; errors: string[]; message?: string } | null = null
  let shopifyId = internalId

  if (syncToShopify) {
    draft = await createShopifyDraftOrder({
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
    if (draft.ok && draft.name) shopifyId = draft.name
  }

  if (!db) {
    return res.status(503).json({ error: 'Service temporarily unavailable' })
  }

  const customerCity = billingAddress?.city ? String(billingAddress.city).trim() : undefined

  let order: Record<string, unknown> | null = null
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
          shopifyId,
          internalId,
          customer,
          value: Math.round(value * 100) / 100,
          payment: payment ?? 'pending',
          fulfillment: fulfillment ?? 'unfulfilled',
          invoice: null,
          status: status ?? 'confirmed',
          date: date ? new Date(date).toISOString() : now.toISOString(),
          items: itemCount,
          tags: 'manual-order',
          currency: 'INR',
          discount: 0,
          lineItems: itemsWithCalculatedPrice,
          billingAddress: billingAddress ?? null,
          shippingAddress: shippingAddress ?? null,
          locationId,
        })
        .returning()
      order = row

      // Customer matching: identity keys only (email/phone/shopifyId).
      // Never match on name — two different customers can share a name, and
      // merging them corrupts orders/totalSpent stats.
      // Accept any id form (bare numeric or gid://shopify/Customer/…) and
      // store/match only the bare numeric form — mixed formats defeat the
      // shopifyId identity match and duplicate customers.
      const draftCustomerShopifyId = draft?.customerId
        ? normalizeShopifyCustomerId(draft.customerId) || null
        : null
      const identityConditions = []
      if (email) identityConditions.push(eq(schema.customers.email, email))
      if (phone) identityConditions.push(eq(schema.customers.phone, phone))
      if (draftCustomerShopifyId) identityConditions.push(eq(schema.customers.shopifyId, draftCustomerShopifyId))
      const [existing] = identityConditions.length
        ? await tx.select().from(schema.customers).where(or(...identityConditions)).limit(1)
        : []
      if (existing) {
        await tx
          .update(schema.customers)
          .set({
            name: customer,
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            ...(customerCity ? { city: customerCity } : {}),
            ...(draftCustomerShopifyId ? { shopifyId: draftCustomerShopifyId } : {}),
            status: existing.status ?? 'active',
          })
          .where(eq(schema.customers.id, existing.id))
      } else {
        await tx.insert(schema.customers).values({
          id: randomUUID(),
          name: customer,
          email: email ?? null,
          phone: phone ?? null,
          city: customerCity ?? null,
          shopifyId: draft?.customerId ?? null,
          orders: 0,
          totalSpent: 0,
          status: 'active',
          joined: now.toISOString().slice(0, 10),
        })
      }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create order'
    return res.status(400).json({ error: msg })
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
    entity: `Sales Order ${shopifyId}`,
    details: `${customer} - ${itemCount} item(s), Rs${value.toFixed(2)}${syncToShopify ? ' (synced to Shopify)' : ''}`,
    userId: actor.userId,
    ip: actor.ip,
  })

  res.status(201).json({ order, shopifySync: draft })
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

    const { customer, email, payment: rawPayment, fulfillment: rawFulfillment, status, date, note, items, shippingAddress, syncToShopify } = req.body

    // Normalize payment and fulfillment values
    const payment = rawPayment === 'Online' || rawPayment === 'online' ? 'paid' : rawPayment
    const fulfillment = rawFulfillment === 'pending' ? 'unfulfilled' : rawFulfillment

    let value = Number(existing.value ?? 0)
    let itemCount = Number(existing.items ?? 0)
    let mappedLineItems: Array<{ title: string; sku: string; quantity: number; price: number }> | null = null
    if (items) {
      const mapped = items
        .map((li: any) => ({
          title: String(li.title ?? li.name ?? '').trim(),
          sku: String(li.sku ?? ''),
          quantity: Math.max(0, Math.floor(Number(li.quantity ?? li.qty ?? 0)) || 0),
          price: Number(li.price ?? 0),
        }))
        .filter((li: any) => li.title && li.quantity > 0)
      if (mapped.length > 0) {
        value = Math.round(mapped.reduce((s: number, li: { price: number; quantity: number }) => s + li.price * li.quantity, 0) * 100) / 100
        itemCount = mapped.reduce((s: number, li: { quantity: number }) => s + li.quantity, 0)
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
    }
    if (date) updates.date = new Date(String(date)).toISOString()

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

    let shopifySync: { ok: boolean; errors: string[]; message?: string } | null = null
    if (syncToShopify && typeof updated.shopifyId === 'string' && updated.shopifyId.startsWith('#')) {
      shopifySync = await updateShopifyOrder({
        orderName: updated.shopifyId,
        email: email ? String(email).trim() : undefined,
        note: note ? String(note).trim() : undefined,
        tags: 'manual-order',
        shippingAddress,
      })
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
    // detail) so the modal can show it under the offending line.
    const msg = err instanceof Error ? err.message : 'Failed to update order'
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
const frontendDist = (() => {
  const candidates: Array<string | null | undefined> = [
    process.env.FRONTEND_DIST,
    typeof _resourcesPath === 'string' ? join(_resourcesPath, 'app', 'frontend', 'dist') : null,
    typeof _resourcesPath === 'string' ? join(_resourcesPath, 'frontend', 'dist') : null,
    join(__dirname, '..', '..', 'frontend', 'dist'),
  ]
  for (const c of candidates) {
    // Guard against the spawn env serializing an `undefined` value to the
    // string "undefined", and only accept a candidate that actually renders.
    if (c && c !== 'undefined' && existsSync(join(c, 'index.html'))) return c
  }
  return join(__dirname, '..', '..', 'frontend', 'dist')
})()
// Serve uploaded product images (public, read-only).
try {
  app.use('/uploads', express.static(UPLOADS_DIR(), { fallthrough: false, maxAge: '30d' }))
  ensureUploadsDir()
} catch (err) {
  logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not mount /uploads static handler')
}

if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist))
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
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(join(frontendDist, 'index.html'))
  })
}

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
    logger.error({ err }, 'Database bootstrap failed — continuing with startup')
  }

  const server = app.listen(config.port, config.host, async () => {
    logger.info({ port: config.port, host: config.host, shopifyConfigured: isConfigured(), frontendOrigin: FRONTEND_ORIGIN }, 'Server started')
    await loadSecretsFromDb()
    // Schedule the daily automated backup (7:00 PM local time).
    startAutoBackup()
    void import('./autoBackup').then((m) => m.startBackupVerification())
    // Periodic Shopify product pull (interval from settings; 0 = disabled).
    void import('./productAutoSync').then((m) => m.startProductAutoSync())
    // Daily business summary email (9:00 AM IST).
    startDailySummary()
    // Hourly sweep of expired per-IP rate-limit rows.
    const rateLimitPruneTimer = setInterval(() => void pruneExpiredRateLimits(), 60 * 60 * 1000)
    rateLimitPruneTimer.unref()
    // Monthly customer statements (1st, 08:30) and due-date reminders (daily 09:15).
    void import('./monthlyStatements').then((m) => m.startMonthlyStatements())
    void import('./dueReminders').then((d) => d.startDueReminders())
    // Daily sales follow-up sweep (10:05): lapses quotations, logs what to chase.
    void import('./salesFollowups').then((f) => f.startSalesFollowUps())
    // Daily supplier payables summary (09:20): one email, never per-supplier.
    void import('./supplierPayables').then((p) => p.startSupplierPayables())
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