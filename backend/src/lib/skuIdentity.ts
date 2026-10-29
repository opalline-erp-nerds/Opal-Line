/**
 * SKU identity for products: concurrency-safe generation and scan lookup.
 *
 * The SKU is the single product identifier now — printed labels carry a QR
 * code encoding ONLY the SKU (see src/barcodeLabels.ts labelCode), and every
 * scan entry point resolves a product through an exact SKU match here.
 *
 * Two rules keep identifiers safe under concurrency:
 *   1. generation runs inside the caller's transaction under a per-category
 *      advisory lock, so two simultaneous creates in the same category are
 *      serialised and cannot mint the same OL-{CODE}-{SEQ} code;
 *   2. the unique index on products.sku (products_sku_idx) is the final
 *      backstop — even a bug that skipped the lock cannot commit a duplicate.
 */
import { sql } from 'drizzle-orm'
import { schema as s } from '../db/client'
import { categoryCode, generateSku, type ProductCodeSettings } from './productCodes'

/**
 * Settings → Product codes, read inside the caller's transaction so the code
 * that is minted matches the configured prefix/format/sequence length.
 * `undefined` when no settings row exists yet (the shipped defaults apply).
 */
export async function productCodeSettings(tx: any): Promise<ProductCodeSettings | null> {
  const [row] = await tx
    .select({
      skuPrefix: s.settings.skuPrefix,
      skuSuffix: s.settings.skuSuffix,
      skuFormat: s.settings.skuFormat,
      skuSeqLength: s.settings.skuSeqLength,
    })
    .from(s.settings)
    .limit(1)
  return row ?? null
}

/**
 * Next free SKU for a category, computed INSIDE the caller's transaction after
 * taking the category's advisory lock. `tx` is any drizzle transaction/db
 * handle — the shapes used here (execute/select) are identical for both.
 * `settings` is the Settings → Product codes slice when the caller has already
 * read it; omitted, the shipped OL defaults apply.
 */
export async function generateUniqueSku(
  tx: any,
  category: string,
  settings?: ProductCodeSettings | null,
  /**
   * The category's own SKU prefix (product_categories.prefix) when the product
   * belongs to a catalogue category. It wins over the name-derived code, so a
   * category created in Inventory → Collections & Categories mints exactly its
   * stated prefix. The advisory lock is keyed on the same code, so products of
   * any categories sharing a code still serialise.
   */
  prefix?: string | null,
): Promise<string> {
  const code = categoryCode(category)
  const lockCode = String(prefix ?? '').replace(/[^a-zA-Z]/g, '').toUpperCase() || code
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'sku:gen:' + lockCode}))`)
  const rows = await tx.select({ sku: s.products.sku }).from(s.products)
  const variantRows = await tx.select({ sku: s.productVariants.sku }).from(s.productVariants)
  return generateSku(
    [...rows.map((r: { sku: string | null }) => r.sku), ...variantRows.map((r: { sku: string | null }) => r.sku)],
    category,
    settings ?? undefined,
    prefix,
  )
}

/**
 * Exact-SKU product lookup for scan entry points (stock count, sales orders,
 * invoice lines). Exact match only — no fuzzy/partial matching — so a scan can
 * never resolve to the wrong product. Returns up to 2 rows so the caller can
 * detect legacy duplicate SKUs instead of silently picking one.
 */
export async function findProductsBySku(
  db: any,
  code: string,
): Promise<Array<{ id: string; name: string; sku: string; stock: number | null; category: string | null; status: string | null }>> {
  return db
    .select({
      id: s.products.id,
      name: s.products.name,
      sku: s.products.sku,
      stock: s.products.stock,
      category: s.products.category,
      status: s.products.status,
    })
    .from(s.products)
    .where(sql`upper(${s.products.sku}) = upper(${code})`)
    .limit(2)
}
