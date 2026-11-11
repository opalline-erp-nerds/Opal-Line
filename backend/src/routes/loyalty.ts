import { Router, type Request, type Response } from 'express'
import type { Express } from 'express'
import { requireAuth } from '../sessions'
import { requirePermission } from '../rbac'
import { db } from '../db/client'
import * as s from '../db/schema'
import { eq } from 'drizzle-orm'
import * as loyalty from '../loyalty'
import { logger } from '../logger'

/**
 * Loyalty points API.
 *
 *   GET    /api/v1/loyalty/summary                  → dashboard totals (ledger)
 *   GET    /api/v1/loyalty/customers?query&limit    → customers with balances
 *   GET    /api/v1/loyalty/customers/:id            → one customer's profile
 *   GET    /api/v1/loyalty/transactions?type&from&to&customerId&search
 *   GET    /api/v1/loyalty/balance?customer=<name|phone|id>
 *   GET    /api/v1/loyalty/history?customer=<name|phone|id>
 *   POST   /api/v1/loyalty/redeem   { customer|customerId, points, invoiceId? }
 *   POST   /api/v1/loyalty/adjust   { customer|customerId, points, note }   (admin)
 *   GET    /api/v1/loyalty/settings                                          (admin)
 *   PUT    /api/v1/loyalty/settings                                          (admin)
 *   POST   /api/v1/loyalty/expire                                            (admin)
 *   GET    /api/v1/loyalty/reconcile                                         (admin)
 *   GET    /api/v1/loyalty/sync/status
 *   POST   /api/v1/loyalty/sync                                              (admin)
 *   POST   /api/v1/loyalty/sync/retry                                        (admin)
 */

const MAX_LIMIT = 200

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** `YYYY-MM-DD` becomes the start of that day; full timestamps pass through. */
function startOfDay(value: string): string {
  return value.length === 10 ? `${value}T00:00:00.000Z` : value
}

/** `YYYY-MM-DD` becomes the end of that day, so a same-day filter is inclusive. */
function endOfDay(value: string): string {
  return value.length === 10 ? `${value}T23:59:59.999Z` : value
}

function parseTypes(raw: unknown): string[] | undefined {
  if (raw == null || raw === '') return undefined
  const value = String(raw)
  const allowed = new Set(['earn', 'redeem', 'adjust', 'refund', 'expire'])
  const types = value.split(',').map((t) => t.trim()).filter((t) => allowed.has(t))
  return types.length > 0 ? types : undefined
}

/** Resolve the customer a request refers to, by id or by name/phone. */
async function customerFromBody(req: Request): Promise<loyalty.LoyaltyCustomer | null> {
  const body = (req.body ?? {}) as { customerId?: unknown; customer?: unknown }
  if (body.customerId) {
    const found = await loyalty.resolveCustomer({ customerId: String(body.customerId) })
    if (found) return found
  }
  const query = String(body.customer ?? '').trim()
  if (!query) return null
  return loyalty.findCustomer(query)
}

