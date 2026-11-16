import test from 'node:test'
import assert from 'node:assert/strict'
import {
  markSessionCleared,
  markSessionEstablished,
  notifyUnauthorized,
  onSessionLost,
  sessionEpoch,
} from './sessionSignal'

test('a fresh 401 clears the session once, not once per failing request', () => {
  markSessionCleared()
  const events: string[] = []
  const stop = onSessionLost(() => events.push('lost'))
  const startedAt = sessionEpoch()

  assert.equal(notifyUnauthorized(startedAt, 1_000), true)
  // A dashboard fires several requests at once; they all 401 together.
  assert.equal(notifyUnauthorized(startedAt, 1_100), false)
  assert.equal(notifyUnauthorized(startedAt, 1_200), false)

  stop()
  assert.deepEqual(events, ['lost'])
})

test('a 401 from a request that started before the current session is ignored', () => {
  markSessionCleared()
  const startedAt = sessionEpoch()

  // The user signed in again while the old request was still in flight.
  markSessionEstablished()

  let fired = false
  const stop = onSessionLost(() => {
    fired = true
  })
  assert.equal(notifyUnauthorized(startedAt, 5_000), false)
  stop()
  assert.equal(fired, false)
})

test('a new session is not silenced by an earlier burst', () => {
  markSessionCleared()
  assert.equal(notifyUnauthorized(sessionEpoch(), 10_000), true)

  markSessionEstablished()
  assert.equal(notifyUnauthorized(sessionEpoch(), 10_001), true)
})

test('an unsubscribed listener is not called', () => {
  markSessionCleared()
  let calls = 0
  const stop = onSessionLost(() => {
    calls++
  })
  stop()
  notifyUnauthorized(sessionEpoch(), 20_000)
  assert.equal(calls, 0)
})
