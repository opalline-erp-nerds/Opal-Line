import test from 'node:test'
import assert from 'node:assert/strict'
import { invalidateApiCache, request } from './core'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function response(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => value,
  } as Response
}

test('cache invalidation separates old and new in-flight GETs', async () => {
  const originalFetch = globalThis.fetch
  const first = deferred<Response>()
  const second = deferred<Response>()
  let calls = 0
  globalThis.fetch = (() => {
    calls += 1
    return calls === 1 ? first.promise : second.promise
  }) as typeof fetch

  try {
    invalidateApiCache()
    const staleRequest = request<{ version: string }>('/cache-invalidation-regression')
    assert.equal(calls, 1)

    invalidateApiCache()
    const freshRequest = request<{ version: string }>('/cache-invalidation-regression')
    assert.equal(calls, 2)

    first.resolve(response({ version: 'stale' }))
    assert.deepEqual(await staleRequest, { version: 'stale' })

    // Settling the old request must not evict the new request's in-flight slot.
    const joinedFreshRequest = request<{ version: string }>('/cache-invalidation-regression')
    assert.equal(calls, 2)
    second.resolve(response({ version: 'fresh' }))
    assert.deepEqual(await freshRequest, { version: 'fresh' })
    assert.deepEqual(await joinedFreshRequest, { version: 'fresh' })
  } finally {
    globalThis.fetch = originalFetch
    invalidateApiCache()
  }
})
