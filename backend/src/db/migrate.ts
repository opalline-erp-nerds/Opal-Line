import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from './schema'
import { defaultRolePermissions } from '../rbac'
import { roleNames } from './seedData'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

async function main() {
  const client = postgres(databaseUrl!, { max: 1 })
  const db = drizzle(client, { schema })

  console.log('Ensuring roles table and users.permissions column...')
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "roles" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "description" text,
      "permissions" jsonb NOT NULL,
      "is_system" boolean DEFAULT false NOT NULL,
      "created_at" timestamp,
      CONSTRAINT "roles_name_unique" UNIQUE("name")
    );
  `)
  await client.unsafe(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "permissions" jsonb;`)
  await client.unsafe(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" text;`)
  await client.unsafe(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;`)
  // Invoice customer detail snapshot (address block for print/PDF)
  await client.unsafe(`ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "customer_phone" text;`)
  await client.unsafe(`ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "customer_address" text;`)
  await client.unsafe(`ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "customer_city" text;`)
  await client.unsafe(`ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "customer_state" text;`)
  await client.unsafe(`ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "customer_pincode" text;`)

  // Silver rate audit fields + staff rate-change approval workflow
  console.log('Ensuring silver rate audit columns and rate request table...')
  await client.unsafe(`ALTER TABLE "silver_rates" ADD COLUMN IF NOT EXISTS "updated_by" text;`)
  await client.unsafe(`ALTER TABLE "silver_rates" ADD COLUMN IF NOT EXISTS "source" text;`)
  await client.unsafe(`ALTER TABLE "silver_rates" ADD COLUMN IF NOT EXISTS "sync_status" text;`)
  await client.unsafe(`ALTER TABLE "silver_rates" ADD COLUMN IF NOT EXISTS "approved_by" text;`)
  // Per-step record of each rate update (pipeline tracker + View dialog).
  await client.unsafe(`ALTER TABLE "silver_rates" ADD COLUMN IF NOT EXISTS "step_log" jsonb;`)
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "silver_rate_requests" (
      "id" text PRIMARY KEY,
      "rate" numeric,
      "previous_rate" numeric,
      "status" text NOT NULL DEFAULT 'pending',
      "sync_first" boolean NOT NULL DEFAULT false,
      "requested_by" text,
      "requested_by_id" text,
      "requested_by_role" text,
      "requested_at" timestamp,
      "decided_by" text,
      "decided_by_id" text,
      "decided_at" timestamp,
      "decision_note" text,
      "result_note" text
    );`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "silver_rate_requests_status_idx" ON "silver_rate_requests" ("status");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "silver_rate_requests_requested_at_idx" ON "silver_rate_requests" ("requested_at");`)
  await client.unsafe(`ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "require_rate_approval" boolean DEFAULT true;`)
  await client.unsafe(`ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "auto_update_mcx" boolean DEFAULT false;`)
  await client.unsafe(`ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "einvoice_mode" text DEFAULT 'off';`)

  console.log('Purchase line items, supplier payment ledger (idempotent)...')
  // Purchases previously stored only totals, so nothing could reach stock and
  // supplier payments had nowhere to be recorded.
  //
  // The three parent tables are created here rather than assumed: an install
  // whose bootstrap predates purchases never had them, and every statement
  // below (the ALTERs, plus the line-item tables that reference these by
  // foreign key) fails against a missing relation.
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "purchase_orders" (
      "id" text PRIMARY KEY NOT NULL,
      "number" text NOT NULL,
      "supplier" text,
      "items" integer,
      "qty" integer,
      "weight" numeric,
      "value" numeric,
      "status" text,
      "date" timestamp,
      CONSTRAINT "purchase_orders_number_unique" UNIQUE ("number")
    );`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_orders_supplier_idx" ON "purchase_orders" ("supplier");`)
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "purchase_invoices" (
      "id" text PRIMARY KEY NOT NULL,
      "number" text NOT NULL,
      "supplier" text,
      "items" integer,
      "qty" integer,
      "weight" numeric,
      "rate" numeric,
      "cost" numeric,
      "tax" numeric,
      "total" numeric,
      "status" text,
      "date" timestamp,
      CONSTRAINT "purchase_invoices_number_unique" UNIQUE ("number")
    );`)
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "purchase_returns" (
      "id" text PRIMARY KEY NOT NULL,
      "number" text NOT NULL,
      "supplier" text,
      "items" integer,
      "weight" numeric,
      "amount" numeric,
      "status" text,
      "date" timestamp,
      CONSTRAINT "purchase_returns_number_unique" UNIQUE ("number")
    );`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_returns_supplier_idx" ON "purchase_returns" ("supplier");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_returns_date_idx" ON "purchase_returns" ("date");`)
  await client.unsafe(`ALTER TABLE "purchase_invoices" ADD COLUMN IF NOT EXISTS "paid_amount" numeric DEFAULT 0;`)
  await client.unsafe(`ALTER TABLE "purchase_invoices" ADD COLUMN IF NOT EXISTS "supplier_gstin" text;`)
  await client.unsafe(`ALTER TABLE "purchase_invoices" ADD COLUMN IF NOT EXISTS "supplier_state" text;`)
  await client.unsafe(`ALTER TABLE "purchase_invoices" ADD COLUMN IF NOT EXISTS "cgst" numeric;`)
  await client.unsafe(`ALTER TABLE "purchase_invoices" ADD COLUMN IF NOT EXISTS "sgst" numeric;`)
  await client.unsafe(`ALTER TABLE "purchase_invoices" ADD COLUMN IF NOT EXISTS "igst" numeric;`)
  await client.unsafe(`ALTER TABLE "purchase_invoices" ADD COLUMN IF NOT EXISTS "tcs_rate" numeric;`)
  await client.unsafe(`ALTER TABLE "purchase_invoices" ADD COLUMN IF NOT EXISTS "tcs_amount" numeric;`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_invoices_status_idx" ON "purchase_invoices" ("status");`)
  await client.unsafe(`ALTER TABLE "purchase_invoices" ADD COLUMN IF NOT EXISTS "order_id" text;`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_invoices_order_id_idx" ON "purchase_invoices" ("order_id");`)
  await client.unsafe(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "cost_price" numeric;`)
  // Piece Rate Product — fixed price per piece, never recomputed from the silver rate
  await client.unsafe(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "piece_rate_product" boolean NOT NULL DEFAULT false;`)
  await client.unsafe(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "fixed_piece_rate" numeric;`)
  await client.unsafe(`ALTER TABLE "purchase_returns" ADD COLUMN IF NOT EXISTS "invoice_id" text;`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_returns_invoice_id_idx" ON "purchase_returns" ("invoice_id");`)
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "purchase_return_items" (
      "id" text PRIMARY KEY NOT NULL,
      "return_id" text NOT NULL,
      "product" text,
      "sku" text,
      "qty" numeric DEFAULT 1,
      "weight" numeric,
      "rate" numeric,
      "amount" numeric,
      CONSTRAINT "purchase_return_items_return_id_fk" FOREIGN KEY ("return_id")
        REFERENCES "purchase_returns" ("id") ON DELETE CASCADE
    );`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_return_items_return_id_idx" ON "purchase_return_items" ("return_id");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_return_items_sku_idx" ON "purchase_return_items" ("sku");`)
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "purchase_invoice_items" (
      "id" text PRIMARY KEY NOT NULL,
      "invoice_id" text NOT NULL,
      "product" text,
      "sku" text,
      "qty" numeric DEFAULT 1,
      "weight" numeric,
      "rate" numeric,
      "cost" numeric,
      "tax" numeric,
      "amount" numeric,
      CONSTRAINT "purchase_invoice_items_invoice_id_fk" FOREIGN KEY ("invoice_id")
        REFERENCES "purchase_invoices" ("id") ON DELETE CASCADE
    );`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_invoice_items_invoice_id_idx" ON "purchase_invoice_items" ("invoice_id");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_invoice_items_sku_idx" ON "purchase_invoice_items" ("sku");`)
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "purchase_order_items" (
      "id" text PRIMARY KEY NOT NULL,
      "order_id" text NOT NULL,
      "product" text,
      "sku" text,
      "qty" numeric DEFAULT 1,
      "weight" numeric,
      "rate" numeric,
      "amount" numeric,
      CONSTRAINT "purchase_order_items_order_id_fk" FOREIGN KEY ("order_id")
        REFERENCES "purchase_orders" ("id") ON DELETE CASCADE
    );`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_order_items_order_id_idx" ON "purchase_order_items" ("order_id");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "purchase_order_items_sku_idx" ON "purchase_order_items" ("sku");`)
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "supplier_payments" (
      "id" text PRIMARY KEY NOT NULL,
      "ref" text,
      "supplier" text,
      "amount" numeric NOT NULL,
      "method" text,
      "note" text,
      "date" timestamp,
      "created_by" text
    );`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "supplier_payments_supplier_idx" ON "supplier_payments" ("supplier");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "supplier_payments_date_idx" ON "supplier_payments" ("date");`)
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "supplier_payment_allocations" (
      "id" text PRIMARY KEY NOT NULL,
      "payment_id" text NOT NULL,
      "invoice_id" text,
      "invoice_number" text,
      "amount" numeric NOT NULL,
      CONSTRAINT "supplier_payment_allocations_payment_id_fk" FOREIGN KEY ("payment_id")
        REFERENCES "supplier_payments" ("id") ON DELETE CASCADE
    );`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "supplier_payment_allocations_payment_id_idx" ON "supplier_payment_allocations" ("payment_id");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "supplier_payment_allocations_invoice_id_idx" ON "supplier_payment_allocations" ("invoice_id");`)

  console.log('Stock ledger and per-location balances (idempotent)...')
  // Self-contained (no foreign keys), so this is safe on any database. Mirrors
  // STOCK_LEDGER_DDL in bootstrap.ts — keep the two in step.
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "stock_levels" (
      "product_id" text NOT NULL,
      "location_id" text NOT NULL,
      "qty" integer NOT NULL DEFAULT 0,
      CONSTRAINT "stock_levels_product_location_idx" UNIQUE ("product_id", "location_id")
    );`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "stock_levels_location_idx" ON "stock_levels" ("location_id");`)
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "stock_movements" (
      "id" text PRIMARY KEY NOT NULL,
      "product_id" text,
      "sku" text,
      "location_id" text,
      "type" text NOT NULL,
      "qty" numeric NOT NULL,
      "stock_after" numeric,
      "unit_cost" numeric,
      "ref_type" text,
      "ref_id" text,
      "note" text,
      "created_by" text,
      "date" timestamp
    );`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "stock_movements_sku_idx" ON "stock_movements" ("sku");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "stock_movements_product_id_idx" ON "stock_movements" ("product_id");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "stock_movements_location_id_idx" ON "stock_movements" ("location_id");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "stock_movements_date_idx" ON "stock_movements" ("date");`)
  await client.unsafe(`CREATE INDEX IF NOT EXISTS "stock_movements_ref_idx" ON "stock_movements" ("ref_type", "ref_id");`)
  await client.unsafe(`INSERT INTO "inventory_locations" ("id", "name", "type") VALUES ('LOC-DEFAULT', 'Main Store', 'store') ON CONFLICT DO NOTHING;`)
  await client.unsafe(`ALTER TABLE "stock_transfers" ADD COLUMN IF NOT EXISTS "received_qty" integer;`)
  await client.unsafe(`ALTER TABLE "stock_transfers" ADD COLUMN IF NOT EXISTS "variance" integer;`)
  await client.unsafe(`ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "location_id" text;`)
  await client.unsafe(`ALTER TABLE "purchase_invoices" ADD COLUMN IF NOT EXISTS "location_id" text;`)

  console.log('Seeding default roles (idempotent)...')
  for (const [i, name] of roleNames.entries()) {
    const existing = await db.select().from(schema.roles).where(eq(schema.roles.name, name)).limit(1)
    if (existing[0]) continue
    await db.insert(schema.roles).values({
      id: `ROLE${i + 1}`,
      name,
      description: `${name} role with default module permissions`,
      permissions: defaultRolePermissions(name),
      isSystem: true,
      createdAt: new Date().toISOString(),
    })
    console.log(`  + ${name}`)
  }

  const roles = await db.select().from(schema.roles)
  console.log('Roles present:', roles.map((r) => r.name).join(', '))

  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
