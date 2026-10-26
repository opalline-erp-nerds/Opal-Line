/**
 * SKU identity: concurrency-safe minting and exact-SKU scan resolution — the
 * DB-backed halves of src/lib/skuIdentity.ts.
 *
 * Skipped unless DASHBOARD_TEST_DATABASE_URL points at a scratch database with
 * the schema applied (the same convention as orderInvoice.test.ts). The
 * connection is opened DIRECTLY against that URL — never through src/db/client
 * — so these tests can only ever touch the scratch database, whatever order
 * the suite imports modules in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const testUrl = process.env.DASHBOARD_TEST_DATABASE_URL?.trim()
const skip = testUrl ? false : 'DASHBOARD_TEST_DATABASE_URL is not set'

async function withScratchDb(run: (db: any, schema: typeof import('../db/schema')) => Promise<void>): Promise<void> {
  const { default: postgres } = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const schema = await import('../db/schema')
  const client = postgres(testUrl as string, { max: 8, connect_timeout: 5, onnotice: () => {} })
  const db = drizzle(client, { schema })
  try {
    await run(db, schema)
  } finally {
    await client.end({ timeout: 5 })
  }
}

test(
  'concurrent creates mint distinct, consecutive OL-{CODE}-{SEQ} SKUs for one category',
  { skip },
  async () => {
    await withScratchDb(async (db, schema) => {
      const { eq, sql } = await import('drizzle-orm')
      const { generateUniqueSku } = await import('./skuIdentity')
      const { categoryCode } = await import('./productCodes')

      const marker = `skuident-${Date.now()}`
      const category = `Concurrency ${marker}`
      try {
        // Leftovers from a crashed earlier run would otherwise continue the
        // sequence; a clean slate keeps this assertion exact.
        await db.delete(schema.products).where(sql`${schema.products.name} like ${'skuident-%'}`)

        // Six parallel transactions racing to mint the FIRST codes of a brand
        // new category. Without the per-category advisory lock they would all
        // read the same max sequence and collide on insert; with it they
        // serialise into OL-…-001 … OL-…-006.
        const skus: string[] = await Promise.all(
          Array.from({ length: 6 }, async () =>
            db.transaction(async (tx: any) => {
              const sku = await generateUniqueSku(tx, category)
              await tx.insert(schema.products).values({
                id: randomUUID(),
                name: `${marker} ${sku}`,
                sku,
                category,
              })
              return sku
            }),
          ),
        )

        const code = categoryCode(category)
        assert.equal(new Set(skus).size, 6, `duplicate SKUs minted: ${skus.join(', ')}`)
        for (const sku of skus) {
          assert.match(sku, new RegExp(`^OL-${code}-\\d{3,}$`), `bad shape: ${sku}`)
        }
        assert.deepEqual(
          [...skus].sort(),
          ['001', '002', '003', '004', '005', '006'].map((n) => `OL-${code}-${n}`),
          'six racers must produce the first six sequences, once each',
        )

        // The minted codes are committed under the unique index…
        const rows = await db
          .select({ sku: schema.products.sku })
          .from(schema.products)
          .where(eq(schema.products.category, category))
        assert.equal(rows.length, 6)
      } finally {
        await db.delete(schema.products).where(sql`${schema.products.name} like ${'skuident-%'}`)
      }
    })
  },
)

test('scanning a label resolves the product by exact SKU, case-insensitively', { skip }, async () => {    await withScratchDb(async (db, schema) => {
      const { eq } = await import('drizzle-orm')
      const { findProductsBySku } = await import('./skuIdentity')
    const sku = `OL-SCN-${Date.now()}`
    const id = randomUUID()
    try {
      await db.insert(schema.products).values({ id, name: 'Scan target', sku, category: 'Rings' })

      const hit = await findProductsBySku(db, sku)
      assert.equal(hit.length, 1)
      assert.equal(hit[0].id, id)
      assert.equal(hit[0].sku, sku)

      // Scanners vary the case of what they read — the same code still resolves.
      assert.equal((await findProductsBySku(db, sku.toLowerCase())).length, 1)

      // Exact match only: a prefix, an extension or a near-miss never resolves,
      // so a scan can never pick the wrong product.
      assert.equal((await findProductsBySku(db, sku.slice(0, 6))).length, 0)
      assert.equal((await findProductsBySku(db, `${sku}-X`)).length, 0)
      assert.equal((await findProductsBySku(db, '')).length, 0)
    } finally {
      await db.delete(schema.products).where(eq(schema.products.id, id))
    }
  })
})

test('the unique SKU index is the final backstop against duplicate identifiers', { skip }, async () => {    await withScratchDb(async (db, schema) => {
      const { eq } = await import('drizzle-orm')
      const sku = `OL-DUP-${Date.now()}`
    const first = randomUUID()
    try {
      await db.insert(schema.products).values({ id: first, name: 'Dup A', sku, category: 'Rings' })
      // Even a path that skipped the advisory lock cannot commit a duplicate:
      // the unique index rejects the second write (drizzle wraps the driver
      // error, so inspect the message AND its cause).
      await assert.rejects(
        () =>
          db
            .insert(schema.products)
            .values({ id: randomUUID(), name: 'Dup B', sku, category: 'Rings' }),
        (err: any) => {
          const text = `${err?.message ?? ''}\n${err?.cause?.message ?? ''}`
          assert.match(text, /duplicate key|unique constraint/i)
          return true
        },
      )
    } finally {
      await db.delete(schema.products).where(eq(schema.products.id, first))
    }
  })
})
