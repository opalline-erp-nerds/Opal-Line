import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, formatApiError, requestText, resetCsrfToken } from './core'

// The booking→invoice stock guard answers with the structured 409 this
// formatter expands. The toast a user sees on a blocked conversion is built
// HERE, so the wording — product/variant, available, required, shortage — is
// pinned against the payload backend/src/stock.ts actually sends.

test('a stock refusal expands to product/variant, available, requested and shortage', () => {
  const err = new ApiError(409, 'Insufficient Stock', {
    code: 'INSUFFICIENT_STOCK',
    message: 'Insufficient Stock — Available: 5, Requested: 20.',
    products: [{ sku: 'TOY-RED', name: 'Silver toy — Red', available: 5, requested: 20, shortage: 15 }],
  })
  const msg = formatApiError(err)
  assert.ok(msg.startsWith('Insufficient Stock:'), 'the header names the problem')
  assert.ok(msg.includes('Silver toy — Red (TOY-RED)'), 'product name AND variant SKU travel to the user')
  assert.ok(msg.includes('Available: 5'), 'the available quantity')
  assert.ok(msg.includes('Requested: 20'), 'the required quantity')
  assert.ok(msg.includes('Short by: 15'), 'the shortage (required − available)')
})

test('shortage is computed when an older payload omits it', () => {
  const err = new ApiError(409, 'Insufficient Stock', {
    code: 'INSUFFICIENT_STOCK',
    products: [{ sku: 'CHAIN', name: 'Silver chain', available: 2, requested: 5 }],
  })
  assert.ok(formatApiError(err).includes('Short by: 3'), 'shortage defaults to requested − available')
  assert.ok(!formatApiError(err).includes('Short by: 0'), 'no zero-shortage noise for non-short lines')
})

test('every short product gets its own line; other errors keep their message', () => {
  const multi = new ApiError(409, 'Insufficient Stock', {
    code: 'INSUFFICIENT_STOCK',
    products: [
      { sku: 'RING', name: 'Ring', available: 1, requested: 2, shortage: 1 },
      { sku: 'PAYAL', name: 'Payal', available: 0, requested: 4, shortage: 4 },
    ],
  })
  const msg = formatApiError(multi)
  assert.equal(msg.split('\n').length, 3, 'header + one line per short product')
  assert.ok(msg.includes('Ring (RING)') && msg.includes('Payal (PAYAL)'))

  assert.equal(formatApiError(new ApiError(400, 'Booking not found')), 'Booking not found')
  assert.equal(formatApiError(new ApiError(409, 'Insufficient Stock')), 'Insufficient Stock', 'detail-less 409 falls back to the message')
  assert.equal(formatApiError(new Error('plain')), 'plain')
  assert.equal(formatApiError(null, 'boom'), 'boom')
})

test('each shortage renders ITS OWN store — one entry never borrows another’s', () => {
  // A multi-store conversion can be short at several stores at once; the
  // backend stamps every entry with its own locationId/location and the
  // renderer must keep them apart (Phase 4, amendment 3).
  const multi = new ApiError(409, 'Insufficient Stock', {
    code: 'INSUFFICIENT_STOCK',
    products: [
      {
        sku: 'P4-RED',
        name: 'Phase4 — red',
        available: 0,
        requested: 5,
        shortage: 5,
        productId: 'prod-1',
        variantId: 'var-red',
        locationId: 'LOC-2',
        location: '2nd Store',
      },
      {
        sku: 'P4-WHT',
        name: 'Phase4 — white',
        available: 1,
        requested: 4,
        shortage: 3,
        productId: 'prod-1',
        variantId: 'var-white',
        locationId: 'LOC-2',
        location: '2nd Store',
      },
    ],
  })
  const lines = formatApiError(multi).split('\n')
  assert.ok(lines[1]!.includes('@ 2nd Store'), 'the first entry names its own store')
  assert.ok(lines[2]!.includes('@ 2nd Store'), 'the second entry names its own store too')
  assert.ok(lines[1]!.includes('P4-RED') && lines[2]!.includes('P4-WHT'), 'one line per short product')

  // …and a refusal at a DIFFERENT store keeps that store on its own entry.
  const crossed = new ApiError(409, 'Insufficient Stock', {
    code: 'INSUFFICIENT_STOCK',
    products: [
      { sku: 'A', name: 'A', available: 1, requested: 2, shortage: 1, locationId: 'LOC-1', location: 'Main Store' },
      { sku: 'B', name: 'B', available: 0, requested: 3, shortage: 3, locationId: 'LOC-2', location: '2nd Store' },
    ],
  })
  const crossedLines = formatApiError(crossed).split('\n')
  assert.ok(crossedLines[1]!.includes('@ Main Store') && !crossedLines[1]!.includes('2nd Store'))
  assert.ok(crossedLines[2]!.includes('@ 2nd Store') && !crossedLines[2]!.includes('Main Store'))
})

test('an incomplete-allocation refusal surfaces the exact line detail', () => {
  // convert →400 { error, details:[{lineIndex, sku, required, allocated}] };
  // the message itself must name the line so the toast is actionable.
  const err = new ApiError(
    400,
    'Booking is not fully allocated: line 1 (P4-RED) has 4 of 10 unit(s) allocated — complete the allocation before converting.',
  )
  const msg = formatApiError(err, 'Failed to convert booking')
  assert.ok(msg.includes('not fully allocated'), 'the refusal reason survives')
  assert.ok(msg.includes('4 of 10'), 'the exact quantities survive')
  assert.ok(msg.includes('P4-RED'), 'the SKU survives')
})

test('requestText refreshes the CSRF token and retries a 403', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; headers?: HeadersInit }> = []
  resetCsrfToken()
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, headers: init?.headers })
      if (url.endsWith('/csrf-token')) {
        return new Response(JSON.stringify({ csrfToken: 'fresh-token' }), { status: 200 })
      }
      const apiCalls = calls.filter((c) => c.url.endsWith('/labels/zpl'))
      if (apiCalls.length === 1) {
        return new Response(JSON.stringify({ error: 'Invalid CSRF token' }), { status: 403 })
      }
      return new Response('%BCD^', { status: 200 })
    }) as typeof fetch

    const text = await requestText('/db/products/labels/zpl', { method: 'POST', body: '{}' })

    assert.equal(text, '%BCD^', 'the retried text body is returned')
    assert.equal(calls.filter((c) => c.url.endsWith('/labels/zpl')).length, 2, 'the state-changing request is retried once')
  } finally {
    globalThis.fetch = originalFetch
    resetCsrfToken()
  }
})
