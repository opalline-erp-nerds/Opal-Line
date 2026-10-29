/**
 * Database lookups that link a product to its pricing collection and category.
 *
 * A product stores both the stable ids (products.collectionId / categoryId) and
 * the display text (products.collection / category). The text keeps every
 * existing filter, search and report working; the ids are what the pricing
 * model and SKU prefix are derived from, so renaming a collection or category
 * never changes what a product points at.
 *
 * The resolution rules live here (rather than only inside the route) so the
 * create, edit and CSV-import paths all agree:
 *   • an explicit collectionId/categoryId is the identity and is validated;
 *   • a category must belong to the collection it is used with;
 *   • a fixed-price collection needs a real category row, because its SKU
 *     prefix comes from the category — a free-text category would mint a code
 *     from its name, which is exactly what this step rules out;
 *   • with no explicit collection nothing is linked (legacy rows keep their
 *     free-text grouping and the Silver Jewels default).
 */
import { eq, sql } from 'drizzle-orm'
import { schema as s } from '../db/client'
import type { CollectionPricingType } from './collections'

export interface CollectionRef {
  id: string
  name: string
  pricingType: CollectionPricingType
  isSystem: boolean
}

export interface CategoryRef {
  id: string
  collectionId: string
  name: string
  prefix: string
}

const collectionColumns = {
  id: s.collections.id,
  name: s.collections.name,
  pricingType: s.collections.pricingType,
  isSystem: s.collections.isSystem,
}

const categoryColumns = {
  id: s.productCategories.id,
  collectionId: s.productCategories.collectionId,
  name: s.productCategories.name,
  prefix: s.productCategories.prefix,
}

/** A collection by its stable id or (case-insensitively) its display name. */
export async function findCollection(tx: any, ref: string | null | undefined): Promise<CollectionRef | null> {
  const key = String(ref ?? '').trim()
  if (!key) return null
  const byId = await tx.select(collectionColumns).from(s.collections).where(eq(s.collections.id, key)).limit(1)
  if (byId[0]) return byId[0] as CollectionRef
  const byName = await tx
    .select(collectionColumns)
    .from(s.collections)
    .where(sql`lower(${s.collections.name}) = lower(${key})`)
    .limit(1)
  return (byName[0] as CollectionRef | undefined) ?? null
}

export async function findCategoryById(tx: any, id: string | null | undefined): Promise<CategoryRef | null> {
  const key = String(id ?? '').trim()
  if (!key) return null
  const [row] = await tx.select(categoryColumns).from(s.productCategories).where(eq(s.productCategories.id, key)).limit(1)
  return (row as CategoryRef | undefined) ?? null
}

/** A category row by its (globally unique) display name. */
export async function findCategoryByName(
  tx: any,
  name: string | null | undefined,
  collectionId?: string | null,
): Promise<CategoryRef | null> {
  const key = String(name ?? '').trim()
  if (!key) return null
  const where = collectionId
    ? sql`lower(${s.productCategories.name}) = lower(${key}) and ${s.productCategories.collectionId} = ${collectionId}`
    : sql`lower(${s.productCategories.name}) = lower(${key})`
  const [row] = await tx.select(categoryColumns).from(s.productCategories).where(where).limit(1)
  return (row as CategoryRef | undefined) ?? null
}

/**
 * Preloaded lookup used by the CSV import routes: collections by id AND by
 * name (both lower-cased), categories by `collectionId\0name`. Loading once
 * keeps a 2000-row import at two queries instead of four per row.
 */
export interface CollectionLookup {
  collections: Map<string, { id: string; name: string; pricingType: CollectionPricingType }>
  categories: Map<string, { id: string; collectionId: string; name: string }>
}

export async function loadCollectionLookup(tx: any): Promise<CollectionLookup> {
  const lookup: CollectionLookup = { collections: new Map(), categories: new Map() }
  for (const row of await tx
    .select({ id: s.collections.id, name: s.collections.name, pricingType: s.collections.pricingType })
    .from(s.collections)) {
    lookup.collections.set(String(row.id).trim().toLowerCase(), row)
    lookup.collections.set(String(row.name).trim().toLowerCase(), row)
  }
  for (const row of await tx
    .select({ id: s.productCategories.id, collectionId: s.productCategories.collectionId, name: s.productCategories.name })
    .from(s.productCategories)) {
    lookup.categories.set(`${row.collectionId}\u0000${String(row.name).trim().toLowerCase()}`, row)
  }
  return lookup
}

