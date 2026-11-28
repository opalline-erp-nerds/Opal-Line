import test from 'node:test'
import assert from 'node:assert/strict'
import type { Options } from 'express-rate-limit'
import { PgRateLimitStore } from './pgRateLimitStore'

test('increment fails open when the rate-limit DB query rejects', async () => {
  // The store's DB client is injectable so this does not need a live database.
  const failingClient = (() => Promise.reject(new Error('DB unavailable'))) as never
  const store = new PgRateLimitStore('test', () => failingClient)
  store.init({ windowMs: 60_000 } as Options)

  const result = await store.increment('user-1')

  assert.equal(result.totalHits, 0, 'a DB error never counts as a hit')
  assert.equal(result.resetTime, undefined, 'a DB error never imposes a reset window')
})
