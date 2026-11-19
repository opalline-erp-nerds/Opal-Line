import 'dotenv/config'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/db/schema'
import { roleNames } from '../src/db/seedData'
import { defaultRolePermissions } from '../src/rbac'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

async function main(): Promise<void> {
  const sql = postgres(databaseUrl!, { max: 1, connect_timeout: 10 })
  try {
    const db = drizzle(sql, { schema })
    const existingIds = await db.select({ id: schema.roles.id }).from(schema.roles)
    const usedIds = new Set(existingIds.map((row) => row.id))
    let nextId = roleNames.length + 1
    let inserted = 0

    for (const [i, name] of roleNames.entries()) {
      const existing = await db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.name, name))
        .limit(1)
      if (existing[0]) {
        console.log(`= ${name} already exists, skipped`)
        continue
      }

      let id = `ROLE${i + 1}`
      if (usedIds.has(id)) {
        while (usedIds.has(`ROLE${nextId}`)) nextId++
        id = `ROLE${nextId}`
        nextId++
      }

      await db.insert(schema.roles).values({
        id,
        name,
        description:
          name === 'Super Admin'
            ? 'Full access to every module'
            : 'No modules by default — a super admin grants access per user',
        permissions: defaultRolePermissions(name),
        isSystem: true,
        createdAt: new Date().toISOString(),
      })
      usedIds.add(id)
      inserted++
      console.log(`+ ${name} inserted as ${id}`)
    }

    console.log(`Done. Inserted ${inserted} missing role(s); existing rows were left untouched.`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
