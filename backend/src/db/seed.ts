import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import argon2 from 'argon2'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'
import {
  activityLogs as activityLogSeed,
  auditLogs as auditLogSeed,
  bankAccounts as bankAccountSeed,
  customers as customerSeed,
  expenses as expenseSeed,
  inventoryLocations as locationSeed,
  ledgerEntries as ledgerSeed,
  payments as paymentSeed,
  products as productSeed,
  purchaseInvoices as purchaseInvoiceSeed,
  purchaseOrders as purchaseOrderSeed,
  purchaseReturns as purchaseReturnSeed,
  roleNames,
  salesInvoiceItems as salesInvoiceItemSeed,
  salesInvoices as salesInvoiceSeed,
  salesOrders as salesOrderSeed,
  salesReturns as salesReturnSeed,
  settingsSeed,
  silverRates as silverRateSeed,
  stockTransfers as stockTransferSeed,
  suppliers as supplierSeed,
  syncLogs as syncLogSeed,
  users as userSeed,
} from './seedData'
import { defaultRolePermissions } from '../rbac'
import { describeDatabaseTarget, isDesktopAppDatabase } from '../lib/seedGuard'
import { setStockTotalTo } from '../stock'
import { sql } from 'drizzle-orm'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Copy backend/.env.example to backend/.env and fill it in.')
  process.exit(1)
}

// db:seed truncates core tables before inserting demo data. It refuses to run
// against the desktop app's bundled database, and against any database that
// already holds data, unless --force (or SEED_FORCE=1) is passed explicitly.
const force = process.argv.includes('--force') || process.env.SEED_FORCE === '1'

// Always show where we are about to write — never with credentials.
console.log(`Seed target: ${describeDatabaseTarget(databaseUrl)}`)

if (isDesktopAppDatabase(databaseUrl) && !force) {
  console.error(
    'Refusing to seed: this is the desktop app\'s bundled database (127.0.0.1:47193, database opal_line).\n' +
      'Seeding would truncate real data. Point DATABASE_URL at a dev/scratch database instead,\n' +
      'or pass --force (or set SEED_FORCE=1) if you really mean to overwrite this one.',
  )
  process.exit(1)
}

