import test from 'node:test'
import assert from 'node:assert/strict'
import { FetchTimeoutError, fetchWithTimeout } from './fetchTimeout'

test('fetchWithTimeout passes a signal and turns timeout aborts into a clear error', async () => {
  const originalFetch = globalThis.fetch
  let receivedSignal: AbortSignal | undefined
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    receivedSignal = init?.signal ?? undefined
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  }) as typeof fetch

  try {
    await assert.rejects(
      () => fetchWithTimeout('https://example.invalid', undefined, 1234, 'Shopify'),
      (err) => err instanceof FetchTimeoutError && err.message === 'Shopify request timed out after 1.234s',
    )
    assert.ok(receivedSignal, 'the outbound fetch receives an abort signal')
  } finally {
    globalThis.fetch = originalFetch
  }
})
