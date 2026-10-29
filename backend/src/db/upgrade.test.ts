/**
 * Upgrade-path regression test.
 *
 * The purchase DDL originally lived only in the fresh-install path, so an
 * existing database never got the purchase tables. The follow-up fix moved it
 * into applyUpgrades — but only the ALTERs and the line-item tables moved; the
 * three parent tables were still never CREATEd. Because upgrade statements are
 * swallowed per-statement, that failure was invisible: bootstrap reported
 * success and every purchase route failed at runtime.
 *
 * This test reproduces the affected install population directly: bootstrap a
 * database, delete everything purchases added, then upgrade it and assert the
 * full purchase schema comes back.
 *
 * Needs a real PostgreSQL. Set UPGRADE_TEST_DATABASE_URL to run it; without it
 * the test skips, so `npm test` still passes on a machine with no database.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import postgres from 'postgres'

const URL = process.env.UPGRADE_TEST_DATABASE_URL

const PURCHASE_TABLES = [
  'purchase_orders',
  'purchase_invoices',
  'purchase_returns',
  'purchase_invoice_items',
  'purchase_order_items',
  'purchase_return_items',
  'supplier_payments',
  'supplier_payment_allocations',
]

const STOCK_TABLES = ['stock_levels', 'stock_movements']

const VARIANT_COLUMNS = [
  'title',
  'option_values',
  'selling_price',
  'compare_at_price',
  'cost_price',
  'gross_weight',
  'reorder_level',
]

const KEY_COLUMNS = [
  'products.cost_price',
  'purchase_invoices.order_id',
  'purchase_invoices.paid_amount',
  'purchase_invoices.supplier_gstin',
  'purchase_invoices.tcs_amount',
  'purchase_returns.invoice_id',
  // Receipt variance was added to an existing table, so the upgrade path has
  // to ALTER it back in. Emulated as pre-feature below, because a column the
  // fresh path creates is not evidence the upgrade path can.
  'stock_transfers.received_qty',
  'stock_transfers.variance',
  // Same reason: these are ALTERed onto pre-existing tables, and a column the
  // fresh path creates proves nothing about the upgrade path.
  'sales_orders.location_id',
  'purchase_invoices.location_id',
]

test('upgrade restores the full purchase schema on a pre-purchase database', async (t) => {
  if (!URL) {
    t.skip('set UPGRADE_TEST_DATABASE_URL to run the upgrade-path test')
    return
  }

  const admin = postgres(URL, { max: 1 })
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = URL

  try {
    const dbName = (await admin.unsafe('select current_database() as n'))[0].n as string
    // Start from a genuinely empty database so the first bootstrap takes the
    // fresh-install path and builds the complete current schema.
    await dropAndRecreate(admin, dbName)

    const { bootstrapDatabase, resetBootstrapForTests } = await import('./bootstrap')

    const fresh = await bootstrapDatabase()
    assert.equal(fresh.tablesCreated, true, 'first bootstrap should create the schema')

    const sql = postgres(URL, { max: 1 })
    try {
      // Emulate an install whose bootstrap ran before purchases existed.
      await sql.unsafe(
        `drop table if exists purchase_return_items, purchase_invoice_items, purchase_order_items,
           supplier_payment_allocations, supplier_payments, purchase_returns,
           purchase_invoices, purchase_orders, stock_movements, stock_levels cascade`,
      )
      await sql.unsafe('alter table products drop column if exists cost_price')
      // Emulate an install that predates transfer receipt variance.
      await sql.unsafe('alter table stock_transfers drop column if exists received_qty')
      await sql.unsafe('alter table stock_transfers drop column if exists variance')
      // …and one that predates per-location sales. purchase_invoices is dropped
      // wholesale above, so its location_id is covered by the upgrade recreating
      // the table rather than by the ALTER; the column assertion below still
      // guards that it exists afterwards.
      await sql.unsafe('alter table sales_orders drop column if exists location_id')
      // Emulate an install whose products.created_at is still a DATE
      // (predates the timestamp upgrade): the upgrade must widen it back.
      await sql.unsafe('alter table products alter column created_at type date using created_at::date')
      // Emulate an install with the old colour-only variant table. The
      // Shopify-style columns must be ALTERed in, and the colour/price values
      // carried forward so existing variants still render.
      await sql.unsafe('drop table if exists product_variants cascade')
      await sql.unsafe(`
        create table product_variants (
          id text primary key,
          product_id text not null,
          colour_name text,
          colour_hex text,
          sku text not null,
          barcode text,
          price numeric,
          stock integer not null default 0,
          shopify_variant_id text,
          shopify_inventory_item_id text,
          status text not null default 'active',
          is_primary boolean not null default false,
          created_at timestamp,
          shopify_status text
        )`)
      await sql.unsafe(`
        insert into product_variants
          (id, product_id, colour_name, sku, price, stock, status, is_primary)
        values ('VAR-LEGACY', 'PROD-LEGACY', 'Red', 'SKU-LEGACY-RED', 100, 2, 'active', false)`)

      assert.deepEqual(
        await purchaseTables(sql),
        [],
        'precondition: no purchase tables before the upgrade',
      )

      resetBootstrapForTests()
      const upgraded = await bootstrapDatabase()
      assert.equal(upgraded.ran, true)

      // The parent tables must exist…
      assert.deepEqual(
        (await purchaseTables(sql)).sort(),
        [...PURCHASE_TABLES].sort(),
        'upgrade must produce every purchase table',
      )

      // …and so must the stock ledger and per-location balances.
      for (const table of STOCK_TABLES) {
        const rows = await sql.unsafe(
          `select 1 from information_schema.tables where table_schema = 'public' and table_name = $1`,
          [table],
        )
        assert.equal(rows.length, 1, `upgrade must produce ${table}`)
      }
      const [defaultLoc] = await sql.unsafe(`select id from inventory_locations where id = 'LOC-DEFAULT'`)
      assert.ok(defaultLoc, 'upgrade must seed the default stock location')

      // …and the columns added alongside them.
      for (const col of KEY_COLUMNS) {
        const [table, column] = col.split('.')
        const rows = await sql.unsafe(
          `select 1 from information_schema.columns
           where table_schema = 'public' and table_name = $1 and column_name = $2`,
          [table, column],
        )
        assert.equal(rows.length, 1, `upgrade must produce ${col}`)
      }

      // …and the Shopify-style variant columns, with legacy colour/price data
      // migrated into them.
      for (const column of VARIANT_COLUMNS) {
        const rows = await sql.unsafe(
          `select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'product_variants' and column_name = $1`,
          [column],
        )
        assert.equal(rows.length, 1, `upgrade must produce product_variants.${column}`)
      }
      const [legacyVariant] = await sql.unsafe(
        `select title, option_values, selling_price from product_variants where id = 'VAR-LEGACY'`,
      )
      assert.equal(legacyVariant?.title, 'Red')
      assert.deepEqual(legacyVariant?.option_values, ['Red'])
      assert.equal(Number(legacyVariant?.selling_price), 100)

      // …and products.created_at must be widened back to a full timestamp:
      // day granularity tied every same-day product, so "newest first" was
      // meaningless within a day.
      const [createdAtCol] = await sql.unsafe(
        `select data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'products' and column_name = 'created_at'`,
      )
      assert.equal(
        createdAtCol?.data_type,
        'timestamp without time zone',
        'upgrade must widen products.created_at from date to timestamp',
      )
    } finally {
      await sql.end({ timeout: 5 })
    }
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
    await admin.end({ timeout: 5 })
  }
})

async function purchaseTables(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql.unsafe(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name like 'purchase%'
        or table_schema = 'public' and table_name like 'supplier_payment%'
     order by table_name`,
  )
  return rows.map((r) => r.table_name as string)
}

async function dropAndRecreate(admin: postgres.Sql, dbName: string): Promise<void> {
  await admin.unsafe(
    `drop schema if exists public cascade; create schema public;
     grant all on schema public to public`,
  )
  void dbName
}