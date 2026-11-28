import { Router } from 'express'
import { desc, sql } from 'drizzle-orm'
import { db, schema } from './db/client'
import { requirePermission } from './rbac'
import { logger } from './logger'
import { DEFAULT_REORDER_LEVEL, lowStockWhere } from './lib/lowStock'

/**
 * Unified notification feed for the header bell:
 *  - low stock products (stock <= reorder level)
 *  - new Shopify orders in the last 24h
 *  - failed syncs in the last 24h (sync_logs)
 *  - failed notification sends in the last 24h (notification_log)
 * Returns the newest 30 items with a type tag for icons.
 */

const feedRouter = Router()

feedRouter.get('/notifications/feed', requirePermission('dashboard', 'view'), async (_req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' })
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    type FeedItem = { type: string; title: string; detail: string | null; at: string | null; href: string }
    const items: FeedItem[] = []

    // All four sources are independent, so issue them together instead of
    // paying four sequential round trips on every 60s poll. The optional
    // tables keep their old swallow-on-error behaviour.
    const [low, orders, syncResult, notifResult] = await Promise.all([
      // Low stock (not time-based — current state; shared default reorder level)
      db
        .select({ id: schema.products.id, name: schema.products.name, sku: schema.products.sku, stock: schema.products.stock, reorder: schema.products.reorderLevel })
        .from(schema.products)
        .where(lowStockWhere())
        .orderBy(sql`${schema.products.stock} asc`)
        .limit(8),
      // New Shopify orders (last 24h)
      db
        .select({ id: schema.salesOrders.id, internalId: schema.salesOrders.internalId, customer: schema.salesOrders.customer, value: schema.salesOrders.value, date: schema.salesOrders.date })
        .from(schema.salesOrders)
        .where(sql`${schema.salesOrders.shopifyId} is not null and ${schema.salesOrders.date} >= ${since}`)
        .orderBy(desc(schema.salesOrders.date))
        .limit(8),
      db
        .select({ id: schema.syncLogs.id, entity: schema.syncLogs.entity, action: schema.syncLogs.action, error: schema.syncLogs.error, time: schema.syncLogs.time })
        .from(schema.syncLogs)
        .where(sql`${schema.syncLogs.status} = 'failed' and ${schema.syncLogs.time} >= ${since}`)
        .orderBy(desc(schema.syncLogs.time))
        .limit(6)
        .then((rows) => ({ ok: true as const, rows }))
        .catch(() => ({ ok: false as const, rows: [] })),
      db
        .select({ id: schema.notificationLog.id, kind: schema.notificationLog.kind, recipient: schema.notificationLog.recipient, error: schema.notificationLog.error, createdAt: schema.notificationLog.createdAt })
        .from(schema.notificationLog)
        .where(sql`${schema.notificationLog.status} = 'failed' and ${schema.notificationLog.createdAt} >= ${since}`)
        .orderBy(desc(schema.notificationLog.createdAt))
        .limit(6)
        .then((rows) => ({ ok: true as const, rows }))
        .catch(() => ({ ok: false as const, rows: [] })),
    ])
    for (const p of low) {
      items.push({
        type: 'low-stock',
        title: `Low stock: ${p.name}`,
        detail: `${p.stock ?? 0} left (reorder at ${p.reorder ?? DEFAULT_REORDER_LEVEL})`,
        at: null,
        href: '/inventory/low-stock',
      })
    }

    for (const o of orders) {
      items.push({
        type: 'new-order',
        title: `New order ${o.internalId ?? ''} — ${o.customer ?? 'Guest'}`,
        detail: `₹${Number(o.value ?? 0).toLocaleString('en-IN')}`,
        at: o.date,
        href: '/sales/orders',
      })
    }

    // Failed syncs (last 24h) — sync_logs uses `time` column. Skipped when the
    // table does not exist yet.
    if (syncResult.ok) {
      for (const s of syncResult.rows) {
        items.push({
          type: 'sync-failed',
          title: `Sync failed: ${s.entity ?? s.action ?? 'unknown'}`,
          detail: (s.error ?? '').slice(0, 80) || null,
          at: s.time,
          href: '/shopify/logs',
        })
      }
    }

    // Failed notification sends (last 24h)
    if (notifResult.ok) {
      for (const n of notifResult.rows) {
        items.push({
          type: 'notify-failed',
          title: `Notification failed: ${n.kind}`,
          detail: `${n.recipient ?? ''} ${(n.error ?? '').slice(0, 60)}`.trim() || null,
          at: n.createdAt,
          href: '/system/notification-log',
        })
      }
    }

    // Sort by time desc (low-stock items have no time, they go last within group)
    items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    const lowCount = items.filter((i) => i.type === 'low-stock').length
    const alertCount = items.filter((i) => i.type !== 'new-order').length
    res.json({ items: items.slice(0, 30), counts: { total: items.length, lowStock: lowCount, alerts: alertCount } })
  } catch (err) {
    logger.error({ err }, 'notification feed failed')
    res.status(500).json({ error: 'Notification feed failed' })
  }
})

export { feedRouter }
