-- Bookings Phase 3: explicit multi-store allocation (planning records only).
--
-- Additive: a new child table keyed to (booking, line index, store). Bookings
-- with no rows here — every legacy and single-store booking — behave exactly
-- as before (sales_orders.location_id remains the store conversion validates
-- and deducts against). Creating/editing allocations never moves or reserves
-- stock; the unique index makes duplicate/conflicting allocations impossible.
--
-- Applied idempotently by bootstrap.ts as well (CREATE TABLE/INDEX IF NOT
-- EXISTS); this file records the same DDL for the drizzle migration trail.

CREATE TABLE IF NOT EXISTS "booking_allocations" (
  "id" text PRIMARY KEY,
  "order_id" text NOT NULL,
  "line_index" integer NOT NULL,
  "product_id" text NOT NULL,
  "variant_id" text,
  "sku" text NOT NULL,
  "location_id" text NOT NULL,
  "quantity" integer NOT NULL,
  "created_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "booking_allocations_line_store_idx"
  ON "booking_allocations" ("order_id", "line_index", "location_id");

CREATE INDEX IF NOT EXISTS "booking_allocations_order_idx"
  ON "booking_allocations" ("order_id");