/** A CSV `collection` cell: a stable id or a display name, case-insensitive. */
export function lookupCollection(
  lookup: CollectionLookup,
  key: string | null | undefined,
): { id: string; name: string; pricingType: CollectionPricingType } | null {
  const normalized = String(key ?? '').trim().toLowerCase()
  if (!normalized) return null
  return lookup.collections.get(normalized) ?? null
}

/** The named category inside one collection; only a match links an import row. */
export function lookupCategory(
  lookup: CollectionLookup,
  collectionId: string,
  categoryName: string | null | undefined,
): { id: string; collectionId: string; name: string } | null {
  const normalized = String(categoryName ?? '').trim().toLowerCase()
  if (!normalized) return null
  return lookup.categories.get(`${collectionId}\u0000${normalized}`) ?? null
}

/**
 * One CSV import row's association. `text` is the row's text fields with the
 * collection/category columns resolved to canonical values; when there is no
 * collection cell the grouping fields are left out entirely, so an update
 * preserves what the product already carries instead of nulling it.
 */
export interface ImportRowAssociation {
  text: Record<string, string | null>
  collection: { id: string; name: string; pricingType: CollectionPricingType } | null
  category: { id: string; collectionId: string; name: string } | null
}

export function importRowAssociation(
  lookup: CollectionLookup,
  mapped: Record<string, string>,
  baseText: Record<string, string | null>,
): ImportRowAssociation {
  const text = { ...baseText }
  const declared = mapped.collection
  const collection = lookupCollection(lookup, declared)
  if (!collection) {
    // No collection cell: keep the product's existing grouping. A cell that
    // does not name a pricing collection stays the free text it always was.
    if (declared) text.collection = declared
    return { text, collection: null, category: null }
  }
  const category = lookupCategory(lookup, collection.id, text.category)
  text.collection = collection.name
  text.collectionId = collection.id
  text.categoryId = category?.id ?? null
  return { text, collection, category }
}

export interface AssociationInput {
  collectionId?: unknown
  collectionName?: unknown
  categoryId?: unknown
  categoryName?: unknown
}

export type AssociationResult =
  | { ok: true; collection: CollectionRef | null; category: CategoryRef | null }
  | { ok: false; error: string }

/**
 * Resolve the collection + category a product write belongs to. See the module
 * docblock for the rules; the returned refs are the canonical rows, so callers
 * store the current display names and stable ids together.
 */
export async function resolveProductAssociation(tx: any, input: AssociationInput): Promise<AssociationResult> {
  const collectionId = String(input.collectionId ?? '').trim()
  const collectionName = String(input.collectionName ?? '').trim()
  const categoryId = String(input.categoryId ?? '').trim()
  const categoryName = String(input.categoryName ?? '').trim()

  let collection: CollectionRef | null = null
  let category: CategoryRef | null = null

  if (categoryId) {
    category = await findCategoryById(tx, categoryId)
    if (!category) return { ok: false, error: 'Unknown category — create it in Inventory → Collections & Categories' }
  }

  if (collectionId || collectionName) {
    collection = await findCollection(tx, collectionId || collectionName)
    if (!collection) return { ok: false, error: 'Unknown collection' }
  } else if (category) {
    // A category id alone is enough: its row names the collection.
    collection = (await findCollection(tx, category.collectionId)) as CollectionRef | null
  }

  if (category && collection && category.collectionId !== collection.id) {
    return {
      ok: false,
      error: `The category "${category.name}" belongs to another collection — pick one from ${collection.name}`,
    }
  }
  if (!category && collection && categoryName) {
    // Match the typed/imported name to a category of THIS collection.
    category = await findCategoryByName(tx, categoryName, collection.id)
  }

  if (collection?.pricingType === 'fixed' && !category) {
    return {
      ok: false,
      error: `${collection.name} is fixed-price: choose a category from that collection — it determines the SKU prefix`,
    }
  }

  return { ok: true, collection, category }
}
