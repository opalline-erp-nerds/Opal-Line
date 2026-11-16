import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  evaluateCatalogGuards,
  evaluateShopGuard,
  shouldPauseAutoSync,
  MIN_CATALOG_RATIO,
} from './productAutoSync.guards'

describe('productAutoSync guards', () => {
  test('rejects a different Shopify store', () => {
    const r = evaluateShopGuard('new-shop', 'old-shop')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.reason, /store changed/)
  })

  test('skips empty full catalog', () => {
    const r = evaluateCatalogGuards({
      configuredShop: 'a',
      storedShop: 'a',
      fullCatalog: true,
      liveCount: 0,
      lastFullCount: 100,
    })
    assert.equal(r.ok, false)
  })

  test('allows empty incremental catalog', () => {
    const r = evaluateCatalogGuards({
      configuredShop: 'a',
      storedShop: 'a',
      fullCatalog: false,
      liveCount: 0,
      lastFullCount: 100,
    })
    assert.equal(r.ok, true)
  })

  test('skips truncated full catalog', () => {
    const last = 200
    const r = evaluateCatalogGuards({
      configuredShop: 'a',
      storedShop: 'a',
      fullCatalog: true,
      liveCount: Math.floor(last * MIN_CATALOG_RATIO) - 1,
      lastFullCount: last,
    })
    assert.equal(r.ok, false)
  })

  test('pauses after five consecutive failures', () => {
    assert.equal(shouldPauseAutoSync(4), false)
    assert.equal(shouldPauseAutoSync(5), true)
  })
})