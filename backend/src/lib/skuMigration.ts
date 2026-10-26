/**
 * Planning half of the safe SKU-regeneration utility
 * (POST /db/products/skus/regenerate in src/routes/db.ts).
 *
 * Generic SKUs are the legacy catch-all codes with the GEN category segment
 * (e.g. SLV-GEN-001) minted when a product sat in the whole-catalogue default
 * category. They carry no category information, so labels, stock history and
 * lookups all lump together. This module decides, without touching the
 * database, which products are candidates and what their new category-based
 * OL-{CODE}-{SEQ} SKU should be — the route does the reference checks and the
 * transactional rewrite.
 *
 * Pure by design: everything here is unit-testable without a database, which
 * is what makes the migration reviewable before a single row changes.
 */
import { categoryCode, generateSku, normalizedCodeSettings, type ProductCodeSettings } from './productCodes'

/** The middle segment that marks a SKU as generic (no category information). */
export const GENERIC_SEGMENT = 'GEN'

/**
 * True when a SKU is one of the legacy generic codes: any prefix, the GEN
 * category segment, a numeric sequence (SLV-GEN-001, OL-GEN-00099, …).
 * Category-specific codes (SLV-RNG-00021) are NOT generic and are never
 * candidates — existing category SKUs are preserved exactly as they are.
 */
export function isGenericSku(sku: string | null | undefined): boolean {
  return /^[A-Z0-9]+-GEN-\d{1,8}$/i.test(String(sku ?? '').trim())
}

export interface MigrationCandidate {
  id: string
  name: string
  oldSku: string
  newSku: string
}

/**
 * Plan the regeneration: every generic SKU gets the product's real category
 * code with the next free sequence for THAT category, so
 * `OL-RNG-001` never collides with an existing category code and two
 * products in different categories get independent sequences.
 *
 * `allSkus` must contain every SKU the plan may collide with (products AND
 * product variants), so the result is safe to apply verbatim.
 */
export function planSkuMigration(
  products: Array<{ id: string; name: string; sku: string; category: string }>,
  allSkus: Array<string | null | undefined>,
  settings?: ProductCodeSettings | null,
): MigrationCandidate[] {
  const cfg = normalizedCodeSettings(settings)
  // Sequences continue from every existing code, generic or not: a Rings
  // product already numbered 21 keeps moving from 22 after regeneration.
  const taken = new Set(
    allSkus
      .map((s) => String(s ?? '').trim().toUpperCase())
      .filter(Boolean),
  )
  const plan: MigrationCandidate[] = []
  // Deterministic order so re-running the dry run shows the same proposal.
  const ordered = [...products].sort((a, b) =>
    a.sku.localeCompare(b.sku, undefined, { numeric: true }) || a.id.localeCompare(b.id),
  )
  for (const p of ordered) {
    const oldSku = String(p.sku ?? '').trim()
    if (!isGenericSku(oldSku)) continue
    const newSku = generateSku([...taken], p.category ?? '', cfg)
    // Reserve the candidate so two generic products in the same category
    // cannot both plan the same sequence number.
    taken.add(newSku.toUpperCase())
    if (newSku.toUpperCase() === oldSku.toUpperCase()) continue
    plan.push({ id: p.id, name: p.name, oldSku, newSku })
  }
  return plan
}

/** How many of a product's SKU references live in each dependent table. */
export interface SkuReferences {
  invoiceItems: number
  orderItems: number
  stockMovements: number
  stockTransfers: number
  variants: number
  shopifyLinked: boolean
}

/**
 * A regeneration is only applied when we know what references the old SKU.
 * Documents (invoices, orders) are historical snapshots: their stored SKU is
 * left untouched so past printouts keep matching what was sold, and the
 * report tells the operator exactly how many such rows still point at the old
 * code. Live references (stock ledger, transfers, variants) are rewritten in
 * the same transaction as the product so nothing dangles.
 */
export function migrationWarnings(refs: SkuReferences): string[] {
  const out: string[] = []
  if (refs.invoiceItems > 0) out.push(`${refs.invoiceItems} invoice line(s) keep the old SKU as a historical snapshot`)
  if (refs.orderItems > 0) out.push(`${refs.orderItems} order line(s) keep the old SKU as a historical snapshot`)
  if (refs.shopifyLinked) out.push('product is linked to Shopify — push products after regenerating so the remote SKU updates')
  return out
}

/** True when the rewrite would touch live (non-document) references. */
export function hasLiveReferences(refs: SkuReferences): boolean {
  return refs.stockMovements > 0 || refs.stockTransfers > 0 || refs.variants > 0
}

export { categoryCode }
