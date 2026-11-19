import type postgres from 'postgres'
import { splitQtyAcrossVariants, type VariantWeightEntry } from '../lib/variantSplit'

/**
 * Attributing pre-existing stock to variants — the migration half of the
 * variant-aware ledger.
 *
 * Until now a balance knew only (product, location) while `product_variants.stock`
 * was a SECOND, independently maintained counter. Nothing kept the two in step,
 * so they disagree on real data: the reported case was Red 4 + White 4 = 8
 * against a product/location total of 7, because every movement had been
 * written under the parent SKU and no movement ever named a variant.
 *
 * The rules, in order, all inside ONE transaction:
 *
 *   1. A product with no variant rows gets a `Default Title` variant (the
 *      convention the catalogue already uses), so single-variant products can
 *      be identified rather than inferred.
 *   2. A product-level balance (`stock_levels.variant_id IS NULL`) is
 *      attributed to its product's ONE variant — unambiguous, nothing invented.
 *   3. A product-level balance on a MULTI-variant product is split across its
 *      variants by their recorded shares with `splitQtyAcrossVariants`, which
 *      guarantees the parts sum to the original total **per location**: no
 *      quantity is created, dropped or moved between stores. When the product
 *      has no recorded variant shares to apportion by, the balance is left
 *      exactly where it is (NULL) rather than guessed at — it still counts
 *      towards products.stock and is reported by `unattributed`.
 *   4. History is annotated forward only where it is unambiguous: a movement
 *      of a product with exactly one variant, and a transfer whose stored SKU
 *      IS a variant SKU. Rows that cannot be named stay NULL — history is
 *      never rewritten to fit a model it predates.
 *   5. `product_variants.stock` becomes a MIRROR of the ledger (sum of that
 *      variant's location balances) for every product the ledger already
 *      tracks. Products that have never been through the ledger keep their
 *      recorded variant counts until `backfillOpeningBalances` gives them an
 *      opening entry.
 *
 * Reversible by construction: every step either adds a nullable column value
 * or replaces one balance row with rows that sum to it. Re-aggregating
 * `stock_levels` to (product_id, location_id) and nulling the variant columns
 * returns the database to the previous model without any quantity changing.
 */

export interface VariantBackfillResult {
  defaultVariantsCreated: number
  levelsAttributed: number
  levelsUnattributed: number
  movementsAttributed: number
  transfersAttributed: number
  variantsRecomputed: number
}

const DEFAULT_TITLE = '["Default Title"]'

interface LevelRow {
  product_id: string
  location_id: string
  qty: number
}

interface VariantRow {
  id: string
  sku: string
  stock: number | null
}

