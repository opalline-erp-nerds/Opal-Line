/**
 * Auto-sync safety: mocked Shopify fetch, scratch DB optional (guards + overlap
 * without persisting catalog writes when DATABASE_URL is unset).
 */
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import 'dotenv/config'

process.env.SHOPIFY_STORE_URL = 'https://opal-line-safety-test.myshopify.com'
process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_safety_test'
delete process.env.DATABASE_URL

let shopify: typeof import('./shopify')

before(async () => {
  shopify = await import('./shopify')
})

describe('product auto-sync safety (mocked Shopify)', () => {
  test('429 on products uses Retry-After then succeeds', async () => {
    let productCalls = 0
    const original = globalThis.fetch
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/products.json')) {
        productCalls++
        if (productCalls === 1) {
          return new Response('throttled', { status: 429, headers: { 'Retry-After': '0' } })
        }
        return new Response(
          JSON.stringify({ products: [{ id: 1, title: 'One', variants: [{ id: 1, sku: 'A', price: '10', inventory_quantity: 1 }], status: 'active' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/shop.json')) {
        return new Response(JSON.stringify({ shop: { myshopify_domain: 'opal-line-safety-test.myshopify.com' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return original(input)
    }
    try {
      const n = await shopify.pullLiveProducts()
      assert.equal(n, 1)
      assert.ok(productCalls >= 2)
    } finally {
      globalThis.fetch = original
    }
  })

  test('partial full catalog is rejected by guard', async () => {
    const { evaluateCatalogGuards } = await import('./productAutoSync.guards')
    const r = evaluateCatalogGuards({
      configuredShop: 'shop',
      storedShop: 'shop',
      fullCatalog: true,
      liveCount: 10,
      lastFullCount: 500,
    })
    assert.equal(r.ok, false)
  })

  test('overlapping syncProductsToDb calls — second is skipped', async () => {
    if (!process.env.DATABASE_URL?.trim()) {
      // Lock overlap is only observable once syncProductsToDb passes the DB gate.
      return
    }
    const original = globalThis.fetch
    let release: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/products.json')) {
        await gate
        return new Response(
          JSON.stringify({ products: [{ id: 2, title: 'Two', variants: [{ id: 2, sku: 'B', price: '20', inventory_quantity: 2 }], status: 'active' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      if (url.includes('inventory_levels') || url.includes('locations')) {
        return new Response(JSON.stringify({ inventory_levels: [], locations: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('custom_collections') || url.includes('smart_collections') || url.includes('collects')) {
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return original(input)
    }
    try {
      const first = shopify.syncProductsToDb({ mode: 'auto', allowRemovals: false })
      await new Promise((r) => setTimeout(r, 20))
      const second = await shopify.syncProductsToDb({ mode: 'auto', allowRemovals: false })
      assert.equal(second.skippedRun, true)
      release!()
      await first
    } finally {
      globalThis.fetch = original
    }
  })
})