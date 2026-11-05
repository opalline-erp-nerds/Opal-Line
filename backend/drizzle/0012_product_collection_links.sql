-- Link products to the pricing collection / category they belong to.
--
-- collections and product_categories were introduced in 0011 as reference
-- data only. This migration gives every product a stable link:
--   collection_id  collections.id        stable collection identity (COL-…)
--   category_id    product_categories.id category row, whose prefix mints SKUs
--
-- Existing rows are left NULL on purpose: their free-text category/collection
-- and their pricing stay exactly as they are, and no SKU or price is rewritten.
-- New products created through the product dialog carry both ids; the backend
-- validates that the category actually belongs to the collection.
--
-- Runtime bootstrap (src/db/bootstrap.ts COLLECTIONS_DDL) applies the same
-- idempotent ALTERs on every start.

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "collection_id" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "category_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_collection_id_idx" ON "products" ("collection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_category_id_idx" ON "products" ("category_id");
