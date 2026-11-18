import { eq, isNotNull } from 'drizzle-orm'
import { db, schema } from './db/client'
import { adminGraphQL } from './shopifyRefunds'
import { logger } from './logger'

/**
 * ERP stock location ↔ EXISTING Shopify location mapping.
 *
 * Rules (see the feature spec): only existing store locations are ever used —
 * nothing here creates or deletes a Shopify location; mappings persist as
 * Shopify's numeric location id (what `inventory_levels/set` needs), never a
 * display name, so renaming either side cannot break the link; the ERP stays
 * the inventory source of truth and the mapping only says WHERE a balance is
 * mirrored.
 */

/** One store location as the mapping UI needs it. */
export interface ShopifyStoreLocation {
  /** Shopify's numeric location id — the value persisted on the mapping. */
  shopifyLocationId: string
  /** Shopify's location name, for display only. */
  name: string
  /** The GraphQL gid, kept for display/debugging (never used as the key). */
  gid: string
}

/** `gid://shopify/Location/5555555` → `5555555`. Null when unparseable. */
export function shopifyLocationIdFromGid(gid: unknown): string | null {
  const value = String(gid ?? '').trim()
  const match = value.match(/^gid:\/\/shopify\/Location\/(\d+)$/)
  return match ? match[1] : null
}

const LOCATIONS_QUERY = `#graphql
  query OpalLineLocations($first: Int!) {
    locations(first: $first) {
      nodes {
        id
        name
      }
    }
  }`

/**
 * The store's existing locations, read through the Admin GraphQL API.
 * Read-only: no mutation exists in this module, by design.
 */
export async function fetchStoreLocations(): Promise<ShopifyStoreLocation[]> {
  const result = await adminGraphQL<{ locations: { nodes: Array<{ id: string; name: string }> } }>(
    LOCATIONS_QUERY,
    { first: 50 },
  )
  if (!result.ok || !result.data) {
    throw new Error(result.error ?? 'Could not fetch locations from Shopify')
  }
  const nodes = result.data.locations?.nodes ?? []
  const out: ShopifyStoreLocation[] = []
  for (const node of nodes) {
    const id = shopifyLocationIdFromGid(node.id)
    // A gid we cannot parse cannot be pushed to (inventory_levels/set wants
    // the numeric id), so it is skipped rather than persisted unusable.
    if (!id) {
      logger.warn({ gid: node.id }, 'Skipping Shopify location with an unparseable id')
      continue
    }
    out.push({ shopifyLocationId: id, name: String(node.name ?? '').trim() || `Location ${id}`, gid: String(node.id) })
  }
  return out
}

/** ERP locations that carry a mapping, with the id stored on the row. */
export async function listLocationMappings(): Promise<
  Array<{ id: string; name: string; shopifyLocationId: string }>
> {
  if (!db) return []
  const rows = await db
    .select({
      id: schema.inventoryLocations.id,
      name: schema.inventoryLocations.name,
      shopifyLocationId: schema.inventoryLocations.shopifyLocationId,
    })
    .from(schema.inventoryLocations)
    .where(isNotNull(schema.inventoryLocations.shopifyLocationId))
  return rows
    .filter((r): r is { id: string; name: string; shopifyLocationId: string } =>
      Boolean(r.shopifyLocationId))
    .map((r) => ({ id: r.id, name: r.name, shopifyLocationId: String(r.shopifyLocationId) }))
}

/**
 * The ERP location a Shopify location id maps to, or null (unmapped).
 * Resolution is by ID only — display names are never the key.
 */
export async function resolveErpLocationForShopify(
  shopifyLocationId: unknown,
): Promise<string | null> {
  const wanted = String(shopifyLocationId ?? '').trim()
  if (!wanted || !db) return null
  const [row] = await db
    .select({ id: schema.inventoryLocations.id })
    .from(schema.inventoryLocations)
    .where(eq(schema.inventoryLocations.shopifyLocationId, wanted))
    .limit(1)
  return row?.id ?? null
}

/** True when `value` is a plausible Shopify numeric location id. */
export function isShopifyLocationId(value: unknown): boolean {
  return /^\d{1,20}$/.test(String(value ?? '').trim())
}
