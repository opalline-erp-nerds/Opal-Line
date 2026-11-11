import 'dotenv/config'
import postgres from 'postgres'
import argon2 from 'argon2'
import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/db/schema'
import { seedAdminPassword } from '../src/hostedMode'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

if (!process.env.SEED_ADMIN_PASSWORD?.trim()) {
  console.error('SEED_ADMIN_PASSWORD is not set.')
  process.exit(1)
}

const password = seedAdminPassword()

async function main(): Promise<void> {
  const sql = postgres(databaseUrl!, { max: 1, connect_timeout: 10 })
  try {
    const table = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
      LIMIT 1`
    if (table.length === 0) {
      throw new Error('The users table does not exist. Start the backend once so bootstrap creates the schema.')
    }

    const existing = await sql`SELECT 1 FROM users LIMIT 1`
    if (existing.length > 0) {
      console.log('A user already exists; nothing to do.')
      return
    }

    const db = drizzle(sql, { schema })
    const passwordHash = await argon2.hash(password)
    await db.insert(schema.users).values({
      id: randomBytes(8).toString('hex'),
      name: 'Administrator',
      email: 'admin@opalline.local',
      username: 'admin',
      passwordHash,
      role: 'Super Admin',
      status: 'active',
      requirePasswordChange: true,
      permissions: null,
    })

    console.log('Created admin user (username: admin).')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
