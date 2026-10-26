import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldApplySearch } from './customerPickerRace'

// The picker debounces keystrokes, so responses can land out of order. The
// guard is the only thing stopping a slow response for an OLD query from
// clobbering the result for what the user typed most recently.

test('a response is applied only when its token is the latest issued', () => {
  // Simulate three keystroke requests; token 3 is the newest.
  assert.equal(shouldApplySearch(3, 3), true, 'latest response lands')
  assert.equal(shouldApplySearch(1, 3), false, 'stale response is dropped')
  assert.equal(shouldApplySearch(2, 3), false, 'mid-flight response is dropped')
})

test('a fresh single request (token 1) is applied', () => {
  assert.equal(shouldApplySearch(1, 1), true)
})

test('after a newer request is issued, the older token no longer matches', () => {
  let latest = 0
  const issuedA = ++latest // 1
  const issuedB = ++latest // 2
  // B lands first, then A trickles in late — A must be rejected.
  assert.equal(shouldApplySearch(issuedB, latest), true)
  assert.equal(shouldApplySearch(issuedA, latest), false)
})
