import { db } from './db/client'
import * as schema from './db/schema'
import { isConfigured } from './config'
import { pullLiveProducts, store } from './shopify'

export type StockChangeSample = {
  sku: string
  field: 'stock' | 'variant_stock'
  old: number
  new: number
}

export type StockSyncPreview = {
  ok: boolean
  parentChanges: number
  variantChanges: number
  samples: StockChangeSample[]
  message?: string
}

function matchProduct(
  live: { id: number; sku: string },
  rows: Array<{ id: string; sku: string; shopifyId: string | null; stock: number | null }>,
): (typeof rows)[0] | undefined {
  const byId = rows.find((r) => String(r.shopifyId ?? '').trim() === String(live.id))
  if (byId) return byId
  const key = String(live.sku ?? '').trim().toLowerCase()
  return rows.find((r) => String(r.sku ?? '').trim().toLowerCase() === key)
}

export async function previewStockChangesFromShopify(): Promise<StockSyncPreview> {
  if (!isConfigured()) {
    return { ok: false, parentChanges: 0, variantChanges: 0, samples: [], message: 'Shopify is not configured' }
  }
  if (!db) {
    return { ok: false, parentChanges: 0, variantChanges: 0, samples: [], message: 'Database is not configured' }
  }
  await pullLiveProducts()
  const live = store.products
  const products = await db.select({
    id: schema.products.id,
    sku: schema.products.sku,
    shopifyId: schema.products.shopifyId,
    stock: schema.products.stock,
  }).from(schema.products)
  const variants = await db.select({
    productId: schema.productVariants.productId,
    sku: schema.productVariants.sku,
    shopifyVariantId: schema.productVariants.shopifyVariantId,
    stock: schema.productVariants.stock,
  }).from(schema.productVariants)
  const variantsByProduct = new Map<string, typeof variants>()
  for (const v of variants) {
    const list = variantsByProduct.get(v.productId) ?? []
    list.push(v)
    variantsByProduct.set(v.productId, list)
  }
  const changes: StockChangeSample[] = []
  for (const p of live) {
    const row = matchProduct(p, products)
    if (!row) continue
    const newStock = Math.max(0, Math.floor(Number(p.inventoryQuantity) || 0))
    const oldStock = Math.max(0, Math.floor(Number(row.stock) || 0))
    if (newStock !== oldStock) {
      changes.push({ sku: String(row.sku ?? ''), field: 'stock', old: oldStock, new: newStock })
    }
    const liveVariants = p.variants ?? []
    if (liveVariants.length === 0) continue
    const localVariants = variantsByProduct.get(row.id) ?? []
    const bySid = new Map(localVariants.filter((v) => v.shopifyVariantId).map((v) => [String(v.shopifyVariantId), v]))
    for (const lv of liveVariants) {
      const local = bySid.get(String(lv.id))
      if (!local) continue
      const n = Math.max(0, Math.floor(Number(lv.inventoryQuantity) || 0))
      const o = Math.max(0, Math.floor(Number(local.stock) || 0))
      if (n !== o) {
        changes.push({ sku: String(local.sku ?? ''), field: 'variant_stock', old: o, new: n })
      }
    }
  }
  return {
    ok: true,
    parentChanges: changes.filter((c) => c.field === 'stock').length,
    variantChanges: changes.filter((c) => c.field === 'variant_stock').length,
    samples: changes.slice(0, 10),
  }
}