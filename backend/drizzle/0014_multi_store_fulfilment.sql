-- Bookings Phase 4: multi-store fulfilment traceability (Option A).
--
-- Additive only; applied idempotently by bootstrap.ts (BOOKING_FULFILMENT_DDL,
-- both the fresh-install and upgrade paths) as well — this file records the
-- same DDL for the drizzle migration trail. No existing row is rewritten and
-- no backfill runs:
--
--   booking_allocations.line_id            stable booking-line identity;
--                                          NULL on Phase-3 rows, which still
--                                          resolve by line_index + identity.
--   booking_allocations.invoice_id         the invoice that consumed this
--   booking_allocations.fulfilled_at       allocation (set in the same
--                                          transaction as the invoice).
--   sales_invoice_items.location_id        the store this line's units were
--                                          fulfilled from; NULL on every
--                                          historical invoice ("legacy:
--                                          resolve exactly as before").
--   sales_invoice_items.booking_line_id    the exact booking line invoiced.
--   sales_invoice_items.booking_allocation_id
--                                          the exact allocation consumed.

ALTER TABLE "booking_allocations" ADD COLUMN IF NOT EXISTS "line_id" text;
ALTER TABLE "booking_allocations" ADD COLUMN IF NOT EXISTS "invoice_id" text;
ALTER TABLE "booking_allocations" ADD COLUMN IF NOT EXISTS "fulfilled_at" timestamp;

ALTER TABLE "sales_invoice_items" ADD COLUMN IF NOT EXISTS "location_id" text;
ALTER TABLE "sales_invoice_items" ADD COLUMN IF NOT EXISTS "booking_line_id" text;
ALTER TABLE "sales_invoice_items" ADD COLUMN IF NOT EXISTS "booking_allocation_id" text;

CREATE INDEX IF NOT EXISTS "sales_invoice_items_booking_line_idx"
  ON "sales_invoice_items" ("booking_line_id");
