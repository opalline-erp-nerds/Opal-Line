-- Inventory collections & categories (foundation only).
--
-- Two pricing collections ship with the app:
--   COL-SILVER-JEWELS  Silver Jewels  (silver-rate pricing, system/immutable name)
--   COL-OTHER-PRODUCTS Other Products (fixed-price, renameable)
--
-- The id is the stable identity; `name` is a display label, so renaming never
-- rewrites a reference. Categories carry a globally unique SKU prefix so future
-- category-based SKU generation cannot mint duplicate codes, and each existing
-- Opal Line category is seeded into Silver Jewels.
--
-- Existing products keep their free-text category/collection columns and their
-- pricing untouched: this migration adds tables and reference rows only.
-- Runtime bootstrap (src/db/bootstrap.ts + src/db/collectionsSeed.ts) applies
-- the same statements idempotently on every start.

CREATE TABLE IF NOT EXISTS "collections" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "pricing_type" text NOT NULL DEFAULT 'fixed',
  "is_system" boolean NOT NULL DEFAULT false,
  "created_at" timestamp,
  "updated_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collections_name_unique" ON "collections" ("name");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "product_categories" (
  "id" text PRIMARY KEY NOT NULL,
  "collection_id" text NOT NULL REFERENCES "collections"("id"),
  "name" text NOT NULL,
  "prefix" text NOT NULL,
  "created_at" timestamp,
  "updated_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_categories_name_unique" ON "product_categories" ("name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_categories_prefix_unique" ON "product_categories" ("prefix");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_categories_collection_idx" ON "product_categories" ("collection_id");
--> statement-breakpoint

INSERT INTO "collections" ("id", "name", "pricing_type", "is_system", "created_at", "updated_at") VALUES
  ('COL-SILVER-JEWELS', 'Silver Jewels', 'silver', true, now(), now()),
  ('COL-OTHER-PRODUCTS', 'Other Products', 'fixed', false, now(), now())
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- One category per established Opal Line SKU prefix. ON CONFLICT DO NOTHING
-- keeps re-runs (and renamed/edited rows) intact.
INSERT INTO "product_categories" ("id", "collection_id", "name", "prefix", "created_at", "updated_at") VALUES
  ('CAT-SIL', 'COL-SILVER-JEWELS', 'Silver jewels', 'SIL', now(), now()),
  ('CAT-RNG', 'COL-SILVER-JEWELS', 'Rings', 'RNG', now(), now()),
  ('CAT-CHN', 'COL-SILVER-JEWELS', 'Chains', 'CHN', now(), now()),
  ('CAT-EAR', 'COL-SILVER-JEWELS', 'Earrings', 'EAR', now(), now()),
  ('CAT-NCK', 'COL-SILVER-JEWELS', 'Necklaces', 'NCK', now(), now()),
  ('CAT-BRC', 'COL-SILVER-JEWELS', 'Bracelets', 'BRC', now(), now()),
  ('CAT-BNG', 'COL-SILVER-JEWELS', 'Bangles', 'BNG', now(), now()),
  ('CAT-PND', 'COL-SILVER-JEWELS', 'Pendants', 'PND', now(), now()),
  ('CAT-ANK', 'COL-SILVER-JEWELS', 'Anklets', 'ANK', now(), now()),
  ('CAT-MNG', 'COL-SILVER-JEWELS', 'Mangalsutra', 'MNG', now(), now()),
  ('CAT-TRG', 'COL-SILVER-JEWELS', 'Toe Rings', 'TRG', now(), now()),
  ('CAT-NSP', 'COL-SILVER-JEWELS', 'Nose Pins', 'NSP', now(), now()),
  ('CAT-CUF', 'COL-SILVER-JEWELS', 'Accessories', 'CUF', now(), now())
ON CONFLICT DO NOTHING;
