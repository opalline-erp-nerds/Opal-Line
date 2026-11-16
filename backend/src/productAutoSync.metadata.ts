import { db } from './db/client'
import * as schema from './db/schema'
import { eq } from 'drizzle-orm'
import { getConfiguredShopDomain } from './shopify'

export const META_LAST_SUCCESS_AT = 'productAutoSyncLastSuccessAt'
export const META_LAST_FULL_COUNT = 'productAutoSyncLastFullCount'
export const META_SHOP_DOMAIN = 'productAutoSyncShopDomain'
export const META_PAUSED = 'productAutoSyncPaused'

export type ProductAutoSyncMeta = {
  lastSuccessAt: string | null
  lastFullCount: number | null
  shopDomain: string | null
  paused: boolean
}

async function readNotificationSettings(): Promise<Record<string, unknown>> {
  if (!db) return {}
  const [row] = await db
    .select({ notificationSettings: schema.settings.notificationSettings })
    .from(schema.settings)
    .where(eq(schema.settings.id, 'app'))
    .limit(1)
  return (row?.notificationSettings ?? {}) as Record<string, unknown>
}

export async function getProductAutoSyncMeta(): Promise<ProductAutoSyncMeta> {
  const s = await readNotificationSettings()
  const lastSuccessAt = typeof s[META_LAST_SUCCESS_AT] === 'string' ? s[META_LAST_SUCCESS_AT] : null
  const lastFullCount = typeof s[META_LAST_FULL_COUNT] === 'number' ? s[META_LAST_FULL_COUNT] : null
  const shopDomain = typeof s[META_SHOP_DOMAIN] === 'string' ? s[META_SHOP_DOMAIN] : null
  const paused = s[META_PAUSED] === true
  return { lastSuccessAt, lastFullCount, shopDomain, paused }
}

export async function patchProductAutoSyncMeta(patch: Partial<ProductAutoSyncMeta>): Promise<void> {
  if (!db) return
  const current = await readNotificationSettings()
  const next: Record<string, unknown> = { ...current }
  if (patch.lastSuccessAt !== undefined) next[META_LAST_SUCCESS_AT] = patch.lastSuccessAt
  if (patch.lastFullCount !== undefined) next[META_LAST_FULL_COUNT] = patch.lastFullCount
  if (patch.shopDomain !== undefined) next[META_SHOP_DOMAIN] = patch.shopDomain
  if (patch.paused !== undefined) next[META_PAUSED] = patch.paused
  await db
    .update(schema.settings)
    .set({ notificationSettings: next })
    .where(eq(schema.settings.id, 'app'))
}

export async function recordSuccessfulProductAutoSync(liveCount: number, fullCatalog: boolean): Promise<void> {
  const shop = getConfiguredShopDomain()
  const patch: Partial<ProductAutoSyncMeta> = {
    lastSuccessAt: new Date().toISOString(),
    shopDomain: shop,
    paused: false,
  }
  if (fullCatalog) patch.lastFullCount = liveCount
  await patchProductAutoSyncMeta(patch)
}