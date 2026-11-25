import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from './config'
import {
  DEFAULT_ORDER_SYNC_INTERVAL_SECONDS,
  MAX_ORDER_SYNC_INTERVAL_SECONDS,
  MIN_ORDER_SYNC_INTERVAL_SECONDS,
  ORDER_SYNC_OVERLAP_MS,
  __resetOrderAutoSyncState,
  getOrderAutoSyncStatus,
  orderSyncUpdatedAtMin,
  parseOrderSyncIntervalSeconds,
  runOrderAutoSync,
  startOrderAutoSync,
  stopOrderAutoSync,
  runOrderAutoSyncOnce,
  type OrderAutoSyncDeps,
  type OrderAutoSyncRunResult,
  type OrderSyncImportResult,
} from './orderAutoSync'

const NOW = Date.parse('2026-11-25T12:00:00.000Z')

type Harness = {
  deps: OrderAutoSyncDeps
  imports: Array<{ updatedAtMin: string | null }>
  watermarks: string[]
}

function harness(overrides: Partial<OrderAutoSyncDeps> & {
  result?: OrderSyncImportResult
  importImpl?: (options: { updatedAtMin: string | null }) => Promise<OrderSyncImportResult>
  watermark?: string | null
} = {}): Harness {
  const imports: Array<{ updatedAtMin: string | null }> = []
  const watermarks: string[] = []
  const deps: OrderAutoSyncDeps = {
    isConfigured: () => true,
    readWatermark: async () => overrides.watermark ?? null,
    writeWatermark: async (iso) => {
      watermarks.push(iso)
    },
    importOrders: async (options) => {
      imports.push(options)
      if (overrides.importImpl) return overrides.importImpl(options)
      return overrides.result ?? { ok: true, imported: 1, updated: 0, errors: [] }
    },
    now: () => NOW,
    ...overrides,
  }
  return { deps, imports, watermarks }
}

describe('order sync interval', () => {
  test('defaults when unset or unusable', () => {
    assert.equal(parseOrderSyncIntervalSeconds(undefined), DEFAULT_ORDER_SYNC_INTERVAL_SECONDS)
    assert.equal(parseOrderSyncIntervalSeconds(null), DEFAULT_ORDER_SYNC_INTERVAL_SECONDS)
    assert.equal(parseOrderSyncIntervalSeconds(''), DEFAULT_ORDER_SYNC_INTERVAL_SECONDS)
    assert.equal(parseOrderSyncIntervalSeconds('not-a-number'), DEFAULT_ORDER_SYNC_INTERVAL_SECONDS)
    assert.equal(parseOrderSyncIntervalSeconds(-5), DEFAULT_ORDER_SYNC_INTERVAL_SECONDS)
  })

  test('0 disables the timer', () => {
    assert.equal(parseOrderSyncIntervalSeconds(0), 0)
    assert.equal(parseOrderSyncIntervalSeconds('0'), 0)
  })

  test('clamps to the safe range and floors fractions', () => {
    assert.equal(parseOrderSyncIntervalSeconds(1), MIN_ORDER_SYNC_INTERVAL_SECONDS)
    assert.equal(parseOrderSyncIntervalSeconds(120), 120)
    assert.equal(parseOrderSyncIntervalSeconds(120.9), 120)
    assert.equal(parseOrderSyncIntervalSeconds(999_999), MAX_ORDER_SYNC_INTERVAL_SECONDS)
  })

  test('reads numeric env strings', () => {
    assert.equal(parseOrderSyncIntervalSeconds('45'), 45)
  })
})

describe('order sync watermark', () => {
  test('no watermark means a full pull', () => {
    assert.equal(orderSyncUpdatedAtMin(null, NOW), null)
    assert.equal(orderSyncUpdatedAtMin(undefined, NOW), null)
    assert.equal(orderSyncUpdatedAtMin('not-a-date', NOW), null)
  })

  test('re-reads an overlap window before the last success', () => {
    const lastSuccess = new Date(NOW - 60_000).toISOString()
    assert.equal(
      orderSyncUpdatedAtMin(lastSuccess, NOW),
      new Date(NOW - 60_000 - ORDER_SYNC_OVERLAP_MS).toISOString(),
    )
  })

  test('a clock jump never asks Shopify for the future', () => {
    const future = new Date(NOW + 60 * 60 * 1000).toISOString()
    assert.equal(orderSyncUpdatedAtMin(future, NOW, 0), new Date(NOW).toISOString())
  })
})

