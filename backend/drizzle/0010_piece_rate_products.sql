-- Piece Rate Product: a fixed price per piece that replaces the silver-rate
-- pricing calculation. Existing rows default to off, so current pricing is
-- untouched until a product is explicitly marked as piece-rate.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "piece_rate_product" boolean NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "fixed_piece_rate" numeric;
