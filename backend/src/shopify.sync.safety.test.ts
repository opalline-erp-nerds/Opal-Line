/**
 * Scratch-DB checks: webhook delete is non-destructive, manual full sync keeps
 * ERP variant price/barcode, product sync never touches issued invoices.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import 'dotenv/config'

const baseDbUrl = process.env.DATABASE_URL?.trim() ?? ''
const TEST_DB = 'opal_line_sync_safety_test'
const MOCK_HOST = 'mock-safety-test.myshopify.com'

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

function miniMockFetch(products: Map<number, Record<string, unknown>>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.includes('/shop.json')) {
      return new Response(JSON.stringify({ shop: { myshopify_domain: `${MOCK_HOST}` } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/products.json') && method === 'GET') {
      const list = [...products.values()]
      return new Response(JSON.stringify({ products: list }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/inventory_levels') || url.includes('/locations') || url.includes('collections') || url.includes('collects')) {
      return new Response(JSON.stringify({ inventory_levels: [], locations: [], custom_collections: [], smart_collections: [], collects: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 404 })
  }
}

test(
  'product sync safety (scratch DB)',
  { skip: baseDbUrl ? false : 'DATABASE_URL is not set' },
  async () => {
    const admin = postgres(baseDbUrl, { max: 1 })
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`)
    } finally {
      await admin.end({ timeout: 5 })
    }

    process.env.DATABASE_URL = scratchUrl(baseDbUrl)
    process.env.SHOPIFY_STORE_URL = `https://${MOCK_HOST}`
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_safety_test'

    const shopifyProductId = 77_001
    const shopifyVariantId = 88_001
    const products = new Map<number, Record<string, unknown>>([
      [
        shopifyProductId,
        {
          id: shopifyProductId,
          title: 'Safety Ring',
          status: 'active',
          product_type: 'Rings',
          variants: [
            {
              id: shopifyVariantId,
              title: 'Default',
              sku: 'SAFE-001',
              price: '999.00',
              barcode: 'SHOP-BAR',
              inventory_quantity: 40,
              inventory_item_id: 55_001,
            },
          ],
          options: [],
        },
      ],
    ])

    const originalFetch = globalThis.fetch
    globalThis.fetch = miniMockFetch(products) as typeof fetch

    try {
      const { bootstrapDatabase } = await import('./db/bootstrap')
      await bootstrapDatabase()
      const { db, schema: s } = await import('./db/client')
      assert.ok(db)

      const productId = randomUUID()
      const variantId = randomUUID()
      const invoiceId = randomUUID()
      await db.insert(s.products).values({
        id: productId,
        name: 'Safety Ring',
        sku: 'SAFE-001',
        barcode: 'ERP-BAR-LOCK',
        category: 'Rings',
        purity: 92.5,
        gst: 3,
        stock: 10,
        shopifyId: String(shopifyProductId),
        shopifyStatus: 'synced',
        status: 'active',
        sellingPrice: 500,
        trackInventory: true,
        chargeOnTax: true,
      })
      await db.insert(s.productVariants).values({
        id: variantId,
        productId,
        title: 'Default',
        optionValues: ['Default'],
        sku: 'SAFE-001-V',
        barcode: 'ERP-VBAR',
        shopifyVariantId: String(shopifyVariantId),
        sellingPrice: 500,
        stock: 10,
        status: 'active',
      })
      await db.insert(s.salesInvoices).values({
        id: invoiceId,
        number: 'INV-SAFE-1',
        grandTotal: 500,
        status: 'issued',
        paymentStatus: 'paid',
        date: '2026-01-01T00:00:00.000Z',
      })

      const shopify = await import('./shopify')
      const pull = await shopify.syncProductsToDb({
        mode: 'full',
        preserveLocalPriceStock: true,
        preserveErpPrices: true,
        preserveLocalBarcodes: true,
        mergeVariants: true,
        allowRemovals: false,
      })
      assert.equal(pull.ok, true)

      const [row] = await db.select().from(s.products).where(eq(s.products.id, productId))
      assert.equal(row.stock, 10, 'parent stock preserved when overwrite off')
      assert.equal(row.barcode, 'ERP-BAR-LOCK')

      const [vRow] = await db.select().from(s.productVariants).where(eq(s.productVariants.id, variantId))
      assert.equal(Number(vRow.sellingPrice), 500, 'variant ERP price preserved on manual-safe full sync')
      assert.equal(vRow.barcode, 'ERP-VBAR')

      const [invBefore] = await db.select().from(s.salesInvoices).where(eq(s.salesInvoices.id, invoiceId))
      const webhook = await import('./shopifyProductWebhook')
      const del = await webhook.flagProductDeletedFromWebhook({ id: shopifyProductId })
      assert.equal(del.removed, 0)
      const countAfter = await db.select({ id: s.products.id }).from(s.products).where(eq(s.products.id, productId))
      assert.equal(countAfter.length, 1, 'webhook delete must not remove the ERP row')
      assert.equal(countAfter[0].id, productId)

      const [invAfter] = await db.select().from(s.salesInvoices).where(eq(s.salesInvoices.id, invoiceId))
      assert.deepEqual(invAfter, invBefore, 'issued invoice unchanged after product sync and delete webhook')
    } finally {
      globalThis.fetch = originalFetch
      const admin2 = postgres(baseDbUrl, { max: 1 })
      try {
        await admin2.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      } catch {
        /* best effort */
      }
      await admin2.end({ timeout: 5 })
    }
  },
)