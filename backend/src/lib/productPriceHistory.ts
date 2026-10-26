import { randomUUID } from 'node:crypto'
import { db, schema } from '../db/client'
import { logger } from '../logger'

/** Persist a selling-price snapshot. Failures are logged, never thrown. */
export async function recordProductPrice(productId: string, sellingPrice: unknown, recordedAt?: string) {
  if (!db || !productId) return
  const price = Number(sellingPrice)
  if (!Number.isFinite(price) || price < 0) return
  try {
    await db.insert(schema.productPriceHistory).values({
      id: randomUUID(),
      productId,
      sellingPrice: price,
      recordedAt: recordedAt ?? new Date().toISOString(),
    })
  } catch (err) {
    logger.warn({ err, productId }, 'product price history write failed')
  }
}
