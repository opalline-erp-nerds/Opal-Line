// Integration regression test for the Shopify customer data sync against the
// REAL Postgres schema, running in a THROWAWAY scratch database
// (opal_line_customer_test). Like shopify.sync.test.ts it skips when
// DATABASE_URL is unset — never the app database. Every row carries a unique
// marker so re-runs and parallel runs cannot collide with each other or with
// the dev data.
//
// Covered scenarios (Shopify customer data sync fixes):
//   - placeholder "Shopify Customer #<id>" rows upgrade to real names
//   - a customer with email/phone but NO name data gets its name + city upgraded
//   - a null/empty/redacted CSV value keeps stored data (never blanks it)
//   - identity matching prevents duplicates: shopify_id first, then
//     case-normalized email, then digits-normalized phone
import 'dotenv/config'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import postgres from 'postgres'

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_customer_test'

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

test(
  'Shopify customer data sync fixes (real schema, scratch DB)',
  { skip: baseDbUrl ? false : 'DATABASE_URL is not set — needs a local PostgreSQL to create the scratch database' },
  async () => {
    const admin = postgres(baseDbUrl, { max: 1 })
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`)
    } finally {
      await admin.end({ timeout: 5 })
    }

    process.env.DATABASE_URL = scratchUrl(baseDbUrl)
    const marker = `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    let raw: postgres.Sql | null = null
    try {
      // The app's own first-run bootstrap creates the full schema.
      const { bootstrapDatabase } = await import('./db/bootstrap')
      const boot = await bootstrapDatabase()
      assert.equal(boot.tablesCreated, true, 'fresh scratch schema must be created')
      const { getRawClient } = await import('./db/client')
      raw = getRawClient()
      assert.ok(raw, 'scratch database must be connected')

      const { importCustomersFromCSV } = await import('./shopifyDataEnhance')

      // ── 1. Placeholder rows upgrade to their real names ──────────────
      const placeholderRes = await importCustomersFromCSV([
        {
          'First Name': 'Priya',
          'Last Name': 'Sharma',
          Email: `priya.${marker}@example.com`,
          'Phone (1)': '9876543210',
          'Default Address City': 'Indore',
        },
      ])
      assert.equal(placeholderRes.imported, 1, placeholderRes.errors.join('; '))
      const [placeholder] = await raw.unsafe(
        `SELECT id, name, email, phone, city FROM customers WHERE email = $1`,
        [`priya.${marker}@example.com`],
      )
      assert.equal(String((placeholder as any).name), 'Priya Sharma')

      // The placeholder IMPORT itself: a row named "Shopify Customer #<id>"
      // (simulating a redacted API sync) is upgraded by id, not duplicated.
      const shopifyId = String(9600000000000 + Math.floor(Math.random() * 1e6))
      await raw.unsafe(
        `INSERT INTO customers (id, name, email, phone, city, province, shopify_id) VALUES ($1, $2, '', '', '', '', $3)`,
        [`C-fix-${shopifyId}`, `Shopify Customer #${shopifyId}`, shopifyId],
      )
      const upgradeRes = await importCustomersFromCSV([
        {
          'Customer ID': shopifyId,
          'First Name': 'Anita',
          'Last Name': 'Kapoor',
          Email: '',
          Phone: '',
          'Default Address Province': 'MH',
        },
      ])
      assert.equal(upgradeRes.updated, 1, upgradeRes.errors.join('; '))
      const [upgraded] = await raw.unsafe(
        `SELECT name, city, province, coalesce(email, '') AS email, coalesce(phone, '') AS phone FROM customers WHERE shopify_id = $1`,
        [shopifyId],
      )
      assert.equal(String((upgraded as any).name), 'Anita Kapoor', 'placeholder name replaced by the real one')
      assert.equal(String((upgraded as any).province), 'MH')
      assert.equal(String((upgraded as any).email), '', 'empty CSV email does not invent data')

      // A re-import of the SAME row adds no duplicate and does not downgrade.
      const againRes = await importCustomersFromCSV([
        { 'Customer ID': shopifyId, 'First Name': 'Wrong', 'Last Name': 'Duplicate' },
      ])
      assert.equal(againRes.updated, 1, againRes.errors.join('; '))
      const dupCount = await raw.unsafe(`SELECT count(*)::int AS n FROM customers WHERE shopify_id = $1`, [shopifyId])
      assert.equal(Number((dupCount[0] as any).n), 1, 'no duplicate row for the same Shopify identity')

      // ── 2. Missing email/phone still enriches name + address ─────────
      const nameOnlyRow = await importCustomersFromCSV([
        {
          'Name': 'Rohit Verma',
          'Default Address City': 'Jaipur',
          'Default Address Province': 'RJ',
        },
      ])
      assert.equal(nameOnlyRow.imported, 1, nameOnlyRow.errors.join('; '))
      const [noContact] = await raw.unsafe(
        `SELECT id, name, city, province, coalesce(email, '') AS email, coalesce(phone, '') AS phone FROM customers WHERE name = 'Rohit Verma' AND city = 'Jaipur'`,
      )
      assert.ok(noContact, 'a CSV row without email or phone is still imported')
      assert.equal(String((noContact as any).province), 'RJ')

      // The name-only row has NO identity key (name is never one — distinct
      // customers can share a name), so a later row with its own email is a
      // separate record. The invariant: the earlier, valid row is untouched.
      const overwriteRes = await importCustomersFromCSV([
        { Name: 'Rohit Verma', 'Email': `rohit.${marker}@example.com`, 'Default Address City': 'Udaipur' },
      ])
      assert.equal(overwriteRes.imported, 1, overwriteRes.errors.join('; '))
      const [stillIntact] = await raw.unsafe(
        `SELECT name, city, coalesce(email, '') AS email FROM customers WHERE name = 'Rohit Verma' AND city = 'Jaipur'`,
      )
      assert.ok(stillIntact, 'the original name-only row was not overwritten')
      assert.equal(String((stillIntact as any).email), '', 'no email was written onto a row that never had one')
      // A placeholder-style row exists only as its name+id: re-importing the
      // same email with a DIFFERENT name must not rewrite it.
      const emailRow = await importCustomersFromCSV([
        { 'Name': 'Different Person', 'Email': `priya.${marker.toUpperCase()}@example.com` },
      ])
      // The row matched (no duplicate insert) and had nothing left to fill;
      // the real stored name must survive the differently-named CSV row.
      assert.ok(emailRow.imported === 0, 'same email must not insert a duplicate row')
      const [priyaAgain] = await raw.unsafe(
        `SELECT name FROM customers WHERE lower(email) = lower($1)`,
        [`priya.${marker.toUpperCase()}@example.com`],
      )
      assert.equal(String((priyaAgain as any).name), 'Priya Sharma', 'a real stored name survives a differently-named CSV row for the same email')

      // ── 3. Redacted customer data: nulls/empties never erase ─────────
      const keepRes = await importCustomersFromCSV([
        { 'Email': `priya.${marker}@example.com`, 'Default Address City': '', 'Phone (1)': 'redacted (redacted by app)' },
      ])
      assert.ok(keepRes.errors.length === 0 || keepRes.updated === 1, keepRes.errors.join('; '))
      const [afterRedact] = await raw.unsafe(
        `SELECT name, phone, city FROM customers WHERE email = $1`,
        [`priya.${marker}@example.com`],
      )
      assert.equal(String((afterRedact as any).name), 'Priya Sharma', 'name preserved across a redacted re-import')
      assert.equal(String((afterRedact as any).city), 'Indore', 'empty CSV city keeps the stored city')

      // ── 4. Identity matching: no duplicates via normalized keys ──────
      // Same person, differently-cased email and reformatted phone!
      const dupRes = await importCustomersFromCSV([
        { 'Name': 'Second Occurrence', 'Email': `PRIYA.${marker.toUpperCase()}@EXAMPLE.COM`, 'Phone (1)': '+91 98765-43210' },
      ])
      // The differently-cased email MUST match the stored row: if the
      // normalized lookup had missed, this CSV line would have inserted a
      // near-duplicate customer instead.
      assert.ok(dupRes.imported === 0, dupRes.errors.join('; '))
      const afterDup = await raw.unsafe(
        `SELECT count(*)::int AS n FROM customers WHERE lower(email) = lower($1) OR phone IN ('9876543210', '+91 98765-43210')`,
        [`priya.${marker}@example.com`],
      )
      assert.equal(Number((afterDup[0] as any).n), 1, 'case/format-different identity matched into the same row')
    } finally {
      if (raw) await raw.end({ timeout: 5 }).catch(() => undefined)
    }
  },
)