export async function attributeLegacyVariantStock(sql: postgres.Sql): Promise<VariantBackfillResult> {
  const result: VariantBackfillResult = {
    defaultVariantsCreated: 0,
    levelsAttributed: 0,
    levelsUnattributed: 0,
    movementsAttributed: 0,
    transfersAttributed: 0,
    variantsRecomputed: 0,
  }

  await sql.begin(async (tx) => {
    // 1 ── every product can name its stock: give the variant-less one its
    // default variant. ON CONFLICT keeps this safe if a variant with that SKU
    // already exists (a product SKU reused as a variant SKU elsewhere).
    const created = await tx`
      INSERT INTO product_variants (id, product_id, title, option_values, sku, stock, status, created_at)
      SELECT 'PV-DEF-' || p.id, p.id, 'Default Title', ${DEFAULT_TITLE}::jsonb, p.sku, 0, 'active', now()
        FROM products p
       WHERE NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)
      ON CONFLICT DO NOTHING
      RETURNING id`
    result.defaultVariantsCreated = created.count

    // 2/3 ── attribute the balances themselves, product by product.
    const pending = await tx`
      SELECT product_id, location_id, qty
        FROM stock_levels
       WHERE variant_id IS NULL
       ORDER BY product_id, location_id`
    const byProduct = new Map<string, LevelRow[]>()
    for (const row of pending as unknown as LevelRow[]) {
      const list = byProduct.get(row.product_id) ?? []
      list.push(row)
      byProduct.set(row.product_id, list)
    }

    for (const [productId, levels] of byProduct) {
      const variants = (await tx`
        SELECT id, sku, stock FROM product_variants WHERE product_id = ${productId} ORDER BY sku, id`) as unknown as VariantRow[]

      // Degenerate: a product still without any variant row (its default
      // variant could not be created because the SKU is already taken by
      // another variant). Leave the balance where it is.
      if (variants.length === 0) {
        result.levelsUnattributed += levels.length
        continue
      }

      if (variants.length === 1) {
        const only = variants[0]!.id
        for (const level of levels) {
          await tx`
            UPDATE stock_levels
               SET variant_id = ${only}
             WHERE product_id = ${level.product_id}
               AND location_id = ${level.location_id}
               AND variant_id IS NULL`
          result.levelsAttributed += 1
        }
        continue
      }

      const weights: VariantWeightEntry[] = variants.map((v) => ({
        variantId: v.id,
        weight: Number(v.stock ?? 0),
        key: String(v.sku ?? v.id),
      }))
      const totalWeight = weights.reduce((sum, w) => sum + Math.max(0, Math.floor(w.weight)), 0)

      // Nothing to apportion by: splitting this balance would be a guess, and
      // a guessed quantity is worse than an honestly unattributed one.
      if (totalWeight === 0) {
        result.levelsUnattributed += levels.length
        continue
      }

      for (const level of levels) {
        const shares = splitQtyAcrossVariants(Number(level.qty ?? 0), weights)
        if (shares.length === 0) {
          result.levelsUnattributed += 1
          continue
        }
        // Replace ONE product-level row with rows that sum to it, in the same
        // transaction: the store's total is unchanged, only its attribution
        // becomes explicit.
        await tx`
          DELETE FROM stock_levels
           WHERE product_id = ${level.product_id}
             AND location_id = ${level.location_id}
             AND variant_id IS NULL`
        for (const share of shares) {
          if (share.qty === 0) continue
          const existing = await tx`
            SELECT qty FROM stock_levels
             WHERE product_id = ${level.product_id}
               AND variant_id = ${share.variantId}
               AND location_id = ${level.location_id}`
          if (existing.count > 0) {
            const current = Number((existing[0] as { qty: number }).qty ?? 0)
            await tx`
              UPDATE stock_levels SET qty = ${current + share.qty}
               WHERE product_id = ${level.product_id}
                 AND variant_id = ${share.variantId}
                 AND location_id = ${level.location_id}`
          } else {
            await tx`
              INSERT INTO stock_levels (product_id, variant_id, location_id, qty)
              VALUES (${level.product_id}, ${share.variantId}, ${level.location_id}, ${share.qty})`
          }
          result.levelsAttributed += 1
        }
      }
    }

    // 4a ── history: name the variant only where there is exactly one answer.
    const movable = await tx`
      SELECT count(*)::int AS n
        FROM stock_movements m
       WHERE m.variant_id IS NULL
         AND m.product_id IS NOT NULL
         AND (SELECT count(*) FROM product_variants v WHERE v.product_id = m.product_id) = 1`
    const movementRows = Number((movable[0] as { n: number })?.n ?? 0)
    if (movementRows > 0) {
      await tx`
        UPDATE stock_movements m
           SET variant_id = v.id
          FROM product_variants v
         WHERE m.variant_id IS NULL
           AND m.product_id IS NOT NULL
           AND v.product_id = m.product_id
           AND (SELECT count(*) FROM product_variants c WHERE c.product_id = v.product_id) = 1`
      result.movementsAttributed = movementRows
    }

    // 4b ── transfers whose stored SKU is literally a variant SKU: unambiguous.
    const transferable = await tx`
      SELECT count(*)::int AS n
        FROM stock_transfers t
       WHERE t.variant_id IS NULL AND t.sku IS NOT NULL
         AND EXISTS (SELECT 1 FROM product_variants v WHERE v.sku = t.sku)`
    const transferRows = Number((transferable[0] as { n: number })?.n ?? 0)
    if (transferRows > 0) {
      await tx`
        UPDATE stock_transfers t
           SET variant_id = v.id
          FROM product_variants v
         WHERE t.variant_id IS NULL AND t.sku IS NOT NULL AND v.sku = t.sku`
      result.transfersAttributed = transferRows
    }

    // 5 ── mirror the ledger onto the variant counters, but only for products
    // the ledger actually tracks: a product with no balance rows has nothing
    // to mirror yet, and zeroing its recorded variant counts would delete
    // information the opening-balance backfill still needs.
    const recomputable = await tx`
      SELECT count(*)::int AS n
        FROM product_variants v
       WHERE EXISTS (SELECT 1 FROM stock_levels l WHERE l.product_id = v.product_id)
         AND EXISTS (SELECT 1 FROM stock_levels l WHERE l.variant_id = v.id)`
    const recomputableCount = Number((recomputable[0] as { n: number })?.n ?? 0)
    if (recomputableCount > 0) {
      await tx`
        UPDATE product_variants v
           SET stock = coalesce((SELECT sum(l.qty) FROM stock_levels l WHERE l.variant_id = v.id), 0)
         WHERE EXISTS (SELECT 1 FROM stock_levels l WHERE l.product_id = v.product_id)
           AND EXISTS (SELECT 1 FROM stock_levels l WHERE l.variant_id = v.id)`
      result.variantsRecomputed = recomputableCount
    }
  })

  return result
}

/**
 * Recomputes `product_variants.stock` and `products.stock` for one product
 * from its location balances. Both counters are mirrors of stock_levels —
 * they are never incremented independently any more, which is what let them
 * drift apart in the first place.
 */
export async function recomputeVariantStockMirrors(
  sql: postgres.Sql,
  productId?: string,
): Promise<{ variants: number; product: boolean }> {
  return sql.begin(async (tx) => {
    const variants = await tx`
      UPDATE product_variants v
         SET stock = coalesce((SELECT sum(l.qty) FROM stock_levels l WHERE l.variant_id = v.id), 0)
       WHERE (${productId ?? null}::text IS NULL OR v.product_id = ${productId ?? null})
         AND EXISTS (SELECT 1 FROM stock_levels l WHERE l.product_id = v.product_id)
      RETURNING v.id`

    const totals = await tx`
      SELECT p.id AS id, coalesce((SELECT sum(l.qty) FROM stock_levels l WHERE l.product_id = p.id), 0)::int AS total
        FROM products p
       WHERE (${productId ?? null}::text IS NULL OR p.id = ${productId ?? null})
         AND EXISTS (SELECT 1 FROM stock_levels l WHERE l.product_id = p.id)`
    for (const row of totals as unknown as Array<{ id: string; total: number }>) {
      await tx`UPDATE products SET stock = ${row.total} WHERE id = ${row.id}`
    }
    return { variants: variants.count, product: totals.count > 0 }
  })
}
