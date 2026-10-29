import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from './schema'
import { defaultRolePermissions, emptyPermissions, MODULE_KEYS, MODULES } from '../rbac'
import type { Permissions } from '../types'
import { roleNames } from './seedData'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import argon2 from 'argon2'
import { logger } from '../logger'

/**
 * First-run database bootstrap.
 *
 * Runs at server startup and is safe to run on every start (all statements
 * are idempotent). On a fresh machine this creates the FULL schema matching
 * src/db/schema.ts exactly, seeds default roles, and provisions the initial
 * admin user so the desktop installer goes from empty PostgreSQL to a working
 * login with zero manual SQL.
 */

let bootstrapped = false

/**
 * Clears the once-per-process bootstrap guard.
 *
 * Only for tests that need to run the upgrade path twice in one process (a
 * fresh install, then an upgrade of that same database). Production calls
 * bootstrapDatabase once per start, which is what the guard is for.
 */
export function resetBootstrapForTests(): void {
  bootstrapped = false
}

async function createClient(): Promise<postgres.Sql> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  return postgres(url, { max: 1, connect_timeout: 10 })
}

async function tableExists(sql: postgres.Sql, name: string): Promise<boolean> {
  const rows = await sql`select 1 from information_schema.tables where table_schema = 'public' and table_name = ${name} limit 1`
  return rows.length > 0
}

/**
 * Per-location stock balances and the append-only movement ledger.
 *
 * Declared once and applied from both createSchema (fresh installs) and
 * applyUpgrades (existing installs). The purchase tables showed exactly what
 * happens when that DDL is duplicated and the copies drift: an existing
 * install never received the tables and booted looking healthy.
 */
const STOCK_LEDGER_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS stock_levels (
    product_id text NOT NULL,
    location_id text NOT NULL,
    qty integer NOT NULL DEFAULT 0,
    CONSTRAINT stock_levels_product_location_idx UNIQUE (product_id, location_id)
  )`,
  `CREATE INDEX IF NOT EXISTS stock_levels_location_idx ON stock_levels (location_id)`,
  `CREATE TABLE IF NOT EXISTS stock_movements (
    id text PRIMARY KEY,
    product_id text,
    sku text,
    location_id text,
    type text NOT NULL,
    qty numeric NOT NULL,
    stock_after numeric,
    unit_cost numeric,
    ref_type text,
    ref_id text,
    note text,
    created_by text,
    date timestamp
  )`,
  `CREATE INDEX IF NOT EXISTS stock_movements_sku_idx ON stock_movements (sku)`,
  `CREATE INDEX IF NOT EXISTS stock_movements_product_id_idx ON stock_movements (product_id)`,
  `CREATE INDEX IF NOT EXISTS stock_movements_location_id_idx ON stock_movements (location_id)`,
  `CREATE INDEX IF NOT EXISTS stock_movements_date_idx ON stock_movements (date)`,
  `CREATE INDEX IF NOT EXISTS stock_movements_ref_idx ON stock_movements (ref_type, ref_id)`,
  // Receipt variance. These live on stock_transfers, which predates this array,
  // so the columns are added rather than created. ADD COLUMN IF NOT EXISTS is
  // idempotent, which keeps this array safe to run on every boot.
  `ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS received_qty integer`,
  `ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS variance integer`,
  // Which location a sale or a purchase belongs to. Without these the movements
  // fall back to the default store, so a sale rung up at a branch debits the
  // wrong balance. Existing documents keep NULL and resolve to the default,
  // which is what they already did.
  `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS location_id text`,
  `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS location_id text`,
  // Settings → Product codes: configurable SKU/barcode auto-generation
  // (src/lib/productCodes.ts). NULL means "use the shipped defaults" (SLV +
  // {PREFIX}-{CATEGORY}-{SEQ} + EAN-13 890…), so installs that never open the
  // new tab keep generating exactly the codes they always did.
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sku_prefix text`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sku_suffix text`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sku_format text`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS sku_seq_length integer`,
  `ALTER TABLE settings ADD COLUMN IF NOT EXISTS barcode_prefix text`,
  // Shopify-style options: `options` holds `[{ name, values }]` on the parent
  // product; each option-value combination is a row in product_variants.
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS options jsonb`,
  `CREATE TABLE IF NOT EXISTS product_variants (
    id text PRIMARY KEY,
    product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    title text NOT NULL,
    option_values jsonb NOT NULL,
    sku text NOT NULL,
    barcode text,
    selling_price numeric,
    compare_at_price numeric,
    cost_price numeric,
    gross_weight numeric,
    stock integer NOT NULL DEFAULT 0,
    reorder_level integer,
    status text,
    created_at timestamp
  )`,
  // Existing installs can have an older colour-only product_variants table
  // (colour_name/colour_hex/price/shopify_variant_id/…). CREATE TABLE IF NOT
  // EXISTS leaves that shape untouched, so the Shopify sync then fails when it
  // writes title/option_values/selling_price. Add the current columns in place.
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS title text`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS option_values jsonb`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS selling_price numeric`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS compare_at_price numeric`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS cost_price numeric`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS gross_weight numeric`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS reorder_level integer`,
  // Carry the legacy colour/price data forward. The column checks keep this
  // safe on fresh installs, where those columns do not exist.
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'product_variants'
                  AND column_name = 'colour_name') THEN
       UPDATE product_variants
          SET title = COALESCE(NULLIF(colour_name, ''), 'Default Title')
        WHERE title IS NULL;
       UPDATE product_variants
          SET option_values = CASE
                WHEN NULLIF(colour_name, '') IS NULL THEN '["Default Title"]'::jsonb
                ELSE to_jsonb(ARRAY[colour_name])
              END
        WHERE option_values IS NULL;
     ELSE
       UPDATE product_variants
          SET title = 'Default Title'
        WHERE title IS NULL;
       UPDATE product_variants
          SET option_values = '["Default Title"]'::jsonb
        WHERE option_values IS NULL;
     END IF;
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'product_variants'
                  AND column_name = 'price') THEN
       UPDATE product_variants
          SET selling_price = price
        WHERE selling_price IS NULL AND price IS NOT NULL;
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS product_variants_sku_idx ON product_variants (sku)`,
  `CREATE INDEX IF NOT EXISTS product_variants_product_id_idx ON product_variants (product_id)`,
]