describe('runOrderAutoSyncOnce', () => {
  beforeEach(() => __resetOrderAutoSyncState())

  test('skips cleanly when Shopify is not configured', async () => {
    const h = harness({ isConfigured: () => false })
    const result = await runOrderAutoSyncOnce(h.deps)
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'Shopify is not configured')
    assert.equal(h.imports.length, 0, 'nothing is fetched without credentials')
    assert.equal(h.watermarks.length, 0)
  })

  test('first run is a full pull and then advances the watermark', async () => {
    const h = harness()
    const first = await runOrderAutoSyncOnce(h.deps)
    assert.equal(first.ok, true)
    assert.equal(first.incremental, false)
    assert.equal(h.imports[0].updatedAtMin, null)
    assert.deepEqual(h.watermarks, [new Date(NOW).toISOString()])
  })

  test('later runs are incremental from the stored watermark', async () => {
    const watermark = new Date(NOW - 10 * 60_000).toISOString()
    const h = harness({ watermark })
    const result = await runOrderAutoSyncOnce(h.deps)
    assert.equal(result.incremental, true)
    assert.equal(
      h.imports[0].updatedAtMin,
      new Date(Date.parse(watermark) - ORDER_SYNC_OVERLAP_MS).toISOString(),
      'the overlap window closes the gap between runs',
    )
    assert.equal(result.updatedAtMin, h.imports[0].updatedAtMin)
  })

  test('a failed import reports the error and does not advance the watermark', async () => {
    const h = harness({
      result: { ok: false, imported: 0, updated: 0, errors: ['Shopify API error 500'], message: 'Shopify API error 500' },
    })
    const result = await runOrderAutoSyncOnce(h.deps)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'Shopify API error 500')
    assert.equal(h.watermarks.length, 0, 'the next run retries the same window')
  })

  test('a thrown importer is contained (the timer survives)', async () => {
    const h = harness({
      importImpl: async () => {
        throw new Error('socket hang up')
      },
    })
    const result = await runOrderAutoSyncOnce(h.deps)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'socket hang up')
    assert.equal(h.watermarks.length, 0)
  })

  test('partial per-order errors do not advance the watermark', async () => {
    const h = harness({
      result: { ok: true, imported: 1, updated: 0, errors: ['Order #1002 could not be saved'] },
    })
    const result = await runOrderAutoSyncOnce(h.deps)
    assert.equal(result.ok, false, 'a failed order is a failed poll')
    assert.equal(result.imported, 1, 'the successful order is still reported')
    assert.equal(result.reason, 'Order #1002 could not be saved')
    assert.equal(h.watermarks.length, 0, 'the next poll retries the failed order')
  })

  test('the watermark records the run start, not the run end', async () => {
    let clock = NOW
    const h = harness({
      now: () => clock,
      importImpl: async () => {
        clock = NOW + 60_000 // a slow Shopify pull
        return { ok: true, imported: 0, updated: 1, errors: [] }
      },
    })
    const result = await runOrderAutoSyncOnce(h.deps)
    assert.equal(result.durationMs, 60_000)
    assert.deepEqual(h.watermarks, [new Date(NOW).toISOString()], 'orders arriving mid-run stay in the next window')
  })
})

describe('order auto-sync mutex', () => {
  beforeEach(() => __resetOrderAutoSyncState())

  test('overlapping runs share one import instead of duplicating it', async () => {
    let release: (value: OrderSyncImportResult) => void = () => {}
    const gate = new Promise<OrderSyncImportResult>((resolve) => {
      release = resolve
    })
    let calls = 0
    const h = harness({
      importImpl: async () => {
        calls++
        return gate
      },
    })

    const a = runOrderAutoSync(h.deps)
    const b = runOrderAutoSync(h.deps)
    // Give both callers a chance to reach the importer before it resolves.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 1, 'the second caller joined the in-flight run')

    release({ ok: true, imported: 2, updated: 1, errors: [] })
    const [first, second] = await Promise.all([a, b])
    assert.deepEqual(first as OrderAutoSyncRunResult, second as OrderAutoSyncRunResult)
    assert.equal(first.imported, 2)
    assert.equal(h.watermarks.length, 1, 'one successful run, one watermark write')
  })

  test('the lock is released so the next tick runs normally', async () => {
    const h = harness()
    await runOrderAutoSync(h.deps)
    await runOrderAutoSync(h.deps)
    assert.equal(h.imports.length, 2, 'sequential runs are not coalesced')
  })
})

describe('order auto-sync scheduler', () => {
  const previous = {
    shop: config.shop,
    accessToken: config.accessToken,
    interval: process.env.ORDER_AUTO_SYNC_INTERVAL_SECONDS,
  }

  beforeEach(() => {
    __resetOrderAutoSyncState()
    config.shop = 'test-store.myshopify.com'
    config.accessToken = 'shpat_test'
    // One tick only: tick() sees 0 and does not schedule another.
    process.env.ORDER_AUTO_SYNC_INTERVAL_SECONDS = '0'
  })

  // Restore the mutable config/env so other test files are unaffected.
  function restore() {
    config.shop = previous.shop
    config.accessToken = previous.accessToken
    if (previous.interval === undefined) delete process.env.ORDER_AUTO_SYNC_INTERVAL_SECONDS
    else process.env.ORDER_AUTO_SYNC_INTERVAL_SECONDS = previous.interval
  }

  test('a tick uses the injected importer and publishes its status', async () => {
    const h = harness()
    try {
      startOrderAutoSync({ startupDelayMs: 5, deps: h.deps })
      assert.ok(getOrderAutoSyncStatus().nextRunAt, 'the first run is scheduled')
      await new Promise((resolve) => setTimeout(resolve, 80))
      const status = getOrderAutoSyncStatus()
      assert.equal(h.imports.length, 1, 'exactly one scheduled run')
      assert.equal(status.lastResult?.ok, true)
      assert.equal(status.nextRunAt, null, 'interval 0 does not schedule another tick')
    } finally {
      stopOrderAutoSync()
      restore()
    }
  })

  test('stop cancels a pending tick', async () => {
    const h = harness()
    try {
      startOrderAutoSync({ startupDelayMs: 1000, deps: h.deps })
      stopOrderAutoSync()
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(h.imports.length, 0, 'a stopped timer must not import')
      assert.equal(getOrderAutoSyncStatus().nextRunAt, null)
    } finally {
      stopOrderAutoSync()
      restore()
    }
  })
})
