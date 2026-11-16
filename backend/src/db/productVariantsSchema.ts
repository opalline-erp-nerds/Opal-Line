import { getRawClient } from './client'
import { logger } from '../logger'

let variantColumnEnsured = false

/** Idempotent: required by variant merge since safety sync (shopify_variant_id). */
export async function ensureProductVariantsShopifyIdColumn(): Promise<void> {
  if (variantColumnEnsured) return
  const sql = getRawClient()
  if (!sql) return
  try {
    await sql.unsafe(`ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS shopify_variant_id text`)
    await sql.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS product_variants_shopify_variant_id_idx ON product_variants (shopify_variant_id) WHERE shopify_variant_id IS NOT NULL`,
    )
    variantColumnEnsured = true
  } catch (err) {
    logger.warn({ err }, 'Could not ensure product_variants.shopify_variant_id column')
  }
}

/** Tests only — run ensure again in the same process. */
export function resetProductVariantsSchemaGuardForTests(): void {
  variantColumnEnsured = false
}