async function createSchema(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (tx) => {
    // ── Identity ──────────────────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS roles (
        id text PRIMARY KEY,
        name text NOT NULL,
        description text,
        permissions jsonb NOT NULL,
        is_system boolean NOT NULL DEFAULT false,
        created_at timestamp,
        CONSTRAINT roles_name_unique UNIQUE (name)
      )`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL,
        username text,
        password_hash text,
        role text NOT NULL,
        last_login timestamp,
        status text NOT NULL,
        avatar_color text,
        permissions jsonb,
        email_verified boolean,
        require_password_change boolean,
        reset_token text,
        reset_token_expiry timestamp,
        email_verification_token text,
        email_verification_expiry timestamp
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email)`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS sessions (
        token text PRIMARY KEY,
        user_id text NOT NULL,
        created_at timestamp,
        expires_at timestamp
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        identifier text PRIMARY KEY,
        count integer NOT NULL DEFAULT 0,
        last_attempt timestamp
      )`)

    // Per-IP rate-limit counters (express-rate-limit store) — kept in the DB
    // so restarts don't reset login/password-reset budgets.
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS rate_limit_hits (
        key text PRIMARY KEY,
        count integer NOT NULL DEFAULT 0,
        reset_at timestamptz
      )`)

    // Seen Shopify webhook delivery ids (replay/retry dedupe, 3-day window).
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        webhook_id text PRIMARY KEY,
        seen_at timestamptz NOT NULL DEFAULT now()
      )`)

    // ── Settings & rates ──────────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS settings (
        id text PRIMARY KEY,
        business_name text,
        gstin text,
        phone text,
        email text,
        address text,
        default_purity numeric,
        making_charge numeric,
        gst_rate numeric,
        currency text,
        invoice_prefix text,
        rate_source text,
        auto_update_mcx boolean,
        require_rate_approval boolean,
        auto_reconcile_razorpay boolean,
        notification_settings jsonb,
        payment_reminders boolean,
        low_stock_alerts boolean,
        daily_summary boolean,
        order_imports boolean,
        login_lockout_enabled boolean DEFAULT false,
        lockout_threshold integer DEFAULT 5,
        lockout_duration_minutes integer DEFAULT 15,
        rate_schedule jsonb,
        scheduled_rate_changes jsonb,
        shopify_store_url_encrypted text,
        shopify_access_token_encrypted text,
        shopify_api_version text,
        webhook_secret_encrypted text,
        db_host_encrypted text,
        db_port_encrypted text,
        db_database_encrypted text,
        db_user_encrypted text,
        db_password_encrypted text,
        updated_at timestamp
      )`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS silver_rates (
        id text PRIMARY KEY,
        purity numeric,
        rate numeric,
        previous_rate numeric,
        updated_at timestamp,
        change numeric,
        change_percent numeric,
        currency text,
        updated_by text,
        source text,
        sync_status text,
        approved_by text
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS silver_rates_updated_at_idx ON silver_rates (updated_at)`)
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS silver_rate_requests (
        id text PRIMARY KEY,
        rate numeric,
        previous_rate numeric,
        status text NOT NULL DEFAULT 'pending',
        sync_first boolean NOT NULL DEFAULT false,
        requested_by text,
        requested_by_id text,
        requested_by_role text,
        requested_at timestamp,
        decided_by text,
        decided_by_id text,
        decided_at timestamp,
        decision_note text,
        result_note text
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS silver_rate_requests_status_idx ON silver_rate_requests (status)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS silver_rate_requests_requested_at_idx ON silver_rate_requests (requested_at)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS gold_rates (
        id text PRIMARY KEY,
        rate numeric NOT NULL,
        purity numeric NOT NULL DEFAULT 99.9,
        currency text NOT NULL DEFAULT 'INR',
        source text,
        updated_at timestamp DEFAULT now()
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS gold_rates_updated_at_idx ON gold_rates (updated_at)`)

    // ── Catalog & inventory ───────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS products (
        id text PRIMARY KEY,
        name text NOT NULL,
        sku text NOT NULL,
        barcode text,
        huid text,
        category text NOT NULL,
        collection text,
        purity numeric,
        gross_weight numeric,
        stone_weight numeric,
        net_weight numeric,
        making_charge numeric,
        gst numeric,
        hsn text,
        supplier text,
        supplier_id text,
        silver_rate numeric,
        selling_price numeric,
        piece_rate_product boolean NOT NULL DEFAULT false,
        fixed_piece_rate numeric,
        compare_at_price numeric,
        cost_price numeric,
        stock integer,
        reorder_level integer,
        shopify_status text,
        shopify_id text,
        status text,
        image text,
        images jsonb,
        description text,
        vendor text,
        product_type text,
        tags text,
        track_inventory boolean NOT NULL DEFAULT true,
        charge_on_tax boolean NOT NULL DEFAULT true,
        created_at timestamp,
        updated_at timestamp
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS products_sku_idx ON products (sku)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS products_shopify_id_idx ON products (shopify_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS products_category_idx ON products (category)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS products_status_idx ON products (status)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS products_shopify_status_idx ON products (shopify_status)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS products_supplier_id_idx ON products (supplier_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS products_name_search_idx ON products USING gin (to_tsvector('english', name))`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS customers (
        id text PRIMARY KEY,
        name text NOT NULL,
        email text,
        phone text,
        city text,
        province text,
        shopify_id text,
        email_verified boolean,
        orders integer,
        total_spent numeric,
        status text,
        joined date
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS customers_shopify_id_idx ON customers (shopify_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (email)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers (phone)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS customers_name_search_idx ON customers USING gin (to_tsvector('english', name))`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id text PRIMARY KEY,
        name text NOT NULL,
        contact text,
        phone text,
        alternate_phone text,
        email text,
        gstin text,
        city text,
        address text,
        status text,
        outstanding numeric
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_idx ON suppliers (name)`)
    // A GSTIN identifies one taxpayer, so it may not be reused across suppliers.
    // Partial so the many legacy rows that carry no GSTIN stay valid.
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS suppliers_gstin_idx ON suppliers (lower(gstin)) WHERE gstin IS NOT NULL AND gstin <> ''`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS inventory_locations (
        id text PRIMARY KEY,
        name text NOT NULL,
        type text,
        city text,
        manager text
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS inventory_locations_name_idx ON inventory_locations (name)`)

    // ── Sales ─────────────────────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS sales_orders (
        id text PRIMARY KEY,
        shopify_id text,
        internal_id text,
        customer text,
        customer_shopify_id text,
        customer_email text,
        customer_phone text,
        value numeric,
        payment text,
        fulfillment text,
        invoice text,
        status text,
        date timestamp,
        items integer,
        tags text,
        currency text,
        discount numeric,
        line_items jsonb,
        billing_address jsonb,
        shipping_address jsonb,
        is_booking boolean,
        advance_paid numeric,
        note text,
        created_at timestamp DEFAULT now(),
        updated_at timestamp
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_shopify_id_idx ON sales_orders (shopify_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS sales_orders_customer_idx ON sales_orders (customer)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS sales_orders_date_idx ON sales_orders (date)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS order_events (
        id text PRIMARY KEY,
        order_id text,
        event text,
        details text,
        actor text,
        created_at timestamp
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS order_events_order_id_idx ON order_events (order_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS order_events_created_idx ON order_events (created_at)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS sales_invoices (
        id text PRIMARY KEY,
        number text NOT NULL,
        shopify_order text,
        customer text,
        customer_email text,
        customer_phone text,
        customer_address text,
        customer_city text,
        customer_state text,
        customer_pincode text,
        silver_value numeric,
        making_charge numeric,
        subtotal numeric,
        gst numeric,
        gst_amount numeric,
        discount numeric,
        grand_total numeric,
        payment_method text,
        payment_status text,
        payment_id text,
        status text,
        date timestamp,
        due_date timestamp
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS sales_invoices_number_idx ON sales_invoices (number)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS sales_invoices_shopify_order_idx ON sales_invoices (shopify_order)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS sales_invoice_items (
        id text PRIMARY KEY,
        invoice_id text NOT NULL,
        product text,
        sku text,
        qty integer,
        weight numeric,
        silver_rate numeric,
        making_charge numeric,
        tax numeric,
        amount numeric
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS sales_invoice_items_invoice_id_idx ON sales_invoice_items (invoice_id)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS sales_returns (
        id text PRIMARY KEY,
        number text NOT NULL,
        invoice_id text,
        credit_note_number text,
        restocked boolean,
        return_items jsonb,
         "order" text,
        customer text,
        items integer,
        amount numeric,
        status text,
        date timestamp
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS sales_returns_number_idx ON sales_returns (number)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS sales_returns_customer_idx ON sales_returns (customer)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS sales_returns_date_idx ON sales_returns (date)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS quotations (
        id text PRIMARY KEY,
        number text NOT NULL,
        customer text,
        customer_phone text,
        customer_email text,
        customer_address text,
        customer_city text,
        customer_state text,
        customer_pincode text,
        subtotal numeric,
        gst numeric,
        gst_amount numeric,
        discount numeric,
        grand_total numeric,
        notes text,
        status text NOT NULL DEFAULT 'draft',
        valid_until timestamp,
        converted_invoice text,
        converted_at timestamp,
        created_by text,
        date timestamp NOT NULL DEFAULT now(),
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS quotations_number_unique ON quotations (number)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS quotations_status_idx ON quotations (status)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS quotations_customer_idx ON quotations (customer)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS quotations_date_idx ON quotations (date)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS quotation_items (
        id text PRIMARY KEY,
        quotation_id text NOT NULL,
        product text,
        sku text,
        qty integer,
        weight numeric,
        silver_rate numeric,
        making_charge numeric,
        amount numeric
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS quotation_items_quotation_id_idx ON quotation_items (quotation_id)`)

    // ── Purchases & stock ─────────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id text PRIMARY KEY,
        number text NOT NULL,
        supplier text,
        supplier_id text,
        items integer,
        qty integer,
        weight numeric,
        value numeric,
        gst numeric DEFAULT 3,
        gst_amount numeric,
        discount numeric DEFAULT 0,
        grand_total numeric,
        notes text,
        expected_date timestamp,
        status text,
        date timestamp
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_number_idx ON purchase_orders (number)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx ON purchase_orders (supplier)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS purchase_invoices (
        id text PRIMARY KEY,
        number text NOT NULL,
        supplier text,
        location_id text,
        items integer,
        qty integer,
        weight numeric,
        rate numeric,
        cost numeric,
        tax numeric,
        total numeric,
        status text,
        date timestamp
      )`)
    await tx.unsafe(`ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS paid_amount numeric DEFAULT 0`)
    await tx.unsafe(`ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS supplier_gstin text`)
    await tx.unsafe(`ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS supplier_state text`)
    await tx.unsafe(`ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS cgst numeric`)
    await tx.unsafe(`ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS sgst numeric`)
    await tx.unsafe(`ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS igst numeric`)
    await tx.unsafe(`ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS tcs_rate numeric`)
    await tx.unsafe(`ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS tcs_amount numeric`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS purchase_invoices_status_idx ON purchase_invoices (status)`)

    // Purchase line items — what arrives, and what adds to stock.
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS purchase_invoice_items (
        id text PRIMARY KEY,
        invoice_id text NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
        product text,
        sku text,
        qty numeric DEFAULT 1,
        weight numeric,
        rate numeric,
        cost numeric,
        tax numeric,
        amount numeric
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS purchase_invoice_items_invoice_id_idx ON purchase_invoice_items (invoice_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS purchase_invoice_items_sku_idx ON purchase_invoice_items (sku)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id text PRIMARY KEY,
        order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        product text,
        sku text,
        qty numeric DEFAULT 1,
        weight numeric,
        rate numeric,
        amount numeric
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS purchase_order_items_order_id_idx ON purchase_order_items (order_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS purchase_order_items_sku_idx ON purchase_order_items (sku)`)

    // Supplier payment ledger + how each payment was allocated.
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS supplier_payments (
        id text PRIMARY KEY,
        ref text,
        supplier text,
        amount numeric NOT NULL,
        method text,
        note text,
        date timestamp,
        created_by text
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS supplier_payments_supplier_idx ON supplier_payments (supplier)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS supplier_payments_date_idx ON supplier_payments (date)`)
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
        id text PRIMARY KEY,
        payment_id text NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
        invoice_id text,
        invoice_number text,
        amount numeric NOT NULL
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS supplier_payment_allocations_payment_id_idx ON supplier_payment_allocations (payment_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS supplier_payment_allocations_invoice_id_idx ON supplier_payment_allocations (invoice_id)`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_number_idx ON purchase_invoices (number)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS purchase_returns (
        id text PRIMARY KEY,
        number text NOT NULL,
        supplier text,
        items integer,
        weight numeric,
        amount numeric,
        status text,
        date timestamp
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS purchase_returns_number_idx ON purchase_returns (number)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS purchase_returns_supplier_idx ON purchase_returns (supplier)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS purchase_returns_date_idx ON purchase_returns (date)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS stock_transfers (
        id text PRIMARY KEY,
        number text NOT NULL,
        "from" text,
        "to" text,
        product text,
        sku text,
        qty integer,
        weight numeric,
        initiated_by text,
        status text,
        date timestamp
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_number_idx ON stock_transfers (number)`)

    for (const stmt of STOCK_LEDGER_DDL) await tx.unsafe(stmt)

    // ── Finance ───────────────────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS payments (
        id text PRIMARY KEY,
        ref text,
        invoice text,
        customer text,
        amount numeric,
        method text,
        gateway text,
        status text,
        date timestamp,
        reconciled boolean
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS payments_ref_idx ON payments (ref)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments (invoice)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id text PRIMARY KEY,
        date date,
        description text,
        ref text,
        debit numeric,
        credit numeric
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS ledger_entries_date_idx ON ledger_entries (date)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS ledger_entries_ref_idx ON ledger_entries (ref)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS expenses (
        id text PRIMARY KEY,
        category text,
        description text,
        amount numeric,
        payment_method text,
        date timestamp,
        status text,
        by text
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses (date)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id text PRIMARY KEY,
        name text NOT NULL,
        bank text,
        account_number text,
        account_number_encrypted text,
        balance numeric,
        ifsc text
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_name_idx ON bank_accounts (name)`)

    // ── Operations / audit / notifications ────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS shipments (
        id text PRIMARY KEY,
        order_id text NOT NULL,
        order_ref text,
        customer text,
        courier text,
        tracking_number text,
        status text NOT NULL DEFAULT 'pending',
        dispatched_at timestamp,
        expected_delivery date,
        delivered_at timestamp,
        notes text,
        created_at timestamp
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS shipments_order_id_idx ON shipments (order_id)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id text PRIMARY KEY,
        timestamp timestamp,
        "user" text,
        user_id text,
        role text,
        action text,
        module text,
        entity text,
        details text,
        ip text
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS activity_logs_timestamp_idx ON activity_logs (timestamp)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id text PRIMARY KEY,
        timestamp timestamp,
        "user" text,
        action text,
        module text,
        entity text,
        changes text,
        ip text
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx ON audit_logs (timestamp)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS sync_logs (
        id text PRIMARY KEY,
        entity text,
        shopify_id text,
        direction text,
        action text,
        status text,
        time timestamp,
        error text,
        retry boolean
      )`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS notification_log (
        id text PRIMARY KEY,
        kind text NOT NULL,
        channel text NOT NULL,
        recipient text,
        ref text,
        status text NOT NULL,
        error text,
        created_at timestamp
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS notification_log_created_idx ON notification_log (created_at)`)

    // ── Batch / lot tracking ──────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS batches (
        id text PRIMARY KEY,
        product_id text NOT NULL,
        batch_number text NOT NULL,
        quantity integer NOT NULL DEFAULT 0,
        cost_price numeric,
        manufacturing_date date,
        expiry_date date,
        supplier text,
        status text DEFAULT 'active',
        created_at timestamp DEFAULT now()
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS batches_product_idx ON batches (product_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS batches_number_idx ON batches (batch_number)`)

    // ── Manufacturing / BOM ───────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS boms (
        id text PRIMARY KEY,
        name text NOT NULL,
        product_id text,
        description text,
        yield_qty integer DEFAULT 1,
        total_cost numeric,
        status text DEFAULT 'active',
        created_at timestamp DEFAULT now()
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS boms_product_idx ON boms (product_id)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS bom_items (
        id text PRIMARY KEY,
        bom_id text NOT NULL,
        product_id text NOT NULL,
        quantity numeric,
        unit text DEFAULT 'g',
        wastage_percent numeric,
        cost numeric
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS bom_items_bom_idx ON bom_items (bom_id)`)

    // ── Karigar (artisan / worker) ────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS karigars (
        id text PRIMARY KEY,
        name text NOT NULL,
        phone text,
        specialty text,
        rate numeric,
        rate_type text DEFAULT 'per_gram',
        balance numeric,
        address text,
        status text DEFAULT 'active',
        created_at timestamp DEFAULT now()
      )`)

    // ── Multi-branch ──────────────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS branches (
        id text PRIMARY KEY,
        name text NOT NULL,
        code text NOT NULL,
        address text,
        phone text,
        manager_name text,
        is_active boolean DEFAULT true,
        created_at timestamp DEFAULT now()
      )`)
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS branches_code_unique ON branches (code)`)

    // ── Loyalty ───────────────────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id text PRIMARY KEY,
        customer_id text NOT NULL,
        invoice_id text,
        invoice_number text,
        type text NOT NULL,
        points numeric NOT NULL,
        balance_after numeric,
        note text,
        created_by text,
        date timestamp NOT NULL DEFAULT now()
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS loyalty_transactions_customer_id_idx ON loyalty_transactions (customer_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS loyalty_transactions_invoice_id_idx ON loyalty_transactions (invoice_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS loyalty_transactions_date_idx ON loyalty_transactions (date)`)

    // ── Multi-currency support ─────────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS currencies (
        id text PRIMARY KEY,
        code text NOT NULL,
        name text NOT NULL,
        symbol text NOT NULL,
        exchange_rate numeric,
        is_active boolean DEFAULT true,
        updated_at timestamp DEFAULT now(),
        CONSTRAINT currencies_code_unique UNIQUE (code)
      )`)

    // ── Double-entry accounting ──────────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS accounts (
        id text PRIMARY KEY,
        code text NOT NULL,
        name text NOT NULL,
        type text NOT NULL,
        sub_type text,
        parent_id text,
        is_group boolean DEFAULT false,
        opening_balance numeric DEFAULT 0,
        current_balance numeric DEFAULT 0,
        currency text DEFAULT 'INR',
        branch_id text,
        is_active boolean DEFAULT true,
        created_at timestamp DEFAULT now(),
        CONSTRAINT accounts_code_unique UNIQUE (code)
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS accounts_type_idx ON accounts (type)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id text PRIMARY KEY,
        entry_number text NOT NULL,
        date date NOT NULL,
        description text,
        reference text,
        reference_type text,
        reference_id text,
        is_auto boolean DEFAULT true,
        branch_id text,
        created_by text,
        created_at timestamp DEFAULT now(),
        CONSTRAINT journal_entries_entry_number_unique UNIQUE (entry_number)
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS journal_entries_date_idx ON journal_entries (date)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS journal_entries_ref_idx ON journal_entries (reference_type, reference_id)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS journal_entry_lines (
        id text PRIMARY KEY,
        journal_entry_id text NOT NULL,
        account_id text NOT NULL,
        debit numeric DEFAULT 0,
        credit numeric DEFAULT 0,
        description text,
        branch_id text
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS jel_entry_idx ON journal_entry_lines (journal_entry_id)`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS jel_account_idx ON journal_entry_lines (account_id)`)

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS financial_periods (
        id text PRIMARY KEY,
        name text NOT NULL,
        start_date date NOT NULL,
        end_date date NOT NULL,
        is_open boolean DEFAULT true,
        closed_at timestamp
      )`)

    // ── Printable designer templates ────────────────────────────────────
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS print_templates (
        id text PRIMARY KEY,
        doc_type text NOT NULL,
        name text NOT NULL,
        config jsonb NOT NULL,
        is_default boolean NOT NULL DEFAULT false,
        updated_at timestamp
      )`)
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS print_templates_doc_type_idx ON print_templates (doc_type)`)
  })
}

async function seedDefaults(db: ReturnType<typeof drizzle>): Promise<{ adminPassword?: string }> {
  // Default roles
  for (const [i, name] of roleNames.entries()) {
    const existing = await db.select().from(schema.roles).where(eq(schema.roles.name, name)).limit(1)
    if (existing[0]) continue
    await db.insert(schema.roles).values({
      id: `ROLE${i + 1}`,
      name,
      description:
        name === 'Super Admin'
          ? 'Full access to every module'
          : 'No modules by default — a super admin grants access per user',
      permissions: defaultRolePermissions(name),
      isSystem: true,
      createdAt: new Date().toISOString(),
    })
    logger.info({ role: name }, 'Bootstrap: seeded role')
  }

  // Initial admin user (only when no users exist at all)
  const users = await db.select({ id: schema.users.id }).from(schema.users).limit(1)
  let generatedAdminPassword: string | undefined
  if (users.length === 0) {
    // Deterministic superadmin credential for every fresh install: the same
    // owner account ships on every new system — username "admin", password
    // below (SEED_ADMIN_PASSWORD overrides it). The earlier one-time random
    // secret made new installs look broken: it was shown once in a dialog,
    // easy to mistype, and five bad attempts hit the 15-minute lockout —
    // leaving users unable to log in with the "auto-generated" credential.
    // The default is published in this repo, so two things bound the
    // exposure: the server binds to 127.0.0.1 only, and requirePasswordChange
    // below forces a new password at the first sign-in — the default never
    // survives the initial setup screen.
    const tempPassword = process.env.SEED_ADMIN_PASSWORD?.trim() || 'Opal@2026'
    generatedAdminPassword = tempPassword
    const passwordHash = await argon2.hash(tempPassword)
    await db.insert(schema.users).values({
      id: randomBytes(8).toString('hex'),
      name: 'Administrator',
      email: 'admin@opalline.local',
      username: 'admin',
      passwordHash,
      role: 'Super Admin',
      status: 'active',
      requirePasswordChange: true,
      // No personal override: the owner is the superadmin who turns modules on
      // for everyone else, and must always inherit the Super Admin role.
      permissions: null,
    })
    logger.info('Bootstrap: created initial admin user')
    console.log('\n══════════════════════════════════════════════════════')
    console.log('  Initial admin account created:')
    console.log('    Username: admin')
    console.log(`    Password: ${tempPassword}`)
    console.log('  You will be asked to set a new password at first login.')
    console.log('══════════════════════════════════════════════════════\n')
    // Hand the one-time credential to the desktop app so it can show the real
    // password in its first-run dialog instead of a hardcoded placeholder.
    // The desktop shell deletes this file as soon as it has displayed it.
    const dataDir = process.env.APP_DATA_DIR?.trim()
    if (dataDir) {
      try {
        mkdirSync(dataDir, { recursive: true })
        writeFileSync(
          join(dataDir, 'first-run-credentials.json'),
          JSON.stringify({ username: 'admin', password: tempPassword, createdAt: new Date().toISOString() }, null, 2),
          { encoding: 'utf8', mode: 0o600 },
        )
      } catch (err) {
        logger.warn({ err: (err as Error)?.message }, 'Bootstrap: could not write first-run credentials file')
      }
    }
  }

  // Settings row
  const settings = await db.select({ id: schema.settings.id }).from(schema.settings).limit(1)
  if (settings.length === 0) {
    await db.insert(schema.settings).values({ id: 'app', gstRate: 3, invoicePrefix: 'SI', currency: 'INR' })
    logger.info('Bootstrap: seeded default settings')
  }

  // Default currencies
  const existingCurrencies = await db.select({ id: schema.currencies.id }).from(schema.currencies).limit(1)
  if (existingCurrencies.length === 0) {
    const defaultCurrencies = [
      { id: 'CUR1', code: 'INR', name: 'Indian Rupee', symbol: '\u20B9', exchangeRate: 1 },
      { id: 'CUR2', code: 'USD', name: 'US Dollar', symbol: '$', exchangeRate: 83 },
      { id: 'CUR3', code: 'EUR', name: 'Euro', symbol: '\u20AC', exchangeRate: 90 },
      { id: 'CUR4', code: 'GBP', name: 'British Pound', symbol: '\u00A3', exchangeRate: 105 },
      { id: 'CUR5', code: 'AED', name: 'UAE Dirham', symbol: 'AED', exchangeRate: 22.5 },
      { id: 'CUR6', code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', exchangeRate: 22 },
    ]
    for (const c of defaultCurrencies) {
      await db.insert(schema.currencies).values({ ...c, isActive: true, updatedAt: new Date().toISOString() })
    }
    logger.info('Bootstrap: seeded default currencies')
  }

  // Default chart of accounts for Indian jewelry business
  const existingAccounts = await db.select({ id: schema.accounts.id }).from(schema.accounts).limit(1)
  if (existingAccounts.length === 0) {
    const defaultAccounts = [
      { id: 'ACC1001', code: '1001', name: 'Cash in Hand', type: 'asset', subType: 'current_asset' },
      { id: 'ACC1002', code: '1002', name: 'Bank Account', type: 'asset', subType: 'current_asset' },
      { id: 'ACC1003', code: '1003', name: 'Accounts Receivable', type: 'asset', subType: 'current_asset' },
      { id: 'ACC1004', code: '1004', name: 'Inventory - Raw Materials', type: 'asset', subType: 'current_asset' },
      { id: 'ACC1005', code: '1005', name: 'Inventory - Finished Goods', type: 'asset', subType: 'current_asset' },
      { id: 'ACC1006', code: '1006', name: 'GST Input Credit', type: 'asset', subType: 'current_asset' },
      { id: 'ACC2001', code: '2001', name: 'Accounts Payable', type: 'liability', subType: 'current_liability' },
      { id: 'ACC2002', code: '2002', name: 'GST Output', type: 'liability', subType: 'current_liability' },
      { id: 'ACC2003', code: '2003', name: 'TDS Payable', type: 'liability', subType: 'current_liability' },
      { id: 'ACC2004', code: '2004', name: 'TCS Payable', type: 'liability', subType: 'current_liability' },
      { id: 'ACC3001', code: '3001', name: "Owner's Equity", type: 'equity', subType: 'equity' },
      { id: 'ACC3002', code: '3002', name: 'Retained Earnings', type: 'equity', subType: 'equity' },
      { id: 'ACC4001', code: '4001', name: 'Sales Revenue', type: 'revenue', subType: 'operating_revenue' },
      { id: 'ACC4002', code: '4002', name: 'Other Income', type: 'revenue', subType: 'other_income' },
      { id: 'ACC5001', code: '5001', name: 'Cost of Goods Sold', type: 'expense', subType: 'cost_of_goods_sold' },
      { id: 'ACC5002', code: '5002', name: 'Salaries Expense', type: 'expense', subType: 'operating_expense' },
      { id: 'ACC5003', code: '5003', name: 'Rent Expense', type: 'expense', subType: 'operating_expense' },
      { id: 'ACC5004', code: '5004', name: 'Utilities Expense', type: 'expense', subType: 'operating_expense' },
      { id: 'ACC5005', code: '5005', name: 'Office Supplies', type: 'expense', subType: 'operating_expense' },
    ]
    for (const a of defaultAccounts) {
      await db.insert(schema.accounts).values({ ...a, currency: 'INR', isActive: true, createdAt: new Date().toISOString() })
    }
    logger.info('Bootstrap: seeded default chart of accounts')
  }
  return { adminPassword: generatedAdminPassword }
}

/**
 * One-time repair for installs that were bootstrapped before the Admin role
 * gained system.delete. The role row stores a snapshot of the defaults, so
 * changing defaultRolePermissions() alone would never reach an existing
 * database. Only the exact legacy shape is rewritten, so a permission an
 * administrator has since customised by hand is left untouched.
 */
async function repairAdminRolePermissions(db: ReturnType<typeof drizzle>): Promise<void> {
  const [adminRole] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'Admin')).limit(1)
  if (!adminRole) return
  const current = (adminRole.permissions ?? {}) as Record<string, Record<string, boolean>>
  const system = current.system
  if (!system) return
  const isLegacyShape =
    system.delete === false && system.view === true && system.create === true && system.edit === true
  if (!isLegacyShape) return
  const next = { ...(current as Record<string, unknown>), system: { view: true, create: true, edit: true, delete: true } }
  await db.update(schema.roles).set({ permissions: next }).where(eq(schema.roles.id, adminRole.id))
  logger.info('Bootstrap: repaired Admin role to allow system deletes')
}

/**
 * The bootstrap owner used to be created with a personal permission override
 * that was a snapshot of the Admin defaults. That snapshot carried
 * system.delete = false, so repairing the role was not enough — the user's own
 * override kept winning in mergePermissions(). Clear the override so the owner
 * inherits the role again. Only an exact match of the legacy snapshot is
 * cleared; a genuinely customised override is left alone.
 */
async function repairAdminUserOverride(db: ReturnType<typeof drizzle>): Promise<void> {
  const current_default = defaultRolePermissions('Admin') as unknown as Record<string, Record<string, boolean>>
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.username, 'admin')).limit(1)
  if (!owner?.permissions) return
  const current = owner.permissions as Record<string, Record<string, boolean>>
  // Only the exact legacy snapshot qualifies: every module matches today's Admin
  // defaults, except system.delete which is still the old `false`.
  const isLegacySnapshot = MODULE_KEYS.every((key) => {
    const a = current[key]
    const b = current_default[key]
    if (!a || !b) return false
    if (key === 'system') return a.view === b.view && a.create === b.create && a.edit === b.edit && a.delete === false
    return a.view === b.view && a.create === b.create && a.edit === b.edit && a.delete === b.delete
  })
  if (!isLegacySnapshot) return
  await db.update(schema.users).set({ permissions: null }).where(eq(schema.users.id, owner.id))
  logger.info('Bootstrap: cleared the stale permission override on the admin user')
}

/**
 * Frozen copy of the per-role module defaults that shipped before module
 * access became superadmin-controlled. Role rows store a snapshot of their
 * defaults, so changing defaultRolePermissions() alone never reaches an
 * existing database. repairDefaultRolePermissions() matches this legacy shape
 * to recognise stock rows; it is deliberately frozen here — it must keep
 * describing what OLD installs stored, not what the code does today.
 */
function legacyDefaultRolePermissions(name: string): Permissions {
  const p = emptyPermissions()
  const all = { view: true, create: true, edit: true, delete: true }
  const view = { view: true, create: false, edit: false, delete: false }
  switch (name) {
    case 'Admin':
      for (const m of MODULES) p[m.key] = { ...all }
      break
    case 'Manager':
      p.dashboard = { ...view }
      p.sales = { ...all }
      p.inventory = { ...all }
      p.purchase = { view: true, create: true, edit: true, delete: false }
      p['silver-rate'] = { ...all }
      p.accounts = { ...view }
      p.shopify = { view: true, create: false, edit: false, delete: false }
      break
    case 'Accounts':
      p.accounts = { ...all }
      p.sales = { view: true, create: false, edit: true, delete: false }
      p.purchase = { ...view }
      p.reports = { ...view }
      p.dashboard = { ...view }
      p.shopify = { view: true, create: false, edit: false, delete: false }
      break
    case 'Purchase':
      p.purchase = { ...all }
      p.inventory = { view: true, create: false, edit: true, delete: false }
      p.reports = { ...view }
      p.dashboard = { ...view }
      p.shopify = { view: true, create: false, edit: false, delete: false }
      break
    case 'Sales':
      p.sales = { ...all }
      p.dashboard = { ...view }
      p.inventory = { ...view }
      p.shopify = { view: true, create: false, edit: false, delete: false }
      break
    case 'Shopify Manager':
      p.shopify = { ...all }
      p.inventory = { view: true, create: false, edit: true, delete: false }
      p.dashboard = { ...view }
      break
    case 'Customer Support':
      p.sales = { view: true, create: false, edit: true, delete: false }
      p.dashboard = { ...view }
      p.shopify = { view: true, create: false, edit: false, delete: false }
      break
    default:
      return p // unknown name: legacy default was empty, nothing to recognise
  }
  return p
}

function samePermissions(a: Permissions | null, b: Permissions): boolean {
  const x = (a ?? {}) as Permissions
  return MODULE_KEYS.every((k) => {
    const lhs = x[k]
    const rhs = b[k]
    if (!lhs || !rhs) return false
    return lhs.view === rhs.view && lhs.create === rhs.create && lhs.edit === rhs.edit && lhs.delete === rhs.delete
  })
}

/**
 * Module access is now superadmin-controlled: no role except Super Admin
 * ships with modules, so the install owner must actually BE a Super Admin —
 * otherwise the account that is supposed to switch modules on would have no
 * modules itself. Promotes the bootstrap owner (username "admin", role Admin)
 * once; afterwards the role no longer reads 'Admin', so the repair is a no-op.
 */
async function repairOwnerSuperAdmin(db: ReturnType<typeof drizzle>): Promise<void> {
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.username, 'admin')).limit(1)
  if (!owner || owner.role !== 'Admin') return
  await db.update(schema.users).set({ role: 'Super Admin' }).where(eq(schema.users.id, owner.id))
  logger.info('Bootstrap: promoted the install owner (admin) to Super Admin')
}

/**
 * One-time reset of the stock role snapshots to the new empty defaults.
 *
 * Only rows that exactly match the legacy default shape are rewritten — a
 * role an admin customised by hand, a custom role, and the Super Admin role
 * itself are left untouched. Once cleared a row no longer matches a legacy
 * shape, so re-running (every start) is a no-op.
 */
async function repairDefaultRolePermissions(db: ReturnType<typeof drizzle>): Promise<void> {
  const roles = await db.select().from(schema.roles)
  for (const role of roles) {
    if (role.isSystem !== true || role.name === 'Super Admin') continue
    const legacy = legacyDefaultRolePermissions(role.name)
    if (!MODULE_KEYS.some((k) => legacy[k]?.view || legacy[k]?.create || legacy[k]?.edit || legacy[k]?.delete)) continue
    if (!samePermissions(role.permissions as Permissions | null, legacy)) continue
    await db.update(schema.roles).set({ permissions: emptyPermissions() }).where(eq(schema.roles.id, role.id))
    logger.info({ role: role.name }, 'Bootstrap: cleared default module access (now superadmin-controlled)')
  }
}

/**
 * Run bootstrap when the database is fresh (no users table). Idempotent and
 * safe on every start; upgrades add missing columns/tables for existing DBs.
 */
export async function bootstrapDatabase(): Promise<{ ran: boolean; tablesCreated: boolean; adminPassword?: string }> {
  if (bootstrapped) return { ran: false, tablesCreated: false }
  bootstrapped = true
  if (!process.env.DATABASE_URL) return { ran: false, tablesCreated: false }

  const sql = await createClient()
  try {
    const hasUsers = await tableExists(sql, 'users')
    if (!hasUsers) {
      logger.info('Bootstrap: fresh database detected — creating schema')
      await createSchema(sql)
      // Bring the fresh schema fully up to date BEFORE seeding defaults —
      // seedDefaults inserts columns (settings.pan, TDS/UPI flags, …) that
      // createSchema's baseline DDL does not include yet.
      await applyUpgrades(sql)
      const drizzleDb = drizzle(sql, { schema })
      const seeded = await seedDefaults(drizzleDb)
      await import('../supplierLinking')
        .then((m) => m.linkProductsToSuppliersSafe(sql))
        .catch(() => undefined)
      return { ran: true, tablesCreated: true, adminPassword: seeded.adminPassword }
    }

    // Existing DB: apply idempotent additions for upgrades
    await applyUpgrades(sql)
    const upgradeDb = drizzle(sql, { schema })
    await repairAdminRolePermissions(upgradeDb).catch(() => undefined)
    await repairAdminUserOverride(upgradeDb).catch(() => undefined)
    await repairOwnerSuperAdmin(upgradeDb).catch(() => undefined)
    await repairDefaultRolePermissions(upgradeDb).catch(() => undefined)
    // Stock balances predate the movement ledger. Give them a dated opening
    // entry so an upgraded install has real history instead of a balance that
    // appears from nowhere on the day of its first sale.
    await import('../stock').then((m) => m.backfillOpeningBalances(upgradeDb)).catch(() => undefined)
    // Invoice items raised before the weight snapshot carried weight 0. Fill
    // them from the catalogue (net weight × qty) so totals, prints and the
    // dashboard agree with new invoices. Idempotent; failures are logged but
    // never block boot.
    await import('../invoiceWeights')
      .then((m) => m.backfillInvoiceItemWeights(upgradeDb))
      .then((n) => {
        if (n > 0) logger.info({ items: n }, 'Bootstrap: backfilled invoice item weights')
      })
      .catch((err) => logger.warn({ err: (err as Error)?.message }, 'Bootstrap: invoice weight backfill failed'))
    return { ran: true, tablesCreated: false }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Idempotent schema additions applied on EVERY bootstrap. Runs on existing
 * databases to upgrade them in place, and on freshly created schemas so a
 * brand-new install is on the latest shape before defaults are seeded
 * (createSchema's baseline DDL can lag behind what seedDefaults inserts —
 * e.g. the settings TDS/UPI columns were only ever added here).
 */
async function applyUpgrades(sql: postgres.Sql): Promise<void> {
  const upgrades: string[] = [
    ...STOCK_LEDGER_DDL,
    // Login lockout became a per-install switch (Settings → Security → Login
    // lockout), off by default. Existing installs get the column as false,
    // which keeps today's behaviour (no lockout) until it is turned on.
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS login_lockout_enabled boolean DEFAULT false`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS lockout_threshold integer DEFAULT 5`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS lockout_duration_minutes integer DEFAULT 15`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS rate_schedule jsonb`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS scheduled_rate_changes jsonb`,
    // Idempotency for sales returns: an optional client key on each credit
    // note so a retried / double-submitted return replays the original note
    // instead of restocking the same units twice. NULLs are unique-exempt,
    // so existing returns without a key are unaffected.
    `ALTER TABLE sales_returns ADD COLUMN IF NOT EXISTS idempotency_key text`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sales_returns_idempotency_key_idx ON sales_returns (idempotency_key)`,
    // products.created_at was a DATE, which tied every product created the
    // same day and made "newest first" meaningless within a day. Upgrade it
    // to a full timestamp (existing rows become midnight); guarded by the
    // column's current type so the statement is a no-op once migrated.
    `DO $$ BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'products' AND column_name = 'created_at' AND data_type = 'date'
       ) THEN
         ALTER TABLE products ALTER COLUMN created_at TYPE timestamp USING created_at::timestamp;
       END IF;
     END $$`,
    `INSERT INTO inventory_locations (id, name, type) VALUES ('LOC-DEFAULT', 'Main Store', 'store') ON CONFLICT DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id text PRIMARY KEY,
        customer_id text NOT NULL,
        invoice_id text,
        invoice_number text,
        type text NOT NULL,
        points numeric NOT NULL,
        balance_after numeric,
        note text,
        created_by text,
        date timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS quotations (
        id text PRIMARY KEY,
        number text NOT NULL,
        customer text,
        customer_phone text,
        customer_email text,
        customer_address text,
        customer_city text,
        customer_state text,
        customer_pincode text,
        subtotal numeric,
        gst numeric,
        gst_amount numeric,
        discount numeric,
        grand_total numeric,
        notes text,
        status text NOT NULL DEFAULT 'draft',
        valid_until timestamp,
        converted_invoice text,
        converted_at timestamp,
        created_by text,
        date timestamp NOT NULL DEFAULT now(),
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp
      )`,
      `CREATE TABLE IF NOT EXISTS quotation_items (
        id text PRIMARY KEY,
        quotation_id text NOT NULL,
        product text,
        sku text,
        qty integer,
        weight numeric,
        silver_rate numeric,
        making_charge numeric,
        amount numeric
      )`,
      `CREATE TABLE IF NOT EXISTS order_events (
        id text PRIMARY KEY,
        order_id text,
        event text,
        details text,
        actor text,
        created_at timestamp
      )`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS customer_phone text`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS customer_address text`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS customer_city text`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS customer_state text`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS customer_pincode text`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS payment_id text`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS due_date timestamp`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS huid text`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS images jsonb`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_level integer`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS description text`,
      `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_email text`,
      `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_phone text`,
      `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS note text`,
      `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS is_booking boolean`,
      `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS advance_paid numeric`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS metal text DEFAULT 'silver'`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS purity_label text`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS diamond_weight numeric`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS tds_type text DEFAULT 'none'`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS tds_rate numeric`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS tds_amount numeric`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS tds_section text`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS buyer_gstin text`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS irn text`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS irn_date timestamp`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS qr_code text`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS pan text`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS tds_enabled boolean DEFAULT false`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS tcs_enabled boolean DEFAULT false`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS default_tds_section text`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS einvoice_enabled boolean DEFAULT false`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS einvoice_mode text DEFAULT 'off'`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS eway_bill_enabled boolean DEFAULT false`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS upi_id text`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS upi_merchant_name text`,
      `CREATE TABLE IF NOT EXISTS gold_rates (
        id text PRIMARY KEY,
        rate numeric NOT NULL,
        purity numeric NOT NULL DEFAULT 99.9,
        currency text NOT NULL DEFAULT 'INR',
        source text,
        updated_at timestamp DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS currencies (
        id text PRIMARY KEY,
        code text NOT NULL,
        name text NOT NULL,
        symbol text NOT NULL,
        exchange_rate numeric,
        is_active boolean DEFAULT true,
        updated_at timestamp DEFAULT now(),
        CONSTRAINT currencies_code_unique UNIQUE (code)
      )`,
      `ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS currency text DEFAULT 'INR'`,
      `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS currency text DEFAULT 'INR'`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS branch_id text`,
      `CREATE TABLE IF NOT EXISTS batches (
        id text PRIMARY KEY,
        product_id text NOT NULL,
        batch_number text NOT NULL,
        quantity integer NOT NULL DEFAULT 0,
        cost_price numeric,
        manufacturing_date date,
        expiry_date date,
        supplier text,
        status text DEFAULT 'active',
        created_at timestamp DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS batches_product_idx ON batches (product_id)`,
      `CREATE INDEX IF NOT EXISTS batches_number_idx ON batches (batch_number)`,
      `CREATE TABLE IF NOT EXISTS boms (
        id text PRIMARY KEY,
        name text NOT NULL,
        product_id text,
        description text,
        yield_qty integer DEFAULT 1,
        total_cost numeric,
        status text DEFAULT 'active',
        created_at timestamp DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS boms_product_idx ON boms (product_id)`,
      `CREATE TABLE IF NOT EXISTS bom_items (
        id text PRIMARY KEY,
        bom_id text NOT NULL,
        product_id text NOT NULL,
        quantity numeric,
        unit text DEFAULT 'g',
        wastage_percent numeric,
        cost numeric
      )`,
      `CREATE INDEX IF NOT EXISTS bom_items_bom_idx ON bom_items (bom_id)`,
      `CREATE TABLE IF NOT EXISTS karigars (
        id text PRIMARY KEY,
        name text NOT NULL,
        phone text,
        specialty text,
        rate numeric,
        rate_type text DEFAULT 'per_gram',
        balance numeric,
        address text,
        status text DEFAULT 'active',
        created_at timestamp DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS branches (
        id text PRIMARY KEY,
        name text NOT NULL,
        code text NOT NULL,
        address text,
        phone text,
        manager_name text,
        is_active boolean DEFAULT true,
        created_at timestamp DEFAULT now()
      )`,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'branches_code_unique') THEN
          CREATE UNIQUE INDEX branches_code_unique ON branches (code);
        END IF;
      END $$`,
      `CREATE TABLE IF NOT EXISTS accounts (
        id text PRIMARY KEY,
        code text NOT NULL,
        name text NOT NULL,
        type text NOT NULL,
        sub_type text,
        parent_id text,
        is_group boolean DEFAULT false,
        opening_balance numeric DEFAULT 0,
        current_balance numeric DEFAULT 0,
        currency text DEFAULT 'INR',
        branch_id text,
        is_active boolean DEFAULT true,
        created_at timestamp DEFAULT now(),
        CONSTRAINT accounts_code_unique UNIQUE (code)
      )`,
      `CREATE INDEX IF NOT EXISTS accounts_type_idx ON accounts (type)`,
      `CREATE TABLE IF NOT EXISTS journal_entries (
        id text PRIMARY KEY,
        entry_number text NOT NULL,
        date date NOT NULL,
        description text,
        reference text,
        reference_type text,
        reference_id text,
        is_auto boolean DEFAULT true,
        branch_id text,
        created_by text,
        created_at timestamp DEFAULT now(),
        CONSTRAINT journal_entries_entry_number_unique UNIQUE (entry_number)
      )`,
      `CREATE INDEX IF NOT EXISTS journal_entries_date_idx ON journal_entries (date)`,
      `CREATE INDEX IF NOT EXISTS journal_entries_ref_idx ON journal_entries (reference_type, reference_id)`,
      `CREATE TABLE IF NOT EXISTS journal_entry_lines (
        id text PRIMARY KEY,
        journal_entry_id text NOT NULL,
        account_id text NOT NULL,
        debit numeric DEFAULT 0,
        credit numeric DEFAULT 0,
        description text,
        branch_id text
      )`,
      `CREATE INDEX IF NOT EXISTS jel_entry_idx ON journal_entry_lines (journal_entry_id)`,
      `CREATE INDEX IF NOT EXISTS jel_account_idx ON journal_entry_lines (account_id)`,
      `CREATE TABLE IF NOT EXISTS financial_periods (
        id text PRIMARY KEY,
        name text NOT NULL,
        start_date date NOT NULL,
        end_date date NOT NULL,
        is_open boolean DEFAULT true,
        closed_at timestamp
      )`,
      `CREATE TABLE IF NOT EXISTS print_templates (
        id text PRIMARY KEY,
        doc_type text NOT NULL,
        name text NOT NULL,
        config jsonb NOT NULL,
        is_default boolean NOT NULL DEFAULT false,
        updated_at timestamp
      )`,
      `CREATE INDEX IF NOT EXISTS print_templates_doc_type_idx ON print_templates (doc_type)`,
      // Per-IP rate-limit counters (express-rate-limit store).
      `CREATE TABLE IF NOT EXISTS rate_limit_hits (
        key text PRIMARY KEY,
        count integer NOT NULL DEFAULT 0,
        reset_at timestamptz
      )`,
      // Seen Shopify webhook delivery ids (replay/retry dedupe).
      `CREATE TABLE IF NOT EXISTS webhook_deliveries (
        webhook_id text PRIMARY KEY,
        seen_at timestamptz NOT NULL DEFAULT now()
      )`,
      // Silver rate audit fields + staff rate-change approval workflow.
      `ALTER TABLE silver_rates ADD COLUMN IF NOT EXISTS updated_by text`,
      `ALTER TABLE silver_rates ADD COLUMN IF NOT EXISTS source text`,
      `ALTER TABLE silver_rates ADD COLUMN IF NOT EXISTS sync_status text`,
      `ALTER TABLE silver_rates ADD COLUMN IF NOT EXISTS approved_by text`,
      // Per-step record of each rate update (timestamps, counts, error text)
      // behind the pipeline tracker + history View dialog.
      `ALTER TABLE silver_rates ADD COLUMN IF NOT EXISTS step_log jsonb`,
      `CREATE TABLE IF NOT EXISTS silver_rate_requests (
        id text PRIMARY KEY,
        rate numeric,
        previous_rate numeric,
        status text NOT NULL DEFAULT 'pending',
        sync_first boolean NOT NULL DEFAULT false,
        requested_by text,
        requested_by_id text,
        requested_by_role text,
        requested_at timestamp,
        decided_by text,
        decided_by_id text,
        decided_at timestamp,
        decision_note text,
        result_note text
      )`,
      `CREATE INDEX IF NOT EXISTS silver_rate_requests_status_idx ON silver_rate_requests (status)`,
      `CREATE INDEX IF NOT EXISTS silver_rate_requests_requested_at_idx ON silver_rate_requests (requested_at)`,
      // The Settings toggles existed in the UI but not on older databases.
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS require_rate_approval boolean DEFAULT true`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_update_mcx boolean DEFAULT false`,
      // Purchase lines, input-GST split, TCS and the supplier payment ledger.
      // These also live in createSchema, but that only runs on a brand-new
      // database — an existing install gets them from here.
      //
      // The three parent tables must be CREATED here, not just altered. An
      // install whose bootstrap ran before purchases existed never had them,
      // and every statement below (the ALTERs and the line-item tables, which
      // reference these by foreign key) fails against a missing relation. Those
      // failures are swallowed per-statement, so the install booted clean with
      // a silently non-functional purchase module.
      `CREATE TABLE IF NOT EXISTS purchase_orders (
        id text PRIMARY KEY,
        number text NOT NULL,
        supplier text,
        items integer,
        qty integer,
        weight numeric,
        value numeric,
        gst numeric DEFAULT 3,
        gst_amount numeric,
        discount numeric DEFAULT 0,
        grand_total numeric,
        notes text,
        expected_date timestamp,
        status text,
        date timestamp
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_number_idx ON purchase_orders (number)`,
      `CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx ON purchase_orders (supplier)`,
      `CREATE TABLE IF NOT EXISTS purchase_invoices (
        id text PRIMARY KEY,
        number text NOT NULL,
        supplier text,
        location_id text,
        items integer,
        qty integer,
        weight numeric,
        rate numeric,
        cost numeric,
        tax numeric,
        total numeric,
        status text,
        date timestamp
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_number_idx ON purchase_invoices (number)`,
      `CREATE TABLE IF NOT EXISTS purchase_returns (
        id text PRIMARY KEY,
        number text NOT NULL,
        supplier text,
        items integer,
        weight numeric,
        amount numeric,
        status text,
        date timestamp
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS purchase_returns_number_idx ON purchase_returns (number)`,
      `CREATE INDEX IF NOT EXISTS purchase_returns_supplier_idx ON purchase_returns (supplier)`,
      `CREATE INDEX IF NOT EXISTS purchase_returns_date_idx ON purchase_returns (date)`,
      `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS paid_amount numeric DEFAULT 0`,
      `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS order_id text`,
      `CREATE INDEX IF NOT EXISTS purchase_invoices_order_id_idx ON purchase_invoices (order_id)`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price numeric`,
      // Piece Rate Product: a fixed price per piece that silver-rate changes
      // and Shopify syncs must never recompute. Off for every existing row.
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS piece_rate_product boolean NOT NULL DEFAULT false`,
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS fixed_piece_rate numeric`,
      `ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS invoice_id text`,
      `CREATE INDEX IF NOT EXISTS purchase_returns_invoice_id_idx ON purchase_returns (invoice_id)`,
      `CREATE TABLE IF NOT EXISTS purchase_return_items (
        id text PRIMARY KEY,
        return_id text NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
        product text,
        sku text,
        qty numeric DEFAULT 1,
        weight numeric,
        rate numeric,
        amount numeric
      )`,
      `CREATE INDEX IF NOT EXISTS purchase_return_items_return_id_idx ON purchase_return_items (return_id)`,
      `CREATE INDEX IF NOT EXISTS purchase_return_items_sku_idx ON purchase_return_items (sku)`,
      `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS supplier_gstin text`,
      `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS supplier_state text`,
      `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS cgst numeric`,
      `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS sgst numeric`,
      `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS igst numeric`,
      `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS tcs_rate numeric`,
      `ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS tcs_amount numeric`,
      `CREATE INDEX IF NOT EXISTS purchase_invoices_status_idx ON purchase_invoices (status)`,
      `CREATE TABLE IF NOT EXISTS purchase_invoice_items (
        id text PRIMARY KEY,
        invoice_id text NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
        product text,
        sku text,
        qty numeric DEFAULT 1,
        weight numeric,
        rate numeric,
        cost numeric,
        tax numeric,
        amount numeric
      )`,
      `CREATE INDEX IF NOT EXISTS purchase_invoice_items_invoice_id_idx ON purchase_invoice_items (invoice_id)`,
      `CREATE INDEX IF NOT EXISTS purchase_invoice_items_sku_idx ON purchase_invoice_items (sku)`,
      `CREATE TABLE IF NOT EXISTS purchase_order_items (
        id text PRIMARY KEY,
        order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        product text,
        sku text,
        qty numeric DEFAULT 1,
        weight numeric,
        rate numeric,
        amount numeric
      )`,
      `CREATE INDEX IF NOT EXISTS purchase_order_items_order_id_idx ON purchase_order_items (order_id)`,
      `CREATE INDEX IF NOT EXISTS purchase_order_items_sku_idx ON purchase_order_items (sku)`,
      `CREATE TABLE IF NOT EXISTS supplier_payments (
        id text PRIMARY KEY,
        ref text,
        supplier text,
        amount numeric NOT NULL,
        method text,
        note text,
        date timestamp,
        created_by text
      )`,
      `CREATE INDEX IF NOT EXISTS supplier_payments_supplier_idx ON supplier_payments (supplier)`,
      `CREATE INDEX IF NOT EXISTS supplier_payments_date_idx ON supplier_payments (date)`,
      `CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
        id text PRIMARY KEY,
        payment_id text NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
        invoice_id text,
        invoice_number text,
        amount numeric NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS supplier_payment_allocations_payment_id_idx ON supplier_payment_allocations (payment_id)`,
      `CREATE INDEX IF NOT EXISTS supplier_payment_allocations_invoice_id_idx ON supplier_payment_allocations (invoice_id)`,
      // Supplier contact/GST details. These tables predate the columns, so an
      // existing install only gets them from here (createSchema is fresh-only).
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS alternate_phone text`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS email text`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS gstin text`,
      `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address text`,
      // Linking products / purchase orders to a real supplier record.
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id text`,
      `CREATE INDEX IF NOT EXISTS products_supplier_id_idx ON products (supplier_id)`,
      `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_id text`,
      // Purchase order detail page: GST breakdown (3% default), discount,
      // grand total, notes and expected delivery date. Existing rows get the
      // default rate and a computed GST/grand total so old POs display the
      // same way new ones do.
      `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS gst numeric DEFAULT 3`,
      `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS gst_amount numeric`,
      `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS discount numeric DEFAULT 0`,
      `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS grand_total numeric`,
      `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS notes text`,
      `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_date timestamp`,
      `UPDATE purchase_orders SET gst = 3 WHERE gst IS NULL`,
      `UPDATE purchase_orders SET gst_amount = round(coalesce(value, 0) * 0.03, 2) WHERE gst_amount IS NULL`,
      `UPDATE purchase_orders SET discount = 0 WHERE discount IS NULL`,
      `UPDATE purchase_orders SET grand_total = round(coalesce(value, 0) + coalesce(gst_amount, 0) - coalesce(discount, 0), 2) WHERE grand_total IS NULL`,
      `CREATE INDEX IF NOT EXISTS audit_logs_timestamp_id_idx ON audit_logs (timestamp DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS activity_logs_timestamp_id_idx ON activity_logs (timestamp DESC, id DESC)`,
      `CREATE TABLE IF NOT EXISTS product_price_history (
        id text PRIMARY KEY,
        product_id text NOT NULL,
        selling_price numeric NOT NULL,
        recorded_at timestamp NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS product_price_history_product_recorded_idx ON product_price_history (product_id, recorded_at)`,
      `INSERT INTO product_price_history (id, product_id, selling_price, recorded_at)
       SELECT 'pph-' || id, id, selling_price, COALESCE(created_at::timestamp, now() - interval '1 day')
       FROM products
       WHERE selling_price IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM product_price_history h WHERE h.id = 'pph-' || products.id)`,
    ]
    for (const stmt of upgrades) {
      await sql.unsafe(stmt).catch(() => undefined)
    }
    await ensureSupplierUniqueIndexes(sql)
    await sql.unsafe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_shopify_id text`).catch(() => undefined)
    await sql.unsafe(`CREATE INDEX IF NOT EXISTS sales_orders_customer_shopify_id_idx ON sales_orders (customer_shopify_id)`).catch(() => undefined)
    await sql.unsafe(`CREATE INDEX IF NOT EXISTS sales_orders_customer_email_idx ON sales_orders (customer_email)`).catch(() => undefined)
}

/**
 * Create the unique supplier indexes (name, GSTIN) without ever failing the
 * boot. Legacy installs may already hold duplicate supplier names or GSTINs
 * from the days when both were free text: a unique index would then error and,
 * if unchecked, could stop the server from starting. Instead we detect the
 * duplicates first, log exactly which values collide, and skip only the index
 * that cannot be built. Nothing is deleted, merged or rewritten — the operator
 * resolves the duplicates and the index is created on a later boot.
 */
async function ensureSupplierUniqueIndexes(sql: postgres.Sql): Promise<void> {
  // suppliers_name_idx is a case-sensitive unique index on name, so look for
  // exact duplicates — the same comparison the index itself enforces.
  const duplicateNames = await sql<{ name: string; count: number }[]>`
    SELECT name, count(*)::int AS count
      FROM suppliers
     WHERE name IS NOT NULL AND btrim(name) <> ''
     GROUP BY name
    HAVING count(*) > 1`
    .catch(() => [] as { name: string; count: number }[])

  if (duplicateNames.length > 0) {
    logger.warn(
      { duplicates: duplicateNames.map((d) => `${d.name} (x${d.count})`) },
      'Bootstrap: duplicate supplier names found — skipping suppliers_name_idx',
    )
  } else {
    await sql
      .unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_idx ON suppliers (name)`)
      .catch((err) => logger.warn({ err: (err as Error)?.message }, 'Bootstrap: could not create suppliers_name_idx'))
  }

  const duplicateGstins = await sql<{ gstin: string; count: number }[]>`
    SELECT lower(gstin) AS gstin, count(*)::int AS count
      FROM suppliers
     WHERE gstin IS NOT NULL AND btrim(gstin) <> ''
     GROUP BY lower(gstin)
    HAVING count(*) > 1`
    .catch(() => [] as { gstin: string; count: number }[])

  if (duplicateGstins.length > 0) {
    logger.warn(
      { duplicates: duplicateGstins.map((d) => `${d.gstin} (x${d.count})`) },
      'Bootstrap: duplicate supplier GSTINs found — skipping suppliers_gstin_idx',
    )
    return
  }

  await sql
    .unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS suppliers_gstin_idx ON suppliers (lower(gstin)) WHERE gstin IS NOT NULL AND btrim(gstin) <> ''`,
    )
    .catch((err) => logger.warn({ err: (err as Error)?.message }, 'Bootstrap: could not create suppliers_gstin_idx'))
}
