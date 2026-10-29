/**
 * Inventory collections & categories — the foundation for grouping products by
 * how they are priced.
 *
 * Two collections ship with the app:
 *   • Silver Jewels  — the existing catalogue, priced from the silver rate.
 *   • Other Products — the independent / fixed-price group ("Other Products"
 *                      is only its initial display name; it can be renamed).
 *
 * The id is the stable identity and the name is a display label, so renaming a
 * collection never rewrites a reference. Categories belong to a collection and
 * carry a globally unique SKU prefix; the existing free-text products.category
 * and products.collection columns are untouched, and no current SKU or pricing
 * code reads these tables yet — this module establishes the data model only.
 *
 * Pure by design so the rules can be unit-tested without a database.
 */
import { CATEGORY_PREFIX } from './productCodes'

export type CollectionPricingType = 'silver' | 'fixed'

/** Stable ids — never derived from the editable name. */
export const COLLECTION_IDS = {
  silverJewels: 'COL-SILVER-JEWELS',
  otherProducts: 'COL-OTHER-PRODUCTS',
} as const

export interface CollectionSeed {
  id: string
  name: string
  pricingType: CollectionPricingType
  isSystem: boolean
}

/**
 * The two foundation collections. Inserted once (ON CONFLICT DO NOTHING), so a
 * renamed collection keeps its new name across restarts.
 */
export const DEFAULT_COLLECTIONS: CollectionSeed[] = [
  {
    id: COLLECTION_IDS.silverJewels,
    name: 'Silver Jewels',
    // The existing silver-rate behaviour is unchanged: this collection only
    // records how its products are priced.
    pricingType: 'silver',
    isSystem: true,
  },
  {
    id: COLLECTION_IDS.otherProducts,
    name: 'Other Products',
    pricingType: 'fixed',
    isSystem: false,
  },
]

export const COLLECTION_PRICING_TYPES: CollectionPricingType[] = ['silver', 'fixed']

/** Uppercase 2–5 letters — the middle segment of OL-{PREFIX}-{SEQ}. */
export const CATEGORY_PREFIX_PATTERN = /^[A-Z]{2,5}$/

export const CATEGORY_NAME_MAX = 120
export const COLLECTION_NAME_MAX = 120
export const CATEGORY_PREFIX_MAX = 5

/** Trimmed category name as stored. */
export function normalizeCategoryName(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

/** Trimmed collection display name as stored (the id is the identity). */
export function normalizeCollectionName(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

/** Trimmed, upper-cased prefix as stored. */
export function normalizeCategoryPrefix(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

/** User-facing validation error, or null when the name is acceptable. */
export function categoryNameError(name: string): string | null {
  if (!name) return 'Category name is required'
  if (name.length > CATEGORY_NAME_MAX) return `Category name must be ${CATEGORY_NAME_MAX} characters or fewer`
  return null
}

/** User-facing validation error, or null when the prefix is acceptable. */
export function categoryPrefixError(prefix: string): string | null {
  if (!prefix) return 'SKU prefix is required'
  if (!CATEGORY_PREFIX_PATTERN.test(prefix)) {
    return 'SKU prefix must be 2–5 letters (A–Z), e.g. BAG'
  }
  return null
}

export function collectionNameError(name: string): string | null {
  if (!name) return 'Collection name is required'
  if (name.length > COLLECTION_NAME_MAX) return `Collection name must be ${COLLECTION_NAME_MAX} characters or fewer`
  return null
}

/**
 * A fixed-price product needs a manually entered selling price. Nothing derives
 * it from the silver rate, weight or making charges — that formula belongs to
 * the silver-rate collection alone.
 */
export function fixedPriceError(value: unknown): string | null {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n) || n <= 0) {
    return 'A selling price is required for a fixed-price collection — it is never calculated from the silver rate'
  }
  return null
}

/** Seeded categories: one row per established SKU prefix, in Silver Jewels. */
export function categorySeedRows(): Array<{
  id: string
  collectionId: string
  name: string
  prefix: string
}> {
  return Object.entries(CATEGORY_PREFIX).map(([name, prefix]) => ({
    id: `CAT-${prefix}`,
    collectionId: COLLECTION_IDS.silverJewels,
    name,
    prefix,
  }))
}

/** Default categories for Other Products collection (empty by default; users can create them). */
export const OTHER_PRODUCT_DEFAULT_CATEGORIES: Array<{
  id: string
  collectionId: string
  name: string
  prefix: string
}> = []
