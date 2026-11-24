import { eq } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { logger } from './logger'
import { isConfigured } from './config'
import { isProductSyncInProgress, normalizeProduct, syncProductsToDb, type ProductsDbSyncResult } from './shopify'
import type { SyncProduct } from './types'

const WEBHOOK_UPSERT_OPTS = {
  mode: 'auto' as const,
  allowRemovals: false,
  mergeVariants: true,
  mirrorFromShopify: true,
}

export function productFromWebhookBody(body: unknown): SyncProduct | null {
  if (!body || typeof body !== 'object') return null
  const raw = body as Record<string, unknown>
  if (raw.id == null) return null
  return normalizeProduct(raw)
}

export async function upsertProductFromWebhook(body: unknown, topic: string): Promise<ProductsDbSyncResult> {
  if (!isConfigured()) {
    return {
      ok: false,
      synced: 0,
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      failed: 1,
      durationMs: 0,
      errors: ['Shopify is not configured'],
      message: 'Shopify is not configured',
    }
  }
  const product = productFromWebhookBody(body)
  if (!product) {
    return {
      ok: false,
      synced: 0,
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      failed: 1,
      durationMs: 0,
      errors: [`Invalid ${topic} payload`],
      message: `Invalid ${topic} payload`,
    }
  }
  if (isProductSyncInProgress()) {
    logger.warn({ topic, shopifyProductId: product.id }, 'Product webhook skipped: catalog sync already running')
    return {
      ok: true,
      synced: 0,
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 1,
      failed: 0,
      durationMs: 0,
      errors: [],
      skippedRun: true,
      message: 'Catalog sync in progress — webhook will retry',
    }
  }
  const result = await syncProductsToDb({
    ...WEBHOOK_UPSERT_OPTS,
    liveProducts: [product],
  })
  logger.info(
    { topic, shopifyProductId: product.id, created: result.created, updated: result.updated, ok: result.ok },
    'Product webhook upserted into database',
  )
  return result
}

export async function flagProductDeletedFromWebhook(body: unknown): Promise<ProductsDbSyncResult> {
  const started = Date.now()
  if (!db) {
    return {
      ok: false,
      synced: 0,
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      failed: 1,
      durationMs: 0,
      errors: ['Database is not configured'],
      message: 'Database is not configured',
    }
  }
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  const shopifyId = String(raw?.id ?? '').trim()
  if (!shopifyId) {
    return {
      ok: false,
      synced: 0,
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      failed: 1,
      durationMs: Date.now() - started,
      errors: ['products/delete payload missing id'],
      message: 'products/delete payload missing id',
    }
  }
  const rows = await db
    .select({ id: schema.products.id, sku: schema.products.sku })
    .from(schema.products)
    .where(eq(schema.products.shopifyId, shopifyId))
  if (rows.length === 0) {
    return {
      ok: true,
      synced: 0,
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 1,
      failed: 0,
      durationMs: Date.now() - started,
      errors: [],
      message: 'No local product linked to deleted Shopify id',
    }
  }
  const note = `Shopify product ${shopifyId} deleted — marked inactive locally (ERP row kept)`
  for (const row of rows) {
    await db
      .update(schema.products)
      .set({
        status: 'inactive',
        shopifyStatus: 'deleted_on_shopify',
      })
      .where(eq(schema.products.id, row.id))
  }
  const { persistShopifySyncLog } = await import('./shopify')
  void persistShopifySyncLog({
    entity: 'Product',
    shopifyId,
    direction: 'in',
    action: 'Webhook Delete',
    status: 'skipped',
    error: note,
  })
  logger.info({ shopifyId, count: rows.length }, 'Product delete webhook: flagged inactive, not removed')
  return {
    ok: true,
    synced: 0,
    created: 0,
    updated: rows.length,
    removed: 0,
    skipped: 0,
    failed: 0,
    durationMs: Date.now() - started,
    errors: [],
    warnings: [note],
  }
}

export async function handleProductWebhook(topic: string, body: unknown): Promise<ProductsDbSyncResult> {
  if (topic === 'products/delete') return flagProductDeletedFromWebhook(body)
  if (topic.startsWith('products/')) return upsertProductFromWebhook(body, topic)
  return {
    ok: false,
    synced: 0,
    created: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    durationMs: 0,
    errors: [`Unhandled product topic: ${topic}`],
    message: `Unhandled product topic: ${topic}`,
  }
}