export function registerLoyaltyRoutes(app: Express) {
  const router = Router()

  router.get('/summary', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const from = typeof req.query.from === 'string' && req.query.from ? startOfDay(req.query.from) : null
      const to = typeof req.query.to === 'string' && req.query.to ? endOfDay(req.query.to) : null
      const [summary, config] = await Promise.all([
        loyalty.getSummary({ from, to }),
        loyalty.resolveConfig(),
      ])
      res.json({ summary, config })
    } catch (err) {
      logger.error({ err }, 'loyalty summary failed')
      res.status(500).json({ error: 'Failed to load loyalty summary' })
    }
  })

  router.get('/customers', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const result = await loyalty.listCustomers({
        query: typeof req.query.query === 'string' ? req.query.query : undefined,
        limit: intParam(req.query.limit, 50, 1, MAX_LIMIT),
        offset: intParam(req.query.offset, 0, 0, 100_000),
      })
      res.json(result)
    } catch (err) {
      logger.error({ err }, 'loyalty customers failed')
      res.status(500).json({ error: 'Failed to load loyalty customers' })
    }
  })

  router.get('/customers/:id', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const profile = await loyalty.getCustomerProfile(String(req.params.id))
      if (!profile) { res.status(404).json({ error: 'Customer not found' }); return }
      res.json(profile)
    } catch (err) {
      logger.error({ err }, 'loyalty customer profile failed')
      res.status(500).json({ error: 'Failed to load customer loyalty profile' })
    }
  })

  router.get('/transactions', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const result = await loyalty.listTransactions({
        customerId: typeof req.query.customerId === 'string' && req.query.customerId ? req.query.customerId : undefined,
        types: parseTypes(req.query.type),
        from: typeof req.query.from === 'string' && req.query.from ? startOfDay(req.query.from) : undefined,
        to: typeof req.query.to === 'string' && req.query.to ? endOfDay(req.query.to) : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        limit: intParam(req.query.limit, 50, 1, MAX_LIMIT),
        offset: intParam(req.query.offset, 0, 0, 100_000),
      })
      res.json(result)
    } catch (err) {
      logger.error({ err }, 'loyalty transactions failed')
      res.status(500).json({ error: 'Failed to load loyalty transactions' })
    }
  })

  router.get('/balance', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const query = String(req.query.customer ?? req.query.customerId ?? '').trim()
      if (!query) { res.status(400).json({ error: 'customer query param required' }); return }
      const customer = await loyalty.findCustomer(query)
      if (!customer) { res.json({ found: false }); return }
      const [balance, config] = await Promise.all([loyalty.getBalance(customer.id), loyalty.resolveConfig()])
      res.json({
        found: true,
        customer,
        balance,
        tier: loyalty.loyaltyTier(balance),
        pointValue: config.pointValue,
        enabled: config.enabled,
      })
    } catch (err) {
      logger.error({ err }, 'loyalty balance failed')
      res.status(500).json({ error: 'Failed to fetch balance' })
    }
  })

  router.get('/history', requireAuth, requirePermission('sales', 'view'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const query = String(req.query.customer ?? req.query.customerId ?? '').trim()
      if (!query) { res.status(400).json({ error: 'customer query param required' }); return }
      const customer = await loyalty.findCustomer(query)
      if (!customer) { res.json({ found: false, entries: [] }); return }
      const entries = await loyalty.history(customer.id, intParam(req.query.limit, 100, 1, 500))
      res.json({ found: true, customer, entries })
    } catch (err) {
      logger.error({ err }, 'loyalty history failed')
      res.status(500).json({ error: 'Failed to fetch history' })
    }
  })

  router.post('/redeem', requireAuth, requirePermission('sales', 'edit'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const points = Math.floor(Number((req.body ?? {}).points))
      if (!Number.isFinite(points) || points <= 0) {
        res.status(400).json({ error: 'points must be a positive whole number' })
        return
      }
      const found = await customerFromBody(req)
      if (!found) { res.status(404).json({ error: 'Customer not found' }); return }

      const body = (req.body ?? {}) as { invoiceId?: unknown; invoiceNumber?: unknown }
      const result = await loyalty.redeem(found.id, points, {
        invoiceId: body.invoiceId ? String(body.invoiceId) : undefined,
        invoiceNumber: body.invoiceNumber ? String(body.invoiceNumber) : undefined,
        createdBy: req.userId,
      })
      if (!result.ok) { res.status(400).json({ error: result.error }); return }
      logger.info({ customerId: found.id, points }, 'loyalty points redeemed')
      const { afterLoyaltyChange } = await import('../shopifyLoyalty')
      void afterLoyaltyChange(found.id)
      res.json({ ok: true, balanceAfter: result.balanceAfter })
    } catch (err) {
      logger.error({ err }, 'loyalty redeem failed')
      res.status(500).json({ error: 'Failed to redeem points' })
    }
  })

  router.post('/adjust', requireAuth, requirePermission('system', 'edit'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const body = (req.body ?? {}) as { points?: unknown; note?: unknown }
      const points = Math.floor(Number(body.points))
      if (!Number.isFinite(points) || points === 0) {
        res.status(400).json({ error: 'points must be a non-zero whole number' })
        return
      }
      if (Math.abs(points) > 1_000_000) {
        res.status(400).json({ error: 'Adjustment is too large' })
        return
      }
      const note = String(body.note ?? '').trim().slice(0, 500)
      const found = await customerFromBody(req)
      if (!found) { res.status(404).json({ error: 'Customer not found' }); return }

      let result: { points: number; balanceAfter: number }
      try {
        result = await loyalty.adjust(found.id, points, note || 'Manual adjustment', req.userId)
      } catch (err) {
        // Insufficient balance for a negative correction is a client error.
        res.status(400).json({ error: err instanceof Error ? err.message : 'Adjustment failed' })
        return
      }
      logger.info({ customerId: found.id, points, note, by: req.userId }, 'loyalty points adjusted')
      const { afterLoyaltyChange } = await import('../shopifyLoyalty')
      void afterLoyaltyChange(found.id)
      res.json({ ok: true, ...result })
    } catch (err) {
      logger.error({ err }, 'loyalty adjust failed')
      res.status(500).json({ error: 'Failed to adjust points' })
    }
  })

  router.get('/settings', requireAuth, requirePermission('sales', 'view'), async (_req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const config = await loyalty.resolveConfig()
      const [row] = await db.select().from(s.settings).where(eq(s.settings.id, 'app')).limit(1)
      res.json({ config, stored: Boolean(row) })
    } catch (err) {
      logger.error({ err }, 'loyalty settings read failed')
      res.status(500).json({ error: 'Failed to load loyalty settings' })
    }
  })

  router.put('/settings', requireAuth, requirePermission('system', 'edit'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const patch: Record<string, unknown> = {}

      if (body.enabled != null) patch.loyaltyEnabled = Boolean(body.enabled)
      if (body.pointsPer != null) {
        const value = Number(body.pointsPer)
        if (!Number.isFinite(value) || value <= 0) { res.status(400).json({ error: 'pointsPer must be greater than 0' }); return }
        patch.loyaltyPointsPer = value
      }
      if (body.pointValue != null) {
        const value = Number(body.pointValue)
        if (!Number.isFinite(value) || value <= 0) { res.status(400).json({ error: 'pointValue must be greater than 0' }); return }
        patch.loyaltyPointValue = value
      }
      if (body.minOrderValue != null) {
        const value = Number(body.minOrderValue)
        if (!Number.isFinite(value) || value < 0) { res.status(400).json({ error: 'minOrderValue must be 0 or more' }); return }
        patch.loyaltyMinOrder = value
      }
      if (body.expiryMonths != null) {
        const value = Math.floor(Number(body.expiryMonths))
        if (!Number.isFinite(value) || value < 0) { res.status(400).json({ error: 'expiryMonths must be 0 or more' }); return }
        patch.loyaltyExpiryMonths = value === 0 ? null : value
      }
      if (body.shopifySync != null) patch.loyaltyShopifySync = Boolean(body.shopifySync)
      if (body.metafieldNamespace != null) {
        const value = String(body.metafieldNamespace).trim()
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value)) { res.status(400).json({ error: 'Invalid metafield namespace' }); return }
        patch.loyaltyMetafieldNamespace = value
      }
      if (body.metafieldKey != null) {
        const value = String(body.metafieldKey).trim()
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) { res.status(400).json({ error: 'Invalid metafield key' }); return }
        patch.loyaltyMetafieldKey = value
      }

      if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'No settings to update' }); return }

      // Settings live in the single `app` row; create it if an install predates it.
      const [existing] = await db.select({ id: s.settings.id }).from(s.settings).where(eq(s.settings.id, 'app')).limit(1)
      if (existing) {
        await db.update(s.settings).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(s.settings.id, 'app'))
      } else {
        await db.insert(s.settings).values({ id: 'app', ...patch, updatedAt: new Date().toISOString() })
      }
      loyalty.invalidateConfig()
      logger.info({ patch: Object.keys(patch), by: req.userId }, 'loyalty settings updated')
      res.json({ ok: true, config: await loyalty.resolveConfig() })
    } catch (err) {
      logger.error({ err }, 'loyalty settings update failed')
      res.status(500).json({ error: 'Failed to save loyalty settings' })
    }
  })

  router.post('/expire', requireAuth, requirePermission('system', 'edit'), async (req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      const body = (req.body ?? {}) as { customerId?: unknown }
      const result = await loyalty.expirePoints({
        customerId: body.customerId ? String(body.customerId) : undefined,
      })
      logger.info({ ...result, by: req.userId }, 'loyalty expiry run')
      res.json({ ok: true, ...result })
    } catch (err) {
      logger.error({ err }, 'loyalty expiry failed')
      res.status(500).json({ error: 'Failed to expire points' })
    }
  })

  router.get('/reconcile', requireAuth, requirePermission('system', 'view'), async (_req: Request, res: Response) => {
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return }
    try {
      res.json(await loyalty.reconcileLedger())
    } catch (err) {
      logger.error({ err }, 'loyalty reconcile failed')
      res.status(500).json({ error: 'Failed to reconcile the loyalty ledger' })
    }
  })

  router.get('/sync/status', requireAuth, requirePermission('sales', 'view'), async (_req: Request, res: Response) => {
    try {
      const { getLoyaltySyncStatus } = await import('../shopifyLoyalty')
      res.json(await getLoyaltySyncStatus())
    } catch (err) {
      logger.error({ err }, 'loyalty sync status failed')
      res.status(500).json({ error: 'Failed to load loyalty sync status' })
    }
  })

  router.post('/sync', requireAuth, requirePermission('system', 'edit'), async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { customerId?: unknown }
      const { pushLoyaltyBalances } = await import('../shopifyLoyalty')
      const result = await pushLoyaltyBalances({
        customerIds: body.customerId ? [String(body.customerId)] : undefined,
        force: true,
      })
      logger.info({ pushed: result.pushed, failed: result.failed, by: req.userId }, 'loyalty balances pushed')
      res.json(result)
    } catch (err) {
      logger.error({ err }, 'loyalty sync failed')
      res.status(500).json({ error: 'Failed to push loyalty balances to Shopify' })
    }
  })

  router.post('/sync/retry', requireAuth, requirePermission('system', 'edit'), async (_req: Request, res: Response) => {
    try {
      const { retryFailedLoyaltySync } = await import('../shopifyLoyalty')
      res.json(await retryFailedLoyaltySync())
    } catch (err) {
      logger.error({ err }, 'loyalty sync retry failed')
      res.status(500).json({ error: 'Failed to retry loyalty sync' })
    }
  })

  app.use('/api/v1/loyalty', router)
}