async function main() {
  const client = postgres(databaseUrl!, { max: 1 })
  const db = drizzle(client, { schema })

  if (!force) {
    const occupied: string[] = []
    const check = async (name: string, rows: Array<{ n: unknown }>) => {
      const n = Number(rows[0]?.n ?? 0)
      if (n > 0) occupied.push(`${name} (${n} rows)`)
    }
    await check('users', await db.select({ n: sql`count(*)` }).from(schema.users))
    await check('products', await db.select({ n: sql`count(*)` }).from(schema.products))
    await check('sales_invoices', await db.select({ n: sql`count(*)` }).from(schema.salesInvoices))
    if (occupied.length > 0) {
      console.error(
        `Refusing to seed: ${describeDatabaseTarget(databaseUrl!)} already contains data:\n` +
          `    ${occupied.join(', ')}\n` +
          '    Seeding truncates it. Use a scratch database, or pass --force (or SEED_FORCE=1) to overwrite.',
      )
      await client.end()
      process.exit(1)
    }
  }

  console.log('Truncating existing data...')
  for (const table of [
    schema.salesInvoiceItems,
    schema.salesInvoices,
    schema.salesOrders,
    schema.purchaseOrders,
    schema.purchaseInvoices,
    schema.salesReturns,
    schema.purchaseReturns,
    schema.stockTransfers,
    schema.stockLevels,
    schema.stockMovements,
    schema.productVariants,
    schema.inventoryLocations,
    schema.bankAccounts,
    schema.ledgerEntries,
    schema.expenses,
    schema.payments,
    schema.auditLogs,
    schema.activityLogs,
    schema.syncLogs,
    schema.products,
    schema.customers,
    schema.suppliers,
    schema.silverRates,
    schema.users,
    schema.roles,
    schema.settings,
    schema.sessions,
    schema.loginAttempts,
  ]) {
    await db.delete(table)
  }

  console.log('Inserting seed data...')
  await db.insert(schema.silverRates).values(silverRateSeed)
  await db.insert(schema.roles).values(
    roleNames.map((name, i) => ({
      id: `ROLE${i + 1}`,
      name,
      description:
        name === 'Super Admin'
          ? 'Full access to every module'
          : 'No modules by default — a super admin grants access per user',
      permissions: defaultRolePermissions(name),
      isSystem: true,
      createdAt: new Date().toISOString(),
    })),
  )
  // Products go in with zero stock: the demo quantities are posted through the
  // ledger right after (see below), so a seeded database is born with balances
  // and movements instead of a products.stock value nothing can explain.
  await db.insert(schema.products).values(productSeed.map((p) => ({ ...p, stock: 0 })))
  // Every other stock write goes through applyStockMovement, and the seed is
  // no exception: the demo quantities become real balances at the default store
  // with `opening` movements behind them, so the rollup is derived from the
  // ledger from the very first row rather than being a column nobody can trace.
  let seededBalances = 0
  for (const p of productSeed) {
    const target = Math.floor(Number(p.stock ?? 0))
    if (target <= 0) continue
    const next = await setStockTotalTo({
      sku: p.sku,
      target,
      type: 'opening',
      refType: 'seed',
      note: 'opening balance for the demo catalogue',
      createdBy: 'seed',
    })
    if (next == null) console.warn(`  (seed) stock for ${p.sku} was NOT posted to the ledger — check that SKU`)
    else seededBalances++
  }
  if (seededBalances > 0) console.log(`Seeded opening balances for ${seededBalances} product(s) into the stock ledger.`)
  await db.insert(schema.customers).values(customerSeed)
  await db.insert(schema.suppliers).values(supplierSeed)
  await db.insert(schema.inventoryLocations).values(locationSeed)
  await db.insert(schema.stockTransfers).values(stockTransferSeed)
  await db.insert(schema.salesInvoices).values(salesInvoiceSeed)
  await db.insert(schema.salesInvoiceItems).values(salesInvoiceItemSeed)
  await db.insert(schema.salesOrders).values(salesOrderSeed)
  await db.insert(schema.purchaseOrders).values(purchaseOrderSeed)
  await db.insert(schema.purchaseInvoices).values(purchaseInvoiceSeed)
  await db.insert(schema.salesReturns).values(salesReturnSeed)
  await db.insert(schema.purchaseReturns).values(purchaseReturnSeed)
  await db.insert(schema.bankAccounts).values(bankAccountSeed)
  await db.insert(schema.ledgerEntries).values(ledgerSeed)
  await db.insert(schema.expenses).values(expenseSeed)
  await db.insert(schema.payments).values(paymentSeed)
  await db.insert(schema.auditLogs).values(auditLogSeed)
  await db.insert(schema.activityLogs).values(activityLogSeed)
  await db.insert(schema.syncLogs).values(syncLogSeed)
  // Seed admin password: same deterministic default as the first-run
  // bootstrap (SEED_ADMIN_PASSWORD ?? 'Opal@2026', documented in
  // docs/CONFIGURATION.md). An unset variable must NOT fall back to a random
  // secret: the docs tell fresh setups to run `npm run db:seed`, and a random
  // fallback replaced the known bootstrap credential with one that was never
  // printed — "login not working on the other developers' machines".
  const seedAdminPassword = process.env.SEED_ADMIN_PASSWORD?.trim() || 'Opal@2026'
  const defaultPasswordHash = await argon2.hash(seedAdminPassword, { type: argon2.argon2id })
  console.log(`Seed admin (arjun) password: ${seedAdminPassword}${process.env.SEED_ADMIN_PASSWORD?.trim() ? '' : ' (default — set SEED_ADMIN_PASSWORD to override)'}`)
  const tempPasswordHash = await argon2.hash('Temp@' + randomBytes(8).toString('hex'), { type: argon2.argon2id })
  await db.insert(schema.users).values(userSeed.map((u, i) => ({ 
    ...u, 
    passwordHash: i === 0 ? defaultPasswordHash : tempPasswordHash,
    // Demo accounts are seeded with known passwords on purpose, so do not
    // force a rotation: requireAuth would lock every seeded user out of the API
    // and there is no way for them to complete a change they cannot start.
    requirePasswordChange: false,
  })))
  await db.insert(schema.settings).values(settingsSeed)

  const counts = {
    silverRates: (await db.select().from(schema.silverRates)).length,
    products: (await db.select().from(schema.products)).length,
    customers: (await db.select().from(schema.customers)).length,
    suppliers: (await db.select().from(schema.suppliers)).length,
    invoices: (await db.select().from(schema.salesInvoices)).length,
    orders: (await db.select().from(schema.salesOrders)).length,
    users: (await db.select().from(schema.users)).length,
  }
  console.log('Seed complete:', counts)

  await client.end()
  // Exit explicitly: importing ../stock also opens the shared DB pool (drizzle
  // client), and an open pool keeps the event loop alive forever — the seed
  // finished but `npm run db:seed` never returned.
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
