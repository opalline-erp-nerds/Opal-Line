/**
 * Seeds the inventory collection foundation: the two pricing collections and
 * one category per established SKU prefix (Silver Jewels).
 *
 * Idempotent and safe on every boot: inserts use ON CONFLICT DO NOTHING keyed
 * by the stable ids, so a renamed collection (Other Products → "Gifting") keeps
 * its new name, and a category an admin edited is never reset. Seeded names
 * that a user already created in another collection are skipped rather than
 * failing the boot, because the unique name/prefix indexes are the final word.
 *
 * Runs after the schema DDL (bootstrap calls it from both the fresh-install and
 * upgrade paths) and is exported so route tests can prepare a scratch database.
 */
import type postgres from 'postgres'
import { DEFAULT_COLLECTIONS, categorySeedRows } from '../lib/collections'

export async function ensureCollectionFoundation(sql: postgres.Sql): Promise<void> {
  for (const collection of DEFAULT_COLLECTIONS) {
    await sql`
      INSERT INTO collections (id, name, pricing_type, is_system, created_at, updated_at)
      VALUES (
        ${collection.id},
        ${collection.name},
        ${collection.pricingType},
        ${collection.isSystem},
        now(),
        now()
      )
      ON CONFLICT DO NOTHING
    `
  }
  for (const row of categorySeedRows()) {
    await sql`
      INSERT INTO product_categories (id, collection_id, name, prefix, created_at, updated_at)
      VALUES (${row.id}, ${row.collectionId}, ${row.name}, ${row.prefix}, now(), now())
      ON CONFLICT DO NOTHING
    `
  }
}
