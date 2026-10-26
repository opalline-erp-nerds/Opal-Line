import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'

// dotenv is loaded by the modules we import; clear the database URL first so
// db/client.ts never opens a real connection inside this test process.
delete process.env.DATABASE_URL

let shopify: typeof import('./shopify')

before(async () => {
  shopify = await import('./shopify')
})

describe('exceedsShopifyPriceCap (Shopify $10,000 USD variant price cap)', () => {
  test('rejects prices above the cap, including fractional cents over it', () => {
    assert.equal(shopify.exceedsShopifyPriceCap(10000.01), true)
    assert.equal(shopify.exceedsShopifyPriceCap(106698.14), true) // the observed 422 push
    assert.equal(shopify.exceedsShopifyPriceCap('106699.99'), true) // numeric strings count too
  })

  test('non-finite or garbage values are not the cap concern', () => {
    // A non-finite price is invalid for other reasons (validity checks in the
    // push paths already reject it before the cap guard runs).
    assert.equal(shopify.exceedsShopifyPriceCap(Infinity), false)
  })

  test('accepts prices at or below the cap', () => {
    assert.equal(shopify.exceedsShopifyPriceCap(10000), false)
    assert.equal(shopify.exceedsShopifyPriceCap(9999.99), false)
    assert.equal(shopify.exceedsShopifyPriceCap('465'), false)
    assert.equal(shopify.exceedsShopifyPriceCap(0), false)
  })

  test('non-numeric or missing values never trip the guard', () => {
    assert.equal(shopify.exceedsShopifyPriceCap(NaN), false)
    assert.equal(shopify.exceedsShopifyPriceCap(undefined), false)
    assert.equal(shopify.exceedsShopifyPriceCap(null), false)
    assert.equal(shopify.exceedsShopifyPriceCap(''), false)
  })

  test('the constant matches the exact limit in Shopify\'s 422 message', () => {
    // Shopify answers 422 {"errors":{"price":["can't exceed $10,000.00 USD"]}}
    assert.equal(shopify.SHOPIFY_MAX_VARIANT_PRICE, 10000)
  })
})

describe('applyPriceSync skips over-cap rows safely', () => {
  test('marks an over-cap entry "skipped" without touching Shopify and keeps valid rows queued', async () => {
    // Only rows above the cap are supplied, so the run can never make an HTTP
    // call: the guard must fire before the variant PUT is attempted.
    shopify.store.price = [
      {
        productId: 8325790040127,
        variantId: 45219141427391,
        title: 'Selling Plans Ski Wax',
        sku: 'SHOP-8325790040127',
        handle: 'selling-plans-ski-wax',
        currentPrice: 100,
        targetPrice: 106698.14,
        status: 'update',
      },
      {
        productId: 8325789876287,
        variantId: 45219141488487,
        title: 'The Complete Snowboard',
        sku: 'SHOP-8325789876287',
        handle: 'the-complete-snowboard',
        currentPrice: 100,
        targetPrice: 84235.37,
        status: 'update',
      },
    ]

    const result = await shopify.applyPriceSync()

    assert.deepEqual(
      { ...result },
      { ok: true, updated: 0, skipped: 2, errors: [] },
      'over-cap rows must be a clean skip, not a failed push',
    )
    assert.deepEqual(
      shopify.store.price.map((p) => p.status),
      ['skipped', 'skipped'],
      'entries must leave the retry queue (status "skipped", not "update")',
    )
  })

  test('no variant PUT is issued for an over-cap-only batch (no network activity)', async () => {
    shopify.store.price = [
      {
        productId: 8325819859007,
        variantId: 999,
        title: 'silver thodu',
        sku: '1524',
        handle: 'silver-thodu',
        currentPrice: 100,
        targetPrice: 49418.09,
        status: 'update',
      },
    ]
    let fetchCalled = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalled++
      throw new Error('applyPriceSync must not attempt a Shopify request for over-cap prices')
    }) as typeof globalThis.fetch
    try {
      const result = await shopify.applyPriceSync()
      assert.equal(result.ok, true)
      assert.equal(result.skipped, 1)
      assert.equal(result.updated, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(fetchCalled, 0, 'the cap guard must run before any HTTP request')
  })

  test('under-cap rows keep their "update" status when the push cannot reach Shopify', async () => {
    // The valid row stays in the "update" retry queue exactly as before — the
    // cap guard must not change how valid prices sync.
    shopify.store.price = [
      {
        productId: 8394469507135,
        variantId: 1000,
        title: 'Gold coin',
        sku: '560',
        handle: 'gold-coin',
        currentPrice: 100,
        targetPrice: 3743.79,
        status: 'update',
      },
    ]
    let seentoVariantPut = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      seentoVariantPut = true
      // Pretend Shopify is unreachable — the exact network behaviour does not
      // matter; what matters is that the row stays queued for retry.
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch
    try {
      const result = await shopify.applyPriceSync()
      assert.equal(seentoVariantPut, true, 'a valid price must still be pushed')
      assert.equal(result.updated, 0)
      assert.equal(result.ok, false)
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.deepEqual(
      shopify.store.price.map((p) => p.status),
      ['update'],
      'valid rows must remain "update" so other products can keep syncing',
    )
    shopify.store.lastError = undefined
  })
